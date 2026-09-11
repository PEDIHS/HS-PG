(() => {
  'use strict';

  const VERSION = '1.0.0';
  const FEATURE = 'admin_time_limit';
  const FEATURE_CARD_ID = 'hs-admin-time-card';
  const FIELD_CLASS = 'hs-admin-time-field';
  const INPUT_CLASS = 'hs-admin-time-input';
  const MAX_DAYS = 36500;
  const rawFetch = window.fetch.bind(window);

  let enabled = false;
  let ownerAccess = false;
  let featureBusy = false;
  let queued = false;
  let observer = null;
  const formState = new WeakMap();
  const pending = new Set();

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
      .hs-admin-time-gold{
        color:#e7bd59;
        background:linear-gradient(100deg,#b97918 0%,#e4b64b 24%,#fff0ab 46%,#d3a13a 59%,#f5d77e 80%,#b97918 100%);
        background-size:220% 100%;
        -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
        animation:hs-admin-time-shine 4.8s ease-in-out infinite;font-weight:650;
      }
      .${FIELD_CLASS}[data-hs-suspended="true"] .${INPUT_CLASS}{border-color:rgba(217,170,66,.55)}
      @media(prefers-reduced-motion:reduce){.hs-admin-time-gold{animation:none!important}}
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
          <p class="text-muted-foreground text-xs sm:text-sm">Pause every user when an admin's time expires and resume their exact remaining time after renewal.</p>
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

  function onAdminsPage() {
    return routePath() === '/admins' || routePath().startsWith('/admins/');
  }

  function adminForms() {
    if (!enabled || !ownerAccess || !onAdminsPage()) return [];
    return [...document.querySelectorAll('form')].filter(form =>
      form.querySelector('input[name="username"]') &&
      form.querySelector('input[name="data_limit"]') &&
      form.querySelector('input[name="password"]')
    );
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
    for (let i = 0; el && i < 5; i += 1, el = el.parentElement) {
      if (el.classList?.contains('space-y-2')) return el;
    }
    return null;
  }

  function fieldMarkup(id) {
    return `
      <label class="block" for="${id}"><span class="hs-admin-time-gold">Time</span><span class="text-muted-foreground ml-1 text-[11px] font-normal">HS · days</span></label>
      <div class="relative min-w-0">
        <div class="min-w-0 flex-1">
          <input id="${id}" class="${INPUT_CLASS} border-border bg-input placeholder:text-input-placeholder focus-visible:ring-ring flex h-9 w-full rounded-lg border px-3 py-2 pr-14 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50" type="number" dir="ltr" inputmode="numeric" min="1" max="${MAX_DAYS}" step="1" placeholder="Unlimited" autocomplete="off">
        </div>
        <span class="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px]">days</span>
      </div>
      <p class="hs-admin-time-status text-muted-foreground min-h-4 text-[11px]">Blank means unlimited time.</p>`;
  }

  function setFieldStatus(field, text, kind = 'muted') {
    const status = field?.querySelector('.hs-admin-time-status');
    if (!status) return;
    status.className = `hs-admin-time-status min-h-4 text-[11px] ${kind === 'error' ? 'text-destructive' : kind === 'warn' ? 'text-amber-600 dark:text-amber-400' : kind === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`;
    status.textContent = text;
  }

  function formatRemaining(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    if (days > 0) return `${days}d ${hours}h remaining`;
    const minutes = Math.max(0, Math.floor((total % 3600) / 60));
    return `${hours}h ${minutes}m remaining`;
  }

  async function hydrateField(form, field) {
    const state = formState.get(form);
    if (!state || state.hydrating) return;
    const username = form.querySelector('input[name="username"]')?.value?.trim();
    if (!username) return;
    state.username = username;
    state.editing = !!form.querySelector('input[name="username"]')?.disabled;
    if (!state.editing) {
      state.loaded = true;
      state.originalDisplay = '';
      setFieldStatus(field, 'Blank means unlimited time.');
      return;
    }

    state.hydrating = true;
    try {
      const info = await api(`/admin-time/by-username/${encodeURIComponent(username)}`);
      if (!info.supported) {
        field.style.display = 'none';
        state.supported = false;
        return;
      }
      state.supported = true;
      const input = field.querySelector(`.${INPUT_CLASS}`);
      if (!state.touched && input) {
        if (info.suspended) input.value = info.duration_days ? String(info.duration_days) : '';
        else if (info.configured && info.remaining_seconds != null) input.value = String(Math.max(1, Math.ceil(Number(info.remaining_seconds) / 86400)));
        else input.value = '';
        state.originalDisplay = input.value;
      }
      field.dataset.hsSuspended = info.suspended ? 'true' : 'false';
      if (info.suspended) setFieldStatus(field, 'Expired · users paused. Enter days and save to renew.', 'warn');
      else if (info.configured) setFieldStatus(field, formatRemaining(info.remaining_seconds));
      else setFieldStatus(field, 'Unlimited admin time.');
      state.loaded = true;
    } catch (error) {
      if (error.status === 404) setFieldStatus(field, 'Admin not found yet.', 'muted');
      else setFieldStatus(field, `HS Time unavailable: ${error.message}`, 'error');
    } finally {
      state.hydrating = false;
    }
  }

  function parseDays(input) {
    const raw = String(input.value || '').trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_DAYS) throw new Error(`Time must be a whole number from 1 to ${MAX_DAYS} days.`);
    return value;
  }

  function ensureField(form) {
    if (form.querySelector(`.${FIELD_CLASS}`)) return;
    const dataInput = form.querySelector('input[name="data_limit"]');
    const item = formItemFor(dataInput);
    if (!item?.parentElement) return;

    const field = document.createElement('div');
    field.className = `${FIELD_CLASS} relative space-y-2`;
    const id = `hs-admin-time-${Math.random().toString(36).slice(2, 9)}`;
    field.innerHTML = fieldMarkup(id);
    item.insertAdjacentElement('afterend', field);

    const input = field.querySelector(`.${INPUT_CLASS}`);
    const state = {field, input, username: '', editing: false, touched: false, dirty: false, loaded: false, hydrating: false, supported: true};
    formState.set(form, state);

    input.addEventListener('input', () => {
      state.touched = true;
      state.dirty = true;
      input.setCustomValidity('');
      field.dataset.hsSuspended = 'false';
      try {
        const days = parseDays(input);
        setFieldStatus(field, days == null ? 'Unlimited after save.' : `${days} day${days === 1 ? '' : 's'} after save.`, 'muted');
      } catch (error) {
        input.setCustomValidity(error.message);
        setFieldStatus(field, error.message, 'error');
      }
    });

    hydrateField(form, field);
  }

  function removeFields() {
    document.querySelectorAll(`.${FIELD_CLASS}`).forEach(el => el.remove());
  }

  function flash(message, error = false) {
    const box = document.createElement('div');
    box.className = `bg-background text-foreground fixed right-4 top-4 z-[250] max-w-sm rounded-lg border px-4 py-3 text-sm shadow-xl ${error ? 'border-destructive/60' : ''}`;
    box.textContent = message;
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 6000);
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
    setTimeout(() => {
      if (!item.finalized) pending.delete(item);
    }, 25000);
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
    } catch (error) {
      flash(`Admin saved, but HS Time failed: ${error.message}`, true);
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

  function setEnabled(value) {
    enabled = !!value;
    ensureFeatureCard();
    if (!enabled) removeFields();
    else queueSync();
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

  function queueSync() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      ensureFeatureCard();
      if (enabled && ownerAccess) adminForms().forEach(ensureField);
      processPending();
    });
  }

  function start() {
    injectStyle();
    document.addEventListener('submit', event => {
      if (event.target instanceof HTMLFormElement && formState.has(event.target)) beginPending(event.target, event);
    }, true);
    window.addEventListener('hashchange', queueSync);
    window.addEventListener('popstate', queueSync);
    window.addEventListener('hs-plugin-feature-changed', event => {
      if (event.detail?.feature === FEATURE) setEnabled(!!event.detail.enabled);
    });

    observer = new MutationObserver(mutations => {
      for (const mutation of mutations) for (const node of mutation.addedNodes) inspectAddedNode(node);
      queueSync();
    });
    observer.observe(document.documentElement, {childList: true, subtree: true});

    refreshFeature();
    setInterval(refreshFeature, 60000);
    setInterval(processPending, 300);
    queueSync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();

  window.HSAdminTime = {
    version: VERSION,
    refresh: refreshFeature,
    get enabled() { return enabled; },
    diagnostics: () => ({version: VERSION, enabled, ownerAccess, route: routePath(), fields: document.querySelectorAll(`.${FIELD_CLASS}`).length, pending: pending.size}),
  };
})();
