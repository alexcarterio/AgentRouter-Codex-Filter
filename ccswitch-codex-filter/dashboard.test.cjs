'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const {once} = require('node:events');
const {makeProxy, ADMIN} = require('./proxy.cjs');
const {Recorder} = require('./metrics.cjs');
const DASHBOARD_HTML = require('./dashboard.cjs');

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

test('recorder aggregates a request lifecycle into classified totals', () => {
  const recorder = new Recorder();
  recorder.observe('request-started', {requestId: 1, model: 'gpt-test', streaming: true, requestBytes: 10});
  recorder.observe('filtered', {requestId: 1, kept: 2, removed: 0, removedItemIds: 0});
  recorder.observe('retry-scheduled', {requestId: 1, kind: 'rateLimit', delayMs: 5000});
  recorder.observe('retry-dispatched', {requestId: 1, kind: 'rateLimit'});
  recorder.observe('forwarded', {requestId: 1, ttfbMs: 7500, status: 200, streaming: true});
  recorder.observe('response-usage', {requestId: 1, usage: {input_tokens: 10, output_tokens: 5,
    input_tokens_details: {cached_tokens: 4}}});
  recorder.observe('http-error', {requestId: 1, status: 429, kind: 'rateLimit', errorCode: 'rate_limit'});
  recorder.observe('retry-accepted', {requestId: 1, retries: 1, status: 200});
  recorder.observe('request-finished', {requestId: 1, outcome: 'success', durationMs: 12000});
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.totals.requests, 1);
  assert.equal(snapshot.totals.success, 1);
  assert.equal(snapshot.totals.reasoningKept, 2);
  assert.equal(snapshot.totals.clientErrorsAvoided, 1);
  assert.equal(snapshot.totals.retriesExecuted, 1);
  assert.equal(snapshot.totals.inputTokens, 10);
  assert.equal(snapshot.totals.outputTokens, 5);
  assert.equal(snapshot.totals.cachedTokens, 4);
  assert.equal(snapshot.retry.rateLimit.scheduled, 1);
  assert.equal(snapshot.retry.rateLimit.executed, 1);
  assert.equal(snapshot.retry.rateLimit.recoveredRequests, 1);
  assert.equal(snapshot.retry.rateLimit.waitMs, 5000);
  assert.equal(snapshot.errorsByCode.rate_limit, 1);
  assert.equal(snapshot.errorsByKind.rateLimit, 1);
  assert.equal(snapshot.active.length, 0);
  assert.equal(snapshot.ttfb.counts.some(count => count > 0), true);
  const record = snapshot.recent.at(-1);
  assert.equal(record.outcome, 'success');
  assert.equal(record.ttfbMs, 7500);
  assert.equal(record.durationMs, 12000);
  assert.deepEqual(record.tokens, {input: 10, output: 5, cached: 4});
  assert.deepEqual(record.kinds, ['rateLimit']);
  assert.deepEqual(record.codes, ['rate_limit']);
});

test('recorder keeps active requests and daily persistence merges same-day aggregates only', () => {
  const recorder = new Recorder();
  recorder.observe('request-started', {requestId: 1, model: 'gpt-test'});
  assert.equal(recorder.snapshot().active.length, 1);
  recorder.observe('retry-scheduled', {requestId: 1, kind: 'transport', delayMs: 1000});
  recorder.observe('retry-scheduled', {requestId: 1, kind: 'transport', delayMs: 2000});
  recorder.observe('history-degraded', {requestId: 1, removed: 1, removedItemIds: 2});
  recorder.observe('request-finished', {requestId: 1, outcome: 'failed', durationMs: 100});
  const failed = recorder.snapshot();
  assert.equal(failed.totals.degradedRequests, 1);
  assert.equal(failed.totals.reasoningRemoved, 1);
  assert.equal(failed.totals.itemIdsRemoved, 2);
  assert.equal(failed.totalFailed.counts.some(count => count > 0), true);
  const saved = JSON.parse(JSON.stringify(recorder.toJSON()));
  const next = new Recorder();
  assert.equal(next.hydrate(saved), true);
  assert.equal(next.snapshot().totals.failed, 1);
  assert.equal(next.snapshot().totals.degradedRequests, 1);
  assert.equal(next.snapshot().retry.transport.scheduled, 2);
  const stale = new Recorder();
  assert.equal(stale.hydrate({...saved, date: '1999-01-01'}), false);
  assert.equal(stale.snapshot().totals.failed, 0);
});

test('dashboard page is served and the data stream requires the control token', async t => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
  });
  const upstreamOrigin = await listen(upstream);
  const recorder = new Recorder();
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, token: 'test-only-secret', recorder,
    getState: () => ({state: 'filtering', upstream: upstreamOrigin})});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const page = await fetch(origin + ADMIN + '/ui');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Codex 过滤观测台/);
  const denied = await fetch(origin + ADMIN + '/ui/stream');
  assert.equal(denied.status, 403);
  await denied.text();
  const wrongToken = await fetch(origin + ADMIN + '/ui/stream?token=nope');
  assert.equal(wrongToken.status, 403);
  await wrongToken.text();
  const response = await fetch(origin + '/responses', {method: 'POST', body: '{"stream":true}'});
  await response.text();
  const stream = await fetch(origin + ADMIN + '/ui/stream?token=test-only-secret');
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  const chunks = [];
  const deadline = Date.now() + 3000;
  let text = '';
  while (Date.now() < deadline && !text.includes('snapshot')) {
    const part = await reader.read();
    if (part.done) break;
    chunks.push(Buffer.from(part.value));
    text = Buffer.concat(chunks).toString('utf8');
  }
  await reader.cancel().catch(() => {});
  assert.match(text, /^event: snapshot\n/m);
  const payload = JSON.parse(text.match(/^data: (.*)$/m)[1]);
  assert.equal(payload.snapshot.totals.requests, 1);
  assert.equal(payload.snapshot.totals.success, 1);
  assert.ok(payload.state.upstream.includes('127.0.0.1'));
  assert.equal(typeof payload.snapshot.version, 'number');
});

test('daily rollover preserves in-flight requests and attributes new events to the new date', t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date(2026, 9, 26, 23, 59)});
  const recorder = new Recorder();
  recorder.observe('request-started', {requestId: 1});
  recorder.observe('forwarded', {requestId: 1, ttfbMs: 1000, status: 200});
  recorder.observe('request-finished', {requestId: 1, outcome: 'success', durationMs: 2000});
  recorder.observe('request-started', {requestId: 2, model: 'cross-midnight'});
  const yesterday = JSON.parse(JSON.stringify(recorder.toJSON()));
  t.mock.timers.tick(120000);
  const midnight = recorder.snapshot();
  assert.equal(midnight.date, '2026-10-27');
  assert.equal(midnight.totals.requests, 0);
  assert.equal(midnight.totals.success, 0);
  assert.equal(midnight.totals.ttfbSamples, 0);
  assert.deepEqual(midnight.active.map(record => record.id), [2]);
  assert.equal(midnight.recent.length, 2);
  recorder.observe('forwarded', {requestId: 2, ttfbMs: 120500, status: 200});
  recorder.observe('response-usage', {requestId: 2, usage: {input_tokens: 8, output_tokens: 3}});
  recorder.observe('request-finished', {requestId: 2, outcome: 'success', durationMs: 121000});
  const saved = JSON.parse(JSON.stringify(recorder.toJSON()));
  assert.equal(saved.date, '2026-10-27');
  assert.equal(saved.totals.requests, 0);
  assert.equal(saved.totals.success, 1);
  assert.equal(saved.totals.inputTokens, 8);
  assert.equal(saved.totals.ttfbMs, 120500);
  assert.equal(saved.totals.ttfbSamples, 1);
  assert.equal(recorder.snapshot().active.length, 0);
  assert.equal(recorder.snapshot().recent.at(-1).outcome, 'success');
  const restarted = new Recorder();
  assert.equal(restarted.hydrate(yesterday), false);
  assert.equal(restarted.hydrate(saved), true);
  assert.equal(restarted.snapshot().totals.success, 1);
  assert.equal(restarted.snapshot().totals.ttfbMs, 120500);
  assert.equal(restarted.snapshot().recent.length, 0);
});

test('serialization rolls an idle day and first-packet averages survive minute retention and restart', t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date(2026, 9, 26, 12)});
  const recorder = new Recorder();
  for (let id = 1; id <= 181; id++) {
    recorder.observe('request-started', {requestId: id});
    recorder.observe('forwarded', {requestId: id, ttfbMs: id === 1 ? 2000 : 1000, status: 200});
    recorder.observe('request-finished', {requestId: id, outcome: 'success', durationMs: 3000});
    t.mock.timers.tick(60000);
  }
  assert.equal(recorder.snapshot().series.length, 180);
  const sameDay = JSON.parse(JSON.stringify(recorder.toJSON()));
  const restarted = new Recorder();
  assert.equal(restarted.hydrate(sameDay), true);
  assert.equal(restarted.snapshot().totals.ttfbSamples, 181);
  assert.equal(restarted.snapshot().totals.ttfbMs, 182000);
  t.mock.timers.tick(24 * 60 * 60000);
  const nextDay = JSON.parse(JSON.stringify(recorder.toJSON()));
  assert.equal(nextDay.date, '2026-10-27');
  assert.equal(nextDay.totals.requests, 0);
  assert.equal(nextDay.totals.success, 0);
});

test('recorder bounds recent entries without losing active requests and classifies transport errors', () => {
  const recorder = new Recorder({maxRecent: 2});
  for (let id = 1; id <= 3; id++) recorder.observe('request-started', {requestId: id});
  assert.deepEqual(recorder.snapshot().recent.map(record => record.id), [2, 3]);
  assert.equal(recorder.snapshot().active.length, 3);
  recorder.observe('transport-error', {requestId: 1, errorCode: 'stream_incomplete'});
  recorder.observe('request-finished', {requestId: 1, outcome: 'failed', durationMs: 100});
  assert.equal(recorder.snapshot().errorsByKind.transport, 1);
  assert.equal(recorder.snapshot().totals.failed, 1);
  assert.equal(recorder.snapshot().active.length, 2);
});

test('dashboard renders request and error strings as text and does not invent retry recovery rates', () => {
  const elements = new Map();
  const node = () => ({style: {}, innerHTML: '', textContent: '', children: [],
    appendChild(child) { this.children.push(child); }, addEventListener() {}});
  const document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  }, createElement: node};
  const listeners = {};
  class EventSource {
    addEventListener(name, listener) { listeners[name] = listener; }
  }
  const script = DASHBOARD_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {document, EventSource, location: {hash: ''},
    localStorage: {getItem: () => 'test-only-secret', setItem() {}}});
  const payload = '<img src=x onerror="globalThis.reviewXss=1">&\'';
  const recorder = new Recorder();
  recorder.observe('request-started', {requestId: 1, model: payload});
  recorder.observe('stream-error', {requestId: 1, kind: payload, errorCode: payload});
  recorder.observe('retry-scheduled', {requestId: 1, kind: 'transport', delayMs: 10000});
  const snapshot = recorder.snapshot();
  listeners.snapshot({data: JSON.stringify({snapshot, state: {state: 'filtering'}})});
  for (const html of [elements.get('activeList').children[0].innerHTML,
    elements.get('reqRows').innerHTML, elements.get('errCodes').innerHTML,
    elements.get('errKinds').innerHTML]) {
    assert.doesNotMatch(html, /<img\b/);
    assert.match(html, /&lt;img src=x onerror=&quot;globalThis\.reviewXss=1&quot;&gt;&amp;&#39;/);
  }
  const retry = elements.get('retryTable').innerHTML;
  assert.match(retry, /计划等待/);
  assert.match(retry, /取消前未等满也计入/);
  assert.doesNotMatch(retry, /0%/);
  const persistedAverage = {...snapshot, totals: {...snapshot.totals, ttfbMs: 5000, ttfbSamples: 2}, series: []};
  listeners.snapshot({data: JSON.stringify({snapshot: persistedAverage, state: {}})});
  assert.equal(elements.get('kTtfb').textContent, '2.50s');
});
