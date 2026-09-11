(() => {
  'use strict';

  const ROOT_ID = 'hs-plugin-root';
  const NAV_ID = 'hs-plugin-nav';
  const QUERY_KEY = 'hs_plugin';
  const VERSION = '0.3.1';
  const rawFetch = window.fetch.bind(window);

  let opening = false;
  let mountedOutlet = null;

  function injectNodeProBrandStyle() {
    if (document.getElementById('hs-node-pro-brand-style')) return;
    const style = document.createElement('style');
    style.id = 'hs-node-pro-brand-style';
    style.textContent = `
      @keyframes hs-node-title-gold-shine {
        0%, 72%, 100% { background-position: 0% 50%; }
        82% { background-position: 100% 50%; }
      }

      .hs-node-pro-card h3 {
        color:#e9c46a!important;
        background:linear-gradient(100deg,#b97a18 0%,#e5b84f 24%,#fff1ad 45%,#d6a43a 58%,#f7dc83 78%,#b97a18 100%);
        background-size:220% 100%;
        background-position:0% 50%;
        -webkit-background-clip:text;
        background-clip:text;
        -webkit-text-fill-color:transparent;
        text-shadow:0 0 7px rgba(235,190,78,.14);
        filter:drop-shadow(0 1px 0 rgba(255,230,150,.08));
        animation:hs-node-title-gold-shine 4.6s ease-in-out infinite;
      }

      .hs-node-pro-card:hover h3 {
        text-shadow:0 0 9px rgba(244,198,82,.20);
      }

      @media (prefers-reduced-motion: reduce) {
        .hs-node-pro-card h3 { animation:none; background-position:48% 50%; }
      }
    `;
    document.head.appendChild(style);
  }

  function authHeaders(extra) {
    const headers = new Headers(extra || {});
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const token = localStorage.getItem('token');
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }

  async function api(path, options = {}) {
    const { headers, ...rest } = options;
    const response = await rawFetch(`/api/hs-plugin${path}`, {
      credentials: 'same-origin',
      ...rest,
      headers: authHeaders(headers),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
    return data;
  }

  function requested() {
    try {
      return new URL(window.location.href).searchParams.get(QUERY_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function setRequested(value, replace = false) {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(QUERY_KEY, '1');
    else url.searchParams.delete(QUERY_KEY);
    const method = replace ? 'replaceState' : 'pushState';
    window.history[method]({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function isPageTransition(el) {
    if (!el || el.tagName !== 'DIV') return false;
    const style = el.getAttribute('style') || '';
    const transformMatch = style.includes('translate3d');
    const classMatch = el.classList.contains('flex') && el.classList.contains('flex-col') && el.classList.contains('flex-1');
    return transformMatch || classMatch;
  }

  function findOutlet() {
    const existing = document.getElementById(ROOT_ID);
    if (existing?.parentElement) return existing.parentElement;

    const inset = document.querySelector('main.dashboard-scroll') || document.querySelector('main');
    if (!inset) return null;

    const transforms = [...inset.querySelectorAll('div[style*="translate3d"]')];
    for (const el of transforms) {
      if (isPageTransition(el) && !el.closest('[data-sidebar="sidebar"]')) return el;
    }

    const shells = [...inset.querySelectorAll('div')].filter(el =>
      el.classList.contains('flex') &&
      el.classList.contains('flex-col') &&
      el.classList.contains('flex-1') &&
      el.classList.contains('justify-between')
    );
    for (const shell of shells) {
      const first = [...shell.children][0];
      if (isPageTransition(first)) return first;
    }

    const footerLink = [...inset.querySelectorAll('a')].find(a => /PasarGuard/i.test(a.textContent || ''));
    if (footerLink) {
      let box = footerLink.closest('div');
      for (let depth = 0; box && depth < 6; depth += 1, box = box.parentElement) {
        const parent = box.parentElement;
        if (!parent) break;
        const children = [...parent.children];
        const idx = children.indexOf(box);
        if (idx > 0) {
          const previous = children[idx - 1];
          if (isPageTransition(previous)) return previous;
        }
      }
    }
    return null;
  }

  function hideNative(outlet) {
    [...outlet.children].forEach(el => {
      if (el.id === ROOT_ID) return;
      if (!el.hasAttribute('data-hs-native-display')) el.setAttribute('data-hs-native-display', el.style.display || '');
      el.style.display = 'none';
    });
  }

  function restoreNative() {
    const root = document.getElementById(ROOT_ID);
    const outlet = root?.parentElement || mountedOutlet || findOutlet();
    if (outlet) {
      [...outlet.children].forEach(el => {
        if (!el.hasAttribute('data-hs-native-display')) return;
        el.style.display = el.getAttribute('data-hs-native-display') || '';
        el.removeAttribute('data-hs-native-display');
      });
    }
    root?.remove();
    mountedOutlet = null;
    setNavActive(false);
  }

  function setNavActive(active) {
    const button = document.querySelector(`#${NAV_ID} [data-sidebar="menu-button"]`);
    if (button) button.dataset.active = active ? 'true' : 'false';

    document.querySelectorAll('[data-sidebar="menu-button"][data-active="true"]').forEach(el => {
      if (el.closest(`#${NAV_ID}`)) return;
      if (active) {
        if (!el.hasAttribute('data-hs-prev-active')) el.setAttribute('data-hs-prev-active', el.dataset.active || 'false');
        el.dataset.active = 'false';
      }
    });

    if (!active) {
      document.querySelectorAll('[data-sidebar="menu-button"][data-hs-prev-active]').forEach(el => {
        el.dataset.active = el.getAttribute('data-hs-prev-active') || 'false';
        el.removeAttribute('data-hs-prev-active');
      });
    }
  }

  function switchMarkup(id, enabled) {
    const state = enabled ? 'checked' : 'unchecked';
    return `<button id="${id}" type="button" role="switch" aria-checked="${enabled ? 'true' : 'false'}" data-state="${state}" class="peer focus-visible:ring-ring focus-visible:ring-offset-background data-[state=checked]:bg-primary data-[state=unchecked]:bg-input inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"><span data-state="${state}" class="bg-background pointer-events-none block h-4 w-4 rounded-full shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"></span></button>`;
  }

  function syncSwitch(button, enabled) {
    const state = enabled ? 'checked' : 'unchecked';
    button.setAttribute('aria-checked', enabled ? 'true' : 'false');
    button.dataset.state = state;
    const thumb = button.querySelector('span');
    if (thumb) thumb.dataset.state = state;
  }

  function featureCard(title, description, slotId) {
    return `
      <div class="bg-card hover:bg-accent/40 flex flex-row items-center justify-between gap-x-3 rounded-lg border p-3 transition-colors sm:p-4">
        <div class="space-y-0.5">
          <div class="text-xs font-medium sm:text-sm">${title}</div>
          <p class="text-muted-foreground text-xs sm:text-sm">${description}</p>
        </div>
        <div id="${slotId}" class="shrink-0 opacity-60">Loading…</div>
      </div>`;
  }

  function renderShell(outlet) {
    hideNative(outlet);
    mountedOutlet = outlet;

    let root = document.getElementById(ROOT_ID);
    if (root && root.parentElement !== outlet) root.remove();
    root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('section');
      root.id = ROOT_ID;
      root.className = 'flex min-h-0 w-full flex-1 flex-col';
      outlet.appendChild(root);
    }

    root.innerHTML = `
      <div class="flex min-h-[calc(100vh-200px)] w-full flex-col">
        <div class="flex flex-1 flex-col p-4 sm:py-6 lg:py-8">
          <div class="flex-1 space-y-6 sm:space-y-8 lg:space-y-10">
            <div class="space-y-3">
              <div class="space-y-2">
                <h3 class="text-base font-semibold sm:text-lg">HS Plugin</h3>
                <p class="text-muted-foreground text-xs sm:text-sm">Manage HS extensions for PasarGuard.</p>
              </div>
              <div class="space-y-2">
                ${featureCard('Host Usage Ratio', 'Enable or disable Usage Ratio controls inside Host.', 'hs-host-ratio-slot')}
                ${featureCard('Node PRO', 'Enhance Node cards with compact realtime CPU and RAM charts.', 'hs-node-pro-slot')}
              </div>
              <div id="hs-tab-status" class="text-muted-foreground min-h-5 text-xs"></div>
            </div>
          </div>
        </div>
      </div>`;

    setNavActive(true);
    return root;
  }

  function bindFeatureToggle(root, { feature, enabled, slotId, buttonId, resync = false }) {
    const slot = root.querySelector(`#${slotId}`);
    if (!slot) return;
    slot.className = 'shrink-0';
    slot.innerHTML = switchMarkup(buttonId, enabled);
    const button = slot.querySelector(`#${buttonId}`);
    const status = root.querySelector('#hs-tab-status');

    button?.addEventListener('click', async () => {
      const current = button.getAttribute('aria-checked') === 'true';
      const next = !current;
      button.disabled = true;
      syncSwitch(button, next);
      if (status) status.textContent = `Applying ${feature === 'node_pro' ? 'Node PRO' : 'Host Usage Ratio'}…`;
      try {
        await api(`/features/${feature}`, { method: 'PUT', body: JSON.stringify({ enabled: next }) });
        if (resync) await api('/resync', { method: 'POST', body: '{}' });
        await window.HSPluginDebug?.refresh?.();
        window.dispatchEvent(new CustomEvent('hs-plugin-feature-changed', { detail: { feature, enabled: next } }));
        if (feature === 'node_pro') window.HSNodePro?.setEnabled?.(next);
        if (status) status.textContent = 'Changes applied.';
      } catch (error) {
        syncSwitch(button, current);
        if (status) status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }

  async function hydrate(root) {
    const status = root.querySelector('#hs-tab-status');
    try {
      const state = await api('/state');
      bindFeatureToggle(root, {
        feature: 'host_usage_ratio',
        enabled: !!state?.features?.host_usage_ratio?.enabled,
        slotId: 'hs-host-ratio-slot',
        buttonId: 'hs-host-ratio-toggle',
        resync: true,
      });
      bindFeatureToggle(root, {
        feature: 'node_pro',
        enabled: !!state?.features?.node_pro?.enabled,
        slotId: 'hs-node-pro-slot',
        buttonId: 'hs-node-pro-toggle',
      });
    } catch (error) {
      for (const id of ['hs-host-ratio-slot', 'hs-node-pro-slot']) {
        const slot = root.querySelector(`#${id}`);
        if (slot) {
          slot.textContent = 'Unavailable';
          slot.className = 'text-destructive shrink-0 text-xs';
        }
      }
      if (status) status.textContent = `API error: ${error.message}`;
    }
  }

  async function openNow() {
    if (opening) return true;
    opening = true;
    try {
      const outlet = findOutlet();
      if (!outlet) return false;
      const root = renderShell(outlet);
      hydrate(root).catch(error => console.error('[HS Plugin] hydrate failed', error));
      return true;
    } finally {
      opening = false;
    }
  }

  function openWithRetry({ reloadFallback = false } = {}) {
    const started = Date.now();
    const attempt = async () => {
      if (!requested()) return;
      if (await openNow()) return;
      if (Date.now() - started < 10000) {
        window.setTimeout(attempt, 120);
        return;
      }
      console.error('[HS Plugin] PageTransition was not found after 10s');
      if (reloadFallback && window.location.pathname !== '/nodes') window.location.assign(`/nodes?${QUERY_KEY}=1`);
    };
    attempt();
  }

  function handleHsClick(event) {
    const nav = event.target.closest?.(`#${NAV_ID}`);
    if (!nav) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    if (!requested()) setRequested(true);
    openWithRetry({ reloadFallback: true });
  }

  document.addEventListener('click', handleHsClick, true);

  document.addEventListener('click', event => {
    if (!document.getElementById(ROOT_ID)) return;
    if (event.target.closest?.(`#${NAV_ID}`)) return;
    const anchor = event.target.closest?.('a');
    if (!anchor) return;
    restoreNative();
    if (requested()) setRequested(false, true);
  }, false);

  window.addEventListener('popstate', () => {
    if (requested()) openWithRetry();
    else restoreNative();
  });

  const boot = () => {
    injectNodeProBrandStyle();
    if (requested()) openWithRetry();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  window.HSPluginTabFix = {
    version: VERSION,
    open: () => {
      if (!requested()) setRequested(true);
      openWithRetry({ reloadFallback: true });
    },
    close: () => {
      restoreNative();
      if (requested()) setRequested(false, true);
    },
    findOutlet,
  };
})();
