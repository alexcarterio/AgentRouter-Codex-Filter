'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const {once} = require('node:events');
const {makeProxy, ADMIN, retryDelayMs} = require('./proxy.cjs');

const azureError = JSON.stringify({error: {type: 'invalid_request_error', code: 'cc_switch_upstream_error',
  message: 'CC Switch local proxy failed: The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it.'}});
const rateError = JSON.stringify({error: {code: 'rate_limit_exceeded', type: 'rate_limit_error',
  message: 'rate limit exceeded: Your requests to test-model for test-model in test-region have exceeded token rate limit'}});

const albPage = '<html> <head><title>400 Bad Request</title></head> <body bgcolor="white">'
  + '<center><h1>400 Bad Request</h1></center> <hr><center>alb</center> </body> </html>';
const albError = JSON.stringify({error: {code: 'cc_switch_upstream_error', type: 'invalid_request_error',
  message: 'CC Switch local proxy failed while handling Codex endpoint /responses. '
    + 'upstream_status: HTTP 400; cause: ' + albPage}});

test('ALB HTML 400 retries raw and CC Switch wrapped responses without client-visible errors', async t => {
  for (const wrapped of [false, true]) {
    await t.test(wrapped ? 'gzip CC Switch wrapper' : 'raw HTML', async t => {
      const bodies = [], rows = [];
      const {origin, health} = await fixture(t, async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        bodies.push(Buffer.concat(chunks));
        if (bodies.length <= 2) {
          const encoded = wrapped ? zlib.gzipSync(albError) : Buffer.from(albPage);
          res.writeHead(400, {'content-type': wrapped ? 'application/json' : 'text/html',
            ...(wrapped ? {'content-encoding': 'gzip'} : {})});
          res.write(encoded.subarray(0, 13)); res.end(encoded.subarray(13));
        } else {
          res.writeHead(200, {'content-type': 'text/event-stream'});
          res.end(sse('response.output_text.delta', {delta: 'alb_recovered'})
            + sse('response.completed', {response: {output: []}}));
        }
      }, (event, data) => rows.push({event, ...data}));
      const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true,"input":"offline-only"}'});
      const output = await response.text();
      assert.equal(response.status, 200);
      assert.match(output, /alb_recovered/);
      assert.match(output, /response.completed/);
      assert.doesNotMatch(output, /400 Bad Request|cc_switch_upstream_error|event: error/);
      assert.equal(bodies.length, 3);
      assert.ok(bodies.every(body => body.equals(bodies[0])));
      assert.equal((await health()).stats.transportRetries, 2);
      for (const event of ['http-error', 'retry-scheduled', 'retry-dispatched']) {
        assert.equal(rows.filter(row => row.event === event && row.errorCode === 'alb_bad_request').length, 2);
      }
    });
  }
});

test('ALB HTML 400 detection does not retry ordinary 400, other HTML, auth, or quota errors', async t => {
  const replies = [
    JSON.stringify({error: {type: 'invalid_request_error', message: 'invalid model'}}),
    albPage.replace('<center>alb</center>', '<center>other-server</center>'),
    albPage.replace('<title>400 Bad Request</title>', '<title>Invalid parameters</title>'),
    JSON.stringify({error: {code: 'invalid_api_key', message: albPage}}),
    JSON.stringify({error: {code: 'insufficient_quota', message: albPage}}),
    JSON.stringify({error: {code: 'invalid_request_error', message: albPage}}),
    JSON.stringify({error: {code: 'cc_switch_upstream_error', message: 'HTTP 400: invalid request'}})
  ];
  const calls = new Map();
  const {origin} = await fixture(t, (req, res) => {
    req.resume(); calls.set(req.url, (calls.get(req.url) || 0) + 1);
    res.writeHead(400, {'content-type': 'application/json'});
    res.end(replies[Number(new URL(req.url, 'http://localhost').searchParams.get('case'))]);
  });
  for (let index = 0; index < replies.length; index++) {
    const route = '/responses?case=' + index;
    await (await fetch(origin + route, {method: 'POST', body: '{}'})).text();
    assert.equal(calls.get(route), 1, 'case ' + index + ' must not retry');
  }
});

test('ALB HTML 400 shares the ten-retry transport budget and exposes the final error on exhaustion', async t => {
  let attempts = 0;
  const rows = [];
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(400, {'content-type': 'application/json'});
    res.end(albError);
  }, (event, data) => rows.push({event, ...data}));
  const output = await (await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'})).text();
  assert.equal(attempts, 11);
  assert.equal((output.match(/event: error/g) || []).length, 1);
  assert.match(output, /400 Bad Request/);
  assert.doesNotMatch(output, /response.completed/);
  const state = await health();
  assert.equal(state.stats.transportRetries, 10);
  assert.equal(state.stats.transportRetryExhausted, 1);
  assert.equal(state.stats.activeRequests, 0);
  assert.ok(rows.some(row => row.event === 'retry-exhausted' && row.errorCode === 'alb_bad_request'
    && row.kind === 'transport' && row.kindRetries === 10));
});

const disconnectedMessage = 'stream disconnected before completion: stream closed before response.completed';
const disconnectedError = {code: 'cc_switch_upstream_error', type: 'invalid_request_error',
  message: 'CC Switch local proxy failed: ' + disconnectedMessage};

test('explicit disconnected errors retry HTTP wrappers and SSE failures without rejected output', async t => {
  for (const variant of [400, 500, 502, 'error', 'response.failed']) {
    await t.test(String(variant), async t => {
      const bodies = [], rows = [];
      const isHttp = typeof variant === 'number';
      const {origin, health} = await fixture(t, async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        bodies.push(Buffer.concat(chunks));
        if (bodies.length <= 2 && isHttp) {
          const body = JSON.stringify({error: disconnectedError});
          res.writeHead(variant, {'content-type': 'application/json',
            ...(variant === 502 ? {'content-encoding': 'gzip'} : {})});
          res.end(variant === 502 ? zlib.gzipSync(body) : body);
        } else {
          res.writeHead(200, {'content-type': 'text/event-stream'});
          if (bodies.length <= 2) {
            res.end(sse('response.output_item.done', {item: {type: 'function_call', name: 'must_not_execute'}})
              + sse(variant, variant === 'error' ? disconnectedError : {response: {error: disconnectedError}}));
          } else res.end(sse('response.output_text.delta', {delta: 'disconnect_recovered'})
            + sse('response.completed', {response: {output: []}}));
        }
      }, (event, data) => rows.push({event, ...data}));
      const response = await fetch(origin + '/responses', {method: 'POST',
        body: '{"stream":true,"input":"offline-only"}'});
      const output = await response.text();
      assert.equal(response.status, 200);
      assert.match(output, /disconnect_recovered/);
      assert.match(output, /response.completed/);
      assert.doesNotMatch(output, /stream disconnected|cc_switch_upstream_error|event: error|must_not_execute/);
      assert.equal(bodies.length, 3);
      assert.ok(bodies.every(body => body.equals(bodies[0])));
      const stats = (await health()).stats;
      assert.equal(stats.transportRetries, 2);
      assert.equal(stats.transportRetryAccepted, 1);
      assert.equal(stats.streamRetryErrors, isHttp ? 0 : 2);
      assert.equal(rows.filter(row => row.event === 'retry-dispatched'
        && row.kind === 'transport' && row.errorCode === 'stream_incomplete').length, 2);
    });
  }
});

test('HTTP disconnected errors share the ALB transport allowance and return the final error on exhaustion', async t => {
  let attempts = 0;
  const rows = [];
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(attempts === 1 ? 400 : 502, {'content-type': 'application/json'});
    res.end(attempts === 1 ? albError : JSON.stringify({error: disconnectedError}));
  }, (event, data) => rows.push({event, ...data}));
  const output = await (await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'})).text();
  assert.equal(attempts, 11);
  assert.equal((output.match(/event: error/g) || []).length, 1);
  assert.ok(output.includes(disconnectedMessage));
  assert.doesNotMatch(output, /^event: response\.completed$/m);
  const stats = (await health()).stats;
  assert.equal(stats.transportRetries, 10);
  assert.equal(stats.transportRetryExhausted, 1);
  assert.equal(stats.activeRequests, 0);
  assert.ok(rows.some(row => row.event === 'retry-exhausted' && row.kind === 'transport'
    && row.errorCode === 'stream_incomplete' && row.kindRetries === 10));
});

test('HTTP auth, quota, and ordinary 4xx failures do not retry despite disconnected wording', async t => {
  const replies = [
    {status: 502, error: {code: 'invalid_api_key', message: disconnectedMessage}},
    {status: 502, error: {code: 'insufficient_quota', message: disconnectedMessage}},
    {status: 502, error: {code: 'cc_switch_upstream_error', message: 'Quota exceeded: ' + disconnectedMessage}},
    {status: 400, error: {code: 'invalid_request_error', message: 'Invalid model'}},
    {status: 403, error: {code: 'forbidden', message: disconnectedMessage}}
  ];
  const calls = new Map();
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); calls.set(req.url, (calls.get(req.url) || 0) + 1);
    const reply = replies[Number(new URL(req.url, 'http://localhost').searchParams.get('case'))];
    res.writeHead(reply.status, {'content-type': 'application/json'});
    res.end(JSON.stringify(reply));
  });
  for (let index = 0; index < replies.length; index++) {
    const route = '/responses?case=' + index;
    const output = await (await fetch(origin + route, {method: 'POST', body: '{}'})).text();
    assert.ok(output.includes(replies[index].error.message));
    assert.equal(calls.get(route), 1, 'case ' + index + ' must not retry');
  }
  assert.equal((await health()).stats.transportRetries, 0);
});

test('generic relay 5xx bodies retry as transport failures and recover', async t => {
  let attempts = 0;
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    if (attempts === 1) {
      res.writeHead(502, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: {code: 'cc_switch_upstream_error', message: 'Internal server error'}}));
    } else {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.end(sse('response.completed', {response: {output: []}}));
    }
  });
  const text = await (await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'})).text();
  assert.match(text, /response\.completed/);
  assert.equal(attempts, 2);
  assert.equal((await health()).stats.transportRetries, 1);
});

test('CC Switch forward failures retry as transport failures without client-visible errors', async t => {
  let attempts = 0;
  const rows = [];
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    if (attempts === 1) {
      res.writeHead(502, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: {code: 'cc_switch_forward_failed',
        message: 'forward to upstream failed: connect ECONNRESET'}}));
    } else {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.end(sse('response.output_text.delta', {delta: 'forward_recovered'})
        + sse('response.completed', {response: {output: []}}));
    }
  }, (event, data) => rows.push({event, ...data}));
  const output = await (await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'})).text();
  assert.match(output, /forward_recovered/);
  assert.doesNotMatch(output, /event: error|cc_switch_forward_failed/);
  assert.equal(attempts, 2);
  assert.equal((await health()).stats.transportRetries, 1);
  assert.ok(rows.some(row => row.event === 'http-error' && row.kind === 'transport'
    && row.errorCode === 'stream_incomplete'));
});

test('bad_response stream errors are retried before any content reaches the client', async t => {
  let attempts = 0;
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end(attempts === 1
      ? sse('response.created', {response: {id: 'bad', output: []}})
        + sse('error', {code: 'bad_response', message: 'malformed upstream payload'})
      : sse('response.output_text.delta', {delta: 'clean_run'})
        + sse('response.completed', {response: {output: []}}));
  });
  const text = await (await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'})).text();
  assert.match(text, /clean_run/);
  assert.doesNotMatch(text, /bad_response|event: error/);
  assert.equal(attempts, 2);
  assert.equal((await health()).stats.transportRetries, 1);
});

test('response.failed without details retries invisibly; explicit business errors still fail once', async t => {
  let attempts = 0;
  const calls = {}, events = [];
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); calls[req.url] = (calls[req.url] || 0) + 1;
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (req.url.includes('quota') || req.url.includes('auth')) {
      const error = req.url.includes('quota') ? {code: 'insufficient_quota', message: 'Quota exceeded'}
        : {code: 'invalid_api_key', message: 'No available channels for this key'};
      res.end('event: response.failed\ndata: ' + JSON.stringify({type: 'response.failed', response: {error}}) + '\n\n');
    } else if (++attempts <= 2) {
      res.write('event: response.output_item.done\ndata: {"item":{"type":"function_call","name":"must_not_execute"}}\n\n');
      res.end('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":null}}\n\n');
    } else res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  }, (event, data) => events.push({event, ...data}));
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  const output = await response.text();
  assert.match(output, /response.completed/);
  assert.doesNotMatch(output, /response.failed|must_not_execute/);
  assert.equal(attempts, 3);
  assert.equal((await health()).stats.transportRetries, 2);
  assert.equal(events.filter(x => x.errorCode === 'upstream_failed_without_details').length, 2);
  for (const kind of ['quota', 'auth']) {
    await (await fetch(origin + '/responses?' + kind, {method: 'POST', body: '{"stream":true}'})).text();
    assert.equal(calls['/responses?' + kind], 1);
  }
});

test('persistent response.failed without details exhausts the existing transport allowance', async t => {
  let attempts = 0;
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end('event: response.failed\ndata: {"response":{"status":"failed","error":{}}}\n\n');
  });
  const output = await (await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'})).text();
  assert.doesNotMatch(output, /response.completed/);
  assert.match(output, /upstream_failed_without_details/);
  assert.match(output, /without error details/);
  assert.equal(attempts, 11);
  assert.equal((await health()).stats.transportRetryExhausted, 1);
});

async function fixture(t, handler, log = () => {}, options = {}) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  // Short waits exercise the real retry loop; policy waits are checked separately.
  const proxy = makeProxy({getUpstream: () => 'http://127.0.0.1:' + upstream.address().port, log,
    retryDelay: () => 10, heartbeatMs: 10, ...options});
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  const origin = 'http://127.0.0.1:' + proxy.address().port;
  return {origin, health: async () => (await fetch(origin + ADMIN + '/health')).json()};
}

test('cross-resource rejection degrades lazy history once, then retries invisibly and streams immediately', {timeout: 10000}, async t => {
  const received = [];
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  t.after(() => finish());
  const {origin, health} = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({body: Buffer.concat(chunks), headers: req.headers, path: req.url});
    if (received.length <= 2) {
      const encoded = zlib.gzipSync(azureError);
      res.writeHead(400, {'content-type': 'application/json', 'content-encoding': 'gzip'});
      res.write(encoded.subarray(0, 15)); res.end(encoded.subarray(15));
      return;
    }
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('event: response.output_text.delta\ndata: {"delta":"recovered"}\n\n');
    await gate;
    res.end('event: response.completed\ndata: {"done":true}\n\n');
  });
  const history = {model: 'offline-only', store: false, stream: true, reasoning: {effort: 'xhigh'},
    include: ['reasoning.encrypted_content'], input: [
    {type: 'reasoning', id: 'rs_keep', encrypted_content: 'fixture', summary: []},
    {type: 'message', id: 'msg_remove', role: 'user', content: 'continue'},
    {type: 'function_call', id: 'fc_remove', name: 'lookup', call_id: 'call_keep', arguments: '{}'},
    {type: 'function_call_output', call_id: 'call_keep', output: 'done'},
    {type: 'web_search_call', id: 'ws_keep_history', status: 'completed', action: {type: 'search', queries: ['keep']}}
  ]};
  const response = await fetch(origin + '/responses?session=original', {method: 'POST', headers: {
    authorization: 'Bearer test-only', 'x-session-id': 'same-session'
  }, body: JSON.stringify(history)});
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  // Heartbeats from the backoff window may arrive first; content still streams
  // as soon as the upstream produces it, long before the gate is released.
  let streamed = '';
  const streamingDeadline = Date.now() + 3000;
  while (Date.now() < streamingDeadline && !streamed.includes('recovered')) {
    const part = await reader.read();
    if (part.done) break;
    streamed += Buffer.from(part.value).toString();
  }
  assert.match(streamed, /recovered/);
  assert.doesNotMatch(streamed, /response\.completed/);
  finish();
  let tail = '';
  for (;;) { const part = await reader.read(); if (part.done) break; tail += Buffer.from(part.value); }
  assert.match(tail, /response\.completed/);
  assert.equal(received.length, 3);
  // The first attempt keeps reasoning continuity and codex's own history intact.
  const lazyBody = JSON.parse(received[0].body);
  assert.equal(lazyBody.store, false);
  assert.deepEqual(lazyBody.include, ['reasoning.encrypted_content']);
  assert.equal(lazyBody.input[0].type, 'reasoning');
  assert.equal(lazyBody.input[0].encrypted_content, 'fixture');
  assert.equal(lazyBody.input[1].id, 'msg_remove');
  assert.equal(lazyBody.input[4].id, 'ws_keep_history');
  assert.equal(lazyBody.reasoning.effort, 'xhigh');
  assert.equal(lazyBody.input[2].call_id, lazyBody.input[3].call_id);
  // After the cross-resource error the degraded attempts use the v10 stripped body.
  for (const attempt of received.slice(1)) {
    assert.deepEqual(attempt.body, received[1].body);
    assert.equal(attempt.headers.authorization, 'Bearer test-only');
    assert.equal(attempt.headers['x-session-id'], 'same-session');
    assert.equal(attempt.path, '/responses?session=original');
  }
  const stripped = JSON.parse(received[1].body);
  assert.equal(stripped.input.some(item => item.type === 'reasoning'), false);
  assert.equal(stripped.input[0].id, undefined);
  assert.equal(stripped.input.at(-1).id, 'ws_keep_history');
  assert.deepEqual(stripped.include, []);
  assert.equal(stripped.input[1].call_id, stripped.input[2].call_id);
  const state = await health();
  assert.equal(state.stats.resourceRetries, 2);
  assert.equal(state.stats.resourceRetryAccepted, 1);
  assert.equal(state.stats.reasoningKept, 1);
  assert.equal(state.stats.removedReasoningItems, 1);
  assert.equal(state.stats.activeRequests, 0);
});

test('permanent resource rejection exhausts five retries and returns the final original error', async t => {
  let attempts = 0;
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(400, {'content-type': 'application/json', 'x-last-attempt': String(attempts)});
    res.end(azureError);
  });
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{}'});
  assert.equal(response.status, 400);
  assert.equal(await response.text(), azureError);
  assert.equal(response.headers.get('x-last-attempt'), '6');
  assert.equal(attempts, 6);
  const state = await health();
  assert.equal(state.stats.resourceRetries, 5);
  assert.equal(state.stats.resourceRetryExhausted, 1);
});

test('unrelated failures are forwarded once; buffered target error is retried', async t => {
  const counts = new Map();
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); counts.set(req.url, (counts.get(req.url) || 0) + 1);
    const status = Number(new URL(req.url, 'http://local').searchParams.get('status'));
    const body = req.url.includes('quote')
      ? JSON.stringify({error: {type: 'other_error', message: JSON.parse(azureError).error.message}})
      : status === 400 ? '{"error":{"type":"invalid_request_error","message":"invalid model"}}' : azureError;
    res.writeHead(status, {'content-type': status === 200 ? 'text/event-stream' : 'application/json'});
    res.end(status === 200 ? 'event: error\ndata: ' + body + '\n\n' : body);
  });
  for (const route of ['/responses?status=400', '/responses?status=400&quote=1', '/responses?status=402',
    '/responses?status=200']) {
    const response = await fetch(origin + route, {method: 'POST', body: route.includes('status=200') ? '{"stream":true}' : '{}'});
    assert.equal(response.status, Number(new URL(route, origin).searchParams.get('status')));
    assert.ok(await response.text());
    assert.equal(counts.get(route), route.includes('status=200') ? 6 : 1);
  }
  assert.equal((await health()).stats.resourceRetries, 5);
});

test('errors arriving with delivered content are not replayed and pass through once', async t => {
  const counts = new Map();
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); counts.set(req.url, (counts.get(req.url) || 0) + 1);
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end('event: response.output_text.delta\ndata: {"delta":"committed"}\n\n'
      + 'event: error\ndata: ' + JSON.stringify({error: {type: 'other_error',
        message: JSON.parse(azureError).error.message}}) + '\n\n');
  });
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /committed/);
  assert.match(text, /event: error/);
  assert.equal(counts.get('/responses'), 1);
  assert.equal((await health()).stats.resourceRetries, 0);
});

test('canceling during the backoff cancels the scheduled retry', {timeout: 5000}, async t => {
  let attempts = 0, scheduled;
  const waiting = new Promise(resolve => { scheduled = resolve; });
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(400, {'content-type': 'application/json'}); res.end(azureError);
  }, event => { if (event === 'retry-scheduled') scheduled(); }, {retryDelay: () => 200});
  const req = http.request(origin + '/responses', {method: 'POST'});
  req.on('error', () => {}); req.end('{}');
  await waiting;
  req.destroy();
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(attempts, 1);
  const state = await health();
  assert.equal(state.stats.resourceRetries, 0);
  assert.equal(state.stats.activeRequests, 0);
});

test('oversized error is preserved and interrupted HTTP error retries as transport failure', {timeout: 5000}, async t => {
  const counts = new Map();
  const oversized = JSON.stringify({error: {...JSON.parse(azureError).error, extra: 'x'.repeat(100000)}});
  const {origin, health} = await fixture(t, async (req, res) => {
    req.resume(); counts.set(req.url, (counts.get(req.url) || 0) + 1);
    res.writeHead(400, {'content-type': 'application/json'});
    if (req.url.includes('partial')) {
      res.write(azureError);
      await new Promise(resolve => setTimeout(resolve, 20));
      res.destroy();
    } else res.end(oversized);
  });
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{}'});
  assert.equal(await response.text(), oversized);
  const partial = await fetch(origin + '/responses?partial=1', {method: 'POST', body: '{}'});
  assert.equal(partial.status, 502);
  await partial.text();
  assert.deepEqual([...counts.values()], [1, 11]);
  assert.equal((await health()).stats.resourceRetries, 0);
  assert.equal((await health()).stats.transportRetries, 10);
});

test('retry waits plateau beyond the old five-retry limit and honor server minimums', () => {
  assert.deepEqual(Array.from({length: 5}, (_, i) => retryDelayMs('resource', i, {}, 0, () => 0)),
    [1000, 2000, 4000, 8000, 15000]);
  assert.deepEqual(Array.from({length: 5}, (_, i) => retryDelayMs('rateLimit', i, {}, 0, () => 0)),
    [10000, 20000, 40000, 60000, 60000]);
  assert.equal(retryDelayMs('rateLimit', 0, {'retry-after': '90'}, 0, () => 0.5), 90500);
  assert.equal(retryDelayMs('resource', 0, {'x-ms-retry-after-ms': '15000'}), 15000);
  assert.equal(retryDelayMs('rateLimit', 0, {'retry-after': 'Thu, 22 Oct 2026 07:01:30 GMT'},
    Date.parse('2026-10-22T07:00:00Z'), () => 0), 90000);
  assert.equal(retryDelayMs('rateLimit', 0, {'retry-after': 'invalid'}, 0, () => 0), 10000);
  assert.equal(retryDelayMs('rateLimit', 19, {}, 0, () => 0), 60000);
  assert.equal(retryDelayMs('transport', 9, {}, 0, () => 0), 15000);
  assert.equal(retryDelayMs('availability', 9, {}, 0, () => 0), 60000);
});

test('mixed HTTP throttling and resource rejections preserve the request', async t => {
  const bodies = [];
  const {origin, health} = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks));
    if (bodies.length <= 5) {
      res.writeHead(bodies.length % 2 ? 429 : 400, {'content-type': 'application/json', 'retry-after': '30'});
      res.end(bodies.length % 2 ? rateError : azureError);
    } else { res.writeHead(200, {'content-type': 'application/json'}); res.end('{"ok":true}'); }
  });
  const response = await fetch(origin + '/responses', {method: 'POST', body: JSON.stringify({input: 'keep'})});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true});
  assert.equal(bodies.length, 6);
  for (const body of bodies) assert.deepEqual(body, bodies[0]);
  const state = await health();
  assert.equal(state.stats.resourceRetries, 2);
  assert.equal(state.stats.rateLimitRetries, 3);
  assert.equal(state.stats.resourceRetryAccepted, 1);
  assert.equal(state.stats.rateLimitRetryAccepted, 1);
});

test('HTTP throttling stays invisible through empty progress keepalives', async t => {
  let attempts = 0;
  const {origin} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    if (attempts === 1) { res.writeHead(429, {'content-type': 'application/json'}); res.end(rateError); }
    else { res.writeHead(200, {'content-type': 'text/event-stream'});
      res.end('event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n'); }
  });
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const text = await response.text();
  assert.match(text, /response.in_progress/);
  assert.match(text, /response.completed/);
  assert.doesNotMatch(text, /rate limit|event: error/);
  assert.equal(attempts, 2);
});

function sse(type, value, newline = '\n') {
  return 'event: ' + type + newline + 'data: ' + JSON.stringify({type, ...value}) + newline + newline;
}

test('gzip fragmented SSE resource/rate rejections are intercepted before any model output', async t => {
  let attempts = 0;
  const {origin, health} = await fixture(t, async (req, res) => {
    req.resume(); attempts++;
    let text;
    if (attempts <= 2) {
      const error = JSON.parse(attempts === 1 ? rateError : azureError).error;
      text = sse('response.created', {response: {id: 'failed_' + attempts, output: []}}, '\r\n')
        + sse('response.failed', {response: {error, output: []}}, '\r\n');
    } else text = sse('response.created', {response: {id: 'success', output: []}})
      + sse('response.output_text.delta', {delta: '恢复成功'})
      + sse('response.completed', {response: {output: []}});
    const zipped = zlib.gzipSync(text);
    res.writeHead(200, {'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'content-length': zipped.length});
    res.write(zipped.subarray(0, 25));
    await new Promise(resolve => setTimeout(resolve, 5));
    res.end(zipped.subarray(25));
  });
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), null);
  const text = await response.text();
  assert.match(text, /恢复成功/);
  assert.match(text, /success/);
  assert.doesNotMatch(text, /failed_1|failed_2|rate limit|different Azure|response.failed/);
  assert.equal(attempts, 3);
  const state = await health();
  assert.equal(state.stats.streamRetryErrors, 2);
  assert.equal(state.stats.resourceRetries, 1);
  assert.equal(state.stats.rateLimitRetries, 1);
});

test('errors before the first content event are retried; tool output from failed attempts is discarded', async t => {
  const counts = new Map();
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); counts.set(req.url, (counts.get(req.url) || 0) + 1);
    res.writeHead(200, {'content-type': 'text/event-stream'});
    // A tool item without any delta still belongs to the retryable window.
    res.end(sse('response.created', {response: {output: []}})
      + sse('response.output_item.added', {item: {type: 'function_call', call_id: 'keep'}})
      + (counts.get(req.url) === 1 ? sse('error', JSON.parse(rateError).error)
        : sse('response.completed', {response: {output: []}})));
  });
  const response = await fetch(origin + '/responses?tool=1', {method: 'POST', body: '{"stream":true}'});
  const text = await response.text();
  assert.doesNotMatch(text, /rate limit exceeded/);
  assert.equal(counts.get('/responses?tool=1'), 2);
  assert.equal((text.match(/event: response.output_/g) || []).length, 1);
  assert.equal((await health()).stats.rateLimitRetries, 1);
});

test('quota errors are not retried and streaming exhaustion returns a terminal error', async t => {
  let rateAttempts = 0, quotaAttempts = 0;
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume();
    if (req.url.includes('quota')) {
      quotaAttempts++;
      res.writeHead(429, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: {code: 'insufficient_quota', type: 'rate_limit_error', message: 'Quota exceeded'}}));
    } else {
      rateAttempts++;
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.end(sse('error', JSON.parse(rateError).error));
    }
  });
  const quota = await fetch(origin + '/responses?quota=1', {method: 'POST', body: '{}'});
  assert.equal(quota.status, 429); await quota.text();
  assert.equal(quotaAttempts, 1);
  const rate = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  assert.equal(rate.status, 200);
  const text = await rate.text();
  assert.equal((text.match(/event: error/g) || []).length, 1);
  assert.equal(rateAttempts, 21);
  const state = await health();
  assert.equal(state.stats.rateLimitRetries, 20);
  assert.equal(state.stats.rateLimitRetryExhausted, 1);
  assert.equal(state.stats.activeRequests, 0);
});

test('server delay beyond total deadline is never shortened into an early retry', async t => {
  let attempts = 0;
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(429, {'content-type': 'application/json', 'retry-after': '2000'}); res.end(rateError);
  }, () => {}, {retryDelay: retryDelayMs});
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{}'});
  assert.equal(response.status, 429); await response.text();
  assert.equal(attempts, 1);
  assert.equal((await health()).stats.rateLimitRetryExhausted, 1);
});

test('HTTP retry exhaustion after heartbeat uses a valid Responses error event', async t => {
  let attempts = 0;
  const {origin} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(429, {'content-type': 'application/json'}); res.end(rateError);
  });
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  const text = await response.text();
  assert.equal(attempts, 21);
  const errors = text.split('\n').filter(x => x.startsWith('data:')).map(x => JSON.parse(x.slice(5))).filter(x => x.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, 'error');
  assert.equal(errors[0].code, 'rate_limit_exceeded');
});

test('failed response output is discarded and never delivered to client tools', async t => {
  let attempts = 0;
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end(sse('response.failed', {response: {error: JSON.parse(rateError).error,
      output: [{type: 'function_call', call_id: 'already_executed'}]}}));
  });
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  assert.doesNotMatch(await response.text(), /already_executed/);
  assert.equal(attempts, 21);
  assert.equal((await health()).stats.rateLimitRetries, 20);
});

test('stream closes after buffered reasoning and tools, then recovers without failed output', async t => {
  let attempts = 0;
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (attempts === 1) {
      res.end(sse('response.output_item.added', {item: {type: 'reasoning', summary: []}})
        + sse('response.output_item.done', {item: {type: 'function_call', call_id: 'discard_failed_tool'}}));
    } else res.end(sse('response.output_text.delta', {delta: 'only_success'})
      + sse('response.completed', {response: {output: []}}));
  });
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  const text = await response.text();
  assert.match(text, /only_success/);
  assert.doesNotMatch(text, /discard_failed_tool|reasoning|event: error/);
  assert.equal(attempts, 2);
  assert.equal((await health()).stats.transportRetries, 1);
});

test('upstream idle timeout retries and total deadline ends waiting with zero active requests', async t => {
  let attempts = 0;
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    if (attempts === 1) { res.writeHead(200, {'content-type': 'text/event-stream'}); res.flushHeaders(); }
    else res.end(sse('response.completed', {response: {output: []}}));
  }, () => {}, {idleTimeoutMs: 40, heartbeatMs: 5});
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  assert.match(await response.text(), /response.completed/);
  assert.equal(attempts, 2);
  assert.equal((await health()).stats.transportRetries, 1);
  const hung = await fixture(t, (req, res) => { req.resume(); }, () => {},
    {deadlineMs: 60, idleTimeoutMs: 1000, heartbeatMs: 5});
  const timeout = await fetch(hung.origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  const text = await timeout.text();
  assert.match(text, /event: error/);
  assert.equal((text.match(/event: error/g) || []).length, 1);
  assert.equal((await hung.health()).stats.activeRequests, 0);
});

test('request log IDs expose the active classified policy and final exhaustion', async t => {
  const rows = [];
  const {origin} = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(429, {'content-type': 'application/json'}); res.end(rateError);
  }, (event, data) => rows.push({event, ...data}));
  await (await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'})).text();
  const ids = new Set(rows.filter(x => x.requestId !== undefined).map(x => x.requestId));
  assert.equal(ids.size, 1);
  assert.equal(rows.filter(x => x.event === 'retry-dispatched').length, 20);
  assert.ok(rows.some(x => x.event === 'request-started' && x.maxRetries === 20
    && x.deadlineMs === 1800000 && x.retryLimits.rateLimit === 20));
  assert.ok(rows.some(x => x.event === 'retry-exhausted' && x.errorCode === 'rate_limit'
    && x.maxRetries === 20 && x.kindRetries === 20 && x.maxKindRetries === 20));
  assert.ok(rows.some(x => x.event === 'request-finished' && x.outcome === 'failed'));
});

test('HTTP 503 no available channel and SSE failure retry invisibly with a shared budget', async t => {
  let attempts = 0;
  const rows = [];
  const unavailable = {error: {type: 'invalid_request_error', code: 'cc_switch_upstream_error',
    message: 'CC Switch local proxy failed: 上游错误 (503): {"error":{"message":"分组 azure-test 下模型 offline-mock 无可用渠道（distributor）","type":"server_error"}}'}};
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    if (attempts === 1) {
      res.writeHead(503, {'content-type': 'application/json', 'content-encoding': 'gzip'});
      res.end(zlib.gzipSync(JSON.stringify(unavailable)));
    } else {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.end(attempts === 2 ? sse('error', {code: 'no_available_channel', message: 'No available channels'})
        : sse('response.completed', {response: {output: []}}));
    }
  }, (event, data) => rows.push({event, ...data}));
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  const text = await response.text();
  assert.match(text, /response.completed/);
  assert.doesNotMatch(text, /event: error|无可用渠道|no_available_channel/);
  assert.equal(attempts, 3);
  const state = (await health()).stats;
  assert.equal(state.availabilityRetries, 2);
  assert.equal(state.availabilityRetryAccepted, 1);
  assert.equal(state.streamRetryErrors, 1);
  assert.ok(rows.some(x => x.event === 'http-error' && x.errorCode === 'no_available_channel'));
  assert.ok(rows.some(x => x.event === 'request-finished' && x.outcome === 'success'));
  assert.deepEqual(Array.from({length: 5}, (_, i) => retryDelayMs('availability', i, {}, 0, () => 0)),
    [5000, 10000, 20000, 30000, 60000]);
  assert.equal(retryDelayMs('availability', 0, {'retry-after': '80'}, 0, () => 0), 80000);
});

test('persistent unavailable channel exhausts ten retries; quota, auth, and unrelated 503 do not retry', async t => {
  const counts = new Map();
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); counts.set(req.url, (counts.get(req.url) || 0) + 1);
    const quota = req.url.includes('quota'), auth = req.url.includes('auth'), unrelated = req.url.includes('other');
    res.writeHead(auth ? 401 : 503, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: {code: quota ? 'insufficient_quota' : auth ? 'invalid_api_key' : 'server_error',
      message: quota ? 'No available channels: quota exhausted' : unrelated ? 'Internal server error' : 'No available channels'}}));
  });
  for (const route of ['/responses?quota', '/responses?auth']) {
    await (await fetch(origin + route, {method: 'POST', body: '{}'})).text();
    assert.equal(counts.get(route), 1);
  }
  // Unknown 503 bodies are generic transport failures and retry to exhaustion.
  await (await fetch(origin + '/responses?other', {method: 'POST', body: '{}'})).text();
  assert.equal(counts.get('/responses?other'), 11);
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  const text = await response.text();
  assert.equal((text.match(/event: error/g) || []).length, 1);
  assert.equal(counts.get('/responses'), 11);
  const stats = (await health()).stats;
  assert.equal(stats.availabilityRetries, 10);
  assert.equal(stats.availabilityRetryExhausted, 1);
  assert.equal(stats.activeRequests, 0);
});

test('extended SSE rate-limit recovery stays invisible beyond five retries', async t => {
  let attempts = 0;
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end(attempts <= 8
      ? sse('response.output_item.added', {item: {type: 'function_call', call_id: 'discard_' + attempts}})
        + sse('error', JSON.parse(rateError).error)
      : sse('response.output_text.delta', {delta: 'recovered_after_eight'})
        + sse('response.completed', {response: {output: []}}));
  });
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /response.in_progress/);
  assert.match(text, /recovered_after_eight/);
  assert.match(text, /response.completed/);
  assert.doesNotMatch(text, /discard_|event: error|rate_limit|response.failed/);
  assert.equal(attempts, 9);
  const state = await health();
  assert.equal(state.filterVersion, 11);
  assert.equal(state.retryPolicy.maxRetries, 20);
  assert.equal(state.stats.rateLimitRetries, 8);
  assert.equal(state.stats.rateLimitRetryAccepted, 1);
});

test('mixed failures retain per-kind backoff and cannot multiply the total budget', async t => {
  let attempts = 0;
  const waits = [], rows = [];
  const {origin, health} = await fixture(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(200, {'content-type': 'text/event-stream'});
    const error = attempts <= 5 ? JSON.parse(azureError).error
      : attempts <= 15 ? {code: 'no_available_channel', message: 'No available channels'}
      : attempts <= 20 ? JSON.parse(rateError).error
      : {code: 'stream_incomplete', message: 'Stream disconnected before completion'};
    res.end(sse('error', error));
  }, (event, data) => rows.push({event, ...data}), {
    retryDelay: (kind, index) => { waits.push({kind, index}); return 10; }
  });
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  const text = await response.text();
  assert.equal((text.match(/event: error/g) || []).length, 1);
  assert.equal(attempts, 21);
  assert.deepEqual(waits.filter(x => x.kind === 'availability').map(x => x.index),
    Array.from({length: 10}, (_, i) => i));
  assert.deepEqual(waits.filter(x => x.kind === 'rateLimit').map(x => x.index), [0, 1, 2, 3, 4]);
  const stats = (await health()).stats;
  assert.equal(stats.resourceRetries + stats.availabilityRetries + stats.rateLimitRetries + stats.transportRetries, 20);
  assert.equal(stats.transportRetries, 0);
  assert.ok(rows.some(x => x.event === 'retry-exhausted' && x.retries === 20 && x.kindRetries === 0));
});

test('lazy history forwards unchanged codex requests byte-for-byte', async t => {
  const bodies = [];
  const {origin, health} = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks));
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end(sse('response.completed', {response: {output: [], usage: {
      input_tokens: 120, output_tokens: 45, input_tokens_details: {cached_tokens: 100}}}}));
  });
  // Codex itself always sends store:false plus include reasoning.encrypted_content.
  const original = JSON.stringify({model: 'gpt-test', store: false, stream: true,
    include: ['reasoning.encrypted_content'],
    input: [
      {type: 'message', id: 'msg_1', role: 'user', content: 'hi'},
      {type: 'reasoning', id: 'rs_1', encrypted_content: 'cipher', summary: []},
      {type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{}'}
    ]});
  const response = await fetch(origin + '/responses', {method: 'POST', body: original});
  assert.equal(response.status, 200);
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].equals(Buffer.from(original)));
  const state = await health();
  assert.equal(state.stats.reasoningKept, 1);
  assert.equal(state.stats.removedReasoningItems, 0);
  assert.equal(state.stats.removedItemIds, 0);
});

test('streamed completion survives arbitrary UTF-8 and SSE chunk boundaries', async t => {
  const events = [];
  const delta = sse('response.output_text.delta', {delta: '开始'});
  // A named SSE event is sufficient; data.type is optional.
  const terminal = 'event: response.completed\r\ndata: ' + JSON.stringify({response: {
    output: [{type: 'message', content: '结束'}], usage: {input_tokens: 9, output_tokens: 4}
  }}) + '\r\n\r\n';
  const {origin} = await fixture(t, async (req, res) => {
    req.resume();
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write(delta);
    await new Promise(resolve => setTimeout(resolve, 5));
    const bytes = Buffer.from(terminal);
    for (let offset = 0; offset < bytes.length; offset += 3) {
      res.write(bytes.subarray(offset, offset + 3));
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    res.end();
  }, () => {}, {recorder: {observe: (event, data) => events.push({event, ...data})}});
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"store":false,"stream":true}'});
  assert.equal(await response.text(), delta + terminal);
  assert.equal(events.filter(row => row.event === 'response-usage').length, 1);
  assert.deepEqual(events.find(row => row.event === 'response-usage').usage, {input_tokens: 9, output_tokens: 4});
  assert.equal(events.find(row => row.event === 'request-finished').outcome, 'success');
});

test('ordinary delta text cannot impersonate a terminal event or cause replay', async t => {
  let attempts = 0;
  const events = [];
  const {origin} = await fixture(t, async (req, res) => {
    req.resume(); attempts++;
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write(sse('response.output_text.delta', {delta: 'first'}));
    await new Promise(resolve => setTimeout(resolve, 5));
    res.end(sse('response.output_text.delta', {delta: 'literal response.completed here'})
      + sse('response.output_item.done', {item: {type: 'function_call', call_id: 'only_once'}}));
  }, () => {}, {recorder: {observe: (event, data) => events.push({event, ...data})}});
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  const text = await response.text();
  assert.equal((text.match(/only_once/g) || []).length, 1);
  assert.equal(attempts, 1);
  assert.equal(events.filter(row => row.event === 'response-usage').length, 0);
  assert.equal(events.find(row => row.event === 'request-finished').outcome, 'failed');
});

test('untyped SSE data is ignored and a same-chunk named completion is recognized', async t => {
  const events = [];
  const {origin} = await fixture(t, (req, res) => {
    req.resume();
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end('data: {}\n\ndata: null\n\ndata: 7\n\ndata: {"type":7}\n\n'
      + sse('response.output_text.delta', {delta: 'valid'})
      + 'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1,"output_tokens":2}}}\n\n');
  }, () => {}, {recorder: {observe: (event, data) => events.push({event, ...data})}});
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  assert.match(await response.text(), /valid/);
  assert.equal(events.find(row => row.event === 'request-finished').outcome, 'success');
  assert.equal(events.filter(row => row.event === 'response-usage').length, 1);
});

test('completion without deltas records forwarding and usage exactly once', async t => {
  const events = [];
  const {origin} = await fixture(t, (req, res) => {
    req.resume();
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end(sse('response.completed', {response: {output: [], usage: {input_tokens: 2, output_tokens: 0}}}));
  }, () => {}, {recorder: {observe: (event, data) => events.push({event, ...data})}});
  await (await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'})).text();
  assert.equal(events.filter(row => row.event === 'forwarded').length, 1);
  assert.equal(events.filter(row => row.event === 'response-usage').length, 1);
  assert.equal(events.find(row => row.event === 'request-finished').outcome, 'success');
});

test('HTTP authentication status and either business error field prevent retries', async t => {
  const counts = new Map();
  const cases = [
    {status: 401, error: {code: 'server_error', message: 'Unauthorized'}},
    {status: 403, error: {code: 'cc_switch_forward_failed', message: 'Forbidden'}},
    {status: 502, error: {code: 'server_error', type: 'authentication_error', message: 'Denied'}},
    {status: 503, error: {code: 'server_error', type: 'insufficient_quota', message: 'Exhausted'}}
  ];
  const {origin} = await fixture(t, (req, res) => {
    req.resume(); counts.set(req.url, (counts.get(req.url) || 0) + 1);
    const selected = cases[Number(req.url.split('=')[1])];
    res.writeHead(selected.status, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: selected.error}));
  });
  for (let index = 0; index < cases.length; index++) {
    const route = '/responses?case=' + index;
    const response = await fetch(origin + route, {method: 'POST', body: '{}'});
    assert.equal(response.status, cases[index].status);
    await response.text();
    assert.equal(counts.get(route), 1);
  }
});

test('SSE event names cannot overwrite top-level authentication or quota classifications', async t => {
  const cases = [
    {event: 'error', detail: {code: 'server_error', type: 'authentication_error', message: 'Unauthorized'}},
    {event: 'response.failed', detail: {code: 'invalid_api_key', message: 'Unauthorized'}},
    {event: 'response.failed', detail: {code: 'server_error', type: 'authentication_error', message: 'Unauthorized'}},
    {event: 'error', detail: {code: 'server_error', type: 'insufficient_quota', message: 'Exhausted'}}
  ];
  const counts = new Map(), events = [];
  const {origin} = await fixture(t, (req, res) => {
    req.resume(); counts.set(req.url, (counts.get(req.url) || 0) + 1);
    const url = new URL(req.url, 'http://local');
    const selected = cases[Number(url.searchParams.get('case'))];
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (url.searchParams.has('after')) res.write(sse('response.output_text.delta', {delta: 'already delivered'}));
    res.end('event: ' + selected.event + '\ndata: ' + JSON.stringify(selected.detail) + '\n\n');
  }, (event, data) => events.push({event, ...data}));
  for (const after of [false, true]) {
    for (let index = 0; index < cases.length; index++) {
      const route = '/responses?case=' + index + (after ? '&after=1' : '');
      const response = await fetch(origin + route, {method: 'POST', body: '{"stream":true}'});
      await response.text();
      assert.equal(counts.get(route), 1, route);
    }
  }
  assert.equal(events.filter(row => row.event === 'retry-scheduled').length, 0);
  assert.equal(events.filter(row => row.event === 'stream-error' && row.kind !== 'other').length, 0);
});

test('dashboard pushes fresh snapshots while the recorder version is unchanged', {timeout: 5000}, async t => {
  let snapshots = 0;
  const {origin} = await fixture(t, (req, res) => { req.resume(); res.end(); }, () => {}, {
    token: 'offline-control-token', recorder: {snapshot: () => ({version: 1, samples: ++snapshots})}
  });
  const controller = new AbortController();
  try {
    const response = await fetch(origin + ADMIN + '/ui/stream', {
      headers: {'x-filter-token': 'offline-control-token'}, signal: controller.signal
    });
    const reader = response.body.getReader();
    let received = '';
    while ((received.match(/event: snapshot/g) || []).length < 2) {
      const next = await reader.read();
      assert.equal(next.done, false);
      received += Buffer.from(next.value).toString();
    }
    assert.match(received, /"samples":1/);
    assert.match(received, /"samples":2/);
  } finally { controller.abort(); }
});
