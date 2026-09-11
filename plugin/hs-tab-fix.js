(() => {
  'use strict';

  const ROOT_ID = 'hs-plugin-root';
  const NAV_ID = 'hs-plugin-nav';
  const QUERY_KEY = 'hs_plugin';
  const VERSION = '0.2.0';
  const rawFetch = window.fetch.bind(window);

  let opening = false;
  let mountedOutlet = null;

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
    const transformMatch = style.includes('translate3d') || style.includes('translate3d(0px, 0px, 0px)');
    const classMatch = el.classList.contains('flex') && el.classList.contains('flex-col') && el.classList.contains('flex-1');
    return transformMatch || classMatch;
  }

  function findOutlet() {
    const existing = document.getElementById(ROOT_ID);
    if (existing?.parentElement) return existing.parentElement;

    const inset = document.querySelector('main.dashboard-scroll') || document.querySelector('main');
    if (!inset) return null;

    // Strongest anchor: current PasarGuard PageTransition always owns an inline translate3d transform.
    const transforms = [...inset.querySelectorAll('div[style*="translate3d"]')];
    for (const el of transforms) {
      if (isPageTransition(el) && !el.closest('[data-sidebar="sidebar"]')) return el;
    }

    // Structural anchor from _dashboard.tsx: shell justify-between -> first child PageTransition -> Footer.
    const shells = [...inset.querySelectorAll('div')].filter(el =>
      el.classList.contains('flex') &&
      el.classList.contains('flex-col') &&
      el.classList.contains('flex-1') &&
      el.classList.contains('justify-between')
    );
    for (const shell of shells) {
      const children = [...shell.children];
      const first = children[0];
      if (isPageTransition(first)) return first;
    }

    // Footer anchor: the content container immediately before the PasarGuard footer.
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
      if (!el.hasAttribute('data-hs-native-display')) {
        el.setAttribute('data-hs-native-display', el.style.display || '');
      }
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

  function switchMarkup(enabled) {
    const state = enabled ? 'checked' : 'unchecked';
    return `<button id="hs-tab-feature-toggle" type="button" role="switch" aria-checked="${enabled ? 'true' : 'false'}" data-state="${state}" class="peer focus-visible:ring-ring focus-visible:ring-offset-background data-[state=checked]:bg-primary data-[state=unchecked]:bg-input inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"><span data-state="${state}" class="bg-background pointer-events-none block h-4 w-4 rounded-full shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"></span></button>`;
  }

  function syncSwitch(button, enabled) {
    const state = enabled ? 'checked' : 'unchecked';
    button.setAttribute('aria-checked', enabled ? 'true' : 'false');
    button.dataset.state = state;
    const thumb = button.querySelector('span');
    if (thumb) thumb.dataset.state = state;
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
              <div class="bg-card flex flex-row items-center justify-between gap-x-3 rounded-lg border p-3 sm:p-4">
                <div class="space-y-0.5">
                  <div class="text-xs font-medium sm:text-sm">Host Usage Ratio</div>
                  <p class="text-muted-foreground text-xs sm:text-sm">Enable or disable Usage Ratio controls inside Host.</p>
                </div>
                <div id="hs-tab-toggle-slot" class="shrink-0 opacity-60">Loading…</div>
              </div>
              <div id="hs-tab-status" class="text-muted-foreground min-h-5 text-xs"></div>
            </div>
          </div>
        </div>
      </div>`;

    setNavActive(true);
    return root;
  }

  async function hydrate(root) {
    const status = root.querySelector('#hs-tab-status');
    const slot = root.querySelector('#hs-tab-toggle-slot');

    try {
      const state = window.HSPluginDebug?.getState?.() || await api('/state');
      const enabled = !!state?.features?.host_usage_ratio?.enabled;
      slot.className = 'shrink-0';
      slot.innerHTML = switchMarkup(enabled);

      const toggle = slot.querySelector('#hs-tab-feature-toggle');
      toggle?.addEventListener('click', async () => {
        const current = toggle.getAttribute('aria-checked') === 'true';
        const next = !current;
        toggle.disabled = true;
        syncSwitch(toggle, next);
        if (status) status.textContent = 'Applying changes…';
        try {
          await api('/features/host_usage_ratio', { method: 'PUT', body: JSON.stringify({ enabled: next }) });
          await api('/resync', { method: 'POST', body: '{}' });
          await window.HSPluginDebug?.refresh?.();
          if (status) status.textContent = 'Changes applied.';
        } catch (error) {
          syncSwitch(toggle, current);
          if (status) status.textContent = error.message;
        } finally {
          toggle.disabled = false;
        }
      });
    } catch (error) {
      slot.textContent = 'Unavailable';
      slot.className = 'text-destructive shrink-0 text-xs';
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
      if (reloadFallback && window.location.pathname !== '/nodes') {
        window.location.assign(`/nodes?${QUERY_KEY}=1`);
      }
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
