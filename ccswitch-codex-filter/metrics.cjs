'use strict';

// In-memory aggregation for the local dashboard. Events mirror the structured
// log; this module never records request bodies or credentials.

const RETRY_KINDS = ['resource', 'rateLimit', 'transport', 'availability'];
const TTFB_BUCKETS = [1000, 2000, 5000, 10000, 30000, 60000, 120000, 300000, 600000];
const TOTAL_BUCKETS = [1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000, 1200000];
const MAX_RECENT = 200;
const MAX_SERIES = 180;

function bucketIndex(buckets, value) {
  let index = 0;
  while (index < buckets.length && value > buckets[index]) index++;
  return index;
}

function histogram(buckets) {
  return {bounds: buckets, counts: new Array(buckets.length + 1).fill(0)};
}

function addHistogram(target, value) {
  if (!Number.isFinite(value) || value < 0) return;
  target.counts[bucketIndex(target.bounds, value)]++;
}

function emptyKindStats() {
  return {scheduled: 0, executed: 0, recoveredRequests: 0, exhaustedRequests: 0, waitMs: 0};
}

function emptyTotals() {
  return {requests: 0, success: 0, failed: 0, canceled: 0, filteredRequests: 0,
    reasoningKept: 0, reasoningRemoved: 0, itemIdsRemoved: 0, degradedRequests: 0,
    retriesExecuted: 0, retryWaitMs: 0, clientErrorsAvoided: 0,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, usageReports: 0, ttfbMs: 0, ttfbSamples: 0};
}

function emptySeriesRow(minute) {
  return {minute, started: 0, success: 0, failed: 0, canceled: 0, retries: 0,
    ttfbMs: 0, ttfbSamples: 0, totalMs: 0, totalSamples: 0, inputTokens: 0, outputTokens: 0};
}

function trimSeries(series) {
  while (series.length > MAX_SERIES) series.shift();
}

class Recorder {
  constructor({maxRecent = MAX_RECENT} = {}) {
    this.maxRecent = maxRecent;
    this.startedAt = Date.now();
    this.version = 1;
    this.resetDaily(localDate());
    this.recent = [];
    this.active = new Map();
  }

  resetDaily(date) {
    this.date = date;
    this.totals = emptyTotals();
    this.errorsByCode = {};
    this.errorsByKind = {};
    this.retry = {};
    for (const kind of RETRY_KINDS) this.retry[kind] = emptyKindStats();
    this.ttfb = histogram(TTFB_BUCKETS);
    this.total = histogram(TOTAL_BUCKETS);
    this.totalFailed = histogram(TOTAL_BUCKETS);
    this.series = [];
  }

  // Attribute each event to its local calendar date. Preserve live requests so
  // their completion and usage can be counted on the new date after midnight.
  rollDay() {
    const date = localDate();
    if (date === this.date) return;
    this.resetDaily(date);
    this.version++;
  }

  observe(event, data = {}) {
    this.rollDay();
    switch (event) {
      case 'request-started': {
        const record = {id: data.requestId, model: data.model || null, streaming: !!data.streaming,
          requestBytes: data.requestBytes || 0, startTs: Date.now(), endTs: null, outcome: null,
          durationMs: null, ttfbMs: null, status: null, retries: 0, kinds: [], codes: [],
          tokens: null, degraded: false, phase: 'waiting'};
        this.active.set(record.id, record);
        this.recent.push(record);
        if (this.recent.length > this.maxRecent) this.recent.shift();
        this.totals.requests++;
        this.row().started++;
        break;
      }
      case 'filtered': {
        this.totals.filteredRequests++;
        this.totals.reasoningKept += data.kept || 0;
        this.totals.reasoningRemoved += data.removed || 0;
        this.totals.itemIdsRemoved += data.removedItemIds || 0;
        break;
      }
      case 'history-degraded': {
        this.totals.degradedRequests++;
        this.totals.reasoningRemoved += data.removed || 0;
        this.totals.itemIdsRemoved += data.removedItemIds || 0;
        this.touch(data.requestId, record => { record.degraded = true; });
        break;
      }
      case 'retry-scheduled': {
        const kind = this.retry[data.kind];
        if (kind) { kind.scheduled++; kind.waitMs += data.delayMs || 0; }
        this.touch(data.requestId, record => {
          record.retries++;
          if (data.kind && !record.kinds.includes(data.kind)) record.kinds.push(data.kind);
          record.phase = 'backoff';
        });
        this.totals.retryWaitMs += data.delayMs || 0;
        this.row().retries++;
        break;
      }
      case 'retry-dispatched': {
        const kind = this.retry[data.kind];
        if (kind) { kind.executed++; this.totals.retriesExecuted++; }
        this.touch(data.requestId, record => { record.phase = 'waiting'; });
        break;
      }
      case 'forwarded': {
        const ttfb = data.ttfbMs;
        this.touch(data.requestId, record => {
          record.status = data.status ?? record.status;
          if (record.ttfbMs === null && Number.isFinite(ttfb)) {
            record.ttfbMs = ttfb;
            record.phase = data.streaming ? 'streaming' : record.phase;
            addHistogram(this.ttfb, ttfb);
            this.totals.ttfbMs += ttfb;
            this.totals.ttfbSamples++;
            const row = this.row();
            row.ttfbMs += ttfb; row.ttfbSamples++;
          }
        });
        break;
      }
      case 'response-usage': {
        const usage = data.usage || {};
        const input = Number(usage.input_tokens) || 0;
        const output = Number(usage.output_tokens) || 0;
        const cached = Number(usage.input_tokens_details?.cached_tokens) || 0;
        this.totals.inputTokens += input;
        this.totals.outputTokens += output;
        this.totals.cachedTokens += cached;
        this.totals.usageReports++;
        const row = this.row();
        row.inputTokens += input; row.outputTokens += output;
        this.touch(data.requestId, record => { record.tokens = {input, output, cached}; });
        break;
      }
      case 'http-error': case 'stream-error': case 'transport-error':
      case 'upstream-error': case 'blocked': case 'response-buffer-exceeded': {
        const code = data.errorCode || data.code || 'other';
        this.errorsByCode[code] = (this.errorsByCode[code] || 0) + 1;
        const kind = data.kind || (event === 'transport-error' ? 'transport' : 'other');
        this.errorsByKind[kind] = (this.errorsByKind[kind] || 0) + 1;
        this.touch(data.requestId, record => {
          if (!record.codes.includes(code)) record.codes.push(code);
        });
        break;
      }
      case 'retry-accepted': {
        this.totals.clientErrorsAvoided++;
        this.touch(data.requestId, record => {
          for (const kind of record.kinds) {
            if (this.retry[kind]) this.retry[kind].recoveredRequests++;
          }
        });
        break;
      }
      case 'retry-exhausted': {
        const kind = this.retry[data.kind];
        if (kind) kind.exhaustedRequests++;
        break;
      }
      case 'request-finished': {
        const outcome = data.outcome || 'failed';
        this.totals[outcome] = (this.totals[outcome] || 0) + 1;
        const record = this.active.get(data.requestId);
        if (record) {
          record.outcome = outcome;
          record.endTs = Date.now();
          record.durationMs = data.durationMs ?? (record.endTs - record.startTs);
          record.phase = 'done';
          this.active.delete(data.requestId);
        }
        const duration = record ? record.durationMs : data.durationMs;
        if (Number.isFinite(duration)) {
          if (outcome === 'success') {
            addHistogram(this.total, duration);
            const row = this.row();
            row.totalMs += duration; row.totalSamples++;
          } else if (outcome === 'failed') {
            addHistogram(this.totalFailed, duration);
          }
        }
        const row = this.row();
        row[outcome === 'canceled' ? 'canceled' : outcome]++;
        break;
      }
      default: return;
    }
    this.version++;
  }

  row() {
    const minute = Math.floor(Date.now() / 60000);
    const last = this.series[this.series.length - 1];
    if (last && last.minute === minute) return last;
    const row = emptySeriesRow(minute);
    this.series.push(row);
    trimSeries(this.series);
    return row;
  }

  touch(requestId, update) {
    const record = this.active.get(requestId);
    if (record) update(record);
  }

  snapshot() {
    this.rollDay();
    return {
      date: this.date,
      version: this.version,
      generatedAt: new Date().toISOString(),
      uptimeMs: Date.now() - this.startedAt,
      totals: {...this.totals},
      retry: Object.fromEntries(RETRY_KINDS.map(kind => [kind, {...this.retry[kind]}])),
      errorsByCode: {...this.errorsByCode},
      errorsByKind: {...this.errorsByKind},
      ttfb: {bounds: this.ttfb.bounds, counts: [...this.ttfb.counts]},
      total: {bounds: this.total.bounds, counts: [...this.total.counts]},
      totalFailed: {bounds: this.totalFailed.bounds, counts: [...this.totalFailed.counts]},
      series: this.series.map(row => ({...row})),
      active: [...this.active.values()].map(record => ({
        id: record.id, model: record.model, streaming: record.streaming, phase: record.phase,
        startedAt: record.startTs, elapsedMs: Date.now() - record.startTs,
        retries: record.retries, kinds: [...record.kinds], degraded: record.degraded})),
      recent: this.recent.map(record => ({
        id: record.id, model: record.model, streaming: record.streaming,
        startTs: record.startTs, endTs: record.endTs, outcome: record.outcome,
        durationMs: record.durationMs, ttfbMs: record.ttfbMs, status: record.status,
        retries: record.retries, kinds: [...record.kinds], codes: [...record.codes],
        tokens: record.tokens, requestBytes: record.requestBytes, degraded: record.degraded}))
    };
  }

  // Daily aggregate persistence: survives restarts within the same local date.
  toJSON() {
    this.rollDay();
    return {date: this.date, savedAt: new Date().toISOString(), totals: this.totals,
      errorsByCode: this.errorsByCode, errorsByKind: this.errorsByKind,
      retry: this.retry, ttfb: this.ttfb, total: this.total, totalFailed: this.totalFailed};
  }

  hydrate(saved) {
    this.rollDay();
    if (!saved || saved.date !== this.date) return false;
    const mergeCounts = (target, source) => {
      for (const [key, value] of Object.entries(source || {})) {
        if (Number.isFinite(value)) target[key] = (target[key] || 0) + value;
      }
    };
    for (const key of Object.keys(emptyTotals())) {
      if (Number.isFinite(saved.totals?.[key])) this.totals[key] += saved.totals[key];
    }
    mergeCounts(this.errorsByCode, saved.errorsByCode);
    mergeCounts(this.errorsByKind, saved.errorsByKind);
    for (const kind of RETRY_KINDS) {
      const source = saved.retry?.[kind] || {};
      for (const key of Object.keys(emptyKindStats())) {
        if (Number.isFinite(source[key])) this.retry[kind][key] += source[key];
      }
    }
    const mergeHistogram = (target, source) => {
      if (!source || !Array.isArray(source.counts)) return;
      source.counts.forEach((count, index) => {
        if (Number.isFinite(count) && index < target.counts.length) target.counts[index] += count;
      });
    };
    mergeHistogram(this.ttfb, saved.ttfb);
    mergeHistogram(this.total, saved.total);
    mergeHistogram(this.totalFailed, saved.totalFailed);
    this.version++;
    return true;
  }
}

function localDate(now = new Date()) {
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}

module.exports = {Recorder, RETRY_KINDS, TTFB_BUCKETS, TOTAL_BUCKETS, localDate};
