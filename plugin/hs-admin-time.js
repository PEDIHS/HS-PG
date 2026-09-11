(() => {
  'use strict';

  const VERSION = '1.3.0';
  const FEATURE = 'admin_time_limit';
  const FEATURE_CARD_ID = 'hs-admin-time-card';
  const ACCOUNT_PORTAL_ID = 'hs-account-overview-portal';
  const FIELD_CLASS = 'hs-admin-time-field';
  const INPUT_CLASS = 'hs-admin-time-input';
  const MAX_DAYS = 36500;
  const rawFetch = window.fetch.bind(window);

  let enabled = false;
  let ownerAccess = false;
  let featureBusy = false;
  let account = null;
  let selfTime = null;
  let accountBusy = false;
  let lastAccountFetch = 0;
  let lastFeatureFetch = 0;
  let nativeStack = null;
  let nativeStackOldPaddingTop = '';
  let portalHeight = 0;
  const formState = new WeakMap();
  const pending = new Set();

  const isFa = () => {
    const lang = (document.documentElement.lang || '').toLowerCase();
    return lang.startsWith('fa') || document.documentElement.dir === 'rtl';
  };
  const tr = (en, fa) => (isFa() ? fa : en);

  function injectStyle() {
    let style = document.getElementById('hs-admin-time-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'hs-admin-time-style';
      document.head.appendChild(style);
    }
    style.textContent = `
      @keyframes hs-admin-gold{0%,70%,100%{background-position:0% 50%}84%{background-position:100% 50%}}
      @keyframes hs-account-rise{0%{opacity:0;transform:translateY(12px) scale(.992)}100%{opacity:1;transform:translateY(0) scale(1)}}
      @keyframes hs-account-glow{0%,100%{transform:translate3d(-12%,0,0) scale(1);opacity:.15}50%{transform:translate3d(16%,-6%,0) scale(1.12);opacity:.3}}
      @keyframes hs-account-shine{0%{transform:translateX(-160%) skewX(-18deg)}62%,100%{transform:translateX(300%) skewX(-18deg)}}
      .hs-admin-time-gold,.hs-account-gold{color:#e7bd59;background:linear-gradient(100deg,#b97918 0%,#e4b64b 24%,#fff0ab 46%,#d3a13a 60%,#f5d77e 80%,#b97918 100%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:hs-admin-gold 4.8s ease-in-out infinite;font-weight:700}
      .${FIELD_CLASS}{min-width:0}
      .${FIELD_CLASS}[data-hs-suspended="true"] .${INPUT_CLASS}{border-color:rgba(217,170,66,.65)!important;box-shadow:0 0 0 1px rgba(217,170,66,.08)}
      #${ACCOUNT_PORTAL_ID}{position:absolute;z-index:25;pointer-events:none;animation:hs-account-rise .42s cubic-bezier(.2,.8,.2,1) both}
      #${ACCOUNT_PORTAL_ID} .hs-account-shell{pointer-events:auto;isolation:isolate}
      #${ACCOUNT_PORTAL_ID} .hs-account-glow{animation:hs-account-glow 7s ease-in-out infinite}
      #${ACCOUNT_PORTAL_ID} .hs-account-progress-fill{position:relative;overflow:hidden;transition:width .7s cubic-bezier(.2,.8,.2,1)}
      #${ACCOUNT_PORTAL_ID} .hs-account-progress-fill::after{content:"";position:absolute;inset:0 auto 0 0;width:34%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.34),transparent);animation:hs-account-shine 3.2s ease-in-out infinite}
      #${ACCOUNT_PORTAL_ID} .hs-account-metric{transition:transform .2s ease,border-color .2s ease,background-color .2s ease}
      #${ACCOUNT_PORTAL_ID} .hs-account-metric:hover{transform:translateY(-2px)}
      #${ACCOUNT_PORTAL_ID} .hs-account-value{font-variant-numeric:tabular-nums}
      @media(prefers-reduced-motion:reduce){.hs-admin-time-gold,.hs-account-gold,#${ACCOUNT_PORTAL_ID},#${ACCOUNT_PORTAL_ID} .hs-account-glow,#${ACCOUNT_PORTAL_ID} .hs-account-progress-fill::after{animation:none!important}#${ACCOUNT_PORTAL_ID} .hs-account-progress-fill,#${ACCOUNT_PORTAL_ID} .hs-account-metric{transition:none!important}}
    `;
  }

  function authHeaders(extra = {}) {
    const headers = new Headers(extra);
    const token = localStorage.getItem('token');
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }

  async function request(path, options = {}, timeoutMs = 6500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const {headers: supplied, ...rest} = options;
      const response = await rawFetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...rest,
        signal: controller.signal,
        headers: authHeaders(supplied || {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.detail || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeout = new Error('Request timed out');
        timeout.status = 408;
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  const hsApi = (path, options = {}, timeoutMs) => request(`/api/hs-plugin${path}`, options, timeoutMs);

  function routePath() {
    const hash = window.location.hash || '';
    if (hash.startsWith('#/')) return hash.slice(1).split('?')[0];
    return window.location.pathname || '/';
  }
  const isDashboardRoute = () => ['/', '/dashboard'].includes(routePath());

  function setText(el, value) {
    if (!el) return;
    const next = value == null ? '' : String(value);
    if (el.textContent !== next) el.textContent = next;
  }
  function setWidth(el, value) {
    if (!el) return;
    const next = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
    if (el.style.width !== next) el.style.width = next;
  }

  function switchMarkup(value) {
    const state = value ? 'checked' : 'unchecked';
    return `<button id="hs-admin-time-toggle" type="button" role="switch" aria-checked="${value ? 'true' : 'false'}" data-state="${state}" class="peer focus-visible:ring-ring focus-visible:ring-offset-background data-[state=checked]:bg-primary data-[state=unchecked]:bg-input inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"><span data-state="${state}" class="bg-background pointer-events-none block h-4 w-4 rounded-full shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"></span></button>`;
  }
  function syncSwitch(button, value) {
    if (!button) return;
    const state = value ? 'checked' : 'unchecked';
    button.setAttribute('aria-checked', value ? 'true' : 'false');
    button.dataset.state = state;
    const thumb = button.querySelector('span');
    if (thumb) thumb.dataset.state = state;
  }

  function featureList() {
    const root = document.getElementById('hs-plugin-root');
    const slot = root?.querySelector('#hs-node-pro-slot');
    return slot?.parentElement?.parentElement || null;
  }
  function ensureFeatureCard() {
    if (!ownerAccess) {
      document.getElementById(FEATURE_CARD_ID)?.remove();
      return;
    }
    const list = featureList();
    if (!list) return;
    let card = document.getElementById(FEATURE_CARD_ID);
    if (!card) {
      card = document.createElement('div');
      card.id = FEATURE_CARD_ID;
      card.className = 'bg-card hover:bg-accent/40 flex flex-row items-center justify-between gap-x-3 rounded-lg border p-3 transition-colors sm:p-4';
      card.innerHTML = `<div class="space-y-0.5"><div class="flex items-center gap-2 text-xs font-medium sm:text-sm"><span>Admin Time Limit</span><span class="hs-admin-time-gold text-[10px] tracking-wide">HS</span></div><p class="text-muted-foreground text-xs sm:text-sm">Pause admin users when time expires, preserve remaining clocks, and resume them after renewal.</p></div><div class="shrink-0">${switchMarkup(enabled)}</div>`;
      const backup = document.getElementById('hs-backup-web-card');
      if (backup?.parentElement === list) backup.insertAdjacentElement('afterend', card);
      else list.appendChild(card);
      card.querySelector('#hs-admin-time-toggle')?.addEventListener('click', toggleFeature);
    }
    syncSwitch(card.querySelector('#hs-admin-time-toggle'), enabled);
  }

  async function toggleFeature(event) {
    if (featureBusy) return;
    const button = event.currentTarget;
    const current = button.getAttribute('aria-checked') === 'true';
    featureBusy = true;
    button.disabled = true;
    syncSwitch(button, !current);
    try {
      const data = await hsApi(`/features/${FEATURE}`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({enabled: !current})});
      enabled = !!data.enabled;
      syncSwitch(button, enabled);
      window.dispatchEvent(new CustomEvent('hs-plugin-feature-changed', {detail: {feature: FEATURE, enabled}}));
      if (!enabled) removeFields();
      await refreshAccount(true);
    } catch (error) {
      syncSwitch(button, current);
      flash(error.message, true);
    } finally {
      featureBusy = false;
      button.disabled = false;
    }
  }

  function directChildOf(parent, node) {
    let current = node;
    while (current && current.parentElement && current.parentElement !== parent) current = current.parentElement;
    return current?.parentElement === parent ? current : null;
  }
  function formItemFor(input) {
    if (!input) return null;
    if (input.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (label?.parentElement) return label.parentElement;
      } catch (_) {}
    }
    let el = input.parentElement;
    for (let i = 0; el && i < 6; i += 1, el = el.parentElement) {
      if (el.classList?.contains('space-y-2')) return el;
    }
    return null;
  }
  function essentialsGrid(form) {
    const username = form.querySelector('input[name="username"]');
    let el = username?.parentElement || null;
    while (el && el !== form) {
      if (el.classList?.contains('grid') && el.classList?.contains('sm:grid-cols-2')) return el;
      el = el.parentElement;
    }
    return null;
  }
  function findDataLimitItem(form) {
    const named = form.querySelector('input[name="data_limit"]');
    if (named) return formItemFor(named);
    const grid = essentialsGrid(form);
    if (!grid) return null;
    for (const span of [...grid.querySelectorAll('span')]) {
      if (String(span.textContent || '').trim().toUpperCase() !== 'GB') continue;
      const child = directChildOf(grid, span);
      if (child?.querySelector('input')) return child;
    }
    return null;
  }
  function adminForms() {
    if (!enabled || !ownerAccess) return [];
    return [...document.querySelectorAll('form')].filter(form => !!form.querySelector('input[name="username"]') && !!form.querySelector('input[name="password"]') && !!findDataLimitItem(form));
  }

  function resetIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  }
  function fieldMarkup(id) {
    return `<div class="flex min-h-5 items-center justify-between gap-2"><label class="block" for="${id}"><span class="hs-admin-time-gold">Time</span><span class="text-muted-foreground ml-1 text-[11px] font-normal">HS · days</span></label><button type="button" data-hs-time-reset class="text-muted-foreground hover:bg-accent hover:text-foreground hidden h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50">${resetIcon()}<span>${tr('Reset', 'ریست')}</span></button></div><div class="relative min-w-0"><input id="${id}" class="${INPUT_CLASS} border-border bg-input placeholder:text-input-placeholder focus-visible:ring-ring flex h-9 w-full rounded-lg border px-3 py-2 pr-14 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50" type="number" dir="ltr" inputmode="numeric" min="1" max="${MAX_DAYS}" step="1" placeholder="Unlimited" autocomplete="off"><span class="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px]">days</span></div><p class="hs-admin-time-status text-muted-foreground min-h-4 text-[11px]">${tr('Blank means unlimited time.', 'خالی = بدون محدودیت زمانی')}</p>`;
  }
  function setFieldStatus(field, text, kind = 'muted') {
    const statusEl = field?.querySelector('.hs-admin-time-status');
    if (!statusEl) return;
    statusEl.className = `hs-admin-time-status min-h-4 text-[11px] ${kind === 'error' ? 'text-destructive' : kind === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`;
    setText(statusEl, text);
  }
  function formatRemaining(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return isFa() ? `${days} روز و ${hours} ساعت باقی مانده` : `${days}d ${hours}h remaining`;
    if (hours > 0) return isFa() ? `${hours} ساعت و ${minutes} دقیقه باقی مانده` : `${hours}h ${minutes}m remaining`;
    return isFa() ? `${minutes} دقیقه باقی مانده` : `${minutes}m remaining`;
  }
  function parseDays(input) {
    const raw = String(input?.value || '').trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_DAYS) throw new Error(tr(`Time must be a whole number from 1 to ${MAX_DAYS} days.`, `زمان باید عدد صحیح بین 1 تا ${MAX_DAYS} روز باشد.`));
    return value;
  }
  function updateResetButton(state) {
    const button = state.field?.querySelector('[data-hs-time-reset]');
    if (!button) return;
    const show = state.editing && state.supported && !!state.info?.configured && Number(state.info?.duration_days || 0) > 0;
    button.classList.toggle('hidden', !show);
    button.classList.toggle('inline-flex', show);
  }
  function applyInfoToField(state, info) {
    state.info = info;
    state.loaded = true;
    state.supported = info.supported !== false;
    if (!state.input) return;
    if (!state.supported) {
      state.input.value = '';
      state.input.disabled = true;
      setFieldStatus(state.field, tr('Owner account is unlimited by design.', 'اکانت Owner به‌صورت پیش‌فرض نامحدود است.'));
      updateResetButton(state);
      return;
    }
    state.input.disabled = false;
    if (!state.touched) {
      state.draft = info.suspended && info.duration_days ? String(info.duration_days) : info.configured && info.remaining_seconds != null ? String(Math.max(1, Math.ceil(Number(info.remaining_seconds) / 86400))) : '';
      if (state.input.value !== state.draft) state.input.value = state.draft;
    }
    state.field.dataset.hsSuspended = info.suspended ? 'true' : 'false';
    if (info.suspended) setFieldStatus(state.field, tr('Expired · users paused. Set days or Reset to renew.', 'منقضی شده · کاربران متوقف‌اند. زمان جدید بزن یا ریست کن.'), 'warn');
    else if (info.configured) setFieldStatus(state.field, formatRemaining(info.remaining_seconds));
    else setFieldStatus(state.field, tr('Unlimited admin time.', 'زمان ادمین نامحدود است.'));
    updateResetButton(state);
  }
  async function hydrateState(form, state) {
    if (state.hydrating) return;
    const username = form.querySelector('input[name="username"]')?.value?.trim();
    if (!username) return;
    state.username = username;
    state.editing = !!(form.querySelector('input[name="username"]')?.disabled || form.querySelector('input[name="username"]')?.readOnly);
    if (!state.editing) {
      state.loaded = true;
      state.supported = true;
      state.info = {configured: false, unlimited: true, suspended: false, supported: true};
      updateResetButton(state);
      return;
    }
    state.hydrating = true;
    try {
      applyInfoToField(state, await hsApi(`/admin-time/by-username/${encodeURIComponent(username)}`));
    } catch (error) {
      setFieldStatus(state.field, error.status === 404 ? tr('Admin not found yet.', 'ادمین هنوز پیدا نشد.') : `HS Time: ${error.message}`, error.status === 404 ? 'muted' : 'error');
    } finally {
      state.hydrating = false;
    }
  }
  async function resetTime(state, button) {
    if (!state.editing || !state.supported || !state.username || !state.info?.configured) return;
    const duration = Number(state.info.duration_days || 0);
    if (!duration || !window.confirm(tr(`Reset ${state.username} to a fresh ${duration}-day period?`, `زمان ${state.username} از همین لحظه دوباره ${duration} روز شود؟`))) return;
    button.disabled = true;
    try {
      const info = await hsApi(`/admin-time/by-username/${encodeURIComponent(state.username)}/reset`, {method: 'POST'});
      state.touched = false;
      state.dirty = false;
      applyInfoToField(state, info);
      flash(tr('Admin time reset successfully.', 'زمان ادمین با موفقیت ریست شد.'));
      await refreshAccount(true);
    } catch (error) {
      flash(`HS Time: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }
  function mountField(form, state, dataItem) {
    const field = document.createElement('div');
    field.className = `${FIELD_CLASS} relative min-w-0 space-y-2`;
    const id = `hs-admin-time-${Math.random().toString(36).slice(2, 9)}`;
    field.innerHTML = fieldMarkup(id);
    dataItem.insertAdjacentElement('afterend', field);
    state.field = field;
    state.input = field.querySelector(`.${INPUT_CLASS}`);
    if (state.draft) state.input.value = state.draft;
    state.input.addEventListener('input', () => {
      state.touched = true;
      state.dirty = true;
      state.draft = state.input.value;
      state.input.setCustomValidity('');
      try {
        const days = parseDays(state.input);
        setFieldStatus(field, days == null ? tr('Unlimited after save.', 'بعد از ذخیره نامحدود می‌شود.') : tr(`${days} days after save.`, `بعد از ذخیره ${days} روز اعتبار خواهد داشت.`));
      } catch (error) {
        state.input.setCustomValidity(error.message);
        setFieldStatus(field, error.message, 'error');
      }
    });
    field.querySelector('[data-hs-time-reset]')?.addEventListener('click', event => resetTime(state, event.currentTarget));
    if (state.loaded && state.info) applyInfoToField(state, state.info);
    else hydrateState(form, state);
  }
  function ensureField(form) {
    const dataItem = findDataLimitItem(form);
    if (!dataItem?.parentElement) return;
    const username = form.querySelector('input[name="username"]')?.value?.trim() || '';
    const editing = !!(form.querySelector('input[name="username"]')?.disabled || form.querySelector('input[name="username"]')?.readOnly);
    let state = formState.get(form);
    if (!state) {
      state = {field: null, input: null, username, editing, touched: false, dirty: false, draft: '', loaded: false, hydrating: false, supported: true, info: null};
      formState.set(form, state);
    } else if (state.username && username && state.username !== username) {
      state.username = username;
      state.editing = editing;
      state.touched = false;
      state.dirty = false;
      state.draft = '';
      state.loaded = false;
      state.hydrating = false;
      state.supported = true;
      state.info = null;
    } else {
      state.username = username;
      state.editing = editing;
    }
    const connected = state.field?.isConnected && state.field.closest('form') === form;
    if (!connected) mountField(form, state, dataItem);
    if (!state.loaded && !state.hydrating) hydrateState(form, state);
  }
  function removeFields() {
    document.querySelectorAll(`.${FIELD_CLASS}`).forEach(el => el.remove());
  }

  function flash(message, error = false) {
    const box = document.createElement('div');
    box.className = `bg-background text-foreground fixed right-4 top-4 z-[350] max-w-sm rounded-lg border px-4 py-3 text-sm shadow-xl ${error ? 'border-destructive/60' : 'border-border'}`;
    box.textContent = message;
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 4500);
  }

  function beginPending(form, event) {
    const state = formState.get(form);
    if (!state?.dirty || !state.supported) return;
    const username = form.querySelector('input[name="username"]')?.value?.trim();
    if (!username) return;
    let days;
    try {
      days = parseDays(state.input);
    } catch (error) {
      state.input.setCustomValidity(error.message);
      state.input.reportValidity();
      event.preventDefault();
      event.stopImmediatePropagation?.();
      return;
    }
    pending.add({dialog: form.closest('[role="dialog"]') || form.parentElement, username, days, editing: state.editing, startedAt: Date.now(), finalized: false});
  }
  async function processPending() {
    for (const item of [...pending]) {
      if (item.finalized) continue;
      if (Date.now() - item.startedAt > 20000) {
        pending.delete(item);
        continue;
      }
      if (item.dialog?.isConnected) continue;
      item.finalized = true;
      pending.delete(item);
      try {
        await hsApi(`/admin-time/by-username/${encodeURIComponent(item.username)}`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({days: item.days})});
      } catch (error) {
        flash(tr(`Admin saved, but HS Time failed: ${error.message}`, `ادمین ذخیره شد اما HS Time خطا داد: ${error.message}`), true);
      }
    }
  }

  function dashboardStack() {
    if (!isDashboardRoute()) return null;
    return [...document.querySelectorAll('div.flex.flex-col')].find(el => el.classList.contains('gap-4') && el.classList.contains('sm:gap-6') && el.parentElement?.classList.contains('w-full') && el.parentElement?.classList.contains('px-3') && el.parentElement?.classList.contains('pt-2')) || null;
  }
  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let current = bytes;
    let unit = -1;
    do { current /= 1024; unit += 1; } while (current >= 1024 && unit < units.length - 1);
    return `${current.toFixed(current >= 100 ? 0 : current >= 10 ? 1 : 2)} ${units[unit]}`;
  }
  function remainingSeconds(info) {
    if (!info?.configured || !info?.expires_at) return null;
    const ts = Date.parse(info.expires_at);
    return Number.isFinite(ts) ? Math.max(0, Math.floor((ts - Date.now()) / 1000)) : Math.max(0, Math.floor(Number(info.remaining_seconds) || 0));
  }
  function formatCompactTime(seconds) {
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
    try { return new Intl.DateTimeFormat(isFa() ? 'fa-IR' : undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(date); }
    catch (_) { return date.toLocaleString(); }
  }
  function accountState() {
    const limit = Number(account?.data_limit || 0);
    const used = Math.max(0, Number(account?.used_traffic || 0));
    const remainingTraffic = limit > 0 ? Math.max(0, limit - used) : null;
    const volumePercentRemaining = limit > 0 ? Math.max(0, Math.min(100, (remainingTraffic / limit) * 100)) : 100;
    const volumePercentUsed = limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;
    const timeEnabled = selfTime?.enabled !== false;
    const timeConfigured = timeEnabled && !!selfTime?.configured;
    const timeRemaining = timeConfigured ? remainingSeconds(selfTime) : null;
    const totalTime = Math.max(0, Number(selfTime?.duration_days || 0) * 86400);
    const timePercentRemaining = timeConfigured && totalTime > 0 ? Math.max(0, Math.min(100, ((timeRemaining || 0) / totalTime) * 100)) : 100;
    const expired = (timeConfigured && (!!selfTime?.suspended || (timeRemaining || 0) <= 0)) || (limit > 0 && remainingTraffic <= 0) || String(account?.status || '').toLowerCase() === 'disabled';
    const warning = !expired && ((timeConfigured && (timeRemaining || 0) <= 3 * 86400) || (limit > 0 && volumePercentRemaining <= 10) || String(account?.status || '').toLowerCase() === 'limited');
    return {limit, used, remainingTraffic, volumePercentRemaining, volumePercentUsed, timeEnabled, timeConfigured, timeRemaining, timePercentRemaining, state: expired ? 'expired' : warning ? 'warning' : 'active'};
  }

  function accountCardMarkup() {
    return `<div class="hs-account-shell bg-card relative overflow-hidden rounded-xl border p-4 shadow-sm transition-all duration-300 hover:shadow-lg sm:p-5 lg:p-6"><div class="hs-account-glow pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-primary/20 blur-3xl"></div><div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-400/55 to-transparent"></div><div class="relative z-10"><div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div class="flex min-w-0 items-center gap-3"><div class="bg-primary/10 text-primary flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/10"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5"><path d="M4 19V8"/><path d="M10 19V5"/><path d="M16 19v-8"/><path d="M22 19V3"/><path d="M2 19h22"/></svg></div><div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h3 class="text-base font-semibold sm:text-lg">${tr('Your Account', 'وضعیت اکانت شما')}</h3><span class="hs-account-gold text-[10px] tracking-wider">HS</span><span data-status class="rounded-md border px-2 py-0.5 text-[10px] font-medium"></span></div><p data-subtitle class="text-muted-foreground mt-1 text-xs"></p></div></div><div class="text-muted-foreground flex items-center gap-1.5 text-[11px]"><span class="relative flex h-2 w-2"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-30"></span><span class="relative inline-flex h-2 w-2 rounded-full bg-green-500"></span></span><span>${tr('Live', 'زنده')}</span></div></div><div class="grid grid-cols-1 gap-3 sm:grid-cols-3"><div class="hs-account-metric bg-background/65 rounded-xl border p-4"><div class="text-muted-foreground mb-2 text-[11px] font-medium">${tr('Available volume', 'حجم قابل استفاده')}</div><div data-total class="hs-account-value text-xl font-bold tracking-tight sm:text-2xl" dir="ltr"></div><div data-total-caption class="text-muted-foreground mt-1 text-[10px]"></div></div><div class="hs-account-metric bg-background/65 rounded-xl border p-4"><div class="text-muted-foreground mb-2 text-[11px] font-medium">${tr('Remaining volume', 'حجم باقی‌مانده')}</div><div data-remaining class="hs-account-value text-xl font-bold tracking-tight sm:text-2xl" dir="ltr"></div><div data-used class="text-muted-foreground mt-1 text-[10px]"></div></div><div class="hs-account-metric bg-background/65 rounded-xl border p-4"><div class="text-muted-foreground mb-2 text-[11px] font-medium">${tr('Remaining time', 'زمان باقی‌مانده')}</div><div data-time class="hs-account-value text-xl font-bold tracking-tight sm:text-2xl" dir="ltr"></div><div data-expiry class="text-muted-foreground mt-1 text-[10px]"></div></div></div><div class="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2"><div class="bg-muted/25 rounded-xl border p-3.5"><div class="mb-2 flex items-center justify-between gap-3 text-[11px]"><span class="text-muted-foreground">${tr('Traffic usage', 'مصرف حجم')}</span><span data-traffic-percent class="font-semibold" dir="ltr"></span></div><div class="bg-muted h-2.5 overflow-hidden rounded-full"><div data-traffic-fill class="hs-account-progress-fill bg-primary h-full rounded-full" style="width:0%"></div></div></div><div class="bg-muted/25 rounded-xl border p-3.5"><div class="mb-2 flex items-center justify-between gap-3 text-[11px]"><span class="text-muted-foreground">${tr('Account lifetime', 'زمان اعتبار اکانت')}</span><span data-time-percent class="font-semibold" dir="ltr"></span></div><div class="bg-muted h-2.5 overflow-hidden rounded-full"><div data-time-fill class="hs-account-progress-fill h-full rounded-full bg-amber-500" style="width:0%"></div></div></div></div></div></div>`;
  }

  function ensurePortal() {
    const isOwner = !!account?.role?.is_owner;
    const shouldShow = !!account && !isOwner && isDashboardRoute();
    let portal = document.getElementById(ACCOUNT_PORTAL_ID);
    if (!shouldShow) {
      portal?.remove();
      restoreNativeStack();
      return null;
    }
    if (!portal) {
      portal = document.createElement('div');
      portal.id = ACCOUNT_PORTAL_ID;
      portal.innerHTML = accountCardMarkup();
      document.body.appendChild(portal);
    }
    return portal;
  }
  function restoreNativeStack() {
    if (nativeStack?.isConnected) nativeStack.style.paddingTop = nativeStackOldPaddingTop;
    nativeStack = null;
    nativeStackOldPaddingTop = '';
    portalHeight = 0;
  }
  function positionPortal() {
    const portal = ensurePortal();
    const stack = dashboardStack();
    if (!portal || !stack) return;
    if (nativeStack !== stack) {
      restoreNativeStack();
      nativeStack = stack;
      nativeStackOldPaddingTop = stack.style.paddingTop || '';
    }
    const rect = stack.getBoundingClientRect();
    portal.style.left = `${window.scrollX + rect.left}px`;
    portal.style.top = `${window.scrollY + rect.top}px`;
    portal.style.width = `${rect.width}px`;
    const measured = Math.ceil(portal.getBoundingClientRect().height || portalHeight || 0);
    if (measured > 0) portalHeight = measured;
    if (portalHeight > 0) stack.style.paddingTop = `${portalHeight + 16}px`;
  }
  function renderAccountCard() {
    const portal = ensurePortal();
    if (!portal || !account) return;
    const s = accountState();
    const badge = portal.querySelector('[data-status]');
    badge.textContent = s.state === 'expired' ? tr('Expired', 'منقضی') : s.state === 'warning' ? tr('Ending soon', 'رو به پایان') : tr('Active', 'فعال');
    badge.className = 'rounded-md border px-2 py-0.5 text-[10px] font-medium ' + (s.state === 'expired' ? 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400' : s.state === 'warning' ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400');
    setText(portal.querySelector('[data-subtitle]'), account.username ? tr(`Live allowance for ${account.username}`, `نمایش زنده اعتبار و حجم ${account.username}`) : tr('Live account allowance', 'نمایش زنده اعتبار اکانت'));
    setText(portal.querySelector('[data-total]'), s.limit > 0 ? formatBytes(s.limit) : '∞');
    setText(portal.querySelector('[data-total-caption]'), s.limit > 0 ? tr('Total assigned traffic', 'کل حجم اختصاص داده‌شده') : tr('Unlimited traffic', 'حجم نامحدود'));
    setText(portal.querySelector('[data-remaining]'), s.limit > 0 ? formatBytes(s.remainingTraffic) : '∞');
    setText(portal.querySelector('[data-used]'), `${tr('Used', 'مصرف‌شده')}: ${formatBytes(s.used)}`);
    setText(portal.querySelector('[data-time]'), !s.timeEnabled ? tr('Disabled', 'غیرفعال') : !s.timeConfigured ? '∞' : formatCompactTime(s.timeRemaining));
    setText(portal.querySelector('[data-expiry]'), !s.timeEnabled ? tr('Time limit feature is off', 'محدودیت زمانی غیرفعال است') : !s.timeConfigured ? tr('Unlimited time', 'بدون محدودیت زمانی') : selfTime?.expires_at ? `${tr('Expires', 'پایان')}: ${formatDate(selfTime.expires_at)}` : '');
    const trafficUsed = s.limit > 0 ? s.volumePercentUsed : 0;
    setText(portal.querySelector('[data-traffic-percent]'), s.limit > 0 ? `${trafficUsed.toFixed(1)}%` : tr('Unlimited', 'نامحدود'));
    const trafficFill = portal.querySelector('[data-traffic-fill]');
    setWidth(trafficFill, trafficUsed);
    trafficFill.className = 'hs-account-progress-fill h-full rounded-full ' + (s.limit > 0 && s.volumePercentRemaining <= 10 ? 'bg-red-500' : s.limit > 0 && s.volumePercentRemaining <= 25 ? 'bg-amber-500' : 'bg-primary');
    setText(portal.querySelector('[data-time-percent]'), s.timeConfigured ? `${s.timePercentRemaining.toFixed(1)}%` : tr('Unlimited', 'نامحدود'));
    const timeFill = portal.querySelector('[data-time-fill]');
    setWidth(timeFill, s.timeConfigured ? s.timePercentRemaining : 100);
    timeFill.className = 'hs-account-progress-fill h-full rounded-full ' + (s.timeConfigured && s.timePercentRemaining <= 10 ? 'bg-red-500' : 'bg-amber-500');
    positionPortal();
  }

  async function refreshAccount(force = false) {
    if (accountBusy) return;
    if (!force && Date.now() - lastAccountFetch < 25000) return;
    accountBusy = true;
    try {
      const adminResult = await Promise.allSettled([request('/api/admin', {}, 5000), hsApi('/admin-time/me', {}, 5000)]);
      if (adminResult[0].status === 'fulfilled') account = adminResult[0].value;
      else if (adminResult[0].reason?.status === 401) account = null;
      if (adminResult[1].status === 'fulfilled') selfTime = adminResult[1].value;
      else if ([401, 404].includes(adminResult[1].reason?.status)) selfTime = null;
      lastAccountFetch = Date.now();
    } finally {
      accountBusy = false;
      renderAccountCard();
    }
  }
  async function refreshFeature(force = false) {
    if (!force && Date.now() - lastFeatureFetch < 55000) return;
    lastFeatureFetch = Date.now();
    try {
      const state = await hsApi('/state', {}, 5000);
      ownerAccess = true;
      enabled = !!state?.features?.[FEATURE]?.enabled;
    } catch (error) {
      if ([401, 403].includes(error.status)) ownerAccess = false;
    }
    ensureFeatureCard();
    if (!enabled && ownerAccess) removeFields();
  }

  function lightweightSync() {
    ensureFeatureCard();
    if (enabled && ownerAccess) adminForms().forEach(ensureField);
    processPending();
    if (isDashboardRoute()) {
      renderAccountCard();
      positionPortal();
    } else {
      document.getElementById(ACCOUNT_PORTAL_ID)?.remove();
      restoreNativeStack();
    }
  }

  function start() {
    injectStyle();
    document.addEventListener('submit', event => {
      if (event.target instanceof HTMLFormElement && formState.has(event.target)) beginPending(event.target, event);
    }, true);
    const routeRefresh = () => {
      setTimeout(() => {
        lightweightSync();
        refreshAccount(true);
      }, 120);
    };
    window.addEventListener('hashchange', routeRefresh);
    window.addEventListener('popstate', routeRefresh);
    window.addEventListener('resize', () => positionPortal(), {passive: true});
    window.addEventListener('scroll', () => positionPortal(), {passive: true});
    window.addEventListener('hs-plugin-feature-changed', event => {
      if (event.detail?.feature !== FEATURE) return;
      enabled = !!event.detail.enabled;
      if (!enabled) removeFields();
      lightweightSync();
      refreshAccount(true);
    });

    refreshFeature(true);
    setTimeout(() => refreshAccount(true), 700);
    setInterval(() => refreshFeature(false), 60000);
    setInterval(() => refreshAccount(false), 30000);
    setInterval(lightweightSync, 2000);
    setInterval(() => {
      if (isDashboardRoute() && account) renderAccountCard();
      processPending();
    }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();

  window.HSAdminTime = {
    version: VERSION,
    refresh: async () => {
      await Promise.allSettled([refreshFeature(true), refreshAccount(true)]);
      lightweightSync();
    },
    get enabled() { return enabled; },
    diagnostics: () => ({
      version: VERSION,
      enabled,
      ownerAccess,
      route: routePath(),
      fields: document.querySelectorAll(`.${FIELD_CLASS}`).length,
      account: account?.username || null,
      owner: !!account?.role?.is_owner,
      dataLimit: account?.data_limit ?? null,
      usedTraffic: account?.used_traffic ?? null,
      timeConfigured: !!selfTime?.configured,
      accountPortal: !!document.getElementById(ACCOUNT_PORTAL_ID),
      accountBusy,
      portalHeight,
    }),
  };
})();