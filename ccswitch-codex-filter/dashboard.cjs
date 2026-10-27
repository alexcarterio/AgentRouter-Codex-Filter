'use strict';

// Single-file dashboard served at /__codex_filter__/ui. No external assets:
// charts are hand-rolled SVG and data arrives over a token-gated SSE stream.

module.exports = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex 过滤观测台</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b1020; --card: rgba(255,255,255,.035); --border: rgba(255,255,255,.09);
    --text: #e6eaf2; --muted: #8a93a8; --accent: #6ea8fe; --ok: #34d399; --bad: #f87171;
    --warn: #fbbf24; --cancel: #94a3b8; --violet: #a78bfa; --cyan: #22d3ee;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: radial-gradient(1200px 600px at 80% -10%, rgba(110,168,254,.12), transparent), var(--bg);
    color: var(--text); font: 14px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  header { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    padding: 14px 22px; background: rgba(11,16,32,.85); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
  header h1 { font-size: 16px; margin: 0 14px 0 0; font-weight: 600; letter-spacing: .5px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
    border: 1px solid var(--border); background: var(--card); font-size: 12px; color: var(--muted); }
  .chip b { color: var(--text); font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.live { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .dot.down { background: var(--bad); box-shadow: 0 0 8px var(--bad); }
  main { padding: 18px 22px 40px; display: flex; flex-direction: column; gap: 16px; max-width: 1400px; margin: 0 auto; }
  .grid { display: grid; gap: 16px; }
  .g3 { grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
  .g2 { grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px; }
  .card h2 { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--muted); letter-spacing: .5px; }
  .card .sub { font-size: 11px; color: var(--muted); margin-bottom: 8px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
  .kpi { padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.03); border: 1px solid var(--border); }
  .kpi .v { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .kpi .l { font-size: 11px; color: var(--muted); }
  .kpi.ok .v { color: var(--ok); } .kpi.bad .v { color: var(--bad); } .kpi.acc .v { color: var(--accent); }
  .kpi.warn .v { color: var(--warn); } .kpi.violet .v { color: var(--violet); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,.04); font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  td.num, th.num { text-align: right; }
  .bar-row { display: grid; grid-template-columns: 110px 1fr 70px; gap: 8px; align-items: center; margin: 4px 0; }
  .bar-track { height: 10px; border-radius: 6px; background: rgba(255,255,255,.06); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 6px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--border); }
  .b-success { color: var(--ok); border-color: rgba(52,211,153,.4); background: rgba(52,211,153,.08); }
  .b-failed { color: var(--bad); border-color: rgba(248,113,113,.4); background: rgba(248,113,113,.08); }
  .b-canceled { color: var(--cancel); border-color: rgba(148,163,184,.4); background: rgba(148,163,184,.08); }
  .b-running { color: var(--accent); border-color: rgba(110,168,254,.4); background: rgba(110,168,254,.08); }
  .b-warn { color: var(--warn); border-color: rgba(251,191,36,.4); background: rgba(251,191,36,.08); }
  svg { display: block; width: 100%; }
  svg text { fill: var(--muted); font-size: 10px; font-family: inherit; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--muted); margin-top: 6px; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
  #login { max-width: 420px; margin: 18vh auto; text-align: center; }
  #login input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border);
    background: var(--card); color: var(--text); font-size: 14px; margin: 12px 0; }
  #login button { padding: 9px 22px; border-radius: 10px; border: 0; background: var(--accent); color: #08101f; font-weight: 600; cursor: pointer; }
  .hint { color: var(--muted); font-size: 12px; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .empty { color: var(--muted); font-size: 12px; padding: 12px 4px; }
  .scroll { max-height: 420px; overflow: auto; }
  .scroll::-webkit-scrollbar { width: 8px; height: 8px; }
  .scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 4px; }
</style>
</head>
<body>
<div id="login" style="display:none">
  <h1>Codex 过滤观测台</h1>
  <p class="hint">本页数据仅限本机访问。请粘贴访问令牌（运行 <b>node filter.cjs ui</b> 可获取带令牌的完整链接，或查看 .runtime/service.json）。</p>
  <input id="token" placeholder="访问令牌 token" autofocus>
  <button id="go">连接</button>
</div>
<div id="app" style="display:none">
<header>
  <h1>Codex 过滤观测台</h1>
  <span class="chip"><span id="connDot" class="dot"></span><span id="connText">连接中…</span></span>
  <span class="chip">服务 <b id="serviceState">-</b></span>
  <span class="chip">上游 <b id="upstream" class="mono">-</b></span>
  <span class="chip">版本 <b id="fver">-</b></span>
  <span class="chip">活跃 <b id="activeCount">0</b></span>
  <span class="chip" id="clockChip">数据更新 <b id="clock">-</b></span>
</header>
<main>
  <div class="card">
    <h2>今日事件总览（本机日期）</h2>
    <div class="sub">开始量计入请求开始当天；完成量、用量与重试事件计入发生当天。跨午夜请求可使今日完成量大于开始量。</div>
    <div class="kpis">
      <div class="kpi acc"><div class="v" id="kReqs">0</div><div class="l">开始请求</div></div>
      <div class="kpi ok"><div class="v" id="kOk">0</div><div class="l">成功</div></div>
      <div class="kpi bad"><div class="v" id="kFail">0</div><div class="l">失败</div></div>
      <div class="kpi"><div class="v" id="kCancel">0</div><div class="l">取消</div></div>
      <div class="kpi warn"><div class="v" id="kRetries">0</div><div class="l">重试执行</div></div>
      <div class="kpi ok"><div class="v" id="kAvoided">0</div><div class="l">重试后获成功响应</div></div>
      <div class="kpi acc"><div class="v" id="kTtfb">-</div><div class="l">今日平均首包延迟</div></div>
      <div class="kpi violet"><div class="v" id="kTokens">-</div><div class="l">累计 tokens (入/出)</div></div>
      <div class="kpi"><div class="v" id="kKept">-</div><div class="l">历史思维链保留/移除</div></div>
      <div class="kpi warn"><div class="v" id="kDegrade">0</div><div class="l">报错后降级请求</div></div>
    </div>
  </div>

  <div class="card" id="activeCard" style="display:none">
    <h2>正在处理</h2>
    <div id="activeList"></div>
  </div>

  <div class="grid g3">
    <div class="card"><h2>请求速率（每分钟）</h2><div class="sub">柱：成功/失败/取消；折线：重试调度</div><div id="chartRate"></div>
      <div class="legend"><span><i style="background:var(--ok)"></i>成功</span><span><i style="background:var(--bad)"></i>失败</span><span><i style="background:var(--cancel)"></i>取消</span><span><i style="background:var(--warn)"></i>重试</span></div></div>
    <div class="card"><h2>延迟（每分钟均值）</h2><div class="sub">首包 = 首次转发上游内容；总耗时仅统计成功请求</div><div id="chartLatency"></div>
      <div class="legend"><span><i style="background:var(--accent)"></i>首包</span><span><i style="background:var(--violet)"></i>成功总耗时</span></div></div>
    <div class="card"><h2>Token 流量（每分钟）</h2><div class="sub">来自 response.completed 的 usage</div><div id="chartTokens"></div>
      <div class="legend"><span><i style="background:var(--cyan)"></i>输入</span><span><i style="background:var(--violet)"></i>输出</span></div></div>
  </div>

  <div class="grid g2">
    <div class="card"><h2>错误分类</h2><div class="sub">按重试类别与错误码聚合</div><div id="errKinds"></div>
      <div class="scroll" style="margin-top:10px"><table><thead><tr><th>错误码</th><th class="num">次数</th></tr></thead><tbody id="errCodes"></tbody></table></div></div>
    <div class="card"><h2>重试效果</h2><div class="sub">重试真的有效吗？这里按类别给出恢复率</div><div id="retryTable"></div></div>
  </div>

  <div class="grid g2">
    <div class="card"><h2>首包延迟分布</h2><div id="histTtfb"></div></div>
    <div class="card"><h2>总耗时分布（成功/失败）</h2><div id="histTotal"></div></div>
  </div>

  <div class="card">
    <h2>最近请求</h2>
    <div class="sub">最多保留 200 条，新请求在顶部；不含任何正文或密钥</div>
    <div class="scroll"><table><thead><tr><th>#</th><th>开始时间</th><th>模型</th><th>结果</th><th class="num">耗时</th><th class="num">首包</th><th class="num">重试调度</th><th>错误</th><th class="num">tokens (入/出)</th></tr></thead>
    <tbody id="reqRows"></tbody></table></div>
  </div>
  <div class="hint" style="text-align:center">数据来自过滤层内存聚合，每秒推送；重启后保留当日累计。原始日志仍可用 node filter.cjs logs 查看。</div>
</main>
</div>
<script>
(function () {
  var ADMIN = '/__codex_filter__';
  var KIND_NAME = {resource: '资源归属', rateLimit: '限流', transport: '断流/网关', availability: '无可用渠道'};
  var CODE_NOTE = {different_azure: '历史属于另一 Azure 资源', rate_limit: '上游限流', stream_incomplete: '断流/超时',
    alb_bad_request: 'ALB 网关 HTML 400', gateway_error: '网关错误', ccswitch_unavailable: 'CC Switch 不可用',
    no_available_channel: '无可用渠道', upstream_failed_without_details: 'response.failed 无详情',
    response_too_large: '响应超大小上限'};
  var token = '';
  try { token = localStorage.getItem('codexFilterToken') || ''; } catch (e) {}
  // A hash token always wins: restarting the service issues a new token, and a
  // hash-only navigation does not reload the page by itself.
  if (location.hash.length > 1) token = decodeURIComponent(location.hash.slice(1));
  if (token) { try { localStorage.setItem('codexFilterToken', token); } catch (e) {} }
  if (!token) {
    document.getElementById('login').style.display = 'block';
    document.getElementById('go').onclick = function () {
      var value = document.getElementById('token').value.trim();
      if (!value) return;
      try { localStorage.setItem('codexFilterToken', value); } catch (e) {}
      location.hash = '#' + encodeURIComponent(value); location.reload();
    };
    document.getElementById('token').addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('go').click(); });
    return;
  }
  document.getElementById('app').style.display = 'block';

  var el = function (id) { return document.getElementById(id); };
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c];
    });
  }
  var fmtInt = function (n) { return (n || 0).toLocaleString('zh-CN'); };
  var fmtSec = function (ms) { return ms == null ? '-' : ms < 10000 ? (ms / 1000).toFixed(2) + 's' : (ms / 1000).toFixed(1) + 's'; };
  function fmtBytes(n) {
    if (!n) return '0';
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1048576).toFixed(1) + 'MB';
  }
  function fmtClock(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  }
  function fmtMinute(minute) {
    var d = new Date(minute * 60000);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function render(snapshot, state) {
    var t = snapshot.totals;
    el('serviceState').textContent = state && state.state ? state.state : '-';
    el('serviceState').style.color = state && state.state === 'filtering' ? 'var(--ok)' : 'var(--warn)';
    el('upstream').textContent = state && state.upstream ? state.upstream.replace('http://', '') : '-';
    el('fver').textContent = 'v' + (state && state.filterVersion != null ? state.filterVersion : '?');
    el('activeCount').textContent = snapshot.active.length;
    el('clock').textContent = fmtClock(snapshot.generatedAt);
    el('kReqs').textContent = fmtInt(t.requests);
    el('kOk').textContent = fmtInt(t.success);
    el('kFail').textContent = fmtInt(t.failed);
    el('kCancel').textContent = fmtInt(t.canceled);
    el('kRetries').textContent = fmtInt(t.retriesExecuted);
    el('kAvoided').textContent = fmtInt(t.clientErrorsAvoided);
    el('kTtfb').textContent = t.ttfbSamples ? fmtSec(t.ttfbMs / t.ttfbSamples) : '-';
    el('kTokens').textContent = fmtInt(t.inputTokens) + ' / ' + fmtInt(t.outputTokens);
    el('kKept').textContent = fmtInt(t.reasoningKept) + ' / ' + fmtInt(t.reasoningRemoved);
    el('kDegrade').textContent = fmtInt(t.degradedRequests);

    var active = el('activeList'); active.innerHTML = '';
    el('activeCard').style.display = snapshot.active.length ? 'block' : 'none';
    var PHASE = {waiting: ['等待上游', 'b-running'], backoff: ['退避等待重试', 'b-warn'], streaming: ['流式输出中', 'b-success']};
    snapshot.active.forEach(function (r) {
      var phase = PHASE[r.phase] || [r.phase, 'b-running'];
      var div = document.createElement('div');
      div.style.cssText = 'display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05);flex-wrap:wrap';
      div.innerHTML = '<span class="mono">#' + esc(r.id) + '</span>' +
        '<span class="badge ' + phase[1] + '">' + esc(phase[0]) + '</span>' +
        '<span class="hint">' + esc(r.model || '未知模型') + (r.kinds.length ? ' · 已触发重试: ' + esc(r.kinds.map(function (k) { return KIND_NAME[k] || k; }).join(',')) : '') + (r.degraded ? ' · 已降级' : '') + '</span>' +
        '<span class="mono" style="margin-left:auto">' + fmtSec(r.elapsedMs) + '</span>';
      active.appendChild(div);
    });

    renderRate(snapshot.series);
    renderLatency(snapshot.series);
    renderTokens(snapshot.series);
    renderErrors(snapshot);
    renderRetry(snapshot);
    renderHist(el('histTtfb'), snapshot.ttfb, 'var(--accent)', 'ms');
    var merged = snapshot.total.counts.map(function (c, i) { return c + (snapshot.totalFailed.counts[i] || 0); });
    renderHist(el('histTotal'), {bounds: snapshot.total.bounds, counts: merged}, 'var(--violet)', 's');
    renderRequests(snapshot.recent);
  }

  function svgOpen(height) { return '<svg viewBox="0 0 600 ' + height + '" preserveAspectRatio="none" style="height:' + height + 'px">'; }
  function chartFrame(height, pad) {
    return '<line x1="' + pad + '" y1="' + (height - 16) + '" x2="596" y2="' + (height - 16) + '" stroke="rgba(255,255,255,.12)"/>';
  }
  function renderRate(rows) {
    var H = 170, pad = 8, W = 600, bottom = H - 16, top = 6;
    var max = 4;
    rows.forEach(function (r) { max = Math.max(max, r.started, r.retries); });
    var bw = rows.length ? Math.max(2, (W - 20) / rows.length - 2) : 0;
    var html = svgOpen(H) + chartFrame(H, pad);
    rows.forEach(function (r, i) {
      var x = 12 + i * ((W - 20) / rows.length);
      var scale = function (v) { return Math.min(1, v / max) * (bottom - top); };
      var parts = [['success', 'var(--ok)'], ['failed', 'var(--bad)'], ['canceled', 'var(--cancel)']];
      var y = bottom;
      parts.forEach(function (p) {
        var h = scale(r[p[0]]);
        if (h > 0) { y -= h; html += '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" fill="' + p[1] + '" opacity=".85"/>'; }
      });
    });
    if (rows.length > 1) {
      var pts = rows.map(function (r, i) {
        var x = 12 + i * ((W - 20) / rows.length) + bw / 2;
        return x + ',' + (bottom - Math.min(1, r.retries / max) * (bottom - top));
      }).join(' ');
      html += '<polyline points="' + pts + '" fill="none" stroke="var(--warn)" stroke-width="1.5" opacity=".9"/>';
    }
    var labelEvery = Math.ceil(rows.length / 6);
    rows.forEach(function (r, i) {
      if (i % labelEvery) return;
      html += '<text x="' + (12 + i * ((W - 20) / rows.length)) + '" y="' + (H - 3) + '">' + fmtMinute(r.minute) + '</text>';
    });
    html += '<text x="596" y="12" text-anchor="end">峰值 ' + max + '</text></svg>';
    el('chartRate').innerHTML = rows.length ? html : '<div class="empty">暂无数据，等待请求…</div>';
  }

  function renderLines(rows, series, maxMs, color) {
    var H = 170, bottom = 154, top = 6, W = 600;
    var html = svgOpen(H) + '<line x1="8" y1="' + bottom + '" x2="596" y2="' + bottom + '" stroke="rgba(255,255,255,.12)"/>';
    var grid = [0.25, 0.5, 0.75];
    grid.forEach(function (g) {
      var y = bottom - g * (bottom - top);
      html += '<line x1="8" y1="' + y + '" x2="596" y2="' + y + '" stroke="rgba(255,255,255,.05)"/>';
      html += '<text x="10" y="' + (y - 3) + '">' + fmtSec(maxMs * g) + '</text>';
    });
    series.forEach(function (s) {
      var points = [];
      rows.forEach(function (r, i) {
        if (!s.pick(r)) return;
        var x = 12 + i * ((W - 20) / Math.max(1, rows.length));
        var v = s.pick(r) / Math.max(1, s.count(r));
        var y = bottom - Math.min(1, v / maxMs) * (bottom - top);
        points.push([x, +y.toFixed(1)]);
      });
      if (points.length === 1) {
        html += '<circle cx="' + points[0][0] + '" cy="' + points[0][1] + '" r="4" fill="' + color[s.i] + '"/>';
      } else if (points.length > 1) {
        html += '<polyline points="' + points.map(function (p) { return p[0] + ',' + p[1]; }).join(' ')
          + '" fill="none" stroke="' + color[s.i] + '" stroke-width="1.6"/>';
      }
    });
    var labelEvery = Math.ceil(rows.length / 6);
    rows.forEach(function (r, i) {
      if (i % labelEvery) return;
      html += '<text x="' + (12 + i * ((W - 20) / Math.max(1, rows.length))) + '" y="' + (H - 3) + '">' + fmtMinute(r.minute) + '</text>';
    });
    return html + '</svg>';
  }
  function renderLatency(rows) {
    var live = rows.filter(function (r) { return r.totalSamples || r.ttfbSamples; });
    if (!live.length) { el('chartLatency').innerHTML = '<div class="empty">暂无数据</div>'; return; }
    var maxMs = 1000;
    rows.forEach(function (r) {
      if (r.ttfbSamples) maxMs = Math.max(maxMs, r.ttfbMs / r.ttfbSamples);
      if (r.totalSamples) maxMs = Math.max(maxMs, r.totalMs / r.totalSamples);
    });
    maxMs *= 1.2;
    el('chartLatency').innerHTML = renderLines(rows, [
      {i: 0, pick: function (r) { return r.ttfbSamples ? r.ttfbMs : 0; }, count: function (r) { return r.ttfbSamples || 1; }},
      {i: 1, pick: function (r) { return r.totalSamples ? r.totalMs : 0; }, count: function (r) { return r.totalSamples || 1; }}
    ], maxMs, ['var(--accent)', 'var(--violet)']);
  }
  function renderTokens(rows) {
    var max = 1;
    rows.forEach(function (r) { max = Math.max(max, r.inputTokens, r.outputTokens); });
    var H = 170, bottom = 154, top = 6, W = 600;
    var html = svgOpen(H) + '<line x1="8" y1="' + bottom + '" x2="596" y2="' + bottom + '" stroke="rgba(255,255,255,.12)"/>';
    [['inputTokens', 'var(--cyan)'], ['outputTokens', 'var(--violet)']].forEach(function (s) {
      var pts = '12,' + bottom + ' ';
      rows.forEach(function (r, i) {
        var x = 12 + i * ((W - 20) / Math.max(1, rows.length));
        pts += x + ',' + (bottom - Math.min(1, r[s[0]] / max) * (bottom - top)) + ' ';
      });
      pts += '596,' + bottom;
      html += '<polygon points="' + pts + '" fill="' + s[1] + '" opacity=".18"/>';
      var line = '';
      rows.forEach(function (r, i) {
        var x = 12 + i * ((W - 20) / Math.max(1, rows.length));
        line += (line ? ' ' : '') + x + ',' + (bottom - Math.min(1, r[s[0]] / max) * (bottom - top));
      });
      if (rows.length) html += '<polyline points="' + line + '" fill="none" stroke="' + s[1] + '" stroke-width="1.4"/>';
    });
    var labelEvery = Math.ceil(rows.length / 6);
    rows.forEach(function (r, i) {
      if (i % labelEvery) return;
      html += '<text x="' + (12 + i * ((W - 20) / Math.max(1, rows.length))) + '" y="' + (H - 3) + '">' + fmtMinute(r.minute) + '</text>';
    });
    html += '<text x="596" y="12" text-anchor="end">峰值 ' + fmtInt(max) + '</text></svg>';
    el('chartTokens').innerHTML = rows.length ? html : '<div class="empty">暂无数据</div>';
  }

  function renderErrors(s) {
    var kinds = Object.entries(s.errorsByKind);
    var max = 1;
    kinds.forEach(function (k) { max = Math.max(max, k[1]); });
    var colors = {resource: 'var(--warn)', rateLimit: 'var(--bad)', transport: 'var(--accent)', availability: 'var(--violet)', other: 'var(--cancel)'};
    el('errKinds').innerHTML = kinds.length ? kinds.sort(function (a, b) { return b[1] - a[1]; }).map(function (k) {
      var pct = Math.round(k[1] / max * 100);
      return '<div class="bar-row"><span>' + esc(KIND_NAME[k[0]] || k[0]) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + (colors[k[0]] || 'var(--cancel)') + '"></div></div><span class="num" style="text-align:right">' + fmtInt(k[1]) + '</span></div>';
    }).join('') : '<div class="empty">没有错误，运行顺畅</div>';
    var codes = Object.entries(s.errorsByCode).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 12);
    el('errCodes').innerHTML = codes.map(function (c) {
      return '<tr><td class="mono" title="' + esc(CODE_NOTE[c[0]] || '') + '">' + esc(c[0]) + '</td><td class="num">' + fmtInt(c[1]) + '</td></tr>';
    }).join('') || '<tr><td colspan="2" class="empty">无</td></tr>';
  }

  function renderRetry(s) {
    var rows = Object.entries(s.retry).map(function (entry) {
      var k = entry[1];
      var settled = k.recoveredRequests + k.exhaustedRequests;
      var rate = settled ? Math.round(100 * k.recoveredRequests / settled) : null;
      return '<tr><td>' + esc(KIND_NAME[entry[0]] || entry[0]) + '</td><td class="num">' + fmtInt(k.scheduled) + '</td><td class="num">' + fmtInt(k.executed) + '</td><td class="num" style="color:var(--ok)">' + fmtInt(k.recoveredRequests) + '</td><td class="num" style="color:var(--bad)">' + fmtInt(k.exhaustedRequests) + '</td><td class="num">' + (rate == null ? '-' : rate + '%') + '</td><td class="num">' + fmtSec(k.waitMs) + '</td></tr>';
    });
    el('retryTable').innerHTML = '<table><thead><tr><th>类别</th><th class="num">调度</th><th class="num">执行</th><th class="num">恢复</th><th class="num">耗尽</th><th class="num">恢复占比</th><th class="num">计划等待</th></tr></thead><tbody>' +
      rows.join('') + '</tbody></table>' +
      '<div class="hint" style="margin-top:8px">恢复占比 = 恢复 ÷ (恢复+耗尽)，不含取消及其他终止；同一请求可涉及多个类别。重试后获成功响应 <b>' + fmtInt(s.totals.clientErrorsAvoided) + '</b> 次；计划等待 <b>' + fmtSec(s.totals.retryWaitMs) + '</b>，取消前未等满也计入。</div>';
  }

  function renderHist(target, hist, color, unit) {
    var counts = hist.counts, bounds = hist.bounds;
    var labels = bounds.map(function (b) { return unit === 's' ? (b / 1000) + 's' : b >= 1000 ? (b / 1000) + 's' : b + 'ms'; });
    var names = ['≤' + labels[0]];
    for (var i = 1; i < labels.length; i++) names.push(labels[i - 1] + '~' + labels[i]);
    names.push('>' + labels[labels.length - 1]);
    var max = 1, sum = 0;
    counts.forEach(function (c) { max = Math.max(max, c); sum += c; });
    var html = counts.map(function (c, i) {
      var pct = Math.round(c / max * 100);
      var share = sum ? Math.round(100 * c / sum) : 0;
      return '<div class="bar-row" title="' + names[i] + '"><span style="font-size:11px">' + names[i] + '</span><div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div><span style="text-align:right;font-size:11px">' + fmtInt(c) + ' (' + share + '%)</span></div>';
    }).join('');
    target.innerHTML = sum ? html : '<div class="empty">暂无数据</div>';
  }

  function renderRequests(recent) {
    var rows = recent.slice().reverse().map(function (r) {
      var badge = r.outcome ? ({success: ['成功', 'b-success'], failed: ['失败', 'b-failed'], canceled: ['取消', 'b-canceled']}[r.outcome] || [r.outcome, '']) : ['进行中', 'b-running'];
      var errors = r.codes.length ? r.codes.map(function (c) { return CODE_NOTE[c] || c; }).join('、') : (r.degraded ? '报错后已降级重试' : '');
      var retryNote = r.retries ? r.retries + '次(' + r.kinds.map(function (k) { return KIND_NAME[k] || k; }).join(',') + ')' : '-';
      return '<tr><td class="mono">' + esc(r.id) + '</td><td>' + fmtClock(new Date(r.startTs).toISOString()) + '</td><td class="mono">' + esc(r.model || '-') + '</td>' +
        '<td><span class="badge ' + badge[1] + '">' + esc(badge[0]) + '</span></td>' +
        '<td class="num">' + fmtSec(r.durationMs) + '</td><td class="num">' + fmtSec(r.ttfbMs) + '</td>' +
        '<td class="num">' + esc(retryNote) + '</td><td class="hint" style="white-space:normal;min-width:120px">' + esc(errors) + '</td>' +
        '<td class="num">' + (r.tokens ? fmtInt(r.tokens.input) + ' / ' + fmtInt(r.tokens.output) : '-') + '</td></tr>';
    });
    el('reqRows').innerHTML = rows.join('') || '<tr><td colspan="9" class="empty">还没有请求经过过滤层</td></tr>';
  }

  function connect() {
    var source = new EventSource(ADMIN + '/ui/stream?token=' + encodeURIComponent(token));
    source.addEventListener('snapshot', function (event) {
      var payload = JSON.parse(event.data);
      el('connDot').className = 'dot live';
      el('connText').textContent = '实时';
      render(payload.snapshot, payload.state);
    });
    source.onerror = function () {
      el('connDot').className = 'dot down';
      el('connText').textContent = '连接断开，重试中…';
    };
  }
  connect();
})();
</script>
</body>
</html>`;
