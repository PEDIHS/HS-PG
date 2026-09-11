(() => {
  'use strict';

  const VERSION = '0.5.0';
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
      border-color:color-mix(in srgb,var(--border) 72%,#38e88c 28%)!important;
      box-shadow:0 10px 28px rgba(0,0,0,.13)!important;
    }
    .${BLOCK_CLASS}{
      margin-top:.72rem;
      padding-top:.72rem;
      border-top:1px solid color-mix(in srgb,var(--border) 78%,transparent);
      color:var(--foreground);
      pointer-events:none;
      min-width:0;
    }
    .${BLOCK_CLASS}-grid{
      display:grid;
      grid-template-columns:minmax(0,1fr) minmax(0,1fr);
      gap:8px;
      min-width:0;
    }
    .${BLOCK_CLASS}-metric{
      position:relative;
      min-width:0;
      height:78px;
      padding:10px 11px;
      overflow:hidden;
      border:1px solid color-mix(in srgb,var(--border) 82%,transparent);
      border-radius:12px;
      background:linear-gradient(145deg,color-mix(in srgb,var(--card) 96%,#17212c 4%),color-mix(in srgb,var(--card) 98%,#090d12 2%));
      box-shadow:inset 0 1px rgba(255,255,255,.018);
    }
    .${BLOCK_CLASS}-metric.wide{height:86px}
    .${BLOCK_CLASS}-head{
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:7px;
      min-width:0;
    }
    .${BLOCK_CLASS}-title{
      display:flex;
      align-items:center;
      gap:5px;
      min-width:0;
      color:var(--muted-foreground);
      font-size:10px;
      line-height:1;
      font-weight:650;
      letter-spacing:.01em;
      white-space:nowrap;
    }
    .${BLOCK_CLASS}-title svg{width:12px;height:12px;flex:none}
    .${BLOCK_CLASS}-value{
      min-width:0;
      color:var(--foreground);
      font-size:12px;
      line-height:1;
      font-weight:700;
      font-variant-numeric:tabular-nums;
      white-space:nowrap;
      text-align:right;
    }
    .${BLOCK_CLASS}-sub{
      display:block;
      margin-top:4px;
      color:var(--muted-foreground);
      font-size:8.5px;
      line-height:1;
      font-weight:500;
    }
    .${BLOCK_CLASS}-spark{
      position:absolute;
      left:10px;
      right:10px;
      bottom:8px;
      height:28px;
      opacity:.92;
    }
    .${BLOCK_CLASS}-spark svg,
    .${BLOCK_CLASS}-mini-spark svg{display:block;width:100%;height:100%;overflow:visible}
    .${BLOCK_CLASS}-spark path,
    .${BLOCK_CLASS}-mini-spark path{
      fill:none;
      stroke-width:2.1;
      stroke-linecap:round;
      stroke-linejoin:round;
    }
    .${BLOCK_CLASS}-spark.green path,.${BLOCK_CLASS}-mini-spark.green path{stroke:#38e88c;filter:drop-shadow(0 0 3px rgba(56,232,140,.27))}
    .${BLOCK_CLASS}-spark.purple path,.${BLOCK_CLASS}-mini-spark.purple path{stroke:#9c86ff;filter:drop-shadow(0 0 3px rgba(156,134,255,.24))}
    .${BLOCK_CLASS}-spark.blue path,.${BLOCK_CLASS}-mini-spark.blue path{stroke:#43a7ff;filter:drop-shadow(0 0 3px rgba(67,167,255,.24))}
    .${BLOCK_CLASS}-dual{
      display:grid;
      grid-template-columns:minmax(0,1fr) minmax(0,1fr);
      gap:0;
      margin-top:10px;
      min-width:0;
    }
    .${BLOCK_CLASS}-dual-item{min-width:0;padding-right:9px}
    .${BLOCK_CLASS}-dual-item+ .${BLOCK_CLASS}-dual-item{
      padding-right:0;
      padding-left:9px;
      border-left:1px solid color-mix(in srgb,var(--border) 78%,transparent);
    }
    .${BLOCK_CLASS}-small-label{
      display:flex;
      align-items:center;
      gap:4px;
      color:var(--muted-foreground);
      font-size:8px;
      line-height:1;
      white-space:nowrap;
    }
    .${BLOCK_CLASS}-down{color:#43a7ff;font-size:10px}
    .${BLOCK_CLASS}-up{color:#38e88c;font-size:10px}
    .${BLOCK_CLASS}-data{
      margin-top:4px;
      color:var(--foreground);
      font-size:10.5px;
      line-height:1;
      font-weight:700;
      font-variant-numeric:tabular-nums;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .${BLOCK_CLASS}-mini-spark{height:14px;margin-top:5px;opacity:.9}
    .${BLOCK_CLASS}-footer{
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:0;
      margin-top:8px;
      padding:8px 10px;
      border:1px solid color-mix(in srgb,var(--border) 82%,transparent);
      border-radius:11px;
      background:color-mix(in srgb,var(--card) 96%,transparent);
    }
    .${BLOCK_CLASS}-footer-item{min-width:0}
    .${BLOCK_CLASS}-footer-item+ .${BLOCK_CLASS}-footer-item{
      padding-left:10px;
      border-left:1px solid color-mix(in srgb,var(--border) 78%,transparent);
    }
    .${BLOCK_CLASS}-footer-label{
      display:flex;
      align-items:center;
      gap:4px;
      color:var(--muted-foreground);
      font-size:8px;
      line-height:1;
    }
    .${BLOCK_CLASS}-footer-value{
      margin-top:4px;
      color:var(--foreground);
      font-size:10.5px;
      line-height:1;
      font-weight:700;
      font-variant-numeric:tabular-nums;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
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

    @media(max-width:440px){
      .${BLOCK_CLASS}-grid{grid-template-columns:1fr}
      .${BLOCK_CLASS}-metric,.${BLOCK_CLASS}-metric.wide{height:78px}
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

  function formatUptime(seconds) {
    let s = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(s / 86400); s %= 86400;
    const hours = Math.floor(s / 3600); s %= 3600;
    const minutes = Math.floor(s / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function pushHistory(nodeId, key, value) {
    const id = String(nodeId);
    if (!history.has(id)) history.set(id, {});
    const bucket = history.get(id);
    if (!Array.isArray(bucket[key])) bucket[key] = [];
    bucket[key].push(Number(value) || 0);
    if (bucket[key].length > 20) bucket[key].shift();
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
      pushHistory(node.id, 'down', Number(node.downlink) || 0);
      pushHistory(node.id, 'up', Number(node.uplink) || 0);
    }
  }

  function sparkPath(values, width = 180, height = 28, pad = 2) {
    const points = Array.isArray(values) && values.length ? values : [0, 0];
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = Math.max(1, max - min);
    const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
    return points.map((value, index) => {
      const x = pad + index * step;
      const y = height - pad - ((value - min) / range) * (height - pad * 2);
      return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
  }

  function spark(values, width = 180, height = 28) {
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><path d="${sparkPath(values, width, height, 2)}"/></svg>`;
  }

  const icon = (path, size = 12) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const cpuIcon = icon('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>');
  const ramIcon = icon('<path d="M2 12h20M6 12v4M10 12v4M14 12v4M18 12v4M4 8h16a2 2 0 0 1 2 2v6H2v-6a2 2 0 0 1 2-2Z"/>');
  const networkIcon = icon('<circle cx="12" cy="12" r="3"/><path d="M2 12h7M15 12h7M12 2v7M12 15v7"/>');
  const trafficIcon = icon('<path d="M7 7h11l-3-3M17 17H6l3 3"/>');
  const clockIcon = icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>');
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
    const ramPct = stats.mem_total ? clamp((Number(stats.mem_used) / Number(stats.mem_total)) * 100) : 0;
    const rx = Number(stats.incoming_bandwidth_speed) || 0;
    const tx = Number(stats.outgoing_bandwidth_speed) || 0;
    const sessionDown = Number(node.downlink) || 0;
    const sessionUp = Number(node.uplink) || 0;
    const lifetimeDown = Number(node.lifetime_downlink) || 0;
    const lifetimeUp = Number(node.lifetime_uplink) || 0;
    const lifetimeTotal = lifetimeDown + lifetimeUp;

    const html = `
      <div class="${BLOCK_CLASS}-grid">
        <div class="${BLOCK_CLASS}-metric">
          <div class="${BLOCK_CLASS}-head">
            <div class="${BLOCK_CLASS}-title">${cpuIcon}<span>CPU</span></div>
            <div class="${BLOCK_CLASS}-value">${cpu.toFixed(cpu < 10 ? 1 : 0)}%<span class="${BLOCK_CLASS}-sub">${Number(stats.cpu_cores) || 0}c</span></div>
          </div>
          <div class="${BLOCK_CLASS}-spark green">${spark(getHistory(node.id, 'cpu'))}</div>
        </div>

        <div class="${BLOCK_CLASS}-metric">
          <div class="${BLOCK_CLASS}-head">
            <div class="${BLOCK_CLASS}-title">${ramIcon}<span>RAM</span></div>
            <div class="${BLOCK_CLASS}-value">${formatBytes(stats.mem_used)}<span class="${BLOCK_CLASS}-sub">/ ${formatBytes(stats.mem_total)} · ${ramPct.toFixed(0)}%</span></div>
          </div>
          <div class="${BLOCK_CLASS}-spark purple">${spark(getHistory(node.id, 'ram'))}</div>
        </div>

        <div class="${BLOCK_CLASS}-metric wide">
          <div class="${BLOCK_CLASS}-title">${networkIcon}<span>Network</span></div>
          <div class="${BLOCK_CLASS}-dual">
            <div class="${BLOCK_CLASS}-dual-item">
              <div class="${BLOCK_CLASS}-small-label"><span class="${BLOCK_CLASS}-down">↓</span><span>RX</span></div>
              <div class="${BLOCK_CLASS}-data">${formatRate(rx)}</div>
              <div class="${BLOCK_CLASS}-mini-spark blue">${spark(getHistory(node.id, 'rx'), 110, 14)}</div>
            </div>
            <div class="${BLOCK_CLASS}-dual-item">
              <div class="${BLOCK_CLASS}-small-label"><span class="${BLOCK_CLASS}-up">↑</span><span>TX</span></div>
              <div class="${BLOCK_CLASS}-data">${formatRate(tx)}</div>
              <div class="${BLOCK_CLASS}-mini-spark green">${spark(getHistory(node.id, 'tx'), 110, 14)}</div>
            </div>
          </div>
        </div>

        <div class="${BLOCK_CLASS}-metric wide">
          <div class="${BLOCK_CLASS}-title">${trafficIcon}<span>Traffic</span></div>
          <div class="${BLOCK_CLASS}-dual">
            <div class="${BLOCK_CLASS}-dual-item">
              <div class="${BLOCK_CLASS}-small-label"><span class="${BLOCK_CLASS}-down">↓</span><span>Down</span></div>
              <div class="${BLOCK_CLASS}-data">${formatBytes(sessionDown)}</div>
              <div class="${BLOCK_CLASS}-mini-spark blue">${spark(getHistory(node.id, 'down'), 110, 14)}</div>
            </div>
            <div class="${BLOCK_CLASS}-dual-item">
              <div class="${BLOCK_CLASS}-small-label"><span class="${BLOCK_CLASS}-up">↑</span><span>Up</span></div>
              <div class="${BLOCK_CLASS}-data">${formatBytes(sessionUp)}</div>
              <div class="${BLOCK_CLASS}-mini-spark green">${spark(getHistory(node.id, 'up'), 110, 14)}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="${BLOCK_CLASS}-footer">
        <div class="${BLOCK_CLASS}-footer-item">
          <div class="${BLOCK_CLASS}-footer-label">${clockIcon}<span>Uptime</span></div>
          <div class="${BLOCK_CLASS}-footer-value">${formatUptime(stats.uptime)}</div>
        </div>
        <div class="${BLOCK_CLASS}-footer-item">
          <div class="${BLOCK_CLASS}-footer-label"><span>Life</span></div>
          <div class="${BLOCK_CLASS}-footer-value">${lifetimeTotal ? formatBytes(lifetimeTotal) : '—'}</div>
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
