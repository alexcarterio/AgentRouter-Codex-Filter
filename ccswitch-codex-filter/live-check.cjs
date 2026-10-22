'use strict';

// One short, ephemeral turn through the installed Codex client. No coding work is delegated.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {providerBase} = require('./config.cjs');
const {SERVICE, ADMIN, decodeBody} = require('./proxy.cjs');
const {request} = require('./filter.cjs');

function codexExecutable() {
  const override = process.argv.indexOf('--codex');
  if (override >= 0 && process.argv[override + 1]) return path.resolve(process.argv[override + 1]);
  const relative = [
    'codex.exe',
    'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
    'node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
  ];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    for (const suffix of relative) {
      const candidate = path.join(directory, suffix);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Cannot locate Codex CLI. Supply --codex C:\\path\\to\\codex.exe');
}
async function main() {
  const configHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const config = fs.readFileSync(path.join(configHome, 'config.toml'), 'utf8');
  const provider = providerBase(config);
  if (!provider || !/^[A-Za-z0-9_-]+$/.test(provider.provider)) throw new Error('No supported active provider.');
  const base = new URL(provider.url);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Start the filter first.');
  const before = await request(base.origin, ADMIN + '/health');
  if (before.service !== SERVICE || before.state !== 'filtering') throw new Error('Configured address is not an attached filter.');
  const executable = codexExecutable();
  const baseline = process.argv.includes('--baseline');
  const target = baseline ? new URL(before.upstream) : base;
  let injected = 0, injectedItemIds = 0;
  const upstreamStatuses = [];
  const sockets = new Set();
  // Inject historical messages/tools and deliberately invalid reasoning ahead of the filter.
  // Retain the actual Codex headers: some upstreams reject generic HTTP clients.
  const bridge = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 64 * 1024 * 1024) throw new Error('Probe request is too large.');
        chunks.push(chunk);
      }
      const headers = {...req.headers, host: target.host};
      let body = Buffer.concat(chunks);
      if (!baseline && req.method === 'POST' && /\/responses\/?(?:\?|$)/.test(req.url)) {
        const parsed = JSON.parse(decodeBody(body, headers['content-encoding'], 64 * 1024 * 1024));
        if (!Array.isArray(parsed.input)) throw new Error('Expected complete Codex history.');
        parsed.input.push({type: 'reasoning', id: 'rs_filter_probe', summary: [],
          encrypted_content: 'deliberately-invalid-foreign-account-ciphertext'});
        const history = [
          {type: 'message', id: 'msg_filter_probe', role: 'assistant',
            content: [{type: 'output_text', text: 'Previous connection check completed.'}]},
          {type: 'function_call', id: 'fc_filter_probe', call_id: 'call_filter_function_probe',
            name: 'completed_connection_check', arguments: '{}'},
          {type: 'function_call_output', id: 'fco_filter_probe', call_id: 'call_filter_function_probe', output: 'Completed.'},
          {type: 'custom_tool_call', id: 'ctc_filter_probe',
            call_id: 'call_filter_custom_probe', name: 'completed_custom_check', input: 'check'},
          {type: 'custom_tool_call_output', id: 'ctco_filter_probe', call_id: 'call_filter_custom_probe', output: 'Completed.'}
        ];
        // Put completed history before the client's final user instruction.
        parsed.input.unshift(...history);
        injectedItemIds += history.length;
        parsed.max_output_tokens = 512;
        body = Buffer.from(JSON.stringify(parsed));
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        headers['content-length'] = String(body.length);
        injected++;
      }
      const upstream = http.request({hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers}, response => {
        if (req.method === 'POST' && /\/responses\/?(?:\?|$)/.test(req.url)) upstreamStatuses.push(response.statusCode);
        res.writeHead(response.statusCode, response.headers);
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
      upstream.end(body);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end('Local probe could not prepare the request.');
    }
  });
  bridge.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(0, '127.0.0.1', resolve); });
  const bridgeBase = 'http://127.0.0.1:' + bridge.address().port + base.pathname.replace(/\/$/, '');
  const child = spawn(executable, ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
    '-c', 'model_providers.' + provider.provider + '.base_url=' + JSON.stringify(bridgeBase),
    '-c', 'model_providers.' + provider.provider + '.request_max_retries=0',
    '-c', 'model_providers.' + provider.provider + '.stream_max_retries=0',
    '-c', 'model_reasoning_effort="low"',
    'This is a connectivity test. Reply with exactly FILTER_OK. Do not use tools or change files.'],
    {cwd: __dirname, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '', completed = false, cliError = false;
  child.stderr.resume();
  const lines = readline.createInterface({input: child.stdout});
  lines.on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') output += event.item.text;
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'turn.failed' || event.type === 'error') cliError = true;
  });
  let timer;
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
      timer = setTimeout(() => { child.kill(); reject(new Error('Live probe timed out.')); }, 90000);
    });
    const after = await request(base.origin, ADMIN + '/health');
    const removed = after.stats.removedReasoningItems - before.stats.removedReasoningItems;
    const removedItemIds = (after.stats.removedItemIds || 0) - (before.stats.removedItemIds || 0);
    const passed = exitCode === 0 && completed && output.trim() === 'FILTER_OK'
      && (baseline || (injected >= 1 && removed >= injected && removedItemIds >= injectedItemIds));
    console.log(JSON.stringify({passed, baseline, client: 'installed Codex CLI', exitCode, completed, cliError,
      expectedOutputReceived: output.trim() === 'FILTER_OK', upstreamStatuses,
      injectedReasoningItems: injected, removedReasoningItems: removed, injectedItemIds, removedItemIds}, null, 2));
    if (!passed) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    child.kill(); lines.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => bridge.close(resolve));
  }
}
main().catch(error => { console.error('Live probe: ' + error.message); process.exitCode = 1; });
