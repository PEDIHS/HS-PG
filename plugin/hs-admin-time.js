(() => {
  'use strict';

  const VERSION = '1.2.0';
  const FEATURE = 'admin_time_limit';
  const FEATURE_CARD_ID = 'hs-admin-time-card';
  const ACCOUNT_CARD_ID = 'hs-account-overview-card';
  const FIELD_CLASS = 'hs-admin-time-field';
  const INPUT_CLASS = 'hs-admin-time-input';
  const MAX_DAYS = 36500;
  const rawFetch = window.fetch.bind(window);

  let enabled = false;
  let ownerAccess = false;
  let featureBusy = false;
  let observer = null;
  let syncQueued = false;
  let syncing = false;
  let account = null;
  let selfTime = null;
  let accountFetchedAt = 0;
  let accountRefreshBusy = false;

  const formState = new WeakMap();
  const draftCache = new Map();
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
      @keyframes hs-account-rise{0%{opacity:0;transform:translateY(10px) scale(.992)}100%{opacity:1;transform:translateY(0) scale(1)}}
      @keyframes hs-account-glow{0%,100%{transform:translate3d(-10%,0,0) scale(1);opacity:.16}50%{transform:translate3d(18%,-6%,0) scale(1.12);opacity:.32}}
      @keyframes hs-account-shine{0%{transform:translateX(-150%) skewX(-18deg)}58%,100%{transform:translateX(270%) skewX(-18deg)}}
      @keyframes hs-account-pulse{0%,100%{box-shadow:0 0 0 0 rgba(217,170,66,.04)}50%{box-shadow:0 0 0 5px rgba(217,170,66,.035)}}
      .hs-admin-time-gold,.hs-account-gold{
        color:#e7bd59;background:linear-gradient(100deg,#b97918 0%,#e4b64b 24%,#fff0ab 46%,#d3a13a 60%,#f5d77e 80%,#b97918 100%);
        background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
        animation:hs-admin-gold 4.8s ease-in-out infinite;font-weight:700
      }
      .${FIELD_CLASS}{min-width:0}
      .${FIELD_CLASS}[data-hs-suspended="true"] .${INPUT_CLASS}{border-color:rgba(217,170,66,.65)!important;box-shadow:0 0 0 1px rgba(217,170,66,.08)}
      #${ACCOUNT_CARD_ID}{animation:hs-account-rise .48s cubic-bezier(.2,.8,.2,1) both}
      #${ACCOUNT_CARD_ID} .hs-account-shell{isolation:isolate}
      #${ACCOUNT_CARD_ID} .hs-account-glow{animation:hs-account-glow 7s ease-in-out infinite}
      #${ACCOUNT_CARD_ID} .hs-account-progress-fill{position:relative;overflow:hidden;transition:width .75s cubic-bezier(.2,.8,.2,1)}
      #${ACCOUNT_CARD_ID} .hs-account-progress-fill::after{content:"";position:absolute;inset:0 auto 0 0;width:34%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.34),transparent);animation:hs-account-shine 3.2s ease-in-out infinite}
      #${ACCOUNT_CARD_ID}[data-state="warning"] .hs-account-shell{animation:hs-account-pulse 2.8s ease-in-out infinite}
      #${ACCOUNT_CARD_ID} .hs-account-metric{transition:transform .22s ease,border-color .22s ease,background-color .22s ease}
      #${ACCOUNT_CARD_ID} .hs-account-metric:hover{transform:translateY(-2px)}
      #${ACCOUNT_CARD_ID} .hs-account-value{font-variant-numeric:tabular-nums}
      @media(prefers-reduced-motion:reduce){
        .hs-admin-time-gold,.hs-account-gold,#${ACCOUNT_CARD_ID},#${ACCOUNT_CARD_ID} .hs-account-glow,#${ACCOUNT_CARD_ID} .hs-account-shell,#${ACCOUNT_CARD_ID} .hs-account-progress-fill::after{animation:none!important}
        #${ACCOUNT_CARD_ID} .hs-account-progress-fill,#${ACCOUNT_CARD_ID} .hs-account-metric{transition:none!important}
      }
    `;
  }

  function authHeaders(extra = {}) {
    const headers = new Headers(extra);
    const token = localStorage.getItem('token');
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }

  async function request(path, options = {}) {
    const {headers: supplied, ...rest} = options;
    const response = await rawFetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...rest,
      headers: authHeaders(supplied || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.detail || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  const hsApi = (path, options = {}) => request(`/api/hs-plugin${path}`, options);

  function routePath() {
    const hash = window.location.hash || '';
    if (hash.startsWith('#/')) return hash.slice(1).split('?')[0];
    return window.location.pathname || '/';
  }

  function isDashboardRoute() {
    const route = routePath();
    return route === '/' || route === '/dashboard';
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
    if (!ownerAccess) return;
    const list = featureList();
    if (!list) return;
    let card = document.getElementById(FEATURE_CARD_ID);
    if (!card) {
      card = document.createElement('div');
      card.id = FEATURE_CARD_ID;
      card.className = 'bg-card hover:bg-accent/40 flex flex-row items-center justify-between gap-x-3 rounded-lg border p-3 transition-colors sm:p-4';
      card.innerHTML = `
        <div class="space-y-0.5">
          <div class="flex items-center gap-2 text-xs font-medium sm:text-sm"><span>Admin Time Limit</span><span class="hs-admin-time-gold text-[10px] tracking-wide">HS</span></div>
          <p class="text-muted-foreground text-xs sm:text-sm">Pause admin users when time expires and resume their preserved time after renewal.</p>
        </div>
        <div class="shrink-0">${switchMarkup(enabled)}</div>`;
      const backup = document.getElementById('hs-backup-web-card');
      if (backup?.parentElement === list) backup.insertAdjacentElement('afterend', card);
      else list.appendChild(card);
      card.querySelector('#hs-admin-time-toggle')?.addEventListener('click', toggleFeature);
    } else {
      syncSwitch(card.querySelector('#hs-admin-time-toggle'), enabled);
    }
  }

  async function toggleFeature(event) {
    if (featureBusy) return;
    const button = event.currentTarget;
    const current = button.getAttribute('aria-checked') === 'true';
    const next = !current;
    featureBusy = true;
    button.disabled = true;
    syncSwitch(button, next);
    const status = document.querySelector('#hs-tab-status');
    if (status) status.textContent = 'Applying Admin Time Limit…';
    try {
      const data = await hsApi(`/features/${FEATURE}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({enabled: next}),
      });
      enabled = !!data.enabled;
      syncSwitch(button, enabled);
      window.dispatchEvent(new CustomEvent('hs-plugin-feature-changed', {detail: {feature: FEATURE, enabled}}));
      if (!enabled) removeFields();
      if (status) status.textContent = enabled ? 'Admin Time Limit enabled.' : 'Admin Time Limit disabled; suspended users resumed.';
      await refreshAccount();
    } catch (error) {
      syncSwitch(button, current);
      if (status) status.textContent = error.message;
    } finally {
      featureBusy = false;
      button.disabled = false;
      queueSync();
    }
  }

  async function refreshFeature() {
    try {
      const state = await hsApi('/state');
      ownerAccess = true;
      enabled = !!state?.features?.[FEATURE]?.enabled;
      ensureFeatureCard();
      if (!enabled) removeFields();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        ownerAccess = false;
        document.getElementById(FEATURE_CARD_ID)?.remove();
        removeFields();
      }
    }
    queueSync();
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
    const spans = [...grid.querySelectorAll('span')].filter(span => String(span.textContent || '').trim().toUpperCase() === 'GB');
    for (const span of spans) {
      const child = directChildOf(grid, span);
      if (child?.querySelector('input')) return child;
    }
    return null;
  }

  function adminForms() {
    if (!enabled || !ownerAccess) return [];
    return [...document.querySelectorAll('form')].filter(form => {
      const username = form.querySelector('input[name="username"]');
      const password = form.querySelector('input[name="password"]');
      return !!username && !!password && !!findDataLimitItem(form);
    });
  }

  function resetIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  }

  function fieldMarkup(id) {
    return `
      <div class="flex min-h-5 items-center justify-between gap-2">
        <label class="block" for="${id}"><span class="hs-admin-time-gold">Time</span><span class="text-muted-foreground ml-1 text-[11px] font-normal">HS · days</span></label>
        <button type="button" data-hs-time-reset class="text-muted-foreground hover:bg-accent hover:text-foreground hidden h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50">${resetIcon()}<span>${tr('Reset', 'ریست')}</span></button>
      </div>
      <div class="relative min-w-0">
        <input id="${id}" class="${INPUT_CLASS} border-border bg-input placeholder:text-input-placeholder focus-visible:ring-ring flex h-9 w-full rounded-lg border px-3 py-2 pr-14 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50" type="number" dir="ltr" inputmode="numeric" min="1" max="${MAX_DAYS}" step="1" placeholder="Unlimited" autocomplete="off">
        <span class="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px]">days</span>
      </div>
      <p class="hs-admin-time-status text-muted-foreground min-h-4 text-[11px]">${tr('Blank means unlimited time.', 'خالی = بدون محدودیت زمانی')}</p>`;
  }

  function setFieldStatus(field, text, kind = 'muted') {
    const status = field?.querySelector('.hs-admin-time-status');
    if (!status) return;
    status.className = `hs-admin-time-status min-h-4 text-[11px] ${kind === 'error' ? 'text-destructive' : kind === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`;
    status.textContent = text;
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
    if (!Number.isInteger(value) || value < 1 || value > MAX_DAYS) {
      throw new Error(tr(`Time must be a whole number from 1 to ${MAX_DAYS} days.`, `زمان باید عدد صحیح بین 1 تا ${MAX_DAYS} روز باشد.`));
    }
    return value;
  }

  function cacheDraft(username, value, touched = true) {
    if (!username) return;
    draftCache.set(username, {value: String(value ?? ''), touched, at: Date.now()});
  }

  function cachedDraft(username) {
    const item = draftCache.get(username);
    if (!item) return null;
    if (Date.now() - item.at > 60000) {
      draftCache.delete(username);
      return null;
    }
    return item;
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
    state.supported = info.supported !== false;
    const input = state.input;
    const field = state.field;
    if (!input || !field) return;

    if (!state.supported) {
      input.value = '';
      input.disabled = true;
      field.dataset.hsSuspended = 'false';
      setFieldStatus(field, tr('Owner account is unlimited by design.', 'اکانت Owner به‌صورت پیش‌فرض نامحدود است.'));
      updateResetButton(state);
      return;
    }

    input.disabled = false;
    const cached = cachedDraft(state.username);
    if (cached?.touched) {
      state.touched = true;
      state.dirty = true;
      state.draft = cached.value;
      input.value = cached.value;
    } else if (!state.touched) {
      if (info.suspended) state.draft = info.duration_days ? String(info.duration_days) : '';
      else if (info.configured && info.remaining_seconds != null) state.draft = String(Math.max(1, Math.ceil(Number(info.remaining_seconds) / 86400)));
      else state.draft = '';
      input.value = state.draft;
    }

    field.dataset.hsSuspended = info.suspended ? 'true' : 'false';
    if (info.suspended) setFieldStatus(field, tr('Expired · users paused. Set days or Reset to renew.', 'منقضی شده · کاربران متوقف‌اند. زمان جدید بزن یا ریست کن.'), 'warn');
    else if (info.configured) setFieldStatus(field, formatRemaining(info.remaining_seconds));
    else setFieldStatus(field, tr('Unlimited admin time.', 'زمان ادمین نامحدود است.'));
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
      const cached = cachedDraft(username);
      if (cached) {
        state.draft = cached.value;
        state.touched = cached.touched;
        state.dirty = cached.touched;
        if (state.input) state.input.value = cached.value;
      }
      updateResetButton(state);
      return;
    }

    state.hydrating = true;
    try {
      const info = await hsApi(`/admin-time/by-username/${encodeURIComponent(username)}`);
      state.loaded = true;
      applyInfoToField(state, info);
    } catch (error) {
      if (error.status === 404) setFieldStatus(state.field, tr('Admin not found yet.', 'ادمین هنوز پیدا نشد.'));
      else setFieldStatus(state.field, `HS Time: ${error.message}`, 'error');
    } finally {
      state.hydrating = false;
    }
  }

  function confirmDialog({title, description, confirmLabel}) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'fixed inset-0 z-[320] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[1px]';
      overlay.innerHTML = `
        <div role="alertdialog" aria-modal="true" class="bg-background text-foreground w-full max-w-md rounded-xl border p-5 shadow-2xl">
          <div class="mb-1 flex items-center gap-2 text-base font-semibold"><span class="hs-admin-time-gold">HS</span><span data-title></span></div>
          <p data-description class="text-muted-foreground mt-2 text-sm leading-6"></p>
          <div class="mt-5 flex justify-end gap-2">
            <button type="button" data-cancel class="hover:bg-accent h-9 rounded-md border px-4 text-sm font-medium transition-colors">${tr('Cancel', 'انصراف')}</button>
            <button type="button" data-confirm class="bg-primary text-primary-foreground hover:bg-primary/90 h-9 rounded-md px-4 text-sm font-medium transition-colors"></button>
          </div>
        </div>`;
      overlay.querySelector('[data-title]').textContent = title;
      overlay.querySelector('[data-description]').textContent = description;
      overlay.querySelector('[data-confirm]').textContent = confirmLabel;
      const finish = value => { overlay.remove(); resolve(value); };
      overlay.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
      overlay.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
      overlay.addEventListener('click', event => { if (event.target === overlay) finish(false); });
      document.body.appendChild(overlay);
      overlay.querySelector('[data-confirm]').focus();
    });
  }

  function flash(message, error = false) {
    const box = document.createElement('div');
    box.className = `bg-background text-foreground fixed right-4 top-4 z-[350] max-w-sm rounded-lg border px-4 py-3 text-sm shadow-xl ${error ? 'border-destructive/60' : 'border-border'}`;
    box.textContent = message;
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 5000);
  }

  async function resetTime(state, button) {
    if (!state.editing || !state.supported || !state.username || !state.info?.configured) return;
    const duration = Number(state.info.duration_days || 0);
    if (!duration) return;
    const ok = await confirmDialog({
      title: tr('Reset Admin Time', 'ریست زمان ادمین'),
      description: tr(`Reset ${state.username} to a fresh ${duration}-day period? User traffic and each user's remaining time will not be reset.`, `زمان ${state.username} از همین لحظه دوباره ${duration} روز می‌شود. حجم و زمان باقی‌مانده کاربران ریست نمی‌شود.`),
      confirmLabel: tr('Reset Time', 'ریست زمان'),
    });
    if (!ok) return;

    const old = button.innerHTML;
    button.disabled = true;
    button.textContent = tr('Resetting…', 'در حال ریست…');
    try {
      const info = await hsApi(`/admin-time/by-username/${encodeURIComponent(state.username)}/reset`, {method: 'POST'});
      draftCache.delete(state.username);
      state.touched = false;
      state.dirty = false;
      state.loaded = true;
      applyInfoToField(state, info);
      flash(tr('Admin time reset successfully.', 'زمان ادمین با موفقیت ریست شد.'));
      await refreshAccount();
    } catch (error) {
      flash(`HS Time: ${error.message}`, true);
    } finally {
      button.disabled = false;
      button.innerHTML = old;
      updateResetButton(state);
    }
  }

  function mountField(form, state, dataItem) {
    const field = document.createElement('div');
    field.className = `${FIELD_CLASS} relative min-w-0 space-y-2`;
    const id = `hs-admin-time-${Math.random().toString(36).slice(2, 9)}`;
    field.innerHTML = fieldMarkup(id);
    dataItem.insertAdjacentElement('afterend', field);

    const input = field.querySelector(`.${INPUT_CLASS}`);
    state.field = field;
    state.input = input;
    if (state.draft != null) input.value = state.draft;

    input.addEventListener('input', () => {
      state.touched = true;
      state.dirty = true;
      state.draft = input.value;
      cacheDraft(state.username, state.draft, true);
      input.setCustomValidity('');
      field.dataset.hsSuspended = 'false';
      try {
        const days = parseDays(input);
        setFieldStatus(field, days == null ? tr('Unlimited after save.', 'بعد از ذخیره نامحدود می‌شود.') : tr(`${days} day${days === 1 ? '' : 's'} after save.`, `بعد از ذخیره ${days} روز اعتبار خواهد داشت.`));
      } catch (error) {
        input.setCustomValidity(error.message);
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
      const cached = cachedDraft(username);
      state = {
        field: null,
        input: null,
        username,
        editing,
        touched: !!cached?.touched,
        dirty: !!cached?.touched,
        draft: cached?.value || '',
        loaded: false,
        hydrating: false,
        supported: true,
        info: null,
      };
      formState.set(form, state);
    } else if (state.username && username && state.username !== username) {
      state.username = username;
      state.editing = editing;
      const cached = cachedDraft(username);
      state.touched = !!cached?.touched;
      state.dirty = !!cached?.touched;
      state.draft = cached?.value || '';
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
    else if (state.field.previousElementSibling !== dataItem) dataItem.insertAdjacentElement('afterend', state.field);
    if (!state.loaded && !state.hydrating) hydrateState(form, state);
  }

  function removeFields() {
    document.querySelectorAll(`.${FIELD_CLASS}`).forEach(el => el.remove());
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

    const dialog = form.closest('[role="dialog"]') || form.parentElement;
    const item = {
      dialog,
      username,
      days,
      editing: state.editing,
      startedAt: Date.now(),
      successSeen: false,
      finalized: false,
      existingBefore: state.editing ? Promise.resolve(true) : hsApi(`/admin-time/by-username/${encodeURIComponent(username)}`).then(() => true).catch(error => error.status === 404 ? false : null),
    };
    pending.add(item);
    setTimeout(() => { if (!item.finalized) pending.delete(item); }, 25000);
  }

  async function finalize(item) {
    if (item.finalized) return;
    item.finalized = true;
    pending.delete(item);
    try {
      const existed = await item.existingBefore;
      if (!item.editing && existed === true) return;
      await hsApi(`/admin-time/by-username/${encodeURIComponent(item.username)}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({days: item.days}),
      });
      draftCache.delete(item.username);
      await refreshAccount();
    } catch (error) {
      flash(tr(`Admin saved, but HS Time failed: ${error.message}`, `ادمین ذخیره شد اما HS Time خطا داد: ${error.message}`), true);
    }
  }

  function markNativeSuccess() {
    const candidates = [...pending].filter(item => Date.now() - item.startedAt < 20000 && !item.finalized);
    if (!candidates.length) return;
    candidates.sort((a, b) => b.startedAt - a.startedAt);
    candidates[0].successSeen = true;
    queueSync();
  }

  function inspectAddedNode(node) {
    if (!(node instanceof Element)) return;
    if (node.matches?.('[data-sonner-toast][data-type="success"]') || node.querySelector?.('[data-sonner-toast][data-type="success"]')) markNativeSuccess();
  }

  function processPending() {
    for (const item of [...pending]) {
      if (item.finalized) continue;
      if (Date.now() - item.startedAt > 25000) {
        pending.delete(item);
        continue;
      }
      if (item.successSeen && !item.dialog?.isConnected) finalize(item);
    }
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
    try {
      return new Intl.DateTimeFormat(isFa() ? 'fa-IR' : undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(date);
    } catch (_) {
      return date.toLocaleString();
    }
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
    const timeTotal = Math.max(0, Number(selfTime?.duration_days || 0) * 86400);
    const timePercentRemaining = timeConfigured && timeTotal > 0 ? Math.max(0, Math.min(100, ((timeRemaining || 0) / timeTotal) * 100)) : 100;

    const timeExpired = timeConfigured && (!!selfTime?.suspended || (timeRemaining || 0) <= 0);
    const trafficExpired = limit > 0 && remainingTraffic <= 0;
    const warning = !timeExpired && !trafficExpired && ((timeConfigured && (timeRemaining || 0) <= 3 * 86400) || (limit > 0 && volumePercentRemaining <= 10));

    let state = 'active';
    let label = tr('Active', 'فعال');
    const nativeStatus = String(account?.status || '').toLowerCase();
    if (timeExpired) {
      state = 'expired';
      label = tr('Time expired', 'زمان تمام شده');
    } else if (trafficExpired) {
      state = 'expired';
      label = tr('Traffic exhausted', 'حجم تمام شده');
    } else if (nativeStatus === 'disabled') {
      state = 'expired';
      label = tr('Disabled', 'غیرفعال');
    } else if (nativeStatus === 'limited') {
      state = 'warning';
      label = tr('Limited', 'محدود');
    } else if (warning) {
      state = 'warning';
      label = tr('Ending soon', 'رو به پایان');
    }

    return {limit, used, remainingTraffic, volumePercentRemaining, volumePercentUsed, timeEnabled, timeConfigured, timeRemaining, timePercentRemaining, state, label};
  }

  function accountCardMarkup() {
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
                  <h3 data-hs-account-title class="text-base font-semibold sm:text-lg"></h3>
                  <span class="hs-account-gold text-[10px] tracking-wider">HS</span>
                  <span data-hs-account-status class="rounded-md border px-2 py-0.5 text-[10px] font-medium"></span>
                </div>
                <p data-hs-account-subtitle class="text-muted-foreground mt-1 text-xs"></p>
              </div>
            </div>
            <div class="text-muted-foreground flex items-center gap-1.5 text-[11px]">
              <span class="relative flex h-2 w-2"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-30"></span><span class="relative inline-flex h-2 w-2 rounded-full bg-green-500"></span></span>
              <span>${tr('Live', 'زنده')}</span>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div class="hs-account-metric bg-background/65 rounded-xl border p-4">
              <div class="text-muted-foreground mb-2 text-[11px] font-medium">${tr('Available volume', 'حجم قابل استفاده')}</div>
              <div data-hs-account-total class="hs-account-value text-xl font-bold tracking-tight sm:text-2xl" dir="ltr"></div>
              <div data-hs-account-total-caption class="text-muted-foreground mt-1 text-[10px]"></div>
            </div>
            <div class="hs-account-metric bg-background/65 rounded-xl border p-4">
              <div class="text-muted-foreground mb-2 text-[11px] font-medium">${tr('Remaining volume', 'حجم باقی‌مانده')}</div>
              <div data-hs-account-remaining class="hs-account-value text-xl font-bold tracking-tight sm:text-2xl" dir="ltr"></div>
              <div data-hs-account-used class="text-muted-foreground mt-1 text-[10px]"></div>
            </div>
            <div class="hs-account-metric bg-background/65 rounded-xl border p-4">
              <div class="text-muted-foreground mb-2 text-[11px] font-medium">${tr('Remaining time', 'زمان باقی‌مانده')}</div>
              <div data-hs-account-time class="hs-account-value text-xl font-bold tracking-tight sm:text-2xl" dir="ltr"></div>
              <div data-hs-account-expiry class="text-muted-foreground mt-1 text-[10px]"></div>
            </div>
          </div>

          <div class="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div class="bg-muted/25 rounded-xl border p-3.5 sm:p-4">
              <div class="mb-2 flex items-center justify-between gap-3 text-[11px]"><span class="text-muted-foreground">${tr('Traffic usage', 'مصرف حجم')}</span><span data-hs-account-traffic-percent class="font-semibold" dir="ltr"></span></div>
              <div class="bg-muted h-2.5 overflow-hidden rounded-full"><div data-hs-account-traffic-fill class="hs-account-progress-fill bg-primary h-full rounded-full" style="width:0%"></div></div>
            </div>
            <div class="bg-muted/25 rounded-xl border p-3.5 sm:p-4">
              <div class="mb-2 flex items-center justify-between gap-3 text-[11px]"><span class="text-muted-foreground">${tr('Account lifetime', 'زمان اعتبار اکانت')}</span><span data-hs-account-time-percent class="font-semibold" dir="ltr"></span></div>
              <div class="bg-muted h-2.5 overflow-hidden rounded-full"><div data-hs-account-time-fill class="hs-account-progress-fill h-full rounded-full bg-amber-500" style="width:0%"></div></div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function ensureAccountCard() {
    const isOwner = !!account?.role?.is_owner;
    const shouldShow = !!account && !isOwner && isDashboardRoute();
    let host = document.getElementById(ACCOUNT_CARD_ID);
    if (!shouldShow) {
      host?.remove();
      return null;
    }
    const stack = dashboardStack();
    if (!stack) return null;
    if (!host) {
      host = document.createElement('div');
      host.id = ACCOUNT_CARD_ID;
      host.className = 'w-full';
      host.innerHTML = accountCardMarkup();
    }
    if (!host.isConnected || host.parentElement !== stack) stack.insertBefore(host, stack.firstElementChild);
    return host;
  }

  function renderAccountCard() {
    const host = ensureAccountCard();
    if (!host || !account) return;
    const s = accountState();
    host.dataset.state = s.state;

    host.querySelector('[data-hs-account-title]').textContent = tr('Your Account', 'وضعیت اکانت شما');
    host.querySelector('[data-hs-account-subtitle]').textContent = account.username
      ? tr(`Live allowance for ${account.username}`, `نمایش زنده اعتبار و حجم ${account.username}`)
      : tr('Live account allowance', 'نمایش زنده اعتبار اکانت');

    const badge = host.querySelector('[data-hs-account-status]');
    badge.textContent = s.label;
    badge.className = 'rounded-md border px-2 py-0.5 text-[10px] font-medium';
    if (s.state === 'expired') badge.classList.add('border-red-500/30', 'bg-red-500/10', 'text-red-600', 'dark:text-red-400');
    else if (s.state === 'warning') badge.classList.add('border-amber-500/30', 'bg-amber-500/10', 'text-amber-600', 'dark:text-amber-400');
    else badge.classList.add('border-green-500/30', 'bg-green-500/10', 'text-green-600', 'dark:text-green-400');

    if (s.limit > 0) {
      host.querySelector('[data-hs-account-total]').textContent = formatBytes(s.limit);
      host.querySelector('[data-hs-account-total-caption]').textContent = tr('Total assigned traffic', 'کل حجم اختصاص داده‌شده');
      host.querySelector('[data-hs-account-remaining]').textContent = formatBytes(s.remainingTraffic);
    } else {
      host.querySelector('[data-hs-account-total]').textContent = '∞';
      host.querySelector('[data-hs-account-total-caption]').textContent = tr('Unlimited traffic', 'حجم نامحدود');
      host.querySelector('[data-hs-account-remaining]').textContent = '∞';
    }
    host.querySelector('[data-hs-account-used]').textContent = `${tr('Used', 'مصرف‌شده')}: ${formatBytes(s.used)}`;

    const timeEl = host.querySelector('[data-hs-account-time]');
    const expiryEl = host.querySelector('[data-hs-account-expiry]');
    if (!s.timeEnabled) {
      timeEl.textContent = tr('Disabled', 'غیرفعال');
      expiryEl.textContent = tr('Time limit feature is off', 'محدودیت زمانی غیرفعال است');
    } else if (!s.timeConfigured) {
      timeEl.textContent = '∞';
      expiryEl.textContent = tr('Unlimited time', 'بدون محدودیت زمانی');
    } else {
      timeEl.textContent = formatCompactTime(s.timeRemaining);
      expiryEl.textContent = selfTime?.expires_at ? `${tr('Expires', 'پایان')}: ${formatDate(selfTime.expires_at)}` : '';
    }

    const trafficFill = host.querySelector('[data-hs-account-traffic-fill]');
    trafficFill.style.width = `${s.limit > 0 ? s.volumePercentUsed : 0}%`;
    host.querySelector('[data-hs-account-traffic-percent]').textContent = s.limit > 0 ? `${s.volumePercentUsed.toFixed(1)}%` : tr('Unlimited', 'نامحدود');
    trafficFill.className = 'hs-account-progress-fill h-full rounded-full ' + (s.limit > 0 && s.volumePercentRemaining <= 10 ? 'bg-red-500' : s.limit > 0 && s.volumePercentRemaining <= 25 ? 'bg-amber-500' : 'bg-primary');

    const timeFill = host.querySelector('[data-hs-account-time-fill]');
    timeFill.style.width = `${s.timeConfigured ? s.timePercentRemaining : 100}%`;
    host.querySelector('[data-hs-account-time-percent]').textContent = s.timeConfigured ? `${s.timePercentRemaining.toFixed(1)}%` : tr('Unlimited', 'نامحدود');
    timeFill.className = 'hs-account-progress-fill h-full rounded-full ' + (s.timeConfigured && s.timePercentRemaining <= 10 ? 'bg-red-500' : 'bg-amber-500');
  }

  async function refreshAccount() {
    if (accountRefreshBusy) return;
    accountRefreshBusy = true;
    try {
      const [adminResult, timeResult] = await Promise.allSettled([
        request('/api/admin'),
        hsApi('/admin-time/me'),
      ]);
      if (adminResult.status === 'fulfilled') account = adminResult.value;
      else if (adminResult.reason?.status === 401) account = null;

      if (timeResult.status === 'fulfilled') selfTime = timeResult.value;
      else if (timeResult.reason?.status === 401 || timeResult.reason?.status === 404) selfTime = null;
      accountFetchedAt = Date.now();
    } finally {
      accountRefreshBusy = false;
      renderAccountCard();
    }
  }

  function syncNow() {
    if (syncing) return;
    syncing = true;
    try {
      ensureFeatureCard();
      if (enabled && ownerAccess) adminForms().forEach(ensureField);
      processPending();
      renderAccountCard();
    } finally {
      syncing = false;
    }
  }

  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      syncNow();
    });
  }

  function start() {
    injectStyle();
    document.addEventListener('submit', event => {
      if (event.target instanceof HTMLFormElement && formState.has(event.target)) beginPending(event.target, event);
    }, true);

    window.addEventListener('hashchange', () => { queueSync(); refreshAccount(); });
    window.addEventListener('popstate', () => { queueSync(); refreshAccount(); });
    window.addEventListener('hs-plugin-feature-changed', event => {
      if (event.detail?.feature === FEATURE) {
        enabled = !!event.detail.enabled;
        if (!enabled) removeFields();
        queueSync();
        refreshAccount();
      }
    });

    observer = new MutationObserver(mutations => {
      for (const mutation of mutations) for (const node of mutation.addedNodes) inspectAddedNode(node);
      queueSync();
    });
    observer.observe(document.documentElement, {childList: true, subtree: true});

    refreshFeature();
    refreshAccount();
    setInterval(refreshFeature, 60000);
    setInterval(refreshAccount, 15000);
    setInterval(() => {
      processPending();
      if (account && Date.now() - accountFetchedAt < 60000) renderAccountCard();
    }, 1000);
    setInterval(syncNow, 500);
    queueSync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();

  window.HSAdminTime = {
    version: VERSION,
    refresh: async () => {
      await Promise.allSettled([refreshFeature(), refreshAccount()]);
      queueSync();
    },
    get enabled() { return enabled; },
    diagnostics: () => ({
      version: VERSION,
      enabled,
      ownerAccess,
      route: routePath(),
      fields: document.querySelectorAll(`.${FIELD_CLASS}`).length,
      forms: adminForms().length,
      account: account?.username || null,
      owner: !!account?.role?.is_owner,
      dataLimit: account?.data_limit ?? null,
      usedTraffic: account?.used_traffic ?? null,
      timeConfigured: !!selfTime?.configured,
      timeEnabled: selfTime?.enabled,
      accountCard: !!document.getElementById(ACCOUNT_CARD_ID),
      pending: pending.size,
    }),
  };
})();
