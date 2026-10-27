'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {SERVICE, ADMIN, FILTER_VERSION, makeProxy, localOrigin} = require('./proxy.cjs');
const {ConfigRouter, discoverCcSwitch, atomicWrite} = require('./config.cjs');
const {Recorder} = require('./metrics.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const LOG_MAX_BYTES = 4 * 1024 * 1024;
const LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
function pruneLog(filename, now = Date.now(), maxBytes = LOG_MAX_BYTES) {
  if (!fs.existsSync(filename)) return;
  const original = fs.readFileSync(filename);
  const kept = [];
  let size = 0;
  for (const line of original.toString('utf8').trimEnd().split('\n').reverse()) {
    let time;
    try { time = Date.parse(JSON.parse(line).time); } catch { continue; }
    if (!Number.isFinite(time) || time < now - LOG_MAX_AGE_MS) continue;
    const bytes = Buffer.from(line + '\n');
    if (size + bytes.length > maxBytes) break;
    kept.push(bytes); size += bytes.length;
  }
  const retained = Buffer.concat(kept.reverse());
  if (original.equals(retained)) return;
  const temporary = filename + '.tmp';
  fs.writeFileSync(temporary, retained);
  fs.renameSync(temporary, filename);
}
// Buffered appender: request handling never waits on disk; the log file is
// reopened on every flush so retention/rotation can safely rename it.
function createLogWriter(filename, {maxBytes = LOG_MAX_BYTES, flushMs = 100} = {}) {
  let queue = [], timer = null, flushing = null, bytes = 0;
  try { bytes = fs.statSync(filename).size; } catch {}
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, flushMs);
  };
  const flush = async () => {
    clearTimeout(timer);
    timer = null;
    if (flushing) { await flushing; return flush(); }
    if (!queue.length) return;
    const payload = queue.join('');
    queue = [];
    flushing = fs.promises.appendFile(filename, payload)
      .then(() => { bytes += Buffer.byteLength(payload); }).catch(() => {});
    await flushing;
    flushing = null;
    if (bytes > maxBytes) {
      try { pruneLog(filename); bytes = fs.statSync(filename).size; } catch { bytes = 0; }
    }
    if (queue.length) await flush();
  };
  const write = line => {
    queue.push(line + '\n');
    if (queue.length >= 128) flush();
    else schedule();
  };
  write.flush = flush;
  return write;
}
function jsonFile(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function request(origin, route, token, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(origin + route, {method, headers: token ? {'x-filter-token': token} : {}}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 65536) res.destroy(); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode !== 200) throw new Error(result.error?.message || 'Local service returned HTTP ' + res.statusCode);
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error('Local service timed out.')));
    req.on('error', reject);
    req.end();
  });
}
async function health(record) {
  if (!record) return null;
  try {
    const result = await request(record.filterOrigin, ADMIN + '/health');
    return result.service === SERVICE && result.instance === record.instance ? result : null;
  } catch { return null; }
}
function reachable(origin) {
  const url = new URL(origin);
  return new Promise(resolve => {
    const socket = net.connect({host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80)});
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1200, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
function parseArgs(argv) {
  const command = (argv.shift() || 'help').toLowerCase();
  if (!['help', 'start', 'serve', 'stop', 'status', 'logs', 'ui'].includes(command)) {
    throw new Error('Use start, stop, status, logs, ui or serve.');
  }
  const values = {};
  const names = new Set(['port', 'upstream', 'config', 'runtime', 'cc-db']);
  while (argv.length) {
    const key = argv.shift();
    if (!key.startsWith('--') || !names.has(key.slice(2)) || !argv.length) throw new Error('Invalid option: ' + key);
    values[key.slice(2)] = argv.shift();
  }
  const port = Number(values.port || 18181);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer between 1024 and 65535.');
  const configHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return {command, port, filterOrigin: 'http://127.0.0.1:' + port,
    configPath: path.resolve(values.config || path.join(configHome, 'config.toml')),
    runtime: path.resolve(values.runtime || path.join(__dirname, '.runtime')),
    databasePath: values['cc-db'] && path.resolve(values['cc-db']),
    upstream: values.upstream && localOrigin(values.upstream)};
}
function files(options) {
  return {state: path.join(options.runtime, 'service.json'), backup: path.join(options.runtime, 'routes.json'),
    log: path.join(options.runtime, 'filter.log'), metrics: path.join(options.runtime, 'metrics.json')};
}
function routerFor(options, backup, getUpstream, log) {
  return new ConfigRouter({configPath: options.configPath, filterOrigin: options.filterOrigin,
    backupPath: backup, getUpstream, log});
}
function removeOwnState(filename, instance) {
  if (jsonFile(filename)?.instance === instance) fs.unlinkSync(filename);
}
async function serve(options) {
  const locations = files(options);
  fs.mkdirSync(options.runtime, {recursive: true});
  let upstream = options.upstream || discoverCcSwitch(options.databasePath);
  if (new URL(upstream).port === String(options.port)) throw new Error('Filter port must differ from CC Switch port.');
  const instance = randomBytes(12).toString('hex');
  const record = {service: SERVICE, pid: process.pid, instance, token: randomBytes(32).toString('hex'),
    filterOrigin: options.filterOrigin, configPath: options.configPath, startedAt: new Date().toISOString()};
  const previous = jsonFile(locations.state);
  if (previous) {
    if (alive(previous.pid) || await health(previous)) throw new Error('A filter process is already running. Use status or stop.');
    fs.unlinkSync(locations.state);
  }
  const recorder = new Recorder();
  recorder.hydrate(jsonFile(locations.metrics));
  pruneLog(locations.log);
  // Exclusive creation serializes simultaneous starts; don't overwrite another instance.
  fs.writeFileSync(locations.state, JSON.stringify(record, null, 2), {flag: 'wx', mode: 0o600});
  let router, server, timer, logTimer, metricsTimer, stopping = false, lastError = null;
  const writer = createLogWriter(locations.log);
  const log = (event, data = {}) => {
    const line = JSON.stringify({time: new Date().toISOString(), event, ...data});
    writer(line);
    console.log(line);
  };
  const flushMetrics = () => { try { atomicWrite(locations.metrics, JSON.stringify(recorder.toJSON())); } catch {} };
  const cleanup = () => removeOwnState(locations.state, instance);
  const shutdown = () => {
    if (stopping) return;
    // If restoration fails, keep serving rather than leaving Codex pointing at a dead port.
    router.restore();
    stopping = true;
    clearInterval(timer);
    clearInterval(logTimer);
    clearInterval(metricsTimer);
    flushMetrics();
    log('stopping');
    setTimeout(() => {
      const force = setTimeout(() => server.closeAllConnections(), 10000);
      force.unref();
      server.close(async () => {
        clearTimeout(force);
        flushMetrics();
        log('stopped');
        await writer.flush();
        cleanup();
      });
      server.closeIdleConnections();
    }, 50);
  };
  try {
    router = routerFor(options, locations.backup, () => upstream, log);
    server = makeProxy({getUpstream: () => upstream, token: record.token, onStop: shutdown, log, recorder,
      getState: () => ({instance, state: stopping ? 'stopping' : router.state, upstream,
        filterOrigin: options.filterOrigin, configPath: options.configPath, lastError,
        filterVersion: FILTER_VERSION, historyMode: 'lazy', bufferMode: 'stream', dashboard: ADMIN + '/ui',
        logPolicy: {retentionHours: 24, maxBytes: LOG_MAX_BYTES, cleanupIntervalMs: 60000}})});
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', resolve);
    });
    const tick = () => {
      if (stopping) return;
      try {
        upstream = options.upstream || discoverCcSwitch(options.databasePath);
        if (new URL(upstream).port === String(options.port)) throw new Error('Filter port conflicts with CC Switch.');
        router.sync();
        lastError = null;
      } catch (error) {
        const message = error.message;
        if (lastError !== message) log('config-error', {message});
        lastError = message;
        router.changeState('config-error');
      }
    };
    tick();
    timer = setInterval(tick, 1000);
    logTimer = setInterval(() => pruneLog(locations.log), 60000);
    logTimer.unref();
    metricsTimer = setInterval(flushMetrics, 60000);
    metricsTimer.unref();
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      try { shutdown(); }
      catch (error) { log('restore-failed', {message: error.message}); }
    });
    log('listening', {filterOrigin: options.filterOrigin, upstream, state: router.state});
  } catch (error) {
    clearInterval(timer);
    clearInterval(logTimer);
    clearInterval(metricsTimer);
    flushMetrics();
    log('service-error', {code: error.code || 'startup_failed'});
    if (server?.listening) server.close();
    cleanup();
    await writer.flush();
    throw error;
  }
}
async function status(options) {
  const record = jsonFile(files(options).state);
  const running = await health(record);
  if (running) {
    const {instance, ...publicState} = running;
    return {...publicState, running: true, ccSwitchReachable: await reachable(running.upstream)};
  }
  return {service: SERVICE, running: false, state: record ? 'stale-state' : 'stopped',
    recoveryBackup: fs.existsSync(files(options).backup)};
}
async function start(options) {
  const locations = files(options);
  const running = await health(jsonFile(locations.state));
  if (running) {
    if (running.filterOrigin !== options.filterOrigin || running.configPath !== options.configPath) {
      throw new Error('Running filter has different options. Stop it before changing config/port.');
    }
    return status(options);
  }
  fs.mkdirSync(options.runtime, {recursive: true});
  const args = [__filename, 'serve', '--port', String(options.port), '--config', options.configPath, '--runtime', options.runtime];
  if (options.upstream) args.push('--upstream', options.upstream);
  if (options.databasePath) args.push('--cc-db', options.databasePath);
  const child = spawn(process.execPath, args, {cwd: __dirname, detached: true, windowsHide: true, stdio: 'ignore'});
  let failure;
  child.on('error', error => { failure = error; });
  child.unref();
  for (let count = 0; count < 40; count++) {
    if (failure) throw failure;
    const result = await health(jsonFile(locations.state));
    if (result) {
      if (result.state === 'config-error') throw new Error('Filter started but config was not attached: ' + result.lastError + '. Use stop to restore/stop.');
      return status(options);
    }
    if (child.exitCode !== null) break;
    await delay(150);
  }
  throw new Error('Filter did not become ready. See ' + locations.log);
}
async function stop(options) {
  const locations = files(options);
  const record = jsonFile(locations.state);
  const running = await health(record);
  if (running) {
    await request(record.filterOrigin, ADMIN + '/stop', record.token, 'POST');
    for (let count = 0; count < 100; count++) {
      if (jsonFile(locations.state)?.instance !== record.instance) return {running: false, state: 'stopped', restored: true};
      await delay(150);
    }
    throw new Error('Stop is still draining requests; retry status.');
  }
  if (record && alive(record.pid)) {
    throw new Error('Recorded process is alive but not responding. Refusing to kill an unverified PID; retry stop after it exits.');
  }
  const backup = jsonFile(locations.backup);
  if (backup) {
    const restoreOptions = {...options, configPath: backup.configPath, filterOrigin: backup.filterOrigin};
    routerFor(restoreOptions, locations.backup, () => options.upstream || discoverCcSwitch(options.databasePath)).restore();
  }
  if (record) removeOwnState(locations.state, record.instance);
  return {running: false, state: 'stopped', restored: !!backup};
}
async function ui(options) {
  const locations = files(options);
  const record = jsonFile(locations.state);
  const running = await health(record);
  if (!running) throw new Error('Filter is not running. Start it first: node filter.cjs start');
  const url = running.filterOrigin + ADMIN + '/ui#' + record.token;
  let opened = false;
  if (process.platform === 'win32') {
    try {
      spawn('cmd', ['/c', 'start', '', url], {detached: true, windowsHide: true, stdio: 'ignore'}).unref();
      opened = true;
    } catch {}
  }
  return {url, opened};
}

function formatLog(row) {
  const time = row.time ? new Date(row.time).toLocaleTimeString('zh-CN', {hour12: false}) : '--:--:--';
  const id = row.requestId === undefined ? 'service' : '#' + row.requestId;
  const code = row.errorCode || ({resource: 'different_azure', rateLimit: 'rate_limit', transport: 'stream_incomplete',
    availability: 'no_available_channel'})[row.kind] || row.code || 'other';
  const codeNote = ({different_azure: '历史记录属于另一个 Azure 资源', rate_limit: '上游临时限流',
    stream_incomplete: '上游断流或等待超时', alb_bad_request: '上游 ALB 网关返回 HTML 400',
    request_deadline: '请求总时间已耗尽',
    insufficient_quota: '上游配额不足', response_too_large: '暂存响应超过大小限制',
    ccswitch_unavailable: 'CC Switch 不可用或请求超时',
    upstream_failed_without_details: '上游报告 response.failed，但没有提供可用的错误详情',
    'response.failed': '上游报告失败，旧日志没有记录具体错误详情',
    no_available_channel: '上游当前没有可用渠道'})[code] || '其他错误，查看英文错误码';
  let message, note;
  switch (row.event) {
    case 'request-started': message = `START streaming=${row.streaming} maxRetries=${row.maxRetries} deadline=${row.deadlineMs / 1000}s`;
      note = `请求开始：最多额外重试 ${row.maxRetries} 次，总期限 ${row.deadlineMs / 1000} 秒`; break;
    case 'filtered': message = `FILTER removedReasoning=${row.removed} removedIds=${row.removedItemIds} keptReasoning=${row.kept ?? 0}`;
      note = row.mode === 'lazy'
        ? `历史过滤完成：保留 ${row.kept ?? 0} 项历史推理（懒模式）${row.removed || row.removedItemIds ? `，移除 ${row.removed} 项推理、${row.removedItemIds} 个历史 ID` : '，无需修改请求'}`
        : `历史过滤完成：移除 ${row.removed} 项推理、${row.removedItemIds} 个历史 ID`; break;
    case 'history-degraded': message = `DEGRADE removedReasoning=${row.removed} removedIds=${row.removedItemIds}`;
      note = `遇到历史资源归属类错误，从本次重试起改用移除历史思维链/ID 的保守请求体（相当于旧版行为）`; break;
    case 'http-error': case 'stream-error': case 'transport-error':
      message = `FAIL ${code}${row.status ? ' HTTP=' + row.status : ''}${row.code ? ' cause=' + row.code : ''}`;
      note = `本次尝试失败：${codeNote}；${row.kind && row.kind !== 'other' ? '按分类进行有限重试，结果见后续记录' : '未命中可重试分类，本次直接返回客户端'}`; break;
    case 'retry-scheduled': message = `WAIT ${code} retry=${row.retry}/${row.maxRetries || 5} delay=${(row.delayMs / 1000).toFixed(3)}s`;
      note = `${codeNote}；等待 ${(row.delayMs / 1000).toFixed(3)} 秒后进行第 ${row.retry} 次重试`;
      if (row.maxKindRetries) note += `；该类 ${row.kindRetry}/${row.maxKindRetries} 次`; break;
    case 'retry-dispatched': message = `RETRY ${code} retry=${row.retry}/${row.maxRetries || 5}`;
      note = `已发出第 ${row.retry} 次重试：${codeNote}`;
      if (row.maxKindRetries) note += `；该类 ${row.kindRetry}/${row.maxKindRetries} 次`; break;
    case 'retry-exhausted': message = `EXHAUSTED ${code} retries=${row.retries}/${row.maxRetries || 5} reason=${row.deadline ? 'deadline' : 'retry_limit'}`;
      note = row.deadline ? '总期限不足或已到期' : row.maxKindRetries && row.kindRetries >= row.maxKindRetries
        ? `${codeNote}已用完 ${row.maxKindRetries} 次额外重试` : `已用完合计 ${row.maxRetries || 5} 次额外重试`;
      note += '，本条请求停止重试'; break;
    case 'retry-accepted': message = `RECOVERED retries=${row.retries} HTTP=${row.status}`;
      note = `重试 ${row.retries} 次后恢复成功`; break;
    case 'request-finished': message = `${String(row.outcome).toUpperCase()} duration=${(row.durationMs / 1000).toFixed(3)}s`;
      note = ({success: '请求成功完成', failed: '请求最终失败', canceled: '客户端连接已关闭，请求已取消'})[row.outcome] || '请求已结束';
      note += `；总耗时 ${(row.durationMs / 1000).toFixed(3)} 秒（含上游响应和重试等待）`; break;
    case 'request-progress': message = `PENDING ${row.phase} retries=${row.retries}/${row.maxRetries || 5} elapsed=${Math.floor(row.elapsedMs / 1000)}s remaining=${Math.ceil(row.remainingMs / 1000)}s`;
      note = row.phase === 'backoff' ? '正在等待重试间隔' : row.phase === 'streaming'
        ? '已开始向客户端流式转发上游内容' : '正在等待 CC Switch / 上游响应';
      note += `；已用 ${Math.floor(row.elapsedMs / 1000)} 秒，剩余 ${Math.ceil(row.remainingMs / 1000)} 秒`; break;
    case 'upstream-http-error': message = `HTTP ${row.status}`; note = '上游返回错误状态，具体分类见后续 FAIL'; break;
    case 'upstream-error': case 'blocked': case 'response-buffer-exceeded': case 'service-error': message = `FAIL ${code}`;
      note = row.event === 'blocked' ? '过滤器拒绝了该请求，查看英文错误码' : codeNote; break;
    case 'listening': message = `READY ${row.state} ${row.filterOrigin}`; note = '过滤服务已开始监听；网页观测台: node filter.cjs ui'; break;
    case 'stopping': case 'stopped': message = row.event.toUpperCase(); note = row.event === 'stopping' ? '过滤服务正在停止' : '过滤服务已停止'; break;
    case 'state': case 'config-state': message = `STATE ${row.state}`; note = '配置接入状态变化'; break;
    default: return null;
  }
  return `[${time}] [${id}] ${message} // ${note}`;
}

async function logs(options) {
  const filename = files(options).log;
  const openedAt = Date.now();
  let offset = 0, identity = '', pending = Buffer.alloc(0), lastLine = '';
  if (fs.existsSync(filename)) {
    const current = fs.statSync(filename);
    offset = current.size; identity = `${current.dev}:${current.ino}`;
    lastLine = fs.readFileSync(filename, 'utf8').trimEnd().split('\n').pop() || '';
  }
  const state = await status(options);
  console.log(`Filter v${state.filterVersion || '?'} running=${state.running} state=${state.state} active=${state.stats?.activeRequests ?? 0} // 版本、运行状态、接入状态、正在处理的请求数`);
  console.log(`实时日志：SUCCESS 成功 / FAIL 本次失败 / WAIT 等待 / RETRY 重试 / EXHAUSTED 重试次数或期限耗尽 / DEGRADE 报错后降级历史。`);
  console.log('同一编号对应同一请求；PENDING 每 15 秒更新等待进度。网页观测台（图表与聚合）：node filter.cjs ui。');
  console.log('仅显示本窗口打开后的新日志；原始日志保留最近 24 小时，最多 4 MiB，繁忙时优先保留最新记录。');
  const print = line => {
    try { const value = formatLog(JSON.parse(line)); if (value) console.log(value); }
    catch { console.log('[log] unreadable entry // 该条日志无法解析'); }
  };
  let lastActivity = Date.now(), checking = false;
  const timer = setInterval(() => {
    try {
      const current = fs.statSync(filename), length = current.size;
      const nextIdentity = `${current.dev}:${current.ino}`;
      const replaced = nextIdentity !== identity || length < offset;
      if (replaced) { offset = 0; pending = Buffer.alloc(0); identity = nextIdentity; }
      if (length === offset) return;
      const bytes = Buffer.alloc(length - offset), fd = fs.openSync(filename, 'r');
      let read;
      try { read = fs.readSync(fd, bytes, 0, bytes.length, offset); } finally { fs.closeSync(fd); }
      offset += read;
      const combined = Buffer.concat([pending, bytes.subarray(0, read)]);
      const end = combined.lastIndexOf(10);
      if (end < 0) { pending = combined; return; }
      let lines = combined.subarray(0, end).toString('utf8').split(/\r?\n/);
      pending = combined.subarray(end + 1);
      if (replaced) {
        const previous = lines.lastIndexOf(lastLine);
        lines = previous >= 0 ? lines.slice(previous + 1) : lines.filter(line => {
          try { return Date.parse(JSON.parse(line).time) >= openedAt; } catch { return false; }
        });
      }
      for (const line of lines) { print(line); lastLine = line; lastActivity = Date.now(); }
    } catch (error) { if (error.code !== 'ENOENT') console.log('[log] cannot read log: ' + error.code + ' // 无法读取日志文件'); }
  }, 500);
  const idleTimer = setInterval(async () => {
    if (checking || Date.now() - lastActivity < 30000) return;
    checking = true;
    try {
      const current = await status(options);
      console.log(`[status] running=${current.running} state=${current.state} active=${current.stats?.activeRequests ?? 0} requests=${current.stats?.requests ?? 0} // 近 30 秒无新日志；这里只显示经过本过滤服务的请求`);
      lastActivity = Date.now();
    } catch (error) {
      console.log('[status] cannot read status: ' + (error.code || error.name) + ' // 状态读取失败，下次继续检查');
      lastActivity = Date.now();
    } finally { checking = false; }
  }, 30000);
  const close = () => { clearInterval(timer); clearInterval(idleTimer); process.exitCode = 0; };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required (built-in SQLite and zstd).');
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    console.log('node filter.cjs start|stop|status|logs|ui|serve [--port 18181] [--upstream http://127.0.0.1:15721] [--config PATH] [--runtime PATH] [--cc-db PATH]');
  } else if (options.command === 'serve') await serve(options);
  else if (options.command === 'logs') await logs(options);
  else if (options.command === 'ui') {
    const result = await ui(options);
    console.log('观测台地址（含本机访问令牌，请勿外传）: ' + result.url);
    if (!result.opened) console.log('请手动在浏览器打开上述地址。');
  } else console.log(JSON.stringify(await ({start, stop, status}[options.command])(options), null, 2));
}
if (require.main === module) main().catch(error => { console.error('Filter: ' + error.message); process.exitCode = 1; });
module.exports = {parseArgs, start, stop, status, serve, ui, request, formatLog, pruneLog, createLogWriter};
