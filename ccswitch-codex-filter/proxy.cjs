'use strict';

const http = require('node:http');
const zlib = require('node:zlib');
const {timingSafeEqual} = require('node:crypto');
const {StringDecoder} = require('node:string_decoder');
const SERVICE = 'ccswitch-codex-reasoning-filter-v1';
const FILTER_VERSION = 10;
const ADMIN = '/__codex_filter__';
const LIMIT = 64 * 1024 * 1024;
const ERROR_LIMIT = 64 * 1024;
const RESOURCE_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];
const RATE_RETRY_DELAYS = [10000, 20000, 40000, 60000, 60000];
const TRANSPORT_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];
const AVAILABILITY_RETRY_DELAYS = [5000, 10000, 20000, 30000, 60000];
const MAX_RETRIES = 20;
const RETRY_LIMITS = Object.freeze({resource: 5, rateLimit: 20, transport: 10, availability: 10});
// These input forms carry their own contents; the server-issued item id is optional.
// Other tool/resource types may require their IDs, so don't recursively strip IDs.
const PORTABLE_ITEMS = new Set(['message', 'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output']);

class FilterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function filterResponsesRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FilterError('invalid_request_json', 'Responses request must be a JSON object.');
  }
  if (body.previous_response_id || body.conversation) {
    throw new FilterError('response_reference_not_portable',
      'Complete message/tool history is required, not previous_response_id or conversation references. Start a new session with a text summary.');
  }
  if (body.include !== undefined && !Array.isArray(body.include)) {
    throw new FilterError('invalid_include', 'include must be an array.');
  }
  if (body.input !== undefined && typeof body.input !== 'string' && !Array.isArray(body.input)) {
    throw new FilterError('invalid_input', 'input must be a string or an array.');
  }
  if (Array.isArray(body.context_management) && body.context_management.some(item => item?.type === 'compaction')) {
    throw new FilterError('encrypted_compaction_disabled',
      'Encrypted compaction is disabled by this filter. Use a text summary and start a new session.');
  }
  const clean = {...body, store: false};
  let removed = 0, removedItemIds = 0;
  if (body.include) clean.include = body.include.filter(value => value !== 'reasoning.encrypted_content');
  if (Array.isArray(body.input)) {
    clean.input = body.input.filter(item => {
      if (item?.type === 'reasoning') { removed++; return false; }
      return true;
    });
    clean.input = clean.input.map(item => {
      if (item?.type === 'compaction' || item?.type === 'item_reference' || item?.encrypted_content) {
        throw new FilterError('encrypted_context_not_portable',
          'Encrypted compaction/context references cannot safely cross accounts. Start a new session with a text summary; history has NOT been silently discarded.');
      }
      const isMessage = item && item.type === undefined && typeof item.role === 'string' && item.content !== undefined;
      if (item && (PORTABLE_ITEMS.has(item.type) || isMessage) && Object.hasOwn(item, 'id')) {
        const portable = {...item};
        delete portable.id;
        removedItemIds++;
        return portable;
      }
      return item;
    });
  }
  // call_id pairs calls/results and is not the server-side item id.
  // Preserve it, this turn's effort, all message contents, and nested resource IDs.
  return {body: clean, removed, removedItemIds};
}

function localOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Upstream must be a loopback HTTP origin, such as http://127.0.0.1:15721');
  }
  return url.origin;
}

function cleanHeaders(headers) {
  const clean = {...headers};
  const named = String(clean.connection || '').split(',').map(value => value.trim().toLowerCase());
  for (const key of [...named, 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade']) delete clean[key];
  return clean;
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  // Keep the socket open so oversized requests can receive JSON 413.
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new FilterError('request_too_large', 'Request exceeds filter size limit.', 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function decodeBody(buffer, encoding, limit) {
  const options = {maxOutputLength: limit};
  try {
    switch (String(encoding || 'identity').toLowerCase()) {
      case 'identity': return buffer;
      case 'gzip': return zlib.gunzipSync(buffer, options);
      case 'deflate': return zlib.inflateSync(buffer, options);
      case 'br': return zlib.brotliDecompressSync(buffer, options);
      case 'zstd': return zlib.zstdDecompressSync(buffer, options);
      default: throw new FilterError('unsupported_content_encoding', 'Unsupported request Content-Encoding.', 415);
    }
  } catch (error) {
    if (error instanceof FilterError) throw error;
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new FilterError('request_too_large', 'Decoded request exceeds filter size limit.', 413);
    throw new FilterError('invalid_compressed_request', 'Cannot decode compressed request.');
  }
}

function sendError(res, error) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(error.status || 502, {'content-type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify({error: {type: 'invalid_request_error', code: error.code || 'local_filter_error', message: error.message}}));
}

function isAlbBadRequestPage(text) {
  return typeof text === 'string' && /<html\b[^>]*>/i.test(text) && /<\/html>/i.test(text)
    && /<title>\s*400\s+Bad\s+Request\s*<\/title>/i.test(text)
    && /<h1>\s*400\s+Bad\s+Request\s*<\/h1>/i.test(text)
    && /<center>\s*alb\s*<\/center>/i.test(text);
}

function retryErrorClass(value) {
  const reported = value?.error || value?.response?.error;
  if (value?.type === 'response.failed' && (!reported || (typeof reported === 'object'
      && !reported.code && !reported.type && !reported.message))) return 'transport';
  const error = value?.error || value?.response?.error || value;
  if (!error || typeof error !== 'object') return null;
  const message = typeof error.message === 'string' ? error.message : '';
  const code = String(error.code || error.type || '');
  // Quota/billing errors can share HTTP 429 with temporary token throttling.
  if (/quota|budget|billing|balance|credit|spend.limit/i.test(code + ' ' + message)) return null;
  if (/^(invalid_api_key|authentication_error|permission_denied|unauthorized|forbidden)$/.test(code)) return null;
  if ((error.type === 'invalid_request_error' || value?.type === 'error' || value?.type === 'response.failed')
      && message.includes('The requested item was created under a different Azure OpenAI resource.')
      && message.includes('Use the same resource that created the item to access it.')) return 'resource';
  if (/^(rate_limit_exceeded|rate_limit_error|too_many_requests)$/.test(code)
      || /exceeded token rate limit/i.test(message)
      || (/rate limit exceeded/i.test(message) && /your requests|token|requests per minute/i.test(message))) return 'rateLimit';
  if (/^(stream_incomplete|stream_disconnected|upstream_idle_timeout|upstream_aborted)$/.test(code)
      || /stream closed before response\.completed|idle timeout waiting for SSE|stream disconnected before completion/i.test(message)) return 'transport';
  if (code === 'no_available_channel' || /无可用渠道|没有可用渠道|no available channels?/i.test(message)) return 'availability';
  return null;
}

function retryDelayMs(kind, index, headers, now = Date.now(), random = Math.random) {
  const delays = kind === 'rateLimit' ? RATE_RETRY_DELAYS
    : kind === 'transport' ? TRANSPORT_RETRY_DELAYS
    : kind === 'availability' ? AVAILABILITY_RETRY_DELAYS : RESOURCE_RETRY_DELAYS;
  let serverDelay = 0;
  for (const name of ['retry-after-ms', 'x-ms-retry-after-ms']) {
    const value = Number(headers[name]);
    if (Number.isFinite(value) && value >= 0) serverDelay = Math.max(serverDelay, value);
  }
  if (headers['retry-after'] !== undefined) {
    const seconds = Number(headers['retry-after']);
    const value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(headers['retry-after']) - now;
    if (Number.isFinite(value) && value >= 0) serverDelay = Math.max(serverDelay, value);
  }
  return Math.max(delays[Math.min(index, delays.length - 1)], serverDelay)
    + (kind === 'rateLimit' ? Math.floor(random() * 1000) : 0);
}

function responseDecoder(encoding) {
  switch (String(encoding || 'identity').toLowerCase()) {
    case 'identity': return null;
    case 'gzip': return zlib.createGunzip();
    case 'deflate': return zlib.createInflate();
    case 'br': return zlib.createBrotliDecompress();
    case 'zstd': return zlib.createZstdDecompress();
    default: throw new Error('unsupported_response_encoding');
  }
}

function makeProxy({getUpstream, token, onStop = () => {}, getState = () => ({}), log = () => {}, limit = LIMIT,
    retryDelay = retryDelayMs, heartbeatMs = 15000, idleTimeoutMs = 120000, deadlineMs = 1800000}) {
  const stats = {requests: 0, filteredRequests: 0, removedReasoningItems: 0, removedItemIds: 0,
    blockedRequests: 0, upstreamErrors: 0, upstreamHttpErrors: 0, lastFilteredAt: null, lastUpstreamStatus: null,
    resourceRetries: 0, resourceRetryAccepted: 0, resourceRetryExhausted: 0,
    rateLimitRetries: 0, rateLimitRetryAccepted: 0, rateLimitRetryExhausted: 0,
    transportRetries: 0, transportRetryAccepted: 0, transportRetryExhausted: 0,
    availabilityRetries: 0, availabilityRetryAccepted: 0, availabilityRetryExhausted: 0,
    streamRetryErrors: 0, activeRequests: 0};
  let nextRequestId = 0;
  const server = http.createServer(async (req, res) => {
    let upstreamRequest, upstreamResponse, responseStream, retryTimer, deadlineTimer, heartbeatTimer;
    let active = false, stopped = false, requestId, outcome, progressTimer;
    const startedAt = Date.now();
    const errorLabel = kind => ({resource: 'different_azure', rateLimit: 'rate_limit', transport: 'stream_incomplete',
      availability: 'no_available_channel'})[kind] || 'other';
    const cancel = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(deadlineTimer);
      clearInterval(heartbeatTimer);
      clearInterval(progressTimer);
      upstreamRequest?.destroy();
      upstreamResponse?.destroy();
      responseStream?.destroy();
      if (active) {
        stats.activeRequests--; active = false;
        log('request-finished', {requestId, outcome: outcome || 'canceled', durationMs: Date.now() - startedAt});
      }
    };
    res.once('close', cancel);
    res.once('finish', cancel);
    req.once('aborted', cancel);
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
        throw new FilterError('invalid_target', 'Only origin-form HTTP requests are accepted.');
      }
      const route = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      if (req.headers.origin || req.headers['sec-fetch-site']) {
        throw new FilterError('browser_request_rejected', 'Browser requests are not supported.', 403);
      }
      if (route === ADMIN + '/health' && req.method === 'GET') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({service: SERVICE, filterVersion: FILTER_VERSION, pid: process.pid, stats,
          retryPolicy: {maxRetries: MAX_RETRIES, limits: RETRY_LIMITS, deadlineMs}, ...getState()}));
        return;
      }
      if (route.startsWith(ADMIN)) {
        const given = Buffer.from(String(req.headers['x-filter-token'] || ''));
        const expected = Buffer.from(String(token || ''));
        if (!expected.length || expected.length !== given.length || !timingSafeEqual(given, expected)) {
          throw new FilterError('invalid_control_token', 'Invalid local control token.', 403);
        }
        if (route !== ADMIN + '/stop' || req.method !== 'POST') throw new FilterError('unknown_control_route', 'Unknown control route.', 404);
        await onStop();
        res.writeHead(200, {'content-type': 'application/json'});
        res.end('{"stopping":true}');
        return;
      }
      if (/\/responses\/compact\/?$/.test(route)) {
        throw new FilterError('encrypted_compaction_disabled',
          'Encrypted Responses compaction is disabled. Use a text summary and start a new session.', 409);
      }
      const upstream = new URL(localOrigin(getUpstream()));
      if (Number(upstream.port || 80) === server.address().port) throw new FilterError('proxy_loop', 'CC Switch and filter must use different ports.', 503);
      const headers = cleanHeaders(req.headers);
      headers.host = upstream.host;
      let body, requestedStream = false;
      const isResponses = /\/responses\/?$/.test(route) && req.method === 'POST';
      requestId = ++nextRequestId;
      if (isResponses) {
        const raw = decodeBody(await readBody(req, limit), req.headers['content-encoding'], limit);
        let input;
        try { input = JSON.parse(raw.toString('utf8')); }
        catch { throw new FilterError('invalid_request_json', 'Responses request is not valid JSON.'); }
        const filtered = filterResponsesRequest(input);
        requestedStream = filtered.body.stream === true;
        body = Buffer.from(JSON.stringify(filtered.body));
        delete headers['content-encoding'];
        delete headers.expect;
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(body.length);
        stats.filteredRequests++;
        stats.removedReasoningItems += filtered.removed;
        stats.removedItemIds += filtered.removedItemIds;
        stats.lastFilteredAt = new Date().toISOString();
        log('filtered', {requestId, removed: filtered.removed, removedItemIds: filtered.removedItemIds});
      }
      if (res.destroyed || req.aborted) return;
      stats.requests++;
      stats.activeRequests++;
      active = true;
      let retries = 0, phase = 'upstream';
      const retriesByKind = {resource: 0, rateLimit: 0, transport: 0, availability: 0};
      const retryKinds = new Set();
      const requestLog = (event, data = {}) => log(event, {requestId, ...data});
      requestLog('request-started', {streaming: requestedStream, maxRetries: MAX_RETRIES, retryLimits: RETRY_LIMITS, deadlineMs});
      progressTimer = setInterval(() => requestLog('request-progress', {
        phase, retries, maxRetries: MAX_RETRIES,
        elapsedMs: Date.now() - startedAt, remainingMs: Math.max(0, deadlineMs - (Date.now() - startedAt))
      }), 15000);
      const deadlineAt = Date.now() + deadlineMs;
      let disposeAttempt = () => {};
      const startHeartbeat = () => {
        if (!requestedStream || heartbeatTimer) return;
        const beat = () => {
          if (stopped || res.destroyed) return;
          if (!res.headersSent) {
            res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache'});
            res.flushHeaders();
          }
          res.write('event: response.in_progress\ndata: '
            + JSON.stringify({type: 'response.in_progress', response: {id: 'resp_filter_' + requestId,
              object: 'response', status: 'in_progress', output: []}}) + '\n\n');
        };
        heartbeatTimer = setInterval(beat, heartbeatMs);
      };
      const stopHeartbeat = () => { clearInterval(heartbeatTimer); heartbeatTimer = null; };
      const finishError = (response, errorBody) => {
        outcome = 'failed';
        stopHeartbeat();
        if (res.headersSent) {
          let error;
          try { error = JSON.parse(decodeBody(errorBody, response.headers['content-encoding'], ERROR_LIMIT)); }
          catch { error = {error: {type: 'upstream_error', message: 'Upstream returned HTTP ' + response.statusCode}}; }
          const detail = error.error || error;
          res.end('event: error\ndata: ' + JSON.stringify({...detail, type: 'error',
            code: detail.code || detail.type || 'upstream_error'}) + '\n\n');
        } else {
          res.writeHead(response.statusCode, cleanHeaders(response.headers));
          res.end(errorBody);
        }
      };
      const schedule = (kind, response, errorCode = errorLabel(kind)) => {
        if (!kind) return false;
        const kindRetries = retriesByKind[kind], maxKindRetries = RETRY_LIMITS[kind];
        const limitReached = retries >= MAX_RETRIES || kindRetries >= maxKindRetries;
        const delayMs = limitReached ? 0 : retryDelay(kind, kindRetries, response.headers);
        if (limitReached || !Number.isFinite(delayMs) || delayMs < 0 || Date.now() + delayMs >= deadlineAt) {
          stats[kind + 'RetryExhausted']++;
          requestLog('retry-exhausted', {kind, errorCode, retries, maxRetries: MAX_RETRIES,
            kindRetries, maxKindRetries, deadline: !limitReached});
          return false;
        }
        retries++;
        retriesByKind[kind]++;
        phase = 'backoff';
        retryKinds.add(kind);
        requestLog('retry-scheduled', {kind, errorCode, retry: retries, maxRetries: MAX_RETRIES,
          kindRetry: retriesByKind[kind], maxKindRetries, delayMs});
        startHeartbeat();
        retryTimer = setTimeout(() => {
          if (stopped || res.destroyed) return;
          stats[kind + 'Retries']++;
          phase = 'upstream';
          requestLog('retry-dispatched', {kind, errorCode, retry: retries, maxRetries: MAX_RETRIES,
            kindRetry: retriesByKind[kind], maxKindRetries});
          dispatch();
        }, delayMs);
        return true;
      };
      const accepted = response => {
        outcome = 'success';
        stopHeartbeat();
        for (const kind of retryKinds) stats[kind + 'RetryAccepted']++;
        if (retries) requestLog('retry-accepted', {retries, status: response.statusCode});
      };
      const failed = error => {
        if (stopped || res.destroyed) return;
        stats.upstreamErrors++;
        outcome = 'failed';
        requestLog('upstream-error', {code: error.code || error.message || 'timeout'});
        if (heartbeatTimer && res.headersSent) {
          res.end('event: error\ndata: {"type":"error","code":"ccswitch_unavailable","message":"Cannot reach CC Switch or request deadline expired."}\n\n');
        } else sendError(res, new FilterError('ccswitch_unavailable', 'Cannot reach CC Switch. Enable its local proxy and Codex takeover, then retry.', 502));
        cancel();
      };
      // One deadline includes CC Switch's own attempts and all local retry waits.
      deadlineTimer = setTimeout(() => {
        requestLog('retry-exhausted', {kind: 'transport', errorCode: 'request_deadline', retries,
          maxRetries: MAX_RETRIES, deadline: true});
        stats.transportRetryExhausted++;
        disposeAttempt(); failed(new Error('upstream_timeout'));
      }, deadlineMs);
      const dispatch = () => {
        if (stopped || res.destroyed) return;
        let discarded = false, settled = false;
        const discard = () => {
          if (discarded) return;
          discarded = true;
          upstreamRequest?.setTimeout(0);
          // Keep the guarded error listeners while destroying sockets: a request
          // without response headers can still emit ECONNRESET after destruction.
          upstreamRequest?.destroy(); upstreamResponse?.destroy(); responseStream?.destroy();
        };
        disposeAttempt = discard;
        const attemptFailed = error => {
          if (discarded || settled || stopped || res.destroyed) return;
          settled = true;
          discard();
          requestLog('transport-error', {code: error.code || error.message || 'stream_closed', errorCode: 'stream_incomplete', retryable: isResponses});
          if (isResponses && schedule('transport', {headers: {}})) return;
          finishError({statusCode: 502, headers: {}}, Buffer.from(JSON.stringify({error: {
            code: 'stream_incomplete', message: 'Upstream stream disconnected before completion or timed out.'}})));
        };
        upstreamResponse = responseStream = null;
        upstreamRequest = http.request({hostname: upstream.hostname.replace(/^\[|\]$/g, ''), port: upstream.port || 80,
          path: req.url, method: req.method, headers}, response => {
          upstreamResponse = response;
          if (isResponses) {
            stats.lastUpstreamStatus = response.statusCode;
            if (response.statusCode >= 400) {
              stats.upstreamHttpErrors++;
              requestLog('upstream-http-error', {status: response.statusCode});
            }
          }
          if (stopped || res.destroyed) { response.destroy(); return; }
          const forward = prefix => {
            if (stopped || res.destroyed) return;
            settled = true;
            response.removeListener('error', attemptFailed);
            response.removeAllListeners('aborted');
            response.on('error', failed);
            response.on('aborted', () => failed(new Error('upstream_aborted')));
            upstreamRequest.setTimeout(0);
            if (response.statusCode >= 400) outcome = 'failed';
            else outcome = 'success';
            stopHeartbeat();
            if (!res.headersSent) {
              res.writeHead(response.statusCode, cleanHeaders(response.headers));
              res.flushHeaders();
            }
            if (prefix) res.write(prefix);
            response.pipe(res);
          };
          response.on('error', attemptFailed);
          response.on('aborted', () => attemptFailed(new Error('upstream_aborted')));
          const isSse = /^text\/event-stream\b/i.test(String(response.headers['content-type'] || ''));
          if (isResponses && response.statusCode === 200 && isSse) {
            let stream;
            try {
              const decoder = responseDecoder(response.headers['content-encoding']);
              stream = decoder ? response.pipe(decoder) : response;
              if (decoder) {
                delete response.headers['content-encoding'];
                delete response.headers['content-length'];
                decoder.on('error', attemptFailed);
              }
              responseStream = stream;
            } catch (error) { attemptFailed(error); return; }
            const decoder = new StringDecoder('utf8');
            const chunks = [];
            let size = 0, pending = '';
            const detach = () => {
              stream.removeListener('data', inspect);
              stream.removeListener('end', ended);
            };
            const finish = (success = true) => {
              settled = true;
              detach();
              if (success) accepted(response);
              else { outcome = 'failed'; stopHeartbeat(); }
              if (!res.headersSent) {
                res.writeHead(200, cleanHeaders(response.headers)); res.flushHeaders();
              }
              res.end(Buffer.concat(chunks));
              discard();
            };
            const inspect = chunk => {
              if (discarded || settled || stopped) return;
              chunks.push(chunk); size += chunk.length;
              if (size > limit) {
                settled = true; detach(); discard();
              requestLog('response-buffer-exceeded', {limit, code: 'response_too_large'});
                finishError({statusCode: 502, headers: {}}, Buffer.from(JSON.stringify({error: {
                  code: 'response_too_large', message: 'Buffered response exceeds filter size limit.'}})));
                return;
              }
              pending += decoder.write(chunk);
              let boundary;
              while ((boundary = /\r?\n\r?\n/.exec(pending))) {
                const frame = pending.slice(0, boundary.index);
                pending = pending.slice(boundary.index + boundary[0].length);
                const lines = frame.split(/\r?\n/);
                const data = lines.filter(line => /^data:/.test(line)).map(line => line.slice(5).replace(/^ /, '')).join('\n');
                if (!data || data.trim() === '[DONE]') continue;
                let value;
                try { value = JSON.parse(data); } catch { continue; }
                const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || value.type;
                if (event === 'error' || event === 'response.failed') {
                  const kind = retryErrorClass({...value, type: event});
                  const detail = value.error || value.response?.error || value;
                  const code = String(detail.code || detail.type || 'other').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
                  const missingDetails = kind === 'transport' && event === 'response.failed'
                    && !(value.error || value.response?.error)?.code && !(value.error || value.response?.error)?.message;
                  requestLog('stream-error', {kind: kind || 'other',
                    errorCode: missingDetails ? 'upstream_failed_without_details' : kind ? errorLabel(kind) : code,
                    errorDetailsPresent: !!(value.error || value.response?.error), bufferedBytes: size});
                  // No model/tool output has been delivered to the client. Discard
                  // the whole rejected response instead of repeating client tools.
                  if (kind && schedule(kind, response)) {
                    settled = true; detach();
                    stats.streamRetryErrors++;
                    discard();
                    return;
                  }
                  settled = true; detach(); discard();
                  // Failed output must not be delivered as executable client tools.
                  finishError({statusCode: 502, headers: {}}, Buffer.from(JSON.stringify({error:
                    missingDetails ? {type: 'upstream_error', code: 'upstream_failed_without_details',
                      message: 'Upstream returned response.failed without error details; the filter retry limit or deadline was reached.'}
                      : value.error || value.response?.error || value})));
                  return;
                }
                if (event === 'response.completed') { finish(); return; }
                if (event === 'response.incomplete') { finish(false); return; }
              }
            };
            const ended = () => {
              if (settled || discarded || stopped || res.destroyed) return;
              detach();
              attemptFailed(new Error('stream_closed_before_completed'));
            };
            stream.on('data', inspect);
            stream.once('end', ended);
            return;
          }
          if (!isResponses || response.statusCode < 400) {
            if (isResponses && retries && response.statusCode >= 200 && response.statusCode < 300) {
              accepted(response);
            }
            forward();
            return;
          }
          const chunks = [];
          let size = 0;
          const collect = chunk => {
            chunks.push(chunk);
            size += chunk.length;
            if (size <= ERROR_LIMIT) return;
            response.removeListener('data', collect);
            response.removeListener('end', completed);
            forward(Buffer.concat(chunks));
          };
          const completed = () => {
            if (stopped || res.destroyed) return;
            const errorBody = Buffer.concat(chunks);
            let value, decoded;
            try { decoded = decodeBody(errorBody, response.headers['content-encoding'], ERROR_LIMIT).toString('utf8'); } catch {}
            try { value = JSON.parse(decoded); } catch {}
            // Only the known ALB HTML page is retried; generic HTTP 400 and
            // explicit auth/quota/parameter errors keep their existing behavior.
            const albBadRequest = response.statusCode === 400 && isAlbBadRequestPage(
              value ? value.error?.code === 'cc_switch_upstream_error' ? value.error.message : '' : decoded);
            const detected = retryErrorClass(value);
            const kind = albBadRequest ? 'transport' : ((detected === 'resource' && response.statusCode === 400)
              || (detected === 'rateLimit' && [400, 429].includes(response.statusCode))
              || detected === 'transport'
              || (detected === 'availability' && response.statusCode === 503) ? detected : null);
            const code = String(value?.error?.code || value?.error?.type || 'other').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
            const errorCode = albBadRequest ? 'alb_bad_request' : kind ? errorLabel(kind) : code;
            requestLog('http-error', {status: response.statusCode, kind: kind || 'other', errorCode});
            if (schedule(kind, response, errorCode)) { settled = true; discard(); return; }
            settled = true;
            finishError(response, errorBody);
          };
          response.on('data', collect);
          response.once('end', completed);
        });
        upstreamRequest.on('error', attemptFailed);
        if (isResponses) upstreamRequest.setTimeout(idleTimeoutMs, () => attemptFailed(new Error('upstream_idle_timeout')));
        if (body) upstreamRequest.end(body);
        else req.pipe(upstreamRequest);
      };
      startHeartbeat();
      dispatch();
    } catch (error) {
      stats.blockedRequests++;
      log('blocked', {code: error.code || 'filter_error'});
      sendError(res, error instanceof FilterError ? error : new FilterError('local_filter_error', 'Local filter failed to handle request.', 500));
    }
  });
  server.on('upgrade', (req, socket) => {
    const body = 'Use Responses over HTTP/SSE; WebSocket filtering is not supported.';
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: '
      + Buffer.byteLength(body) + '\r\n\r\n' + body);
  });
  server.requestTimeout = 120000;
  return server;
}

module.exports = {SERVICE, ADMIN, FilterError, filterResponsesRequest, localOrigin, makeProxy, decodeBody, retryDelayMs};
