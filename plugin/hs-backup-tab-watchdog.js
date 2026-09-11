(() => {
  'use strict';

  const VERSION = '1.1.0';
  const TAB_ID = 'hs-backup-settings-tab';
  const PANEL_ID = 'hs-backup-settings-panel';
  const QUERY_KEY = 'hs_backup';
  const rawFetch = window.fetch.bind(window);

  let enabled = !!window.HSBackup?.enabled;
  let queued = false;
  let observer = null;
  let featureTimer = null;
  let repairTimer = null;
  let mirroredPath = false;
  let originalPath = window.location.pathname || '/';

  const backupIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7V4h16v3"/><path d="M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><path d="M9 11h6M12 11v5"/><path d="m9.5 13.5 2.5 2.5 2.5-2.5"/></svg>`;

  function injectStyle() {
    let style = document.getElementById('hs-backup-tab-watchdog-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'hs-backup-tab-watchdog-style';
      document.head.appendChild(style);
    }
    style.textContent = `
      #${TAB_ID} .hs-backup-tab-mark{color:#d9aa42;filter:drop-shadow(0 0 4px rgba(218,170,66,.14))}
    `;
  }

  function authHeaders() {
    const headers = new Headers();
    const token = localStorage.getItem('token');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }

  function hashRoute() {
    const rawHash = String(window.location.hash || '');
    const raw = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
    const route = raw.startsWith('/') ? raw : raw ? `/${raw}` : '';
    const queryAt = route.indexOf('?');
    const path = (queryAt >= 0 ? route.slice(0, queryAt) : route) || window.location.pathname || '/';
    const search = queryAt >= 0 ? route.slice(queryAt) : '';
    return {path, search};
  }

  function onSettingsPage() {
    const path = hashRoute().path;
    return path === '/settings' || path.startsWith('/settings/');
  }

  function mirrorHashPathForLegacyBackup() {
    if (!onSettingsPage()) return false;
    const routePath = hashRoute().path;
    if (!mirroredPath) originalPath = window.location.pathname || '/';
    if (window.location.pathname !== routePath) {
      const url = new URL(window.location.href);
      const next = `${routePath}${url.search}${url.hash}`;
      window.history.replaceState(window.history.state, '', next);
    }
    mirroredPath = true;
    return true;
  }

  function restoreOriginalPathIfNeeded() {
    if (!mirroredPath) return;
    if (onSettingsPage() && document.getElementById(PANEL_ID)) return;
    const url = new URL(window.location.href);
    const targetPath = originalPath || '/';
    if (window.location.pathname !== targetPath) {
      window.history.replaceState(window.history.state, '', `${targetPath}${url.search}${url.hash}`);
    }
    mirroredPath = false;
  }

  function tabBarCandidates() {
    const exact = [...document.querySelectorAll('div.scrollbar-hide.flex.overflow-x-auto.border-b')];
    const broad = exact.length ? [] : [...document.querySelectorAll('div.border-b')].filter(el => {
      const cls = el.classList;
      return cls.contains('flex') && cls.contains('overflow-x-auto');
    });
    return [...exact, ...broad].filter(bar => [...bar.children].some(child => child.tagName === 'BUTTON'));
  }

  function findTabBar() {
    if (!onSettingsPage()) return null;
    const bars = tabBarCandidates();
    if (!bars.length) return null;

    let best = null;
    let bestScore = -1;
    for (const bar of bars) {
      let score = 0;
      const buttonCount = [...bar.children].filter(child => child.tagName === 'BUTTON').length;
      if (buttonCount >= 1 && buttonCount <= 12) score += 3;
      if (bar.closest('.relative.w-full')) score += 4;
      if (bar.parentElement?.classList.contains('w-full')) score += 2;
      if (!bar.closest('#hs-plugin-root')) score += 2;
      if (score > bestScore) {
        best = bar;
        bestScore = score;
      }
    }
    return best;
  }

  function tabMarkup() {
    return `<div class="flex items-center gap-1.5"><span class="hs-backup-tab-mark">${backupIcon}</span><span>Backup</span></div>`;
  }

  function requestBackupView() {
    // PasarGuard uses createHashRouter. The original HS Backup 1.x code reads
    // location.pathname/search, so mirror the active hash route only while the
    // HS Backup view is active. React continues to use the unchanged hash.
    mirrorHashPathForLegacyBackup();

    const url = new URL(window.location.href);
    url.searchParams.set(QUERY_KEY, '1');
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);

    const fire = () => window.dispatchEvent(new PopStateEvent('popstate'));
    window.HSBackup?.setEnabled?.(true);
    fire();
    setTimeout(fire, 40);
    setTimeout(fire, 160);

    setTimeout(() => {
      if (!document.getElementById(PANEL_ID) && onSettingsPage()) {
        window.HSBackup?.refresh?.();
        fire();
      }
    }, 450);
  }

  function ensureTab() {
    if (!enabled || !onSettingsPage()) return false;
    const bar = findTabBar();
    if (!bar) return false;

    let tab = document.getElementById(TAB_ID);
    if (tab && tab.parentElement !== bar) {
      tab.remove();
      tab = null;
    }

    if (!tab) {
      const native = [...bar.children].find(child => child.tagName === 'BUTTON');
      tab = native ? native.cloneNode(false) : document.createElement('button');
      tab.id = TAB_ID;
      tab.type = 'button';
      tab.dataset.hsBackupWatchdog = VERSION;
      tab.className = 'relative flex-shrink-0 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors text-muted-foreground hover:text-foreground';
      tab.innerHTML = tabMarkup();
      tab.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        requestBackupView();
      }, true);
      bar.appendChild(tab);
    }
    return true;
  }

  function queueRepair() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (enabled) ensureTab();
      if (!onSettingsPage()) restoreOriginalPathIfNeeded();
    });
  }

  async function refreshFeature() {
    try {
      const response = await rawFetch('/api/hs-plugin/backup/feature', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: authHeaders(),
      });
      if (!response.ok) return;
      const data = await response.json().catch(() => ({}));
      enabled = !!data.enabled;
      if (enabled) queueRepair();
      else if (document.getElementById(TAB_ID)?.dataset.hsBackupWatchdog) document.getElementById(TAB_ID)?.remove();
    } catch (_) {
      // The main HS Backup script owns user-facing API errors.
    }
  }

  function handleRouteChange() {
    if (!onSettingsPage()) restoreOriginalPathIfNeeded();
    queueRepair();
  }

  function start() {
    injectStyle();
    observer = new MutationObserver(queueRepair);
    observer.observe(document.documentElement, {childList: true, subtree: true});

    window.addEventListener('popstate', queueRepair);
    window.addEventListener('hashchange', handleRouteChange);
    window.addEventListener('pageshow', queueRepair);
    window.addEventListener('focus', queueRepair);
    window.addEventListener('hs-plugin-feature-changed', event => {
      if (event.detail?.feature !== 'backup_web') return;
      enabled = !!event.detail.enabled;
      if (enabled) queueRepair();
    });

    refreshFeature();
    featureTimer = window.setInterval(refreshFeature, 10000);
    repairTimer = window.setInterval(() => {
      if (enabled && onSettingsPage()) ensureTab();
      else restoreOriginalPathIfNeeded();
    }, 900);
    queueRepair();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();

  window.HSBackupTabWatchdog = {
    version: VERSION,
    repair: ensureTab,
    refresh: refreshFeature,
    diagnostics: () => ({
      version: VERSION,
      enabled,
      pathname: window.location.pathname,
      hash: window.location.hash,
      hashRoute: hashRoute(),
      settingsPage: onSettingsPage(),
      mirroredPath,
      tabBarFound: !!findTabBar(),
      tabPresent: !!document.getElementById(TAB_ID),
      panelPresent: !!document.getElementById(PANEL_ID),
      mainBackupVersion: window.HSBackup?.version || null,
    }),
    stop: () => {
      observer?.disconnect();
      if (featureTimer) clearInterval(featureTimer);
      if (repairTimer) clearInterval(repairTimer);
    },
  };
})();
