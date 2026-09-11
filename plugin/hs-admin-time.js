(() => {
  'use strict';

  const VERSION = '1.1.0';
  const FEATURE = 'admin_time_limit';
  const FEATURE_CARD_ID = 'hs-admin-time-card';
  const DASHBOARD_CARD_ID = 'hs-admin-time-dashboard-card';
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
  let selfInfo = null;
  let selfInfoFetchedAt = 0;
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
      @keyframes hs-admin-time-shine {
        0%,70%,100%{background-position:0% 50%}
        82%{background-position:100% 50%}
      }
      @keyframes hs-admin-time-pulse {
        0%,100%{opacity:.52;transform:scale(1)}
        50%{opacity:.9;transform:scale(1.015)}
      }
      .hs-admin-time-gold{
        color:#e7bd59;
        background:linear-gradient(100deg,#b97918 0%,#e4b64b 24%,#fff0ab 46%,#d3a13a 59%,#f5d77e 80%,#b97918 100%);
        background-size:220% 100%;
        -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
        animation:hs-admin-time-shine 4.8s ease-in-out infinite;font-weight:650;
      }
      .${FIELD_CLASS}{min-width:0}
      .${FIELD_CLASS}[data-hs-suspended="true"] .${INPUT_CLASS}{border-color:rgba(217,170,66,.65)!important;box-shadow:0 0 0 1px rgba(217,170,66,.08)}
      #${DASHBOARD_CARD_ID}[data-state="warning"]{border-color:rgba(217,170,66,.36)}
      #${DASHBOARD_CARD_ID}[data-state="expired"]{border-color:rgba(239,68,68,.36)}
      #${DASHBOARD_CARD_ID} .hs-time-progress-fill{transition:width .6s ease}
      #${DASHBOARD_CARD_ID}[data-state="warning"] .hs-time-clock-glow{animation:hs-admin-time-pulse 2.8s ease-in-out infinite}
      @media(prefers-reduced-motion:reduce){.hs-admin-time-gold,.hs-time-clock-glow{animation:none!important}.hs-time-progress-fill{transition:none!important}}
    `;
  }

  function headers(extra = {}) {
    const result = new Headers(extra);
    const token = localStorage.getItem('token');
    if (token && !result.has('Authorization')) result.set('Authorization', `Bearer ${token}`);
    return result;
  }

  async function api(path, options = {}) {
    const {headers: supplied, ...rest} = options;
    const response = await rawFetch(`/api/hs-plugin${path}`, {
      credentials: 'same-origin', cache: 'no-store', ...rest, headers: headers(supplied || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.detail || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
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
          <p class="text-muted-foreground text-xs sm:text-sm">Pause admin users when time expires, preserve their remaining clocks, and resume them after renewal.</p>
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
      const data = await api(`/features/${FEATURE}`, {
        method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({enabled: next}),
      });
      setEnabled(!!data.enabled);
      window.dispatchEvent(new CustomEvent('hs-plugin-feature-changed', {detail: {feature: FEATURE, enabled: !!data.enabled}}));
      await refreshSelfInfo();
      if (status) status.textContent = next ? 'Admin Time Limit enabled.' : 'Admin Time Limit disabled; suspended users resumed.';
    } catch (error) {
      syncSwitch(button, current);
      if (status) status.textContent = error.message;
    } finally {
      featureBusy = false;
      button.disabled = false;
    }
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

  function directChildOf(parent, node) {
    let current = node;
    while (current && current.parentElement && current.parentElement !== parent) current = current.parentElement;
    return current?.parentElement === parent ? current : null;
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
      if (!child) continue;
      const input = child.querySelector('input');
      if (input) return child;
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
        <div class="min-w-0 flex-1">
          <input id="${id}" class="${INPUT_CLASS} border-border bg-input placeholder:text-input-placeholder focus-visible:ring-ring flex h-9 w-full rounded-lg border px-3 py-2 pr-14 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50" type="number" dir="ltr" inputmode="numeric" min="1" max="${MAX_DAYS}" step="1" placeholder="Unlimited" autocomplete="off">
        </div>
        <span class="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px]">days</span>
      </div>
      <p class="hs-admin-time-status text-muted-foreground min-h-4 text-[11px]">${tr('Blank means unlimited time.', 'خالی = بدون محدودیت زمانی')}</p>`;
  }

  function setFieldStatus(field, text, kind = 'muted') {
    const status = field?.querySelector('.hs-admin-time-status');
    if (!status) return;
    status.className = `hs-admin-time-status min-h-4 text-[11px] ${kind === 'error' ? 'text-destructive' : kind === 'warn' ? 'text-amber-600 dark:text-amber-400' : kind === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`;
    status.textContent = text;
  }

  function formatRemaining(seconds, compact = false) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (compact) {
      if (days > 0) return isFa() ? `${days} روز ${hours} ساعت` : `${days}d ${hours}h`;
      if (hours > 0) return isFa() ? `${hours} ساعت ${minutes} دقیقه` : `${hours}h ${minutes}m`;
      return isFa() ? `${minutes} دقیقه` : `${minutes}m`;
    }
    if (days > 0) return isFa() ? `${days} روز و ${hours} ساعت باقی مانده` : `${days}d ${hours}h remaining`;
    if (hours > 0) return isFa() ? `${hours} ساعت و ${minutes} دقیقه باقی مانده` : `${hours}h ${minutes}m remaining`;
    return isFa() ? `${minutes} دقیقه باقی مانده` : `${minutes}m remaining`;
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
    const field = state.field;
    const input = state.input;
    if (!field || !input) return;

    if (!state.supported) {
      input.value = '';
      input.disabled = true;
      field.dataset.hsSuspended = 'false';
      setFieldStatus(field, tr('Owner account is unlimited by design.', 'اکانت Owner به‌صورت پیش‌فرض نامحدود است.'));
      updateResetButton(state);
      return;
    }

    input.disabled = false;
    if (!state.touched) {
      if (info.suspended) state.draft = info.duration_days ? String(info.duration_days) : '';
      else if (info.configured && info.remaining_seconds != null) state.draft = String(Math.max(1, Math.ceil(Number(info.remaining_seconds) / 86400)));
      else state.draft = '';
      input.value = state.draft;
      state.originalDisplay = state.draft;
    } else {
      input.value = state.draft ?? input.value;
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
      if (!state.touched) {
        state.draft = '';
        if (state.input) state.input.value = '';
      }
      setFieldStatus(state.field, tr('Blank means unlimited time.', 'خالی = بدون محدودیت زمانی'));
      updateResetButton(state);
      return;
    }

    state.hydrating = true;
    try {
      const info = await api(`/admin-time/by-username/${encodeURIComponent(username)}`);
      state.loaded = true;
      applyInfoToField(state, info);
    } catch (error) {
      if (error.status === 404) setFieldStatus(state.field, tr('Admin not found yet.', 'ادمین هنوز پیدا نشد.'));
      else setFieldStatus(state.field, `HS Time: ${error.message}`, 'error');
    } finally {
      state.hydrating = false;
    }
  }

  function parseDays(input) {
    const raw = String(input.value || '').trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_DAYS) throw new Error(tr(`Time must be a whole number from 1 to ${MAX_DAYS} days.`, `زمان باید عدد صحیح بین 1 تا ${MAX_DAYS} روز باشد.`));
    return value;
  }

  function createConfirmDialog({title, description, confirmLabel}) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'fixed inset-0 z-[320] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[1px]';
      overlay.innerHTML = `
        <div role="alertdialog" aria-modal="true" class="bg-background text-foreground w-full max-w-md rounded-xl border p-5 shadow-2xl">
          <div class="mb-1 flex items-center gap-2 text-base font-semibold"><span class="hs-admin-time-gold">HS</span><span></span></div>
          <p class="text-muted-foreground mt-2 text-sm leading-6"></p>
          <div class="mt-5 flex justify-end gap-2">
            <button type="button" data-cancel class="hover:bg-accent h-9 rounded-md border px-4 text-sm font-medium transition-colors">${tr('Cancel', 'انصراف')}</button>
            <button type="button" data-confirm class="bg-primary text-primary-foreground hover:bg-primary/90 h-9 rounded-md px-4 text-sm font-medium transition-colors"></button>
          </div>
        </div>`;
      overlay.querySelector('.font-semibold span:last-child').textContent = title;
      overlay.querySelector('p').textContent = description;
      overlay.querySelector('[data-confirm]').textContent = confirmLabel;
      const finish = value => { overlay.remove(); resolve(value); };
      overlay.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
      overlay.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
      overlay.addEventListener('click', event => { if (event.target === overlay) finish(false); });
      document.body.appendChild(overlay);
      overlay.querySelector('[data-confirm]').focus();
    });
  }

  async function resetTime(form, state, button) {
    if (!state.editing || !state.supported || !state.username || !state.info?.configured) return;
    const duration = Number(state.info.duration_days || 0);
    if (!duration) return;
    const ok = await createConfirmDialog({
      title: tr('Reset Admin Time', 'ریست زمان ادمین'),
      description: tr(`Reset ${state.username} to a fresh ${duration}-day period? User traffic and each user's remaining time will not be reset.`, `زمان ${state.username} از همین لحظه دوباره ${duration} روز می‌شود. حجم و زمان باقی‌مانده کاربران ریست نمی‌شود.`),
      confirmLabel: tr('Reset Time', 'ریست زمان'),
    });
    if (!ok) return;

    button.disabled = true;
    const old = button.innerHTML;
    button.textContent = tr('Resetting…', 'در حال ریست…');
    try {
      const info = await api(`/admin-time/by-username/${encodeURIComponent(state.username)}/reset`, {method: 'POST'});
      state.touched = false;
      state.dirty = false;
      state.loaded = true;
      applyInfoToField(state, info);
      flash(tr('Admin time reset successfully.', 'زمان ادمین با موفقیت ریست شد.'));
      await refreshSelfInfo();
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

    field.querySelector('[data-hs-time-reset]')?.addEventListener('click', event => resetTime(form, state, event.currentTarget));

    if (state.loaded && state.info) applyInfoToField(state, state.info);
    else hydrateState(form, state);
  }

  function ensureField(form) {
    const dataItem = findDataLimitItem(form);
    if (!dataItem?.parentElement) return;

    let state = formState.get(form);
    const username = form.querySelector('input[name="username"]')?.value?.trim() || '';
    const editing = !!(form.querySelector('input[name="username"]')?.disabled || form.querySelector('input[name="username"]')?.readOnly);
    if (!state) {
      state = {field: null, input: null, username, editing, touched: false, dirty: false, draft: '', originalDisplay: '', loaded: false, hydrating: false, supported: true, info: null};
      formState.set(form, state);
    } else if (state.username && username && state.username !== username) {
      state.username = username;
      state.editing = editing;
      state.touched = false;
      state.dirty = false;
      state.draft = '';
      state.originalDisplay = '';
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

  function flash(message, error = false) {
    const box = document.createElement('div');
    box.className = `bg-background text-foreground fixed right-4 top-4 z-[350] max-w-sm rounded-lg border px-4 py-3 text-sm shadow-xl ${error ? 'border-destructive/60' : 'border-border'}`;
    box.textContent = message;
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 5000);
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
      form, dialog, username, days, editing: state.editing, startedAt: Date.now(), successSeen: false, finalized: false,
      existingBefore: state.editing ? Promise.resolve(true) : api(`/admin-time/by-username/${encodeURIComponent(username)}`).then(() => true).catch(error => error.status === 404 ? false : null),
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
      await api(`/admin-time/by-username/${encodeURIComponent(item.username)}`, {
        method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({days: item.days}),
      });
      await refreshSelfInfo();
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

  function dashboardCardMarkup() {
    return `
      <div class="group relative overflow-hidden rounded-lg border bg-card transition-all duration-300 hover:shadow-lg">
        <div class="from-primary/10 dark:from-primary/5 pointer-events-none absolute inset-0 bg-gradient-to-r to-transparent opacity-40"></div>
        <div class="relative z-10 p-4 sm:p-5 lg:p-6">
          <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex min-w-0 items-center gap-3">
              <div class="hs-time-clock-glow bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              </div>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="text-muted-foreground text-xs font-medium sm:text-sm" data-hs-time-title></p>
                  <span class="hs-admin-time-gold text-[10px] font-semibold tracking-wide">HS</span>
                  <span data-hs-time-badge class="rounded-md border px-2 py-0.5 text-[10px] font-medium"></span>
                </div>
                <p data-hs-time-expiry class="text-muted-foreground mt-1 truncate text-[11px] sm:text-xs"></p>
              </div>
            </div>
            <div class="min-w-0 text-start sm:text-end">
              <div data-hs-time-remaining dir="ltr" class="text-2xl font-bold tracking-tight sm:text-3xl"></div>
              <div data-hs-time-caption class="text-muted-foreground mt-1 text-[11px]"></div>
            </div>
          </div>
          <div class="mt-4">
            <div class="bg-muted/60 h-1.5 w-full overflow-hidden rounded-full">
              <div class="hs-time-progress-fill bg-primary h-full rounded-full" style="width:0%"></div>
            </div>
            <div class="text-muted-foreground mt-2 flex items-center justify-between gap-3 text-[10px] sm:text-[11px]">
              <span data-hs-time-plan></span>
              <span data-hs-time-percent dir="ltr"></span>
            </div>
          </div>
        </div>
      </div>`;
  }

  function ensureDashboardCard() {
    const shouldShow = !!selfInfo && selfInfo.enabled !== false && selfInfo.supported !== false && isDashboardRoute();
    let host = document.getElementById(DASHBOARD_CARD_ID);
    if (!shouldShow) {
      host?.remove();
      return null;
    }
    const stack = dashboardStack();
    if (!stack) return null;
    if (!host) {
      host = document.createElement('div');
      host.id = DASHBOARD_CARD_ID;
      host.className = 'w-full';
      host.innerHTML = dashboardCardMarkup();
    }
    if (!host.isConnected || host.parentElement !== stack) {
      const first = stack.firstElementChild;
      if (first) first.insertAdjacentElement('afterend', host);
      else stack.appendChild(host);
    }
    return host;
  }

  function remainingFromInfo(info) {
    if (!info?.configured || !info.expires_at) return null;
    const ts = Date.parse(info.expires_at);
    if (!Number.isFinite(ts)) return Math.max(0, Number(info.remaining_seconds) || 0);
    return Math.max(0, Math.floor((ts - Date.now()) / 1000));
  }

  function formatExpiry(iso) {
    const date = iso ? new Date(iso) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(isFa() ? 'fa-IR' : undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(date);
    } catch (_) {
      return date.toLocaleString();
    }
  }

  function renderDashboardCard() {
    const host = ensureDashboardCard();
    if (!host || !selfInfo) return;
    const configured = !!selfInfo.configured;
    const suspended = !!selfInfo.suspended;
    const remaining = remainingFromInfo(selfInfo);
    const total = Math.max(0, Number(selfInfo.duration_days || 0) * 86400);
    const percent = configured && total > 0 ? Math.max(0, Math.min(100, ((remaining || 0) / total) * 100)) : 100;
    const warning = configured && !suspended && (remaining || 0) <= 3 * 86400;
    const state = suspended || (configured && (remaining || 0) <= 0) ? 'expired' : warning ? 'warning' : configured ? 'active' : 'unlimited';
    host.dataset.state = state;

    host.querySelector('[data-hs-time-title]').textContent = tr('Admin Account Time', 'زمان اکانت ادمین');
    const badge = host.querySelector('[data-hs-time-badge]');
    const remainingEl = host.querySelector('[data-hs-time-remaining]');
    const expiryEl = host.querySelector('[data-hs-time-expiry]');
    const caption = host.querySelector('[data-hs-time-caption]');
    const plan = host.querySelector('[data-hs-time-plan]');
    const percentEl = host.querySelector('[data-hs-time-percent]');
    const fill = host.querySelector('.hs-time-progress-fill');

    badge.className = 'rounded-md border px-2 py-0.5 text-[10px] font-medium';
    if (state === 'expired') {
      badge.textContent = tr('Expired', 'منقضی');
      badge.classList.add('border-red-500/30', 'bg-red-500/10', 'text-red-600', 'dark:text-red-400');
      remainingEl.textContent = tr('Expired', 'منقضی');
      caption.textContent = tr('Users are paused until renewal', 'کاربران تا زمان تمدید متوقف‌اند');
      fill.className = 'hs-time-progress-fill h-full rounded-full bg-red-500';
    } else if (state === 'warning') {
      badge.textContent = tr('Ending soon', 'رو به پایان');
      badge.classList.add('border-amber-500/30', 'bg-amber-500/10', 'text-amber-600', 'dark:text-amber-400');
      remainingEl.textContent = formatRemaining(remaining, true);
      caption.textContent = tr('Remaining account time', 'زمان باقی‌مانده اکانت');
      fill.className = 'hs-time-progress-fill h-full rounded-full bg-amber-500';
    } else if (state === 'active') {
      badge.textContent = tr('Active', 'فعال');
      badge.classList.add('border-green-500/30', 'bg-green-500/10', 'text-green-600', 'dark:text-green-400');
      remainingEl.textContent = formatRemaining(remaining, true);
      caption.textContent = tr('Remaining account time', 'زمان باقی‌مانده اکانت');
      fill.className = 'hs-time-progress-fill bg-primary h-full rounded-full';
    } else {
      badge.textContent = tr('Unlimited', 'نامحدود');
      badge.classList.add('border-border', 'bg-muted/50', 'text-muted-foreground');
      remainingEl.textContent = '∞';
      caption.textContent = tr('No time limit', 'بدون محدودیت زمانی');
      fill.className = 'hs-time-progress-fill bg-primary h-full rounded-full';
    }

    expiryEl.textContent = configured && selfInfo.expires_at
      ? `${tr('Ends', 'پایان')}: ${formatExpiry(selfInfo.expires_at)}`
      : tr('This admin account has no expiration date.', 'برای این اکانت تاریخ انقضا تنظیم نشده است.');
    plan.textContent = configured && selfInfo.duration_days
      ? `${tr('Plan', 'دوره')}: ${selfInfo.duration_days} ${tr('days', 'روز')}`
      : tr('Unlimited plan', 'دوره نامحدود');
    percentEl.textContent = configured ? `${percent.toFixed(1)}%` : '100%';
    fill.style.width = `${configured ? percent : 100}%`;
  }

  async function refreshSelfInfo() {
    try {
      const info = await api('/admin-time/me');
      selfInfo = info;
      selfInfoFetchedAt = Date.now();
    } catch (error) {
      if (error.status === 401 || error.status === 404) selfInfo = null;
    }
    renderDashboardCard();
  }

  function setEnabled(value) {
    enabled = !!value;
    ensureFeatureCard();
    if (!enabled) removeFields();
    queueSync();
  }

  async function refreshFeature() {
    try {
      const state = await api('/state');
      ownerAccess = true;
      setEnabled(!!state?.features?.[FEATURE]?.enabled);
    } catch (error) {
      if (error.status === 403 || error.status === 401) {
        ownerAccess = false;
        removeFields();
        document.getElementById(FEATURE_CARD_ID)?.remove();
      }
    }
  }

  function syncNow() {
    if (syncing) return;
    syncing = true;
    try {
      ensureFeatureCard();
      if (enabled && ownerAccess) adminForms().forEach(ensureField);
      processPending();
      renderDashboardCard();
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
    window.addEventListener('hashchange', () => { queueSync(); refreshSelfInfo(); });
    window.addEventListener('popstate', () => { queueSync(); refreshSelfInfo(); });
    window.addEventListener('hs-plugin-feature-changed', event => {
      if (event.detail?.feature === FEATURE) {
        setEnabled(!!event.detail.enabled);
        refreshSelfInfo();
      }
    });

    observer = new MutationObserver(mutations => {
      for (const mutation of mutations) for (const node of mutation.addedNodes) inspectAddedNode(node);
      queueSync();
    });
    observer.observe(document.documentElement, {childList: true, subtree: true});

    refreshFeature();
    refreshSelfInfo();
    setInterval(refreshFeature, 60000);
    setInterval(refreshSelfInfo, 30000);
    setInterval(() => {
      processPending();
      if (selfInfo && Date.now() - selfInfoFetchedAt < 120000) renderDashboardCard();
    }, 1000);
    setInterval(syncNow, 500);
    queueSync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();

  window.HSAdminTime = {
    version: VERSION,
    refresh: async () => { await Promise.allSettled([refreshFeature(), refreshSelfInfo()]); queueSync(); },
    get enabled() { return enabled; },
    diagnostics: () => ({
      version: VERSION,
      enabled,
      ownerAccess,
      route: routePath(),
      fields: document.querySelectorAll(`.${FIELD_CLASS}`).length,
      forms: adminForms().length,
      dashboardCard: !!document.getElementById(DASHBOARD_CARD_ID),
      selfConfigured: !!selfInfo?.configured,
      selfSupported: selfInfo?.supported,
      selfSuspended: !!selfInfo?.suspended,
      pending: pending.size,
    }),
  };
})();
