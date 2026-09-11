(() => {
  'use strict';

  const VERSION = '1.0.0';
  const CARD_ID = 'hs-account-overview-card';
  const STYLE_ID = 'hs-account-overview-style';
  const OLD_TIME_CARD_ID = 'hs-admin-time-dashboard-card';
  const rawFetch = window.fetch.bind(window);

  let account = null;
  let timeInfo = null;
  let fetchedAt = 0;
  let observer = null;
  let refreshBusy = false;
  let renderQueued = false;

  const isFa = () => {
    const lang = (document.documentElement.lang || '').toLowerCase();
    return lang.startsWith('fa') || document.documentElement.dir === 'rtl';
  };
  const tr = (en, fa) => (isFa() ? fa : en);

  function authHeaders(extra = {}) {
    const headers = new Headers(extra);
    const token = localStorage.getItem('token');
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }

  async function request(path) {
    const response = await rawFetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: authHeaders(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.detail || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function injectStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `
      #${OLD_TIME_CARD_ID}{display:none!important}
      @keyframes hs-account-rise{0%{opacity:0;transform:translateY(10px) scale(.992)}100%{opacity:1;transform:translateY(0) scale(1)}}
      @keyframes hs-account-glow{0%,100%{transform:translate3d(-10%,0,0) scale(1);opacity:.18}50%{transform:translate3d(18%,-6%,0) scale(1.12);opacity:.34}}
      @keyframes hs-account-shine{0%{transform:translateX(-140%) skewX(-18deg)}55%,100%{transform:translateX(260%) skewX(-18deg)}}
      @keyframes hs-account-pulse{0%,100%{box-shadow:0 0 0 0 rgba(217,170,66,.05)}50%{box-shadow:0 0 0 5px rgba(217,170,66,.035)}}
      @keyframes hs-account-gold{0%,70%,100%{background-position:0% 50%}84%{background-position:100% 50%}}
      #${CARD_ID}{animation:hs-account-rise .48s cubic-bezier(.2,.8,.2,1) both}
      #${CARD_ID} .hs-account-shell{isolation:isolate}
      #${CARD_ID} .hs-account-glow{animation:hs-account-glow 7s ease-in-out infinite}
      #${CARD_ID} .hs-account-gold{
        color:#e7bd59;background:linear-gradient(100deg,#b97918 0%,#e4b64b 24%,#fff0ab 46%,#d3a13a 60%,#f5d77e 80%,#b97918 100%);
        background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
        animation:hs-account-gold 4.8s ease-in-out infinite;font-weight:700
      }
      #${CARD_ID} .hs-account-progress-fill{position:relative;overflow:hidden;transition:width .75s cubic-bezier(.2,.8,.2,1)}
      #${CARD_ID} .hs-account-progress-fill::after{content:"";position:absolute;inset:0 auto 0 0;width:34%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.34),transparent);animation:hs-account-shine 3.2s ease-in-out infinite}
      #${CARD_ID}[data-state="warning"] .hs-account-shell{animation:hs-account-pulse 2.8s ease-in-out infinite}
      #${CARD_ID} .hs-account-metric{transition:transform .22s ease,border-color .22s ease,background-color .22s ease}
      #${CARD_ID} .hs-account-metric:hover{transform:translateY(-2px)}
      #${CARD_ID} .hs-account-value{font-variant-numeric:tabular-nums;transition:opacity .18s ease}
      @media(prefers-reduced-motion:reduce){
        #${CARD_ID},#${CARD_ID} .hs-account-glow,#${CARD_ID} .hs-account-shell,#${CARD_ID} .hs-account-gold,#${CARD_ID} .hs-account-progress-fill::after{animation:none!important}
        #${CARD_ID} .hs-account-progress-fill,#${CARD_ID} .hs-account-metric{transition:none!important}
      }
    `;
  }

  function routePath() {
    const hash = window.location.hash || '';
    if (hash.startsWith('#/')) return hash.slice(1).split('?')[0];
    return window.location.pathname || '/';
  }

  function isDashboardRoute() {
    const route = routePath();
    return route === '/' || route === '/dashboard';
  }

  function dashboardStack() {
    if (!isDashboardRoute()) return null;
    const candidates = [...document.querySelectorAll('div.flex.flex-col')];
    return candidates.find(el =>
      el.classList.contains('gap-4') &&
      el.classList.contains('sm:gap-6') &&
      el.parentElement?.classList.contains('w-full') &&
      el.parentElement?.classList.contains('px-3') &&
      el.parentElement?.classList.contains('pt-2')
    ) || null;
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (!Number.isFinite(bytes)) return '0 B';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let current = bytes;
    let unit = -1;
    do {
      current /= 1024;
      unit += 1;
    } while (current >= 1024 && unit < units.length - 1);
    const digits = current >= 100 ? 0 : current >= 10 ? 1 : 2;
    return `${current.toFixed(digits)} ${units[unit]}`;
  }

  function remainingSeconds(info) {
    if (!info?.configured || !info?.expires_at) return null;
    const ts = Date.parse(info.expires_at);
    if (!Number.isFinite(ts)) return Math.max(0, Math.floor(Number(info.remaining_seconds) || 0));
    return Math.max(0, Math.floor((ts - Date.now()) / 1000));
  }

  function formatTime(seconds) {
    if (seconds == null) return tr('Unlimited', 'نامحدود');
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (total <= 0) return tr('Expired', 'منقضی');
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return isFa() ? `${days} روز ${hours} ساعت` : `${days}d ${hours}h`;
    if (hours > 0) return isFa() ? `${hours} ساعت ${minutes} دقیقه` : `${hours}h ${minutes}m`;
    return isFa() ? `${minutes} دقیقه` : `${minutes}m`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(isFa() ? 'fa-IR' : undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(date);
    } catch (_) {
      return date.toLocaleString();
    }
  }

  function statusInfo() {
    const limit = Number(account?.data_limit || 0);
    const used = Math.max(0, Number(account?.used_traffic || 0));
    const remainingTraffic = limit > 0 ? Math.max(0, limit - used) : null;
    const volumePercentRemaining = limit > 0 ? Math.max(0, Math.min(100, (remainingTraffic / limit) * 100)) : 100;

    const timeEnabled = timeInfo?.enabled !== false;
    const timeConfigured = timeEnabled && !!timeInfo?.configured;
    const timeRemaining = timeConfigured ? remainingSeconds(timeInfo) : null;
    const timeTotal = Math.max(0, Number(timeInfo?.duration_days || 0) * 86400);
    const timePercentRemaining = timeConfigured && timeTotal > 0
      ? Math.max(0, Math.min(100, ((timeRemaining || 0) / timeTotal) * 100))
      : 100;

    const timeExpired = timeConfigured && (!!timeInfo?.suspended || (timeRemaining || 0) <= 0);
    const trafficExpired = limit > 0 && remainingTraffic <= 0;
    const warning = !timeExpired && !trafficExpired && (
      (timeConfigured && (timeRemaining || 0) <= 3 * 86400) ||
      (limit > 0 && volumePercentRemaining <= 10)
    );

    let state = 'active';
    let label = tr('Active', 'فعال');
    if (timeExpired) {
      state = 'expired';
      label = tr('Time expired', 'زمان تمام شده');
    } else if (trafficExpired) {
      state = 'expired';
      label = tr('Traffic exhausted', 'حجم تمام شده');
    } else if (String(account?.status || '').toLowerCase() === 'limited') {
      state = 'warning';
      label = tr('Limited', 'محدود');
    } else if (String(account?.status || '').toLowerCase() === 'disabled') {
      state = 'expired';
      label = tr('Disabled', 'غیرفعال');
    } else if (warning) {
      state = 'warning';
      label = tr('Ending soon', 'رو به پایان');
    }

    return {
      limit,
      used,
      remainingTraffic,
      volumePercentRemaining,
      volumePercentUsed: limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0,
      timeEnabled,
      timeConfigured,
      timeRemaining,
      timePercentRemaining,
      state,
      label,
    };
  }

  function cardMarkup() {
    return `
      <div class="hs-account-shell bg-card relative overflow-hidden rounded-xl border p-4 shadow-sm transition-all duration-300 hover:shadow-lg sm:p-5 lg:p-6">
        <div class="hs-account-glow pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-primary/20 blur-3xl"></div>
        <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-400/55 to-transparent"></div>
        <div class="relative z-10">
          <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex min-w-0 items-center gap-3">
              <div class="bg-primary/10 text-primary flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/10">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5"><path d="M4 19V8"/><path d="M10 19V5"/><path d="M16 19v-8"/><path d="M22 19V3"/><path d="M2 19h22"/></svg>
              </div>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="text-base font-semibold sm:text-lg" data-hs-account-title></h3>
                  <span class="hs-account-gold text-[10px] tracking-wider">HS</span>
                  <span data-hs-account-status class="rounded-md border px-2 py-0.5 text-[10px] font-medium"></span>
                </div>
                <p data-hs-account-subtitle class="text-muted-foreground mt-1 text-xs"></p>
              </div>
            </div>
            <div class="text-muted-foreground flex items-center gap-1.5 text-[11px]">
              <span class="relative flex h-2 w-2"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-30"></span><span class="relative inline-flex h-2 w-2 rounded-full bg-green-500"></span></span>
              <span data-hs-account-live></span>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div class="hs-account-metric bg-background/65 rounded-xl border p-4">
              <div class="text-muted-foreground mb-2 flex items-center justify-between gap-2 text-[11px] font-medium">
                <span>${tr('Available volume', 'حجم قابل استفاده')}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><path d="M12 2v20M5 9l7-7 7 7"/><path d="M5 15l7 7 7-7"/></svg>
              </div>
              <div data-hs-account-total class="hs-account-value text-xl font-bold tracking-tight sm:text-2xl" dir="ltr"></div>
              <div data-hs-account-total-caption class="text-muted-foreground mt-1 text-[10px]"></div>
            </div>

            <div class="hs-account-metric bg-background/65 rounded-xl border p-4">
              <div class="text-muted-foreground mb-2 flex items-center justify-between gap-2 text-[11px] font-medium">
                <span>${tr('Remaining volume', 'حجم باقی‌مانده')}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              </div>
              <div data-hs-account-remaining class="hs-account-value text-xl font-bold tracking-tight sm:text-2xl" dir="ltr"></div>
              <div data-hs-account-used class="text-muted-foreground mt-1 text-[10px]"></div>
            </div>

            <div class="hs-account-metric bg-background/65 rounded-xl border p-4">
              <div class="text-muted-foreground mb-2 flex items-center justify-between gap-2 text-[11px] font-medium">
                <span>${tr('Remaining time', 'زمان باقی‌مانده')}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              </div>
              <div data-hs-account-time class="hs-account-value text-xl font-bold tracking-tight sm:text-2xl" dir="ltr"></div>
              <div data-hs-account-expiry class="text-muted-foreground mt-1 text-[10px]"></div>
            </div>
          </div>

          <div class="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div class="bg-muted/25 rounded-xl border p-3.5 sm:p-4">
              <div class="mb-2 flex items-center justify-between gap-3 text-[11px]">
                <span class="text-muted-foreground">${tr('Traffic usage', 'مصرف حجم')}</span>
                <span data-hs-account-traffic-percent class="font-semibold" dir="ltr"></span>
              </div>
              <div class="bg-muted h-2.5 overflow-hidden rounded-full">
                <div data-hs-account-traffic-fill class="hs-account-progress-fill bg-primary h-full rounded-full" style="width:0%"></div>
              </div>
            </div>
            <div class="bg-muted/25 rounded-xl border p-3.5 sm:p-4">
              <div class="mb-2 flex items-center justify-between gap-3 text-[11px]">
                <span class="text-muted-foreground">${tr('Account lifetime', 'زمان اعتبار اکانت')}</span>
                <span data-hs-account-time-percent class="font-semibold" dir="ltr"></span>
              </div>
              <div class="bg-muted h-2.5 overflow-hidden rounded-full">
                <div data-hs-account-time-fill class="hs-account-progress-fill h-full rounded-full bg-amber-500" style="width:0%"></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function ensureCard() {
    const isOwner = !!account?.role?.is_owner;
    const shouldShow = !!account && !isOwner && isDashboardRoute();
    let host = document.getElementById(CARD_ID);
    document.getElementById(OLD_TIME_CARD_ID)?.setAttribute('aria-hidden', 'true');
    if (!shouldShow) {
      host?.remove();
      return null;
    }
    const stack = dashboardStack();
    if (!stack) return null;
    if (!host) {
      host = document.createElement('div');
      host.id = CARD_ID;
      host.className = 'w-full';
      host.innerHTML = cardMarkup();
    }
    if (!host.isConnected || host.parentElement !== stack) stack.insertBefore(host, stack.firstElementChild);
    return host;
  }

  function render() {
    const host = ensureCard();
    if (!host || !account) return;
    const s = statusInfo();
    host.dataset.state = s.state;

    host.querySelector('[data-hs-account-title]').textContent = tr('Your Account', 'وضعیت اکانت شما');
    host.querySelector('[data-hs-account-subtitle]').textContent = account.username
      ? tr(`Live allowance for ${account.username}`, `نمایش زنده اعتبار و حجم ${account.username}`)
      : tr('Live account allowance', 'نمایش زنده اعتبار اکانت');
    host.querySelector('[data-hs-account-live]').textContent = tr('Live', 'زنده');

    const badge = host.querySelector('[data-hs-account-status]');
    badge.textContent = s.label;
    badge.className = 'rounded-md border px-2 py-0.5 text-[10px] font-medium';
    if (s.state === 'expired') badge.classList.add('border-red-500/30', 'bg-red-500/10', 'text-red-600', 'dark:text-red-400');
    else if (s.state === 'warning') badge.classList.add('border-amber-500/30', 'bg-amber-500/10', 'text-amber-600', 'dark:text-amber-400');
    else badge.classList.add('border-green-500/30', 'bg-green-500/10', 'text-green-600', 'dark:text-green-400');

    const total = host.querySelector('[data-hs-account-total]');
    const totalCaption = host.querySelector('[data-hs-account-total-caption]');
    const remaining = host.querySelector('[data-hs-account-remaining]');
    const used = host.querySelector('[data-hs-account-used]');
    if (s.limit > 0) {
      total.textContent = formatBytes(s.limit);
      totalCaption.textContent = tr('Total assigned traffic', 'کل حجم اختصاص داده‌شده');
      remaining.textContent = formatBytes(s.remainingTraffic);
      used.textContent = `${tr('Used', 'مصرف‌شده')}: ${formatBytes(s.used)}`;
    } else {
      total.textContent = '∞';
      totalCaption.textContent = tr('Unlimited traffic', 'حجم نامحدود');
      remaining.textContent = '∞';
      used.textContent = `${tr('Used', 'مصرف‌شده')}: ${formatBytes(s.used)}`;
    }

    const timeEl = host.querySelector('[data-hs-account-time]');
    const expiryEl = host.querySelector('[data-hs-account-expiry]');
    if (!s.timeEnabled) {
      timeEl.textContent = tr('Disabled', 'غیرفعال');
      expiryEl.textContent = tr('Time limit feature is off', 'محدودیت زمانی غیرفعال است');
    } else if (!s.timeConfigured) {
      timeEl.textContent = '∞';
      expiryEl.textContent = tr('Unlimited time', 'بدون محدودیت زمانی');
    } else {
      timeEl.textContent = formatTime(s.timeRemaining);
      expiryEl.textContent = timeInfo?.expires_at
        ? `${tr('Expires', 'پایان')}: ${formatDate(timeInfo.expires_at)}`
        : '';
    }

    const trafficFill = host.querySelector('[data-hs-account-traffic-fill]');
    const trafficPercent = host.querySelector('[data-hs-account-traffic-percent]');
    trafficFill.style.width = `${s.limit > 0 ? s.volumePercentUsed : 0}%`;
    trafficPercent.textContent = s.limit > 0 ? `${s.volumePercentUsed.toFixed(1)}%` : tr('Unlimited', 'نامحدود');
    trafficFill.className = 'hs-account-progress-fill h-full rounded-full ' + (s.volumePercentRemaining <= 10 && s.limit > 0 ? 'bg-red-500' : s.volumePercentRemaining <= 25 && s.limit > 0 ? 'bg-amber-500' : 'bg-primary');

    const timeFill = host.querySelector('[data-hs-account-time-fill]');
    const timePercent = host.querySelector('[data-hs-account-time-percent]');
    timeFill.style.width = `${s.timeConfigured ? s.timePercentRemaining : 100}%`;
    timePercent.textContent = s.timeConfigured ? `${s.timePercentRemaining.toFixed(1)}%` : tr('Unlimited', 'نامحدود');
    timeFill.className = 'hs-account-progress-fill h-full rounded-full ' + (s.timeConfigured && s.timePercentRemaining <= 10 ? 'bg-red-500' : s.timeConfigured && s.timePercentRemaining <= 25 ? 'bg-amber-500' : 'bg-amber-500');
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  async function refresh() {
    if (refreshBusy) return;
    refreshBusy = true;
    try {
      const [adminResult, timeResult] = await Promise.allSettled([
        request('/api/admin'),
        request('/api/hs-plugin/admin-time/me'),
      ]);
      if (adminResult.status === 'fulfilled') account = adminResult.value;
      else if (adminResult.reason?.status === 401) account = null;

      if (timeResult.status === 'fulfilled') timeInfo = timeResult.value;
      else if (timeResult.reason?.status === 401 || timeResult.reason?.status === 404) timeInfo = null;
      fetchedAt = Date.now();
    } finally {
      refreshBusy = false;
      queueRender();
    }
  }

  function start() {
    injectStyle();
    observer = new MutationObserver(queueRender);
    observer.observe(document.documentElement, {childList: true, subtree: true});
    window.addEventListener('hashchange', () => { queueRender(); refresh(); });
    window.addEventListener('popstate', () => { queueRender(); refresh(); });
    window.addEventListener('hs-plugin-feature-changed', event => {
      if (event.detail?.feature === 'admin_time_limit') refresh();
    });

    refresh();
    setInterval(refresh, 15000);
    setInterval(() => {
      if (account && Date.now() - fetchedAt < 60000) queueRender();
    }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();

  window.HSAccountOverview = {
    version: VERSION,
    refresh,
    diagnostics: () => ({
      version: VERSION,
      route: routePath(),
      account: account?.username || null,
      owner: !!account?.role?.is_owner,
      dataLimit: account?.data_limit ?? null,
      usedTraffic: account?.used_traffic ?? null,
      timeConfigured: !!timeInfo?.configured,
      timeEnabled: timeInfo?.enabled,
      card: !!document.getElementById(CARD_ID),
    }),
  };
})();
