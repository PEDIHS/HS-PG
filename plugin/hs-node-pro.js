(() => {
  'use strict';

  const VERSION = '0.6.0';
  const STYLE_ID = 'hs-node-pro-style';
  const BLOCK_CLASS = 'hs-node-pro';
  const CARD_CLASS = 'hs-node-pro-card';
  const IP_CLASS = 'hs-node-ip-value';
  const IP_BUTTON_CLASS = 'hs-node-ip-toggle';
  const rawFetch = window.fetch.bind(window);

  let enabled = false;
  let refreshTimer = null;
  let stateTimer = null;
  let observer = null;
  let nodesCache = [];
  let statsCache = {};
  let busy = false;
  let renderQueued = false;

  const history = new Map();
  const revealedIps = new Set();

  const css = `
    .${CARD_CLASS}{
      min-width:0!important;
      overflow:hidden!important;
      transition:border-color .2s ease,box-shadow .2s ease!important;
    }
    .${CARD_CLASS}:hover{
      border-color:color-mix(in srgb,var(--border) 76%,#38e88c 24%)!important;
      box-shadow:0 8px 24px rgba(0,0,0,.11)!important;
    }
    .${BLOCK_CLASS}{
      margin-top:.58rem;
      padding-top:.58rem;
      border-top:1px solid color-mix(in srgb,var(--border) 80%,transparent);
      color:var(--foreground);
      pointer-events:none;
      min-width:0;
    }
    .${BLOCK_CLASS}-resources{
      display:grid;
      grid-template-columns:minmax(0,1fr) minmax(0,1fr);
      gap:7px;
      min-width:0;
    }
    .${BLOCK_CLASS}-metric{
      min-width:0;
      height:66px;
      padding:9px 10px 8px;
      overflow:hidden;
      border:1px solid color-mix(in srgb,var(--border) 84%,transparent);
      border-radius:11px;
      background:linear-gradient(145deg,color-mix(in srgb,var(--card) 97%,#17212c 3%),color-mix(in srgb,var(--card) 99%,#090d12 1%));
      box-shadow:inset 0 1px rgba(255,255,255,.015);
    }
    .${BLOCK_CLASS}-head{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:8px;
      min-width:0;
    }
    .${BLOCK_CLASS}-title{
      display:flex;
      align-items:center;
      gap:5px;
      min-width:0;
      color:var(--muted-foreground);
      font-size:9.5px;
      line-height:1;
      font-weight:650;
      letter-spacing:.01em;
      white-space:nowrap;
    }
    .${BLOCK_CLASS}-title svg{width:11px;height:11px;flex:none}
    .${BLOCK_CLASS}-usage{
      min-width:0;
      color:color-mix(in srgb,var(--foreground) 88%,var(--muted-foreground) 12%);
      font-size:9px;
      line-height:1;
      font-weight:600;
      font-variant-numeric:tabular-nums;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      text-align:right;
    }
    .${BLOCK_CLASS}-chart-row{
      display:grid;
      grid-template-columns:minmax(0,1fr) 34px;
      align-items:end;
      gap:7px;
      margin-top:7px;
      min-width:0;
    }
    .${BLOCK_CLASS}-spark{
      position:relative;
      height:27px;
      min-width:0;
      overflow:hidden;
      border-radius:7px;
      background:linear-gradient(180deg,transparent 0%,color-mix(in srgb,var(--muted) 23%,transparent) 100%);
    }
    .${BLOCK_CLASS}-spark::after{
      content:'';
      position:absolute;
      left:0;
      right:0;
      bottom:1px;
      height:1px;
      background:color-mix(in srgb,var(--border) 58%,transparent);
    }
    .${BLOCK_CLASS}-spark svg,
    .${BLOCK_CLASS}-mini-spark svg{display:block;width:100%;height:100%;overflow:visible}
    .${BLOCK_CLASS}-spark path,
    .${BLOCK_CLASS}-mini-spark path{
      fill:none;
      stroke-width:2;
      stroke-linecap:round;
      stroke-linejoin:round;
      vector-effect:non-scaling-stroke;
    }
    .${BLOCK_CLASS}-spark.green path,.${BLOCK_CLASS}-mini-spark.green path{stroke:#38e88c;filter:drop-shadow(0 0 2.5px rgba(56,232,140,.24))}
    .${BLOCK_CLASS}-spark.purple path,.${BLOCK_CLASS}-mini-spark.purple path{stroke:#9c86ff;filter:drop-shadow(0 0 2.5px rgba(156,134,255,.22))}
    .${BLOCK_CLASS}-spark.blue path,.${BLOCK_CLASS}-mini-spark.blue path{stroke:#43a7ff;filter:drop-shadow(0 0 2.5px rgba(67,167,255,.22))}
    .${BLOCK_CLASS}-percent{
      align-self:center;
      color:var(--foreground);
      font-size:11px;
      line-height:1;
      font-weight:700;
      font-variant-numeric:tabular-nums;
      text-align:right;
      white-space:nowrap;
    }
    .${BLOCK_CLASS}-network{
      display:grid;
      grid-template-columns:auto minmax(0,1fr) minmax(0,1fr);
      align-items:center;
      gap:10px;
      min-width:0;
      height:55px;
      margin-top:7px;
      padding:8px 10px;
      border:1px solid color-mix(in srgb,var(--border) 84%,transparent);
      border-radius:11px;
      background:linear-gradient(145deg,color-mix(in srgb,var(--card) 97%,#17212c 3%),color-mix(in srgb,var(--card) 99%,#090d12 1%));
      box-shadow:inset 0 1px rgba(255,255,255,.015);
    }
    .${BLOCK_CLASS}-network-title{
      display:flex;
      align-items:center;
      gap:5px;
      color:var(--muted-foreground);
      font-size:9.5px;
      line-height:1;
      font-weight:650;
      white-space:nowrap;
    }
    .${BLOCK_CLASS}-network-title svg{width:11px;height:11px}
    .${BLOCK_CLASS}-net-item{
      display:grid;
      grid-template-columns:auto minmax(0,1fr);
      grid-template-rows:auto 13px;
      column-gap:6px;
      row-gap:4px;
      min-width:0;
      padding-left:10px;
      border-left:1px solid color-mix(in srgb,var(--border) 76%,transparent);
    }
    .${BLOCK_CLASS}-net-label{
      display:flex;
      align-items:center;
      gap:3px;
      color:var(--muted-foreground);
      font-size:7.5px;
      line-height:1;
      white-space:nowrap;
    }
    .${BLOCK_CLASS}-down{color:#43a7ff;font-size:9px}
    .${BLOCK_CLASS}-up{color:#38e88c;font-size:9px}
    .${BLOCK_CLASS}-net-value{
      min-width:0;
      color:var(--foreground);
      font-size:9.5px;
      line-height:1;
      font-weight:700;
      font-variant-numeric:tabular-nums;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      text-align:right;
    }
    .${BLOCK_CLASS}-mini-spark{
      grid-column:1/-1;
      height:13px;
      min-width:0;
      opacity:.88;
    }
    .${BLOCK_CLASS}-error{color:var(--muted-foreground);font-size:9px;padding:.1rem 0}

    .${IP_CLASS}{
      display:inline-block;
      min-width:92px;
      max-width:170px;
      overflow:hidden;
      text-overflow:ellipsis;
      vertical-align:middle;
      font-variant-numeric:tabular-nums;
    }
    .${IP_BUTTON_CLASS}{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      width:23px;
      height:23px;
      margin-left:4px;
      padding:0;
      border:0;
      border-radius:7px;
      background:transparent;
      color:var(--muted-foreground);
      vertical-align:middle;
      cursor:pointer;
      pointer-events:auto;
      transition:background .15s ease,color .15s ease;
    }
    .${IP_BUTTON_CLASS}:hover{background:color-mix(in srgb,var(--muted) 70%,transparent);color:var(--foreground)}
    .${IP_BUTTON_CLASS}:focus-visible{outline:2px solid color-mix(in srgb,var(--primary) 65%,transparent);outline-offset:1px}
    .${IP_BUTTON_CLASS} svg{width:13px;height:13px}

    @media(max-width:390px){
      .${BLOCK_CLASS}-resources{gap:6px}
      .${BLOCK_CLASS}-metric{height:64px;padding:8px}
      .${BLOCK_CLASS}-usage{font-size:8px}
      .${BLOCK_CLASS}-chart-row{grid-template-columns:minmax(0,1fr) 31px;gap:5px}
      .${BLOCK_CLASS}-network{grid-template-columns:auto 1fr 1fr;gap:6px;padding:7px 8px}
      .${BLOCK_CLASS}-net-item{padding-left:7px}
      .${BLOCK_CLASS}-network-title span{display:none}
    }
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function authHeaders(extra) {
    const headers = new Headers(extra || {});
    const token = localStorage.getItem('token');
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }

  async function jsonFetch(path) {
    const response = await rawFetch(path, { credentials: 'same-origin', headers: authHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
    return data;
  }

  function onNodesPage() {
    return window.location.pathname === '/nodes' || window.location.pathname.startsWith('/nodes/') || /#\/nodes(?:\/|$)/.test(window.location.hash);
  }

  function clamp(value, min = 0, max = 100) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  function formatBytes(value) {
    let n = Number(value) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let unit = 0;
    while (Math.abs(n) >= 1024 && unit < units.length - 1) {
      n /= 1024;
      unit += 1;
    }
    const digits = n >= 100 || unit === 0 ? 0 : n >= 10 ? 1 : 2;
    return `${n.toFixed(digits)} ${units[unit]}`;
  }

  function formatRate(value) {
    return `${formatBytes(value)}/s`;
  }

  function formatCoreValue(value) {
    const n = Math.max(0, Number(value) || 0);
    if (n >= 10) return n.toFixed(1);
    if (n >= 1) return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return n.toFixed(2);
  }

  function pushHistory(nodeId, key, value) {
    const id = String(nodeId);
    if (!history.has(id)) history.set(id, {});
    const bucket = history.get(id);
    if (!Array.isArray(bucket[key])) bucket[key] = [];
    bucket[key].push(Number(value) || 0);
    if (bucket[key].length > 24) bucket[key].shift();
  }

  function getHistory(nodeId, key) {
    const values = history.get(String(nodeId))?.[key];
    return Array.isArray(values) && values.length ? values : [0, 0];
  }

  function sampleHistory() {
    for (const node of nodesCache) {
      const stats = statsCache[String(node.id)] ?? statsCache[node.id] ?? null;
      if (!stats) continue;
      const ramPct = stats.mem_total ? clamp((Number(stats.mem_used) / Number(stats.mem_total)) * 100) : 0;
      pushHistory(node.id, 'cpu', clamp(stats.cpu_usage));
      pushHistory(node.id, 'ram', ramPct);
      pushHistory(node.id, 'rx', Number(stats.incoming_bandwidth_speed) || 0);
      pushHistory(node.id, 'tx', Number(stats.outgoing_bandwidth_speed) || 0);
    }
  }

  function smoothSeries(values, alpha = .42) {
    const source = Array.isArray(values) && values.length ? values.map(v => Number(v) || 0) : [0, 0];
    if (source.length < 2) return source;
    const out = [source[0]];
    for (let i = 1; i < source.length; i += 1) {
      out.push(out[i - 1] + alpha * (source[i] - out[i - 1]));
    }
    return out;
  }

  function pointSeries(values, width, height, pad, fixedMin = null, fixedMax = null) {
    const source = smoothSeries(values);
    const min = Number.isFinite(fixedMin) ? fixedMin : Math.min(...source);
    const max = Number.isFinite(fixedMax) ? fixedMax : Math.max(...source);
    const range = Math.max(1, max - min);
    const step = source.length > 1 ? (width - pad * 2) / (source.length - 1) : 0;
    return source.map((value, index) => ({
      x: pad + index * step,
      y: height - pad - ((clamp(value, min, max) - min) / range) * (height - pad * 2),
    }));
  }

  function smoothPath(points) {
    if (!points.length) return '';
    if (points.length === 1) return `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    let d = `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
  }

  function spark(values, width = 180, height = 27, fixedPercentScale = false) {
    const points = pointSeries(values, width, height, 2, fixedPercentScale ? 0 : null, fixedPercentScale ? 100 : null);
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><path d="${smoothPath(points)}"/></svg>`;
  }

  const icon = (path, size = 11) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const cpuIcon = icon('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>');
  const ramIcon = icon('<path d="M2 12h20M6 12v4M10 12v4M14 12v4M18 12v4M4 8h16a2 2 0 0 1 2 2v6H2v-6a2 2 0 0 1 2-2Z"/>');
  const networkIcon = icon('<circle cx="12" cy="12" r="3"/><path d="M2 12h7M15 12h7M12 2v7M12 15v7"/>');
  const eyeIcon = icon('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>', 13);
  const eyeOffIcon = icon('<path d="m3 3 18 18"/><path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c6.5 0 10 6 10 6a16.4 16.4 0 0 1-3 3.8M6.5 6.5C3.7 8.1 2 12 2 12s3.5 6 10 6a9.9 9.9 0 0 0 4.1-.9M9.9 9.9a3 3 0 0 0 4.2 4.2"/>', 13);

  function findKnownCard(nodeId) {
    const id = String(nodeId);
    return [...document.querySelectorAll(`.${CARD_CLASS}`)].find(el => el.dataset.hsNodeId === id) || null;
  }

  function cardForNode(node) {
    const known = findKnownCard(node.id);
    if (known) return known;

    const endpoint = `${node.address}:${node.port || 62050}`;
    const spans = [...document.querySelectorAll('span[dir="ltr"]')].filter(el => (el.textContent || '').trim() === endpoint);
    for (const span of spans) {
      let el = span;
      for (let depth = 0; el && depth < 8; depth += 1, el = el.parentElement) {
        if (el.tagName === 'DIV' && el.classList.contains('relative') && el.classList.contains('overflow-hidden') && el.classList.contains('border')) {
          el.classList.add(CARD_CLASS);
          el.dataset.hsNodeId = String(node.id);
          return el;
        }
      }
    }
    return null;
  }

  function contentForCard(card) {
    const direct = [...card.children].find(el => el.tagName === 'DIV' && el.classList.contains('p-3'));
    if (!direct) return null;
    return [...direct.children].find(el => el.tagName === 'DIV' && el.classList.contains('min-w-0') && el.classList.contains('flex-1')) || null;
  }

  function maskedEndpoint() {
    return '••••••••••••••';
  }

  function maskNodeIp(card, node) {
    const id = String(node.id);
    const endpoint = `${node.address}:${node.port || 62050}`;
    let span = [...card.querySelectorAll('span[dir="ltr"]')].find(el => el.dataset.hsIpNodeId === id);
    if (!span) span = [...card.querySelectorAll('span[dir="ltr"]')].find(el => (el.textContent || '').trim() === endpoint);
    if (!span) return;

    span.classList.add(IP_CLASS);
    span.dataset.hsIpNodeId = id;
    span.dataset.hsRealEndpoint = endpoint;
    span.textContent = revealedIps.has(id) ? endpoint : maskedEndpoint();

    let button = span.nextElementSibling;
    if (!button || !button.classList.contains(IP_BUTTON_CLASS) || button.dataset.hsIpNodeId !== id) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = IP_BUTTON_CLASS;
      button.dataset.hsIpNodeId = id;
      span.insertAdjacentElement('afterend', button);
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (revealedIps.has(id)) revealedIps.delete(id);
        else revealedIps.add(id);
        const targetSpan = button.previousElementSibling;
        if (targetSpan?.classList.contains(IP_CLASS)) {
          const shown = revealedIps.has(id);
          targetSpan.textContent = shown ? targetSpan.dataset.hsRealEndpoint : maskedEndpoint();
          button.innerHTML = shown ? eyeOffIcon : eyeIcon;
          button.setAttribute('aria-label', shown ? 'Hide IP address' : 'Show IP address');
          button.title = shown ? 'Hide IP' : 'Show IP';
        }
      });
    }

    const shown = revealedIps.has(id);
    button.innerHTML = shown ? eyeOffIcon : eyeIcon;
    button.setAttribute('aria-label', shown ? 'Hide IP address' : 'Show IP address');
    button.title = shown ? 'Hide IP' : 'Show IP';
  }

  function restoreIps() {
    document.querySelectorAll(`.${IP_CLASS}`).forEach(span => {
      if (span.dataset.hsRealEndpoint) span.textContent = span.dataset.hsRealEndpoint;
      span.classList.remove(IP_CLASS);
      delete span.dataset.hsIpNodeId;
      delete span.dataset.hsRealEndpoint;
    });
    document.querySelectorAll(`.${IP_BUTTON_CLASS}`).forEach(button => button.remove());
    revealedIps.clear();
  }

  function renderNode(node, stats) {
    const card = cardForNode(node);
    if (!card) return false;
    maskNodeIp(card, node);

    const content = contentForCard(card);
    if (!content) return false;

    let block = content.querySelector(`:scope > .${BLOCK_CLASS}`);
    if (!block) {
      block = document.createElement('div');
      block.className = BLOCK_CLASS;
      block.dataset.hsNodeId = String(node.id);
      content.appendChild(block);
    }

    if (!stats) {
      const errorHtml = `<div class="${BLOCK_CLASS}-error">Realtime stats unavailable</div>`;
      if (block.innerHTML !== errorHtml) block.innerHTML = errorHtml;
      return true;
    }

    const cpu = clamp(stats.cpu_usage);
    const cpuCores = Math.max(0, Number(stats.cpu_cores) || 0);
    const cpuUsed = cpuCores ? cpuCores * cpu / 100 : 0;
    const ramUsed = Number(stats.mem_used) || 0;
    const ramTotal = Number(stats.mem_total) || 0;
    const ramPct = ramTotal ? clamp((ramUsed / ramTotal) * 100) : 0;
    const rx = Number(stats.incoming_bandwidth_speed) || 0;
    const tx = Number(stats.outgoing_bandwidth_speed) || 0;

    const cpuPercent = `${cpu.toFixed(cpu < 10 ? 1 : 0)}%`;
    const ramPercent = `${ramPct.toFixed(ramPct < 10 ? 1 : 0)}%`;
    const cpuUsageText = cpuCores ? `${formatCoreValue(cpuUsed)} / ${formatCoreValue(cpuCores)} cores` : '—';
    const ramUsageText = ramTotal ? `${formatBytes(ramUsed)} / ${formatBytes(ramTotal)}` : '—';

    const html = `
      <div class="${BLOCK_CLASS}-resources">
        <div class="${BLOCK_CLASS}-metric">
          <div class="${BLOCK_CLASS}-head">
            <div class="${BLOCK_CLASS}-title">${cpuIcon}<span>CPU</span></div>
            <div class="${BLOCK_CLASS}-usage" title="${cpuUsageText}">${cpuUsageText}</div>
          </div>
          <div class="${BLOCK_CLASS}-chart-row">
            <div class="${BLOCK_CLASS}-spark green">${spark(getHistory(node.id, 'cpu'), 180, 27, true)}</div>
            <div class="${BLOCK_CLASS}-percent">${cpuPercent}</div>
          </div>
        </div>

        <div class="${BLOCK_CLASS}-metric">
          <div class="${BLOCK_CLASS}-head">
            <div class="${BLOCK_CLASS}-title">${ramIcon}<span>RAM</span></div>
            <div class="${BLOCK_CLASS}-usage" title="${ramUsageText}">${ramUsageText}</div>
          </div>
          <div class="${BLOCK_CLASS}-chart-row">
            <div class="${BLOCK_CLASS}-spark purple">${spark(getHistory(node.id, 'ram'), 180, 27, true)}</div>
            <div class="${BLOCK_CLASS}-percent">${ramPercent}</div>
          </div>
        </div>
      </div>

      <div class="${BLOCK_CLASS}-network">
        <div class="${BLOCK_CLASS}-network-title">${networkIcon}<span>Network</span></div>

        <div class="${BLOCK_CLASS}-net-item">
          <div class="${BLOCK_CLASS}-net-label"><span class="${BLOCK_CLASS}-down">↓</span><span>RX</span></div>
          <div class="${BLOCK_CLASS}-net-value">${formatRate(rx)}</div>
          <div class="${BLOCK_CLASS}-mini-spark blue">${spark(getHistory(node.id, 'rx'), 120, 13)}</div>
        </div>

        <div class="${BLOCK_CLASS}-net-item">
          <div class="${BLOCK_CLASS}-net-label"><span class="${BLOCK_CLASS}-up">↑</span><span>TX</span></div>
          <div class="${BLOCK_CLASS}-net-value">${formatRate(tx)}</div>
          <div class="${BLOCK_CLASS}-mini-spark green">${spark(getHistory(node.id, 'tx'), 120, 13)}</div>
        </div>
      </div>`;

    if (block.innerHTML !== html) block.innerHTML = html;
    return true;
  }

  function removeBlocks() {
    document.querySelectorAll(`.${BLOCK_CLASS}`).forEach(el => el.remove());
    restoreIps();
    document.querySelectorAll(`.${CARD_CLASS}`).forEach(card => {
      card.classList.remove(CARD_CLASS);
      delete card.dataset.hsNodeId;
    });
  }

  function renderAll() {
    renderQueued = false;
    if (!enabled || !onNodesPage()) {
      removeBlocks();
      return;
    }
    for (const node of nodesCache) {
      renderNode(node, statsCache[String(node.id)] ?? statsCache[node.id] ?? null);
    }
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(renderAll);
  }

  async function refreshData() {
    if (!enabled || !onNodesPage() || busy) return;
    busy = true;
    try {
      const [nodesData, statsData] = await Promise.all([
        jsonFetch('/api/nodes?limit=1000'),
        jsonFetch('/api/nodes/realtime_stats'),
      ]);
      nodesCache = Array.isArray(nodesData?.nodes) ? nodesData.nodes : [];
      statsCache = statsData && typeof statsData === 'object' ? statsData : {};
      sampleHistory();
      renderAll();
    } catch (error) {
      console.warn('[HS Node PRO] refresh failed', error);
    } finally {
      busy = false;
    }
  }

  async function refreshFeatureState() {
    try {
      const state = await jsonFetch('/api/hs-plugin/state');
      setEnabled(!!state?.features?.node_pro?.enabled, false);
    } catch (error) {
      console.warn('[HS Node PRO] feature state failed', error);
    }
  }

  function setEnabled(next, refresh = true) {
    enabled = !!next;
    if (!enabled) {
      removeBlocks();
      return;
    }
    injectStyle();
    if (refresh) refreshData();
    else queueRender();
  }

  function start() {
    injectStyle();
    observer = new MutationObserver(() => {
      if (enabled && onNodesPage()) queueRender();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('popstate', () => setTimeout(() => enabled ? refreshData() : removeBlocks(), 80));
    window.addEventListener('hs-plugin-feature-changed', event => {
      if (event.detail?.feature === 'node_pro') setEnabled(!!event.detail.enabled);
    });

    refreshFeatureState().then(refreshData);
    refreshTimer = window.setInterval(refreshData, 5000);
    stateTimer = window.setInterval(refreshFeatureState, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.HSNodePro = {
    version: VERSION,
    refresh: refreshData,
    setEnabled,
    get enabled() { return enabled; },
  };
})();