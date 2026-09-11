(() => {
  'use strict';

  const VERSION = '0.3.0';
  const STYLE_ID = 'hs-node-pro-style';
  const BLOCK_CLASS = 'hs-node-pro';
  const rawFetch = window.fetch.bind(window);

  let enabled = false;
  let refreshTimer = null;
  let stateTimer = null;
  let observer = null;
  let nodesCache = [];
  let statsCache = {};
  let busy = false;

  const css = `
    .${BLOCK_CLASS}{margin-top:.55rem;padding-top:.7rem;border-top:1px solid color-mix(in srgb,var(--border) 70%,transparent);pointer-events:none}
    .${BLOCK_CLASS}-meters{display:grid;gap:.55rem}
    .${BLOCK_CLASS}-row{display:grid;grid-template-columns:38px minmax(80px,1fr) auto;align-items:center;gap:.55rem;font-size:11px;line-height:1.2}
    .${BLOCK_CLASS}-label{display:flex;align-items:center;gap:.3rem;color:var(--muted-foreground);font-weight:600;letter-spacing:.02em}
    .${BLOCK_CLASS}-value{color:var(--foreground);font-variant-numeric:tabular-nums;white-space:nowrap}
    .${BLOCK_CLASS}-track{height:6px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--muted) 88%,transparent)}
    .${BLOCK_CLASS}-fill{height:100%;min-width:0;border-radius:inherit;background:linear-gradient(90deg,color-mix(in srgb,var(--primary) 72%,#16a34a),var(--primary));transition:width .35s ease}
    .${BLOCK_CLASS}-net{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.45rem;margin-top:.7rem}
    .${BLOCK_CLASS}-metric{min-width:0;border:1px solid color-mix(in srgb,var(--border) 70%,transparent);border-radius:.55rem;background:color-mix(in srgb,var(--card) 88%,transparent);padding:.48rem .55rem}
    .${BLOCK_CLASS}-metric-title{display:flex;align-items:center;gap:.3rem;color:var(--muted-foreground);font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
    .${BLOCK_CLASS}-metric-value{margin-top:.18rem;color:var(--foreground);font-size:11px;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .${BLOCK_CLASS}-metric-sub{margin-top:.12rem;color:var(--muted-foreground);font-size:9px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .${BLOCK_CLASS}-error{color:var(--muted-foreground);font-size:10px;padding:.15rem 0}
    @media(max-width:640px){.${BLOCK_CLASS}-net{grid-template-columns:repeat(2,minmax(0,1fr))}}
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

  const icon = (path) => `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const cpuIcon = icon('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>');
  const ramIcon = icon('<path d="M2 12h20M6 12v4M10 12v4M14 12v4M18 12v4M4 8h16a2 2 0 0 1 2 2v6H2v-6a2 2 0 0 1 2-2Z"/>');
  const downIcon = icon('<path d="M12 3v14M6 11l6 6 6-6M5 21h14"/>');
  const upIcon = icon('<path d="M12 21V7M18 13l-6-6-6 6M5 3h14"/>');
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
      block.innerHTML = '<div class="hs-node-pro-error">Realtime resource stats unavailable</div>';
      return true;
    }

    const cpu = clamp(stats.cpu_usage);
    const ramPct = stats.mem_total ? clamp((Number(stats.mem_used) / Number(stats.mem_total)) * 100) : 0;
    const sessionDown = Number(node.downlink) || 0;
    const sessionUp = Number(node.uplink) || 0;
    const lifetimeDown = Number(node.lifetime_downlink) || 0;
    const lifetimeUp = Number(node.lifetime_uplink) || 0;
    const totalSession = sessionDown + sessionUp;

    block.innerHTML = `
      <div class="${BLOCK_CLASS}-meters">
        <div class="${BLOCK_CLASS}-row">
          <div class="${BLOCK_CLASS}-label">${cpuIcon}<span>CPU</span></div>
          <div class="${BLOCK_CLASS}-track"><div class="${BLOCK_CLASS}-fill" style="width:${cpu.toFixed(1)}%"></div></div>
          <div class="${BLOCK_CLASS}-value">${cpu.toFixed(cpu < 10 ? 1 : 0)}% · ${Number(stats.cpu_cores) || 0}c</div>
        </div>
        <div class="${BLOCK_CLASS}-row">
          <div class="${BLOCK_CLASS}-label">${ramIcon}<span>RAM</span></div>
          <div class="${BLOCK_CLASS}-track"><div class="${BLOCK_CLASS}-fill" style="width:${ramPct.toFixed(1)}%"></div></div>
          <div class="${BLOCK_CLASS}-value">${formatBytes(stats.mem_used)} / ${formatBytes(stats.mem_total)}</div>
        </div>
      </div>
      <div class="${BLOCK_CLASS}-net">
        <div class="${BLOCK_CLASS}-metric">
          <div class="${BLOCK_CLASS}-metric-title">${downIcon}<span>RX</span></div>
          <div class="${BLOCK_CLASS}-metric-value">${formatRate(stats.incoming_bandwidth_speed)}</div>
          <div class="${BLOCK_CLASS}-metric-sub">Total ↓ ${formatBytes(sessionDown)}</div>
        </div>
        <div class="${BLOCK_CLASS}-metric">
          <div class="${BLOCK_CLASS}-metric-title">${upIcon}<span>TX</span></div>
          <div class="${BLOCK_CLASS}-metric-value">${formatRate(stats.outgoing_bandwidth_speed)}</div>
          <div class="${BLOCK_CLASS}-metric-sub">Total ↑ ${formatBytes(sessionUp)}</div>
        </div>
        <div class="${BLOCK_CLASS}-metric">
          <div class="${BLOCK_CLASS}-metric-title">${clockIcon}<span>Node</span></div>
          <div class="${BLOCK_CLASS}-metric-value">${formatUptime(stats.uptime)} uptime</div>
          <div class="${BLOCK_CLASS}-metric-sub">Usage ${formatBytes(totalSession)}${lifetimeDown + lifetimeUp ? ` · Life ${formatBytes(lifetimeDown + lifetimeUp)}` : ''}</div>
        </div>
      </div>`;
    return true;
  }

  function removeBlocks() {
    document.querySelectorAll(`.${BLOCK_CLASS}`).forEach(el => el.remove());
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
