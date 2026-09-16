(() => {
  'use strict';

  const VERSION = '0.9.2';
  const STYLE_ID = 'hs-node-pro-style';
  const BLOCK_CLASS = 'hs-node-pro';
  const CARD_CLASS = 'hs-node-pro-card';
  const IP_CLASS = 'hs-node-ip-value';
  const IP_BUTTON_CLASS = 'hs-node-ip-toggle';
  const MASK = '••••••••••••••';
  const rawFetch = window.fetch.bind(window);

  let enabled = false;
  let refreshTimer = null;
  let stateTimer = null;
  let observer = null;
  let nodesCache = [];
  let statsCache = {};
  let busy = false;
  let renderQueued = false;
  let nodesRefreshedAt = 0;

  const history = new Map();
  const revealedIps = new Set();

  const css = `
    .${CARD_CLASS}{
      min-width:0!important;
      overflow:hidden!important;
      border-radius:26px!important;
      border:1px solid rgba(255,255,255,.105)!important;
      background:
        linear-gradient(135deg,rgba(255,255,255,.082),rgba(255,255,255,.024)),
        var(--card)!important;
      box-shadow:
        0 20px 54px -30px rgba(0,0,0,.62),
        inset 0 1px 0 rgba(255,255,255,.13),
        inset 0 -1px 0 rgba(255,255,255,.025)!important;
      backdrop-filter:blur(10px) saturate(115%);
      -webkit-backdrop-filter:blur(10px) saturate(115%);
      isolation:isolate;
    }
    .${CARD_CLASS}::before{
      content:''!important;
      display:block!important;
      position:absolute!important;
      inset:0!important;
      z-index:0!important;
      pointer-events:none!important;
      background:linear-gradient(120deg,rgba(255,255,255,.115),transparent 27%,transparent 72%,rgba(67,183,255,.025))!important;
      opacity:.46!important;
    }
    .${CARD_CLASS}::after{
      content:'';
      position:absolute;
      width:210px;
      height:150px;
      left:-72px;
      top:-86px;
      z-index:0;
      pointer-events:none;
      border-radius:50%;
      background:radial-gradient(circle,rgba(255,255,255,.075) 0,rgba(255,255,255,.028) 45%,transparent 72%);
    }
    .${CARD_CLASS} > *{position:relative;z-index:1}
    .${CARD_CLASS} > div.p-3{padding:16px!important}
    .${CARD_CLASS} h3{
      color:#ebcc63!important;
      font-size:18px!important;
      line-height:1.15!important;
      font-weight:750!important;
      letter-spacing:-.3px!important;
    }
    .${CARD_CLASS} .bg-green-500{
      width:9px!important;
      height:9px!important;
      background:#3bf0ae!important;
      box-shadow:0 0 10px rgba(59,240,174,.72),0 0 22px rgba(59,240,174,.26)!important;
    }
    .${CARD_CLASS} .bg-amber-500{box-shadow:0 0 9px rgba(245,158,11,.38)}
    .${CARD_CLASS} .${IP_CLASS}{color:rgba(226,232,240,.48)!important;font-size:11px!important;letter-spacing:.06em!important}
    .${CARD_CLASS} .hs-node-pro-native-info{margin-bottom:10px!important}
    .${CARD_CLASS} .hs-node-pro-native-info > div:first-child{margin-top:5px}
    .${CARD_CLASS} .hs-node-pro-native-total{
      margin-top:11px!important;
      padding:10px 0!important;
      border-top:1px solid rgba(255,255,255,.055)!important;
      border-bottom:1px solid rgba(255,255,255,.055)!important;
      border-radius:0!important;
      overflow:visible!important;
    }
    .${CARD_CLASS} .hs-node-pro-native-total > div:last-child{
      column-gap:12px!important;
      row-gap:3px!important;
      font-size:10.5px!important;
      line-height:1.25!important;
    }
    .${CARD_CLASS} .hs-node-pro-native-total > div:last-child > span:first-child{color:#f4f7fa!important;font-weight:700!important}
    .${CARD_CLASS} .hs-node-pro-native-total [class*='text-blue-']{color:#43b7ff!important;font-weight:650!important}
    .${CARD_CLASS} .hs-node-pro-native-total [class*='text-emerald-']{color:#3bf0ae!important;font-weight:650!important}
    .${CARD_CLASS} .hs-node-pro-native-total [role='progressbar']{height:4px!important;background:rgba(255,255,255,.055)!important}
    .${CARD_CLASS} .hs-node-pro-native-separator{display:none!important}
    .${CARD_CLASS} .hs-node-pro-native-menu{
      width:34px!important;
      height:34px!important;
      border-radius:11px!important;
      border:1px solid rgba(255,255,255,.06)!important;
      background:rgba(255,255,255,.035)!important;
      color:rgba(255,255,255,.66)!important;
      box-shadow:inset 0 1px rgba(255,255,255,.035)!important;
    }
    .${CARD_CLASS} .hs-node-pro-native-menu:hover{background:rgba(255,255,255,.075)!important;transform:translateY(-1px)}

    .${BLOCK_CLASS}{
      margin-top:12px;
      color:#f4f7fa;
      pointer-events:none;
      min-width:0;
      font-family:Inter,-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',sans-serif;
    }
    .${BLOCK_CLASS}-live-shell{
      padding:11px;
      margin-bottom:10px;
      overflow:hidden;
      border:1px solid rgba(255,255,255,.065);
      border-radius:18px;
      background:linear-gradient(145deg,rgba(255,255,255,.055),rgba(255,255,255,.018));
      box-shadow:inset 0 1px rgba(255,255,255,.055);
    }
    .${BLOCK_CLASS}-live-head{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      min-height:16px;
      margin-bottom:7px;
      padding:0 2px;
      position:relative;
    }
    .${BLOCK_CLASS}-live-title{
      display:flex;
      align-items:center;
      gap:7px;
      color:rgba(255,255,255,.76);
      font-size:9.5px;
      line-height:1;
      font-weight:750;
      letter-spacing:.65px;
    }
    .${BLOCK_CLASS}-realtime{
      position:absolute;
      left:50%;
      top:50%;
      transform:translate(-50%,-50%);
      display:flex;
      align-items:center;
      justify-content:center;
      min-width:54px;
      height:16px;
      padding:0 7px;
      box-sizing:border-box;
      border:1px solid rgba(255,255,255,.055);
      border-radius:999px;
      background:rgba(255,255,255,.025);
      color:rgba(255,255,255,.30);
      font-size:8.5px;
      line-height:16px;
      font-weight:650;
      letter-spacing:.45px;
      text-align:center;
      white-space:nowrap;
      pointer-events:none;
    }
    .${BLOCK_CLASS}-realtime > span{display:block;transform:translateY(.5px)}
    .${BLOCK_CLASS}-live-dot{
      width:6px;
      height:6px;
      flex:none;
      border-radius:999px;
      background:#3bf0ae;
      box-shadow:0 0 10px rgba(59,240,174,.7);
      animation:hs-node-live-pulse 1.5s ease-in-out infinite;
    }
    @keyframes hs-node-live-pulse{50%{opacity:.35}}
    .${BLOCK_CLASS}-network{
      display:grid;
      grid-template-columns:minmax(0,1fr) minmax(0,1fr);
      gap:9px;
      min-width:0;
    }
    .${BLOCK_CLASS}-network-metric{
      position:relative;
      height:82px;
      min-width:0;
      padding:10px 11px 8px;
      overflow:hidden;
      border:1px solid rgba(255,255,255,.07);
      border-radius:15px;
      background:linear-gradient(145deg,rgba(255,255,255,.065),rgba(255,255,255,.018));
      box-shadow:inset 0 1px rgba(255,255,255,.055);
    }
    .${BLOCK_CLASS}-network-metric::before{
      content:'';
      position:absolute;
      width:88px;
      height:58px;
      left:-25px;
      top:-31px;
      border-radius:50%;
      background:radial-gradient(circle,rgba(255,255,255,.06) 0,rgba(255,255,255,.018) 48%,transparent 72%);
      pointer-events:none;
    }
    .${BLOCK_CLASS}-network-label{
      position:relative;
      z-index:2;
      display:flex;
      align-items:center;
      gap:5px;
      color:rgba(255,255,255,.42);
      font-size:8.5px;
      line-height:1;
      font-weight:700;
      letter-spacing:.65px;
      white-space:nowrap;
    }
    .${BLOCK_CLASS}-network-arrow.rx{color:#43b7ff}
    .${BLOCK_CLASS}-network-arrow.tx{color:#3bf0ae}
    .${BLOCK_CLASS}-network-rate{
      position:relative;
      z-index:2;
      display:flex;
      align-items:baseline;
      gap:3px;
      margin-top:4px;
      color:#f4f7fa;
      font-size:18px;
      line-height:1;
      font-weight:750;
      letter-spacing:-.45px;
      font-variant-numeric:tabular-nums;
      white-space:nowrap;
    }
    .${BLOCK_CLASS}-network-rate.rx{color:#43b7ff}
    .${BLOCK_CLASS}-network-rate.tx{color:#3bf0ae}
    .${BLOCK_CLASS}-unit{color:rgba(255,255,255,.34);font-size:8.5px;font-weight:600;letter-spacing:0}
    .${BLOCK_CLASS}-network-spark{
      position:absolute;
      left:10px;
      right:10px;
      bottom:7px;
      height:30px;
      z-index:1;
      overflow:hidden;
      opacity:.82;
      mask-image:linear-gradient(to right,transparent 0,#000 8%,#000 100%);
      -webkit-mask-image:linear-gradient(to right,transparent 0,#000 8%,#000 100%);
    }
    .${BLOCK_CLASS}-network-spark svg{display:block;width:100%;height:100%;overflow:visible}
    .${BLOCK_CLASS}-network-spark path{fill:none;stroke-width:1.55;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
    .${BLOCK_CLASS}-network-spark.rx path{stroke:#43b7ff}
    .${BLOCK_CLASS}-network-spark.tx path{stroke:#3bf0ae}

    .${BLOCK_CLASS}-resources{
      display:grid;
      grid-template-columns:minmax(0,1fr) minmax(0,1fr);
      gap:9px;
      min-width:0;
    }
    .${BLOCK_CLASS}-metric{
      position:relative;
      min-width:0;
      height:66px;
      padding:9px 11px 7px;
      overflow:hidden;
      border:1px solid rgba(255,255,255,.065);
      border-radius:15px;
      background:linear-gradient(145deg,rgba(255,255,255,.052),rgba(255,255,255,.016));
      box-shadow:inset 0 1px rgba(255,255,255,.045);
    }
    .${BLOCK_CLASS}-head{
      position:relative;
      z-index:2;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:7px;
      min-width:0;
    }
    .${BLOCK_CLASS}-title{
      display:flex;
      align-items:center;
      gap:5px;
      min-width:0;
      color:rgba(255,255,255,.48);
      font-size:8.5px;
      line-height:1;
      font-weight:700;
      letter-spacing:.55px;
      white-space:nowrap;
    }
    .${BLOCK_CLASS}-title svg{width:10px;height:10px;flex:none;opacity:.85}
    .${BLOCK_CLASS}-usage{
      min-width:0;
      max-width:68%;
      color:rgba(255,255,255,.30);
      font-size:7.8px;
      line-height:1;
      font-weight:550;
      font-variant-numeric:tabular-nums;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      text-align:right;
    }
    .${BLOCK_CLASS}-chart-row{position:absolute;inset:24px 10px 6px 10px;z-index:1}
    .${BLOCK_CLASS}-spark{position:absolute;left:0;right:58px;bottom:0;height:29px;overflow:hidden;opacity:.72}
    .${BLOCK_CLASS}-spark svg{display:block;width:100%;height:100%;overflow:visible}
    .${BLOCK_CLASS}-spark path{fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
    .${BLOCK_CLASS}-spark.green path{stroke:#3bf0ae}
    .${BLOCK_CLASS}-spark.purple path{stroke:#9884ff}
    .${BLOCK_CLASS}-percent{
      position:absolute;
      right:0;
      top:2px;
      min-width:46px;
      z-index:3;
      color:#f4f7fa;
      font-size:15px;
      line-height:1;
      font-weight:750;
      font-variant-numeric:tabular-nums;
      text-align:right;
      white-space:nowrap;
      text-shadow:0 1px 8px rgba(0,0,0,.32);
      pointer-events:none;
    }
    .${BLOCK_CLASS}-metric:first-child .${BLOCK_CLASS}-percent{color:#3bf0ae}
    .${BLOCK_CLASS}-metric:last-child .${BLOCK_CLASS}-percent{color:#9884ff}
    .${BLOCK_CLASS}-error{color:rgba(255,255,255,.38);font-size:9px;padding:8px 2px}

    .${IP_CLASS}{
      display:inline-block;
      min-width:92px;
      max-width:170px;
      overflow:hidden;
      text-overflow:ellipsis;
      vertical-align:middle;
      font-variant-numeric:tabular-nums;
      letter-spacing:.015em;
    }
    .${IP_BUTTON_CLASS}{
      position:relative!important;
      z-index:50!important;
      display:inline-flex!important;
      align-items:center!important;
      justify-content:center!important;
      width:24px!important;
      height:24px!important;
      margin-left:4px!important;
      padding:0!important;
      border:1px solid rgba(255,255,255,.05)!important;
      border-radius:8px!important;
      background:rgba(255,255,255,.025)!important;
      color:rgba(255,255,255,.42)!important;
      vertical-align:middle!important;
      cursor:pointer!important;
      pointer-events:auto!important;
      touch-action:manipulation!important;
      transition:background .15s ease,color .15s ease,border-color .15s ease,transform .12s ease!important;
    }
    .${IP_BUTTON_CLASS} *{pointer-events:none!important}
    .${IP_BUTTON_CLASS}:hover{background:rgba(255,255,255,.07)!important;color:#f4f7fa!important;border-color:rgba(255,255,255,.08)!important}
    .${IP_BUTTON_CLASS}:active{transform:scale(.94)}
    .${IP_BUTTON_CLASS}[data-hs-ip-state='shown']{color:#3bf0ae!important;background:rgba(59,240,174,.07)!important;border-color:rgba(59,240,174,.14)!important}
    .${IP_BUTTON_CLASS}:focus-visible{outline:2px solid rgba(67,183,255,.5);outline-offset:1px}
    .${IP_BUTTON_CLASS} svg{width:13px;height:13px;display:block}

    @media(max-width:390px){
      .${CARD_CLASS}{border-radius:22px!important}
      .${CARD_CLASS} > div.p-3{padding:13px!important}
      .${CARD_CLASS} h3{font-size:16px!important}
      .${BLOCK_CLASS}-live-shell{padding:9px;border-radius:16px}
      .${BLOCK_CLASS}-network{gap:7px}
      .${BLOCK_CLASS}-network-metric{height:76px;padding:9px}
      .${BLOCK_CLASS}-network-rate{font-size:16px}
      .${BLOCK_CLASS}-network-spark{left:8px;right:8px;height:27px}
      .${BLOCK_CLASS}-resources{gap:7px}
      .${BLOCK_CLASS}-metric{height:62px;padding:8px 9px}
      .${BLOCK_CLASS}-usage{font-size:7.2px}
      .${BLOCK_CLASS}-spark{right:50px}
      .${BLOCK_CLASS}-percent{min-width:40px;font-size:13px}
    }

    @media(prefers-reduced-motion:reduce){.${BLOCK_CLASS}-live-dot{animation:none!important}}
  `;

  function injectStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
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

  function formatBandwidth(value) {
    const bytes = Math.max(0, Number(value) || 0);
    const bits = bytes * 8;
    if (bits >= 1024 * 1024 * 1024) return `${(bits / (1024 * 1024 * 1024)).toFixed(bits >= 10 * 1024 * 1024 * 1024 ? 1 : 2)} Gbps`;
    if (bits >= 1024 * 1024) return `${(bits / (1024 * 1024)).toFixed(bits >= 100 * 1024 * 1024 ? 0 : 1)} Mbps`;
    if (bits >= 1024) return `${(bits / 1024).toFixed(bits >= 100 * 1024 ? 0 : 1)} Kbps`;
    return `${Math.round(bits)} bps`;
  }

  function formatBandwidthParts(value) {
    const text = formatBandwidth(value);
    const split = text.lastIndexOf(' ');
    return split > 0 ? { value: text.slice(0, split), unit: text.slice(split + 1) } : { value: text, unit: '' };
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
    if (bucket[key].length > 26) bucket[key].shift();
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
      pushHistory(node.id, 'rx', Math.max(0, Number(stats.incoming_bandwidth_speed) || 0));
      pushHistory(node.id, 'tx', Math.max(0, Number(stats.outgoing_bandwidth_speed) || 0));
    }
  }

  function smoothSeries(values, alpha = .34) {
    const source = Array.isArray(values) && values.length ? values.map(v => Number(v) || 0) : [0, 0];
    if (source.length < 2) return source;
    const out = [source[0]];
    for (let i = 1; i < source.length; i += 1) {
      out.push(out[i - 1] + alpha * (source[i] - out[i - 1]));
    }
    return out;
  }

  function pointSeries(values, width, height, pad) {
    const source = smoothSeries(values);
    let min = Math.max(0, Math.min(...source) - 5);
    let max = Math.min(100, Math.max(...source) + 5);

    if (max - min < 16) {
      const middle = (min + max) / 2;
      min = Math.max(0, middle - 8);
      max = Math.min(100, middle + 8);
      if (max - min < 16) {
        if (min <= 0) max = Math.min(100, 16);
        else if (max >= 100) min = Math.max(0, 84);
      }
    }

    const range = Math.max(1, max - min);
    const step = source.length > 1 ? (width - pad * 2) / (source.length - 1) : 0;
    return source.map((value, index) => ({
      x: pad + index * step,
      y: height - pad - ((clamp(value, min, max) - min) / range) * (height - pad * 2),
    }));
  }

  function ratePointSeries(values, width, height, pad) {
    const source = smoothSeries(values, .42);
    const maxValue = Math.max(...source, 1);
    const minValue = Math.max(0, Math.min(...source) * .88);
    const ceiling = Math.max(maxValue * 1.08, minValue + 1);
    const range = Math.max(1, ceiling - minValue);
    const step = source.length > 1 ? (width - pad * 2) / (source.length - 1) : 0;
    return source.map((value, index) => ({
      x: pad + index * step,
      y: height - pad - ((Math.max(minValue, Number(value) || 0) - minValue) / range) * (height - pad * 2),
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

  function spark(values, width = 180, height = 29) {
    const points = pointSeries(values, width, height, 2);
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><path d="${smoothPath(points)}"/></svg>`;
  }

  function rateSpark(values, width = 120, height = 17) {
    const points = ratePointSeries(values, width, height, 1.5);
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><path d="${smoothPath(points)}"/></svg>`;
  }

  const icon = (path, size = 11) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const cpuIcon = icon('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>');
  const ramIcon = icon('<path d="M2 12h20M6 12v4M10 12v4M14 12v4M18 12v4M4 8h16a2 2 0 0 1 2 2v6H2v-6a2 2 0 0 1 2-2Z"/>');
  const eyeOpenIcon = icon('<path d="M2.5 12s3.4-5.2 9.5-5.2 9.5 5.2 9.5 5.2-3.4 5.2-9.5 5.2S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.6"/>', 14);
  const eyeClosedIcon = icon('<path d="M3 12.8c2.3 2.1 5.3 3.2 9 3.2s6.7-1.1 9-3.2"/><path d="m6.1 15.2-1.2 1.7M9.8 16l-.4 2M14.2 16l.4 2M17.9 15.2l1.2 1.7"/>', 14);

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

  function syncIpVisual(span, button, id) {
    if (!(span instanceof HTMLElement) || !(button instanceof HTMLElement)) return;
    const endpoint = span.dataset.hsRealEndpoint || '';
    if (!endpoint) return;

    const shown = revealedIps.has(id);
    span.textContent = shown ? endpoint : MASK;
    button.dataset.hsIpState = shown ? 'shown' : 'hidden';
    button.innerHTML = shown ? eyeOpenIcon : eyeClosedIcon;
    button.setAttribute('aria-pressed', shown ? 'true' : 'false');
    button.setAttribute('aria-label', shown ? 'Hide IP address' : 'Show IP address');
    button.title = shown ? 'Hide IP' : 'Show IP';
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

    let button = span.nextElementSibling;
    if (!button || !button.classList.contains(IP_BUTTON_CLASS) || button.dataset.hsIpNodeId !== id) {
      if (button?.classList?.contains(IP_BUTTON_CLASS)) button.remove();
      button = document.createElement('button');
      button.type = 'button';
      button.className = IP_BUTTON_CLASS;
      button.dataset.hsIpNodeId = id;
      span.insertAdjacentElement('afterend', button);
    }

    syncIpVisual(span, button, id);
  }

  function handleIpPointerDown(event) {
    const button = event.target instanceof Element ? event.target.closest(`.${IP_BUTTON_CLASS}`) : null;
    if (!button) return;
    event.stopPropagation();
  }

  function handleIpClick(event) {
    const button = event.target instanceof Element ? event.target.closest(`.${IP_BUTTON_CLASS}`) : null;
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

    const span = button.previousElementSibling;
    if (!(span instanceof HTMLElement) || !span.classList.contains(IP_CLASS)) return;

    const id = String(button.dataset.hsIpNodeId || span.dataset.hsIpNodeId || '');
    if (!id) return;

    if (revealedIps.has(id)) revealedIps.delete(id);
    else revealedIps.add(id);
    syncIpVisual(span, button, id);
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

  function decorateNativeCard(card, content) {
    const name = content.querySelector('h3');
    if (name) name.classList.add('hs-node-pro-native-name');

    const endpoint = content.querySelector(`span.${IP_CLASS}`);
    const info = endpoint?.closest('div.mb-2');
    if (info) info.classList.add('hs-node-pro-native-info');

    const usage = [...content.children].find(el =>
      el instanceof HTMLElement &&
      el.classList.contains('min-w-0') &&
      el.classList.contains('space-y-1') &&
      el.classList.contains('overflow-x-hidden')
    );
    if (usage) {
      usage.classList.add('hs-node-pro-native-total');
      if (usage.previousElementSibling instanceof HTMLElement) usage.previousElementSibling.classList.add('hs-node-pro-native-separator');
    }

    const menu = content.querySelector(':scope > div:first-child button[aria-haspopup="menu"]') || content.querySelector('button[aria-haspopup="menu"]');
    if (menu instanceof HTMLElement) menu.classList.add('hs-node-pro-native-menu');
  }

  function nodeMarkup() {
    return `
      <div class="${BLOCK_CLASS}-live-shell">
        <div class="${BLOCK_CLASS}-live-head">
          <div class="${BLOCK_CLASS}-live-title"><span class="${BLOCK_CLASS}-live-dot"></span><span>LIVE NETWORK</span></div>
          <span class="${BLOCK_CLASS}-realtime"><span>REALTIME</span></span>
        </div>
        <div class="${BLOCK_CLASS}-network" aria-label="Live network traffic">
          <div class="${BLOCK_CLASS}-network-metric" data-hs-network="rx">
            <div class="${BLOCK_CLASS}-network-label"><span class="${BLOCK_CLASS}-network-arrow rx">↓</span><span>RECEIVE</span></div>
            <div class="${BLOCK_CLASS}-network-rate rx"><span data-hs-field="rx-value">0</span><span class="${BLOCK_CLASS}-unit" data-hs-field="rx-unit">bps</span></div>
            <div class="${BLOCK_CLASS}-network-spark rx"><svg viewBox="0 0 220 40" preserveAspectRatio="none"><path/></svg></div>
          </div>
          <div class="${BLOCK_CLASS}-network-metric" data-hs-network="tx">
            <div class="${BLOCK_CLASS}-network-label"><span class="${BLOCK_CLASS}-network-arrow tx">↑</span><span>SEND</span></div>
            <div class="${BLOCK_CLASS}-network-rate tx"><span data-hs-field="tx-value">0</span><span class="${BLOCK_CLASS}-unit" data-hs-field="tx-unit">bps</span></div>
            <div class="${BLOCK_CLASS}-network-spark tx"><svg viewBox="0 0 220 40" preserveAspectRatio="none"><path/></svg></div>
          </div>
        </div>
      </div>
      <div class="${BLOCK_CLASS}-resources">
        <div class="${BLOCK_CLASS}-metric" data-hs-resource="cpu">
          <div class="${BLOCK_CLASS}-head"><div class="${BLOCK_CLASS}-title">${cpuIcon}<span>CPU</span></div><div class="${BLOCK_CLASS}-usage" data-hs-field="cpu-usage">—</div></div>
          <div class="${BLOCK_CLASS}-chart-row"><div class="${BLOCK_CLASS}-spark green"><svg viewBox="0 0 180 29" preserveAspectRatio="none"><path/></svg></div><div class="${BLOCK_CLASS}-percent" data-hs-field="cpu-percent">0%</div></div>
        </div>
        <div class="${BLOCK_CLASS}-metric" data-hs-resource="ram">
          <div class="${BLOCK_CLASS}-head"><div class="${BLOCK_CLASS}-title">${ramIcon}<span>RAM</span></div><div class="${BLOCK_CLASS}-usage" data-hs-field="ram-usage">—</div></div>
          <div class="${BLOCK_CLASS}-chart-row"><div class="${BLOCK_CLASS}-spark purple"><svg viewBox="0 0 180 29" preserveAspectRatio="none"><path/></svg></div><div class="${BLOCK_CLASS}-percent" data-hs-field="ram-percent">0%</div></div>
        </div>
      </div>`;
  }

  function ensureNodeMarkup(block) {
    if (block.dataset.hsReady === '1') return;
    block.innerHTML = nodeMarkup();
    block.dataset.hsReady = '1';
  }

  function setField(block, name, value, title) {
    const el = block.querySelector(`[data-hs-field="${name}"]`);
    if (!el) return;
    const text = String(value);
    if (el.textContent !== text) el.textContent = text;
    if (title !== undefined && el.getAttribute('title') !== title) el.setAttribute('title', title);
  }

  function setPath(block, selector, d) {
    const path = block.querySelector(selector);
    if (path && path.getAttribute('d') !== d) path.setAttribute('d', d);
  }

  function renderNode(node, stats) {
    const card = cardForNode(node);
    if (!card) return false;
    maskNodeIp(card, node);

    const content = contentForCard(card);
    if (!content) return false;
    decorateNativeCard(card, content);

    let block = content.querySelector(`:scope > .${BLOCK_CLASS}`);
    if (!block) {
      block = document.createElement('div');
      block.className = BLOCK_CLASS;
      block.dataset.hsNodeId = String(node.id);
      content.appendChild(block);
    }

    if (!stats) {
      if (block.dataset.hsReady !== 'error') {
        block.innerHTML = `<div class="${BLOCK_CLASS}-error">Realtime stats unavailable</div>`;
        block.dataset.hsReady = 'error';
      }
      return true;
    }

    ensureNodeMarkup(block);
    const cpu = clamp(stats.cpu_usage);
    const cpuCores = Math.max(0, Number(stats.cpu_cores) || 0);
    const cpuUsed = cpuCores ? cpuCores * cpu / 100 : 0;
    const ramUsed = Number(stats.mem_used) || 0;
    const ramTotal = Number(stats.mem_total) || 0;
    const ramPct = ramTotal ? clamp((ramUsed / ramTotal) * 100) : 0;
    const cpuPercent = `${cpu.toFixed(cpu < 10 ? 1 : 0)}%`;
    const ramPercent = `${ramPct.toFixed(ramPct < 10 ? 1 : 0)}%`;
    const cpuUsageText = cpuCores ? `${formatCoreValue(cpuUsed)} / ${formatCoreValue(cpuCores)} cores` : '—';
    const ramUsageText = ramTotal ? `${formatBytes(ramUsed)} / ${formatBytes(ramTotal)}` : '—';
    const rxDisplay = formatBandwidthParts(Math.max(0, Number(stats.incoming_bandwidth_speed) || 0));
    const txDisplay = formatBandwidthParts(Math.max(0, Number(stats.outgoing_bandwidth_speed) || 0));

    setField(block, 'rx-value', rxDisplay.value);
    setField(block, 'rx-unit', rxDisplay.unit);
    setField(block, 'tx-value', txDisplay.value);
    setField(block, 'tx-unit', txDisplay.unit);
    setField(block, 'cpu-usage', cpuUsageText, cpuUsageText);
    setField(block, 'ram-usage', ramUsageText, ramUsageText);
    setField(block, 'cpu-percent', cpuPercent);
    setField(block, 'ram-percent', ramPercent);
    setPath(block, '[data-hs-network="rx"] .hs-node-pro-network-spark path', smoothPath(ratePointSeries(getHistory(node.id, 'rx'), 220, 40, 1.5)));
    setPath(block, '[data-hs-network="tx"] .hs-node-pro-network-spark path', smoothPath(ratePointSeries(getHistory(node.id, 'tx'), 220, 40, 1.5)));
    setPath(block, '[data-hs-resource="cpu"] .hs-node-pro-spark path', smoothPath(pointSeries(getHistory(node.id, 'cpu'), 180, 29, 2)));
    setPath(block, '[data-hs-resource="ram"] .hs-node-pro-spark path', smoothPath(pointSeries(getHistory(node.id, 'ram'), 180, 29, 2)));
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
    if (!enabled || !onNodesPage() || busy || document.hidden) return;
    busy = true;
    try {
      const now = Date.now();
      const refreshNodes = !nodesCache.length || now - nodesRefreshedAt >= 30000;
      const [nodesData, statsData] = await Promise.all([
        refreshNodes ? jsonFetch('/api/nodes?limit=1000') : Promise.resolve({nodes: nodesCache}),
        jsonFetch('/api/nodes/realtime_stats'),
      ]);
      if (refreshNodes) nodesRefreshedAt = now;
      nodesCache = Array.isArray(nodesData?.nodes) ? nodesData.nodes : nodesCache;
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
    document.addEventListener('pointerdown', handleIpPointerDown, true);
    document.addEventListener('click', handleIpClick, true);

    observer = new MutationObserver(mutations => {
      if (!enabled || !onNodesPage()) return;
      const external = mutations.some(mutation => !(mutation.target instanceof Element) || !mutation.target.closest(`.${BLOCK_CLASS}`));
      if (external) queueRender();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('popstate', () => setTimeout(() => enabled ? refreshData() : removeBlocks(), 80));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && enabled) refreshData(); });
    window.addEventListener('hs-plugin-feature-changed', event => {
      if (event.detail?.feature === 'node_pro') setEnabled(!!event.detail.enabled);
    });

    refreshFeatureState().then(refreshData);
    refreshTimer = window.setInterval(refreshData, 2000);
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