(() => {
  'use strict';

  const ROOT_ID = 'hs-plugin-root';
  const NAV_ID = 'hs-plugin-nav';
  const VERSION = '0.1.6';
  const rawFetch = window.fetch.bind(window);

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

  function findOutlet() {
    const existing = document.getElementById(ROOT_ID);
    if (existing?.parentElement) return existing.parentElement;

    const inset = document.querySelector('main.dashboard-scroll') || document.querySelector('main');
    if (!inset) return null;

    // Most robust anchor: PasarGuard footer is the sibling immediately after PageTransition.
    const footerLink = [...inset.querySelectorAll('a')].find(a => /PasarGuard/i.test(a.textContent || ''));
    if (footerLink) {
      let footerBox = footerLink.closest('div');
      while (footerBox && footerBox.parentElement && footerBox.parentElement !== inset) {
        const parent = footerBox.parentElement;
        const siblings = [...parent.children];
        if (siblings.length >= 2 && siblings[siblings.length - 1].contains(footerLink)) {
          const previous = siblings[siblings.length - 2];
          if (previous && previous.tagName === 'DIV') return previous;
        }
        footerBox = parent;
      }
    }

    // Current PasarGuard _dashboard.tsx structure.
    const shells = [...inset.querySelectorAll('div')].filter(el =>
      el.classList.contains('flex') &&
      el.classList.contains('min-h-0') &&
      el.classList.contains('flex-1') &&
      el.classList.contains('flex-col') &&
      el.classList.contains('justify-between')
    );
    for (const shell of shells) {
      const children = [...shell.children];
      if (children.length >= 2 && children[0]?.tagName === 'DIV') return children[0];
    }

    // Safe fallback: choose the flex column that contains the currently rendered route,
    // never the SidebarInset itself.
    const candidates = [...inset.querySelectorAll('div')].filter(el =>
      el.classList.contains('flex') &&
      el.classList.contains('flex-1') &&
      el.classList.contains('flex-col') &&
      !el.hasAttribute('data-sidebar')
    );
    return candidates.find(el => el.children.length > 0) || null;
  }

  function hideNative(outlet) {
    [...outlet.children].forEach(el => {
      if (el.id === ROOT_ID) return;
      if (!el.hasAttribute('data-hs-tab-display')) el.setAttribute('data-hs-tab-display', el.style.display || '');
      el.style.display = 'none';
    });
  }

  function restoreNative() {
    const root = document.getElementById(ROOT_ID);
    const outlet = root?.parentElement || findOutlet();
    if (outlet) {
      [...outlet.children].forEach(el => {
        if (!el.hasAttribute('data-hs-tab-display')) return;
        el.style.display = el.getAttribute('data-hs-tab-display') || '';
        el.removeAttribute('data-hs-tab-display');
      });
    }
    root?.remove();
  }

  function setActive(active) {
    const button = document.querySelector(`#${NAV_ID} [data-sidebar="menu-button"]`);
    if (button) button.dataset.active = active ? 'true' : 'false';
  }

  function renderSwitch(enabled) {
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

  async function openTab() {
    let state = window.HSPluginDebug?.getState?.() || null;
    if (!state) state = await api('/state');

    const outlet = findOutlet();
    if (!outlet) {
      console.error('[HS Plugin] unable to locate PasarGuard PageTransition');
      return;
    }

    hideNative(outlet);
    let root = document.getElementById(ROOT_ID);
    if (root && root.parentElement !== outlet) root.remove();
    root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('section');
      root.id = ROOT_ID;
      root.className = 'flex min-h-0 w-full flex-1 flex-col';
      outlet.appendChild(root);
    }

    const enabled = !!state?.features?.host_usage_ratio?.enabled;
    root.innerHTML = `
      <div class="flex min-h-[calc(100vh-200px)] w-full flex-col">
        <div class="flex flex-1 flex-col p-4 sm:py-6 lg:py-8">
          <div class="flex-1 space-y-6 sm:space-y-8 lg:space-y-10">
            <div class="space-y-3">
              <div class="space-y-2">
                <h3 class="text-base font-semibold sm:text-lg">HS Plugin</h3>
                <p class="text-muted-foreground text-xs sm:text-sm">Manage HS extensions for PasarGuard.</p>
              </div>
              <div class="bg-card hover:bg-accent/50 flex flex-row items-center justify-between gap-x-3 rounded-lg border p-3 transition-colors sm:p-4">
                <div class="space-y-0.5">
                  <div class="text-xs font-medium sm:text-sm">Host Usage Ratio</div>
                  <p class="text-muted-foreground text-xs sm:text-sm">Enable or disable Usage Ratio controls inside Host.</p>
                </div>
                ${renderSwitch(enabled)}
              </div>
              <div id="hs-tab-status" class="text-muted-foreground min-h-5 text-xs"></div>
            </div>
          </div>
        </div>
      </div>`;

    setActive(true);
    const toggle = root.querySelector('#hs-tab-feature-toggle');
    toggle?.addEventListener('click', async () => {
      const current = toggle.getAttribute('aria-checked') === 'true';
      const next = !current;
      const status = root.querySelector('#hs-tab-status');
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
  }

  document.addEventListener('click', event => {
    const hsNav = event.target.closest?.(`#${NAV_ID}`);
    if (hsNav) {
      setTimeout(() => {
        const root = document.getElementById(ROOT_ID);
        if (!root || root.offsetParent === null) openTab().catch(error => console.error('[HS Plugin] tab open failed', error));
      }, 0);
      return;
    }

    if (document.getElementById(ROOT_ID) && event.target.closest?.('a')) {
      restoreNative();
      setActive(false);
    }
  }, true);

  window.HSPluginTabFix = { version: VERSION, open: openTab, close: restoreNative, findOutlet };
})();
