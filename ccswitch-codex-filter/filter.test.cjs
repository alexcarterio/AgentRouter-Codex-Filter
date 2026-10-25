'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const {once} = require('node:events');
const {spawn} = require('node:child_process');
const {makeProxy, filterResponsesRequest, localOrigin, ADMIN} = require('./proxy.cjs');
const {ConfigRouter, providerBase} = require('./config.cjs');
const {start, stop, status, parseArgs, pruneLog} = require('./filter.cjs');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
function call(origin, route, {body, headers = {}, method = 'POST'} = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(origin + route, {method, headers}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}));
    });
    request.setTimeout(5000, () => request.destroy(new Error('test request timeout')));
    request.on('error', reject);
    request.end(body);
  });
}
function fixture(t) {
  const root = path.join(__dirname, '.runtime');
  fs.mkdirSync(root, {recursive: true});
  const directory = fs.mkdtempSync(path.join(root, 'test-'));
  t.after(() => {
    // Only remove the temporary directory this test created under the workspace.
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(root));
    assert.match(path.basename(directory), /^test-/);
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return directory;
}
const sample = {
  model: 'mock-model', store: true, stream: true, reasoning: {effort: 'xhigh', summary: 'auto'},
  include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
  input: [
    {role: 'user', content: [{type: 'input_text', text: '你好'}, {type: 'input_image', image_url: 'data:image/png;base64,AAAA'}]},
    {type: 'reasoning', id: 'rs_old', encrypted_content: 'foreign-account-ciphertext', summary: []},
    {type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"x":1}'},
    {type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'result'},
    {type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_2', name: 'exec', input: 'a'},
    {type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_2', output: 'ok'},
    {type: 'message', id: 'msg_old', role: 'assistant', phase: 'final_answer',
      content: [{type: 'output_text', text: 'done', annotations: [{type: 'file_citation', file_id: 'file_keep', index: 0, filename: 'evidence.txt'}]}]}
  ]
};

test('removes historical reasoning while preserving tools, images, effort, and original input', () => {
  const snapshot = JSON.stringify(sample);
  const result = filterResponsesRequest(sample);
  assert.equal(result.removed, 1);
  assert.equal(result.removedItemIds, 5);
  assert.equal(result.body.store, false);
  assert.deepEqual(result.body.include, ['message.output_text.logprobs']);
  assert.deepEqual(result.body.input, [
    sample.input[0],
    {type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"x":1}'},
    {type: 'function_call_output', call_id: 'call_1', output: 'result'},
    {type: 'custom_tool_call', call_id: 'call_2', name: 'exec', input: 'a'},
    {type: 'custom_tool_call_output', call_id: 'call_2', output: 'ok'},
    {type: 'message', role: 'assistant', phase: 'final_answer', content: sample.input[6].content}
  ]);
  assert.deepEqual(result.body.reasoning, sample.reasoning);
  assert.equal(JSON.stringify(sample), snapshot);
  assert.deepEqual(filterResponsesRequest({input: 'hello'}).body, {input: 'hello', store: false});
});

test('strips only optional history item IDs, keeping call IDs and resource references', () => {
  const input = [
    {id: 'msg_shorthand', role: 'user', content: [{type: 'input_file', file_id: 'file_keep'}]},
    {type: 'function_call', id: 'fc_outer', call_id: 'call_keep', name: 'lookup', arguments: '{"id":"business_1"}'},
    {type: 'function_call_output', id: 'fco_outer', call_id: 'call_keep', output: [{type: 'input_text', text: '{"id":"business_2"}'}]},
    {type: 'file_search_call', id: 'fs_required', status: 'completed', queries: ['test'], results: []},
    {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'ok'}]}
  ];
  const result = filterResponsesRequest({input});
  assert.equal(result.removedItemIds, 3);
  assert.equal(result.body.input[0].id, undefined);
  assert.equal(result.body.input[0].content[0].file_id, 'file_keep');
  assert.equal(result.body.input[1].call_id, result.body.input[2].call_id);
  assert.equal(result.body.input[1].arguments, input[1].arguments);
  assert.deepEqual(result.body.input[2].output, input[2].output);
  assert.deepEqual(result.body.input.slice(3), input.slice(3));
  assert.equal(input[0].id, 'msg_shorthand');
  assert.equal(filterResponsesRequest(result.body).removedItemIds, 0);
});

test('upstream accepts replayed history with no resource-bound item IDs and intact tool pairs', async t => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks));
    const foreign = received.input.some(item => item.id !== undefined || item.type === 'reasoning');
    const tools = received.input.filter(item => item.call_id);
    const paired = tools.length === 4 && tools[0].call_id === tools[1].call_id && tools[2].call_id === tools[3].call_id;
    res.writeHead(foreign || !paired ? 400 : 200, {'content-type': 'application/json'});
    res.end(JSON.stringify(foreign ? {error: 'The requested item was created under a different resource.'} : {paired}));
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const body = JSON.stringify(sample);
  assert.equal((await call(upstreamOrigin, '/responses', {body})).status, 400);
  const result = await call(origin, '/responses', {body});
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).paired, true);
  assert.equal(received.input.at(-1).content[0].annotations[0].file_id, 'file_keep');
});
test('fails explicitly on cross-account references and compaction', () => {
  for (const body of [
    {previous_response_id: 'resp_old'}, {conversation: {id: 'conv_old'}},
    {input: [{type: 'compaction', encrypted_content: 'x'}]}, {input: [{type: 'item_reference', id: 'old'}]},
    {input: [{type: 'new_opaque_type', encrypted_content: 'x'}]}, {context_management: [{type: 'compaction'}]}
  ]) assert.throws(() => filterResponsesRequest(body), /text summary/);
  for (const body of [null, [], {include: 'x'}, {input: {type: 'message'}}]) {
    assert.throws(() => filterResponsesRequest(body));
  }
  assert.throws(() => localOrigin('https://example.com'));
  assert.throws(() => localOrigin('http://127.0.0.1:15721/v1'));
});
test('HTTP filtering handles all compressed forms and preserves authorization, path and errors', {timeout: 15000}, async t => {
  const captured = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured.push({path: req.url, headers: req.headers, body: Buffer.concat(chunks)});
    res.writeHead(req.url.includes('quota') ? 429 : 200, {'content-type': 'application/json', 'x-test': 'unchanged'});
    res.end('{"from":"upstream"}');
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const raw = Buffer.from(JSON.stringify(sample));
  for (const [encoding, body] of [
    ['identity', raw], ['gzip', zlib.gzipSync(raw)], ['deflate', zlib.deflateSync(raw)],
    ['br', zlib.brotliCompressSync(raw)], ['zstd', zlib.zstdCompressSync(raw)]
  ]) {
    const result = await call(origin, '/v1/responses?mode=quota', {body, headers: {
      'content-encoding': encoding, 'content-length': String(body.length), authorization: 'Bearer mock-secret',
      'x-session-id': 'session-1', connection: 'x-hop', 'x-hop': 'remove'
    }});
    assert.equal(result.status, 429);
    assert.equal(result.headers['x-test'], 'unchanged');
    const received = captured.at(-1);
    assert.equal(received.path, '/v1/responses?mode=quota');
    assert.equal(received.headers.authorization, 'Bearer mock-secret');
    assert.equal(received.headers['x-session-id'], 'session-1');
    assert.equal(received.headers['x-hop'], undefined);
    assert.equal(received.headers['content-encoding'], undefined);
    assert.equal(Number(received.headers['content-length']), received.body.length);
    assert.deepEqual(JSON.parse(received.body), filterResponsesRequest(sample).body);
  }
  await call(origin, '/responses/', {body: raw});
  await call(origin, '/api/codex/v1/responses', {body: raw});
  assert.deepEqual(JSON.parse(captured.at(-1).body), filterResponsesRequest(sample).body);
  const health = JSON.parse((await call(origin, ADMIN + '/health', {method: 'GET'})).body);
  assert.equal(health.stats.filteredRequests, 7);
  assert.equal(health.stats.removedReasoningItems, 7);
  assert.equal(health.filterVersion, 10);
  assert.equal(health.stats.removedItemIds, 35);
  assert.equal(health.stats.upstreamHttpErrors, 5);
  assert.equal(health.stats.lastUpstreamStatus, 200);
  assert.ok(Number.isFinite(Date.parse(health.stats.lastFilteredAt)));
  const previousCount = captured.length;
  for (const [route, body, expected] of [
    ['/v1/responses', '{', 400],
    ['/v1/responses/compact', '{}', 409],
    ['/responses', '{"previous_response_id":"x"}', 400],
    ['/v1/responses', '{"input":[{"type":"compaction"}]}', 400]
  ]) assert.equal((await call(origin, route, {body})).status, expected);
  assert.equal((await call(origin, '/responses', {body: raw, headers: {origin: 'http://example.com'}})).status, 403);
  assert.equal(captured.length, previousCount);
  assert.equal((await call(origin, ADMIN + '/stop', {body: '{}'})).status, 403);
  await call(origin, '/models', {method: 'GET'});
  assert.equal(captured.at(-1).path, '/models');
});
test('SSE keepalive arrives before completion while model output is buffered; cancel closes upstream', {timeout: 10000}, async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  let disconnected;
  const canceled = new Promise(resolve => { disconnected = resolve; });
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('event: response.output_text.delta\ndata: {"delta":"first"}\n\n');
    if (req.url.includes('cancel')) res.on('close', disconnected);
    else { await gate; res.end('event: response.completed\ndata: {"done":true}\n\n'); }
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, heartbeatMs: 10});
  const origin = await listen(proxy);
  t.after(async () => { finish(); await close(proxy); await close(upstream); });
  await new Promise((resolve, reject) => {
    const req = http.request(origin + '/responses', {method: 'POST'}, res => {
      let received = '', released = false;
      res.on('data', chunk => {
        received += chunk;
        if (!released && received.includes('response.in_progress')) {
          assert.doesNotMatch(received, /"first"/);
          released = true;
          finish();
        }
      });
      res.on('end', () => {
        try { assert.match(received, /response.completed/); resolve(); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(sample));
  });
  await new Promise((resolve, reject) => {
    const req = http.request(origin + '/responses?cancel=1', {method: 'POST'}, res => {
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.on('error', reject);
    req.end(JSON.stringify(sample));
  });
  await canceled;
});
test('size limit, upstream offline, proxy loops and WebSocket fail explicitly', {timeout: 10000}, async t => {
  const unused = http.createServer();
  const unavailableOrigin = await listen(unused);
  await close(unused);
  const proxy = makeProxy({getUpstream: () => unavailableOrigin, limit: 32, retryDelay: () => 10});
  const origin = await listen(proxy);
  t.after(() => close(proxy));
  assert.equal((await call(origin, '/responses', {body: 'x'.repeat(100)})).status, 413);
  assert.equal((await call(origin, '/responses', {body: '{}'})).status, 502);
  const expanded = zlib.gzipSync(Buffer.from('x'.repeat(1000)));
  assert.equal((await call(origin, '/responses', {body: expanded, headers: {'content-encoding': 'gzip'}})).status, 413);
  const loop = makeProxy({getUpstream: () => loopOrigin});
  const loopOrigin = await listen(loop);
  t.after(() => close(loop));
  assert.equal((await call(loopOrigin, '/responses', {body: '{}'})).status, 503);
  const handshake = await new Promise((resolve, reject) => {
    const socket = net.connect(proxy.address().port, '127.0.0.1');
    let data = '';
    socket.on('connect', () => socket.write('GET /responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(handshake, /^HTTP\/1.1 426 Upgrade Required\r\n/);
});
test('configuration attach/restore preserves BOM, CRLF, comments and unrelated providers', t => {
  const directory = fixture(t);
  const configPath = path.join(directory, 'config.toml');
  const backupPath = path.join(directory, 'routes.json');
  const original = '\uFEFFmodel_provider = "custom"\r\nmodel = "example"\r\n'
    + '[model_providers.other]\r\nbase_url = \'http://127.0.0.1:15721/v1\' # keep\r\n'
    + '[model_providers."custom"]\r\nbase_url = \'http://127.0.0.1:15721/v1\' # keep\r\nwire_api = "responses"\r\n';
  fs.writeFileSync(configPath, original);
  const options = {configPath, backupPath, filterOrigin: 'http://127.0.0.1:18181', getUpstream: () => 'http://127.0.0.1:15721'};
  const router = new ConfigRouter(options);
  router.sync();
  const attached = fs.readFileSync(configPath, 'utf8');
  assert.equal(providerBase(attached).url, 'http://127.0.0.1:18181/v1');
  assert.equal(providerBase(attached, 'other').url, 'http://127.0.0.1:15721/v1');
  assert.equal(router.state, 'filtering');
  router.sync();
  assert.equal(fs.readFileSync(configPath, 'utf8'), attached);
  new ConfigRouter(options).restore(); // Recovers even after the original process is lost.
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  router.sync();
  fs.appendFileSync(configPath, '# user edit\r\n');
  router.restore();
  assert.equal(fs.readFileSync(configPath, 'utf8'), original + '# user edit\r\n');
  router.sync();
  fs.writeFileSync(configPath, original.replaceAll('http://127.0.0.1:15721/v1', 'https://provider.example/v1'));
  const direct = fs.readFileSync(configPath, 'utf8');
  router.sync();
  assert.equal(router.state, 'waiting-for-ccswitch');
  router.restore();
  assert.equal(fs.readFileSync(configPath, 'utf8'), direct);
});
test('CC Switch rewrites are reattached; unsupported config and missing backup do not get overwritten', t => {
  const directory = fixture(t), configPath = path.join(directory, 'config.toml');
  const options = {configPath, backupPath: path.join(directory, 'routes.json'),
    filterOrigin: 'http://127.0.0.1:18181', getUpstream: () => 'http://127.0.0.1:15721'};
  const router = new ConfigRouter(options);
  const original = 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "http://127.0.0.1:15721/v1"\n';
  fs.writeFileSync(configPath, original);
  router.sync();
  fs.writeFileSync(configPath, original + '# new provider choice\n');
  router.sync();
  assert.equal(providerBase(fs.readFileSync(configPath, 'utf8')).url, 'http://127.0.0.1:18181/v1');
  router.restore();
  assert.equal(fs.readFileSync(configPath, 'utf8'), original + '# new provider choice\n');
  fs.writeFileSync(configPath, original.replace('15721', '18181'));
  assert.throws(() => new ConfigRouter({...options, backupPath: path.join(directory, 'missing.json')}).sync(), /backup/);
  const duplicate = original + 'base_url = "http://127.0.0.1:15721/v1"\n';
  fs.writeFileSync(configPath, duplicate);
  assert.throws(() => router.sync(), /Duplicate/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), duplicate);
});
test('background start/status/idempotent start/stop and offline recovery', {timeout: 25000}, async t => {
  const directory = fixture(t);
  const upstream = http.createServer((req, res) => { req.resume(); res.end('{}'); });
  const upstreamOrigin = await listen(upstream);
  const reservation = http.createServer();
  const filterOrigin = await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);
  const configPath = path.join(directory, 'config.toml');
  const original = 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "' + upstreamOrigin + '/v1"\nwire_api = "responses"\n';
  fs.writeFileSync(configPath, original);
  const options = parseArgs(['start', '--port', String(port), '--upstream', upstreamOrigin, '--config', configPath, '--runtime', path.join(directory, 'runtime')]);
  t.after(async () => { await stop(options); await close(upstream); });
  const first = await start(options);
  assert.equal(first.running, true);
  assert.equal(first.state, 'filtering');
  assert.equal(first.ccSwitchReachable, true);
  assert.equal(providerBase(fs.readFileSync(configPath, 'utf8')).url, filterOrigin + '/v1');
  assert.equal((await start(options)).pid, first.pid);
  await call(filterOrigin, '/responses', {body: JSON.stringify(sample)});
  assert.equal((await status(options)).stats.removedReasoningItems, 1);
  assert.equal((await status(options)).stats.removedItemIds, 5);
  assert.equal((await stop(options)).restored, true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal((await status(options)).running, false);
  // Emulate an abrupt exit after config rewrite, with no server or live state file.
  fs.writeFileSync(configPath, original.replace(upstreamOrigin, filterOrigin));
  assert.equal((await stop(options)).restored, true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

test('live logs follow real request outcomes without printing bodies or credentials', {timeout: 5000}, async t => {
  const directory = fixture(t), filename = path.join(directory, 'filter.log');
  fs.writeFileSync(filename, JSON.stringify({time: new Date().toISOString(), event: 'request-finished',
    requestId: 999, outcome: 'success', durationMs: 1}) + '\n');
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    req.resume(); attempts++;
    if (attempts === 1) {
      res.writeHead(429, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: {code: 'rate_limit_exceeded', message: 'exceeded token rate limit'}}));
    } else {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.end('event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
    }
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, retryDelay: () => 10,
    log: (event, data) => fs.appendFileSync(filename, JSON.stringify({time: new Date().toISOString(), event, ...data}) + '\n')});
  const origin = await listen(proxy);
  const child = spawn(process.execPath, [path.join(__dirname, 'filter.cjs'), 'logs', '--runtime', directory],
    {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; }); child.stderr.resume();
  t.after(async () => { child.kill(); await close(proxy); await close(upstream); });
  const readyBy = Date.now() + 1500;
  while (!text.includes('仅显示本窗口打开后的新日志') && Date.now() < readyBy) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(text, /仅显示本窗口打开后的新日志/);
  await call(origin, '/responses', {body: JSON.stringify({stream: true, input: 'do_not_log_body'}),
    headers: {authorization: 'Bearer do_not_log_credential'}});
  const deadline = Date.now() + 2500;
  while (!text.includes('[#1] SUCCESS duration=') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(text, /\[#1\] FAIL rate_limit/);
  assert.match(text, /\[#1\] WAIT rate_limit retry=1\/20/);
  assert.match(text, /\[#1\] SUCCESS duration=/);
  // Replace the file as retention does, retaining already observed rows.
  const rotated = filename + '.tmp';
  fs.writeFileSync(rotated, fs.readFileSync(filename, 'utf8') + JSON.stringify({time: new Date().toISOString(),
    event: 'request-finished', requestId: 2, outcome: 'success', durationMs: 2}) + '\n');
  fs.renameSync(rotated, filename);
  const rotatedBy = Date.now() + 1200;
  while (!text.includes('[#2] SUCCESS') && Date.now() < rotatedBy) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(text, /\[#2\] SUCCESS/);
  assert.equal(text.match(/\[#1\] SUCCESS/g).length, 1);
  assert.doesNotMatch(text, /\[#999\]/);
  assert.doesNotMatch(text, /do_not_log_body|do_not_log_credential/);
});

test('raw logs expire after 24 hours and keep newest complete entries within the byte limit', t => {
  const directory = fixture(t), filename = path.join(directory, 'filter.log');
  const now = Date.now();
  const row = (age, requestId) => JSON.stringify({time: new Date(now - age).toISOString(), event: 'filtered', requestId}) + '\n';
  const old = row(24 * 60 * 60 * 1000 + 1, 1), boundary = row(24 * 60 * 60 * 1000, 2), recent = row(0, 3);
  fs.writeFileSync(filename, old + boundary + recent);
  pruneLog(filename, now);
  assert.equal(fs.readFileSync(filename, 'utf8'), boundary + recent);
  pruneLog(filename, now, Buffer.byteLength(recent));
  assert.equal(fs.readFileSync(filename, 'utf8'), recent);
  assert.ok(fs.statSync(filename).size <= Buffer.byteLength(recent));
  pruneLog(filename, now + 24 * 60 * 60 * 1000 + 1);
  assert.equal(fs.statSync(filename).size, 0);
  assert.equal(fs.existsSync(filename + '.tmp'), false);
});
