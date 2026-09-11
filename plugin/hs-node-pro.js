(() => {
  'use strict';

  const VERSION = '0.3.1';
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
    .${BLOCK_CLASS}{margin-top:.7rem;padding-top:.78rem;border-top:1px solid color-mix(in srgb,var(--border) 72%,transparent);pointer-events:none}
    .${BLOCK_CLASS}-meters{display:grid;gap:.62rem}
    .${BLOCK_CLASS}-row{display:grid;grid-template-columns:44px minmax(90px,1fr) auto;align-items:center;gap:.65rem;font-size:11px;line-height:1}
    .${BLOCK_CLASS}-label{display:flex;align-items:center;gap:.34rem;color:var(--muted-foreground);font-weight:650;letter-spacing:.01em}
    .${BLOCK_CLASS}-value{display:flex;align-items:baseline;gap:.3rem;color:var(--foreground);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
    .${BLOCK_CLASS}-value-sub{color:var(--muted-foreground);font-size:9px;font-weight:500}
    .${BLOCK_CLASS}-track{position:relative;height:5px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--muted) 84%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--border) 22%,transparent)}
    .${BLOCK_CLASS}-fill{height:100%;min-width:0;border-radius:inherit;background:linear-gradient(90deg,#20c997 0%,color-mix(in srgb,var(--primary) 82%,#3b82f6) 100%);box-shadow:0 0 8px color-mix(in srgb,var(--primary) 22%,transparent);transition:width .35s ease}
    .${BLOCK_CLASS}-meta{display:flex;align-items:center;flex-wrap:wrap;gap:.34rem .75rem;margin-top:.72rem;color:var(--muted-foreground);font-size:9.5px;line-height:1.3;font-variant-numeric:tabular-nums}
    .${BLOCK_CLASS}-meta-item{display:inline-flex;align-items:center;gap:.28rem;white-space:nowrap}
    .${BLOCK_CLASS}-meta-item strong{color:var(--foreground);font-size:10px;font-weight:600}
    .${BLOCK_CLASS}-meta-dot{width:2px;height:2px;border-radius:999px;background:color-mix(in srgb,var(--muted-foreground) 55%,transparent)}
    .${BLOCK_CLASS}-error{color:var(--muted-foreground);font-size:10px;padding:.12rem 0}
    @media(max-width:640px){
      .${BLOCK_CLASS}-row{grid-template-columns:40px minmax(70px,1fr) auto;gap:.5rem}
      .${BLOCK_CLASS}-meta{gap:.35rem .6rem}
      .${BLOCK_CLASS}-meta-dot{display:none}
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

  const icon = (path) => `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const cpuIcon = icon('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>');
  const ramIcon = icon('<path d="M2 12h20M6 12v4M10 12v4M14 12v4M18 12v4M4 8h16a2 2 0 0 1 2 2v6H2v-6a2 2 0 0 1 2-2Z"/>');
  const downIcon = icon('<path d="M12 3v14M6 11l6 6 6-6"/>');
  const upIcon = icon('<path d="M12 21V7M18 13l-6-6-6 6"/>');
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

  function metaDot() {
    return `<span class="${BLOCK_CLASS}-meta-dot" aria-hidden="true"></span>`;
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
      block.innerHTML = '<div class="hs-node-pro-error">Realtime stats unavailable</div>';
      return true;
    }

    const cpu = clamp(stats.cpu_usage);
    const ramPct = stats.mem_total ? clamp((Number(stats.mem_used) / Number(stats.mem_total)) * 100) : 0;
    const sessionDown = Number(node.downlink) || 0;
    const sessionUp = Number(node.uplink) || 0;
    const lifetimeDown = Number(node.lifetime_downlink) || 0;
    const lifetimeUp = Number(node.lifetime_uplink) || 0;
    const lifetimeTotal = lifetimeDown + lifetimeUp;

    block.innerHTML = `
      <div class="${BLOCK_CLASS}-meters">
        <div class="${BLOCK_CLASS}-row">
          <div class="${BLOCK_CLASS}-label">${cpuIcon}<span>CPU</span></div>
          <div class="${BLOCK_CLASS}-track"><div class="${BLOCK_CLASS}-fill" style="width:${cpu.toFixed(1)}%"></div></div>
          <div class="${BLOCK_CLASS}-value"><span>${cpu.toFixed(cpu < 10 ? 1 : 0)}%</span><span class="${BLOCK_CLASS}-value-sub">${Number(stats.cpu_cores) || 0}c</span></div>
        </div>
        <div class="${BLOCK_CLASS}-row">
          <div class="${BLOCK_CLASS}-label">${ramIcon}<span>RAM</span></div>
          <div class="${BLOCK_CLASS}-track"><div class="${BLOCK_CLASS}-fill" style="width:${ramPct.toFixed(1)}%"></div></div>
          <div class="${BLOCK_CLASS}-value"><span>${formatBytes(stats.mem_used)}</span><span class="${BLOCK_CLASS}-value-sub">/ ${formatBytes(stats.mem_total)}</span></div>
        </div>
      </div>
      <div class="${BLOCK_CLASS}-meta">
        <span class="${BLOCK_CLASS}-meta-item">${downIcon}<span>RX</span><strong>${formatRate(stats.incoming_bandwidth_speed)}</strong></span>
        ${metaDot()}
        <span class="${BLOCK_CLASS}-meta-item">${upIcon}<span>TX</span><strong>${formatRate(stats.outgoing_bandwidth_speed)}</strong></span>
        ${metaDot()}
        <span class="${BLOCK_CLASS}-meta-item"><span>↓</span><strong>${formatBytes(sessionDown)}</strong></span>
        ${metaDot()}
        <span class="${BLOCK_CLASS}-meta-item"><span>↑</span><strong>${formatBytes(sessionUp)}</strong></span>
        ${metaDot()}
        <span class="${BLOCK_CLASS}-meta-item">${clockIcon}<strong>${formatUptime(stats.uptime)}</strong></span>
        ${lifetimeTotal ? `${metaDot()}<span class="${BLOCK_CLASS}-meta-item"><span>Life</span><strong>${formatBytes(lifetimeTotal)}</strong></span>` : ''}
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
