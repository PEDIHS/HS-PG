(() => {
  'use strict';

  const VERSION = '0.4.0';
  const STYLE_ID = 'hs-node-pro-style';
  const BLOCK_CLASS = 'hs-node-pro';
  const CARD_CLASS = 'hs-node-pro-card';
  const rawFetch = window.fetch.bind(window);

  let enabled = false;
  let refreshTimer = null;
  let stateTimer = null;
  let observer = null;
  let nodesCache = [];
  let statsCache = {};
  let busy = false;
  const history = new Map();

  const css = `
    .${CARD_CLASS}{
      grid-column:1/-1!important;
      border-radius:24px!important;
      border:1px solid rgba(255,255,255,.065)!important;
      background:linear-gradient(145deg,rgba(22,31,42,.96),rgba(13,19,26,.98))!important;
      box-shadow:0 20px 58px rgba(0,0,0,.28),inset 0 1px rgba(255,255,255,.025)!important;
      overflow:hidden!important;
      transition:border-color .2s ease,box-shadow .2s ease,transform .2s ease!important;
    }
    .${CARD_CLASS}:hover{border-color:rgba(255,255,255,.095)!important;box-shadow:0 24px 64px rgba(0,0,0,.34),inset 0 1px rgba(255,255,255,.03)!important}
    .${CARD_CLASS}>div.p-3{padding:22px!important}
    .${BLOCK_CLASS}{margin-top:1rem;padding-top:1rem;border-top:1px solid rgba(255,255,255,.065);pointer-events:none;color:#f5f7fa}
    .${BLOCK_CLASS}-top{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:14px}
    .${BLOCK_CLASS}-bottom{display:grid;grid-template-columns:1.2fr 1.2fr .8fr;gap:14px}
    .${BLOCK_CLASS}-box{position:relative;min-width:0;min-height:132px;padding:18px;border-radius:18px;border:1px solid rgba(255,255,255,.065);background:linear-gradient(145deg,rgba(255,255,255,.025),rgba(255,255,255,.01));overflow:hidden;box-shadow:inset 0 1px rgba(255,255,255,.015)}
    .${BLOCK_CLASS}-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
    .${BLOCK_CLASS}-title{display:flex;align-items:center;gap:8px;color:#e6edf5;font-size:13px;font-weight:650}
    .${BLOCK_CLASS}-title svg{color:#9eacc0;flex:none}
    .${BLOCK_CLASS}-value{text-align:right;color:#f5f7fa;font-size:17px;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums;white-space:nowrap}
    .${BLOCK_CLASS}-sub{display:block;margin-top:4px;color:#8996aa;font-size:11px;font-weight:500}
    .${BLOCK_CLASS}-spark{position:absolute;left:18px;right:18px;bottom:14px;height:48px;opacity:.95}
    .${BLOCK_CLASS}-spark svg{display:block;width:100%;height:100%;overflow:visible}
    .${BLOCK_CLASS}-spark path{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
    .${BLOCK_CLASS}-spark.green path{stroke:#38e88c;filter:drop-shadow(0 0 5px rgba(56,232,140,.32))}
    .${BLOCK_CLASS}-spark.purple path{stroke:#9c86ff;filter:drop-shadow(0 0 5px rgba(156,134,255,.30))}
    .${BLOCK_CLASS}-spark.blue path{stroke:#43a7ff;filter:drop-shadow(0 0 5px rgba(67,167,255,.30))}
    .${BLOCK_CLASS}-box-title{display:flex;align-items:center;gap:8px;margin-bottom:21px;color:#e6edf5;font-size:13px;font-weight:650}
    .${BLOCK_CLASS}-box-title svg{color:#9eacc0}
    .${BLOCK_CLASS}-dual{display:grid;grid-template-columns:1fr 1fr;min-width:0}
    .${BLOCK_CLASS}-dual-item{position:relative;min-width:0;padding-right:16px}
    .${BLOCK_CLASS}-dual-item+ .${BLOCK_CLASS}-dual-item{padding-right:0;padding-left:16px;border-left:1px solid rgba(255,255,255,.07)}
    .${BLOCK_CLASS}-small-label{display:flex;align-items:center;gap:6px;color:#8996aa;font-size:10.5px;font-weight:550}
    .${BLOCK_CLASS}-arrow-down{color:#43a7ff;font-size:15px;line-height:1}
    .${BLOCK_CLASS}-arrow-up{color:#38e88c;font-size:15px;line-height:1}
    .${BLOCK_CLASS}-data{margin-top:6px;color:#f5f7fa;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .${BLOCK_CLASS}-small-chart{height:29px;margin-top:10px}
    .${BLOCK_CLASS}-small-chart svg{display:block;width:100%;height:100%;overflow:visible}
    .${BLOCK_CLASS}-small-chart path{fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
    .${BLOCK_CLASS}-uptime-grid{display:grid;grid-template-columns:1fr 1fr;margin-top:27px}
    .${BLOCK_CLASS}-uptime-item{min-width:0}
    .${BLOCK_CLASS}-uptime-item+ .${BLOCK_CLASS}-uptime-item{border-left:1px solid rgba(255,255,255,.07);padding-left:16px}
    .${BLOCK_CLASS}-uptime-label{color:#8996aa;font-size:10.5px}
    .${BLOCK_CLASS}-uptime-value{margin-top:7px;color:#f5f7fa;font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .${BLOCK_CLASS}-error{color:#8996aa;font-size:11px;padding:.2rem 0}
    @media(max-width:900px){
      .${BLOCK_CLASS}-bottom{grid-template-columns:1fr 1fr}
      .${BLOCK_CLASS}-bottom>.${BLOCK_CLASS}-box:last-child{grid-column:1/-1}
    }
    @media(max-width:640px){
      .${CARD_CLASS}{border-radius:20px!important}
      .${CARD_CLASS}>div.p-3{padding:16px!important}
      .${BLOCK_CLASS}-top,.${BLOCK_CLASS}-bottom{grid-template-columns:1fr}
      .${BLOCK_CLASS}-bottom>.${BLOCK_CLASS}-box:last-child{grid-column:auto}
      .${BLOCK_CLASS}-box{min-height:124px;padding:16px;border-radius:16px}
      .${BLOCK_CLASS}-spark{left:16px;right:16px}
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

  function remember(nodeId, key, value) {
    const id = String(nodeId);
    if (!history.has(id)) history.set(id, {});
    const bucket = history.get(id);
    if (!Array.isArray(bucket[key])) bucket[key] = [];
    bucket[key].push(Number(value) || 0);
    if (bucket[key].length > 18) bucket[key].shift();
    return bucket[key];
  }

  function sparkPath(values, width = 300, height = 58, pad = 4) {
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

  function spark(values, tone = 'blue', small = false) {
    const w = small ? 180 : 300;
    const h = small ? 35 : 58;
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${sparkPath(values, w, h, 3)}"/></svg>`;
  }

  const icon = (path, size = 15) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const cpuIcon = icon('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>');
  const ramIcon = icon('<path d="M2 12h20M6 12v4M10 12v4M14 12v4M18 12v4M4 8h16a2 2 0 0 1 2 2v6H2v-6a2 2 0 0 1 2-2Z"/>');
  const networkIcon = icon('<circle cx="12" cy="12" r="3"/><path d="M2 12h7M15 12h7M12 2v7M12 15v7"/>');
  const trafficIcon = icon('<path d="M7 7h11l-3-3M17 17H6l3 3"/>');
  const clockIcon = icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>');

  function cardForNode(node) {
    const endpoint = `${node.address}:${node.port || 62050}`;
    const spans = [...document.querySelectorAll('span[dir="ltr"]')].filter(el => (el.textContent || '').trim() === endpoint);
    for (const span of spans) {
      let el = span;
      for (let depth = 0; el && depth < 8; depth += 1, el = el.parentElement) {
        if (el.tagName === 'DIV' && el.classList.contains('relative') && el.classList.contains('overflow-hidden') && el.classList.contains('border')) return el;
      }
    }
    return null;
  }

  function contentForCard(card) {
    const direct = [...card.children].find(el => el.tagName === 'DIV' && el.classList.contains('p-3'));
    if (!direct) return null;
    return [...direct.children].find(el => el.tagName === 'DIV' && el.classList.contains('min-w-0') && el.classList.contains('flex-1')) || null;
  }

  function renderNode(node, stats) {
    const card = cardForNode(node);
    if (!card) return false;
    card.classList.add(CARD_CLASS);

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
      block.innerHTML = '<div class="hs-node-pro-error">Realtime stats unavailable</div>';
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

    const cpuHistory = remember(node.id, 'cpu', cpu);
    const ramHistory = remember(node.id, 'ram', ramPct);
    const rxHistory = remember(node.id, 'rx', rx);
    const txHistory = remember(node.id, 'tx', tx);
    const downHistory = remember(node.id, 'down', sessionDown);
    const upHistory = remember(node.id, 'up', sessionUp);

    block.innerHTML = `
      <div class="${BLOCK_CLASS}-top">
        <div class="${BLOCK_CLASS}-box">
          <div class="${BLOCK_CLASS}-head">
            <div class="${BLOCK_CLASS}-title">${cpuIcon}<span>CPU</span></div>
            <div class="${BLOCK_CLASS}-value">${cpu.toFixed(cpu < 10 ? 1 : 0)}%<span class="${BLOCK_CLASS}-sub">${Number(stats.cpu_cores) || 0} cores</span></div>
          </div>
          <div class="${BLOCK_CLASS}-spark green">${spark(cpuHistory, 'green')}</div>
        </div>

        <div class="${BLOCK_CLASS}-box">
          <div class="${BLOCK_CLASS}-head">
            <div class="${BLOCK_CLASS}-title">${ramIcon}<span>RAM</span></div>
            <div class="${BLOCK_CLASS}-value">${formatBytes(stats.mem_used)}<span class="${BLOCK_CLASS}-sub">/ ${formatBytes(stats.mem_total)} · ${ramPct.toFixed(0)}%</span></div>
          </div>
          <div class="${BLOCK_CLASS}-spark purple">${spark(ramHistory, 'purple')}</div>
        </div>
      </div>

      <div class="${BLOCK_CLASS}-bottom">
        <div class="${BLOCK_CLASS}-box">
          <div class="${BLOCK_CLASS}-box-title">${networkIcon}<span>Network</span></div>
          <div class="${BLOCK_CLASS}-dual">
            <div class="${BLOCK_CLASS}-dual-item">
              <div class="${BLOCK_CLASS}-small-label"><span class="${BLOCK_CLASS}-arrow-down">↓</span><span>RX</span></div>
              <div class="${BLOCK_CLASS}-data">${formatRate(rx)}</div>
              <div class="${BLOCK_CLASS}-small-chart blue">${spark(rxHistory, 'blue', true)}</div>
            </div>
            <div class="${BLOCK_CLASS}-dual-item">
              <div class="${BLOCK_CLASS}-small-label"><span class="${BLOCK_CLASS}-arrow-up">↑</span><span>TX</span></div>
              <div class="${BLOCK_CLASS}-data">${formatRate(tx)}</div>
              <div class="${BLOCK_CLASS}-small-chart green">${spark(txHistory, 'green', true)}</div>
            </div>
          </div>
        </div>

        <div class="${BLOCK_CLASS}-box">
          <div class="${BLOCK_CLASS}-box-title">${trafficIcon}<span>Total Traffic</span></div>
          <div class="${BLOCK_CLASS}-dual">
            <div class="${BLOCK_CLASS}-dual-item">
              <div class="${BLOCK_CLASS}-small-label"><span class="${BLOCK_CLASS}-arrow-down">↓</span><span>Downloaded</span></div>
              <div class="${BLOCK_CLASS}-data">${formatBytes(sessionDown)}</div>
              <div class="${BLOCK_CLASS}-small-chart blue">${spark(downHistory, 'blue', true)}</div>
            </div>
            <div class="${BLOCK_CLASS}-dual-item">
              <div class="${BLOCK_CLASS}-small-label"><span class="${BLOCK_CLASS}-arrow-up">↑</span><span>Uploaded</span></div>
              <div class="${BLOCK_CLASS}-data">${formatBytes(sessionUp)}</div>
              <div class="${BLOCK_CLASS}-small-chart green">${spark(upHistory, 'green', true)}</div>
            </div>
          </div>
        </div>

        <div class="${BLOCK_CLASS}-box">
          <div class="${BLOCK_CLASS}-box-title">${clockIcon}<span>Uptime & Life</span></div>
          <div class="${BLOCK_CLASS}-uptime-grid">
            <div class="${BLOCK_CLASS}-uptime-item">
              <div class="${BLOCK_CLASS}-uptime-label">Uptime</div>
              <div class="${BLOCK_CLASS}-uptime-value">${formatUptime(stats.uptime)}</div>
            </div>
            <div class="${BLOCK_CLASS}-uptime-item">
              <div class="${BLOCK_CLASS}-uptime-label">Life</div>
              <div class="${BLOCK_CLASS}-uptime-value">${lifetimeTotal ? formatBytes(lifetimeTotal) : '—'}</div>
            </div>
          </div>
        </div>
      </div>`;

    block.querySelectorAll(`.${BLOCK_CLASS}-small-chart.blue path`).forEach(path => { path.style.stroke = '#43a7ff'; path.style.filter = 'drop-shadow(0 0 4px rgba(67,167,255,.28))'; });
    block.querySelectorAll(`.${BLOCK_CLASS}-small-chart.green path`).forEach(path => { path.style.stroke = '#38e88c'; path.style.filter = 'drop-shadow(0 0 4px rgba(56,232,140,.28))'; });
    return true;
  }

  function removeBlocks() {
    document.querySelectorAll(`.${BLOCK_CLASS}`).forEach(el => el.remove());
    document.querySelectorAll(`.${CARD_CLASS}`).forEach(el => el.classList.remove(CARD_CLASS));
  }

  function renderAll() {
    if (!enabled || !onNodesPage()) {
      removeBlocks();
      return;
    }
    for (const node of nodesCache) renderNode(node, statsCache[String(node.id)] ?? statsCache[node.id] ?? null);
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
    else renderAll();
  }

  function start() {
    injectStyle();
    observer = new MutationObserver(() => {
      if (enabled && onNodesPage()) window.requestAnimationFrame(renderAll);
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
