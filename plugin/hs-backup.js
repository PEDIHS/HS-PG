(() => {
  'use strict';

  const VERSION = '1.0.0';
  const FEATURE_CARD_ID = 'hs-backup-web-card';
  const TAB_ID = 'hs-backup-settings-tab';
  const PANEL_ID = 'hs-backup-settings-panel';
  const MODAL_ID = 'hs-backup-confirm-modal';
  const QUERY_KEY = 'hs_backup';
  const rawFetch = window.fetch.bind(window);

  let enabled = false;
  let active = false;
  let selectedFile = null;
  let observer = null;
  let queued = false;
  let featureBusy = false;
  let exportBusy = false;
  let importBusy = false;
  let statusTimer = null;

  const icon = (body, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  const backupIcon = icon('<path d="M4 7V4h16v3"/><path d="M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><path d="M9 11h6M12 11v5"/><path d="m9.5 13.5 2.5 2.5 2.5-2.5"/>');
  const exportIcon = icon('<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 14v5h14v-5"/>', 17);
  const importIcon = icon('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 19h14"/>', 17);
  const fileIcon = icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>', 18);
  const checkIcon = icon('<path d="m5 12 4 4L19 6"/>', 14);
  const spinnerIcon = `<svg class="hs-backup-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>`;

  function injectStyle() {
    let style = document.getElementById('hs-backup-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'hs-backup-style';
      document.head.appendChild(style);
    }
    style.textContent = `
      @keyframes hs-backup-spin-keyframes { to { transform:rotate(360deg) } }
      @keyframes hs-backup-gold-shine {
        0%,70%,100% { background-position:0% 50% }
        82% { background-position:100% 50% }
      }
      .hs-backup-spin{animation:hs-backup-spin-keyframes .8s linear infinite}
      .hs-backup-gold{
        color:#e6bb57;
        background:linear-gradient(100deg,#b97918 0%,#e4b64b 24%,#fff0ab 46%,#d3a13a 59%,#f5d77e 80%,#b97918 100%);
        background-size:220% 100%;
        -webkit-background-clip:text;
        background-clip:text;
        -webkit-text-fill-color:transparent;
        animation:hs-backup-gold-shine 4.8s ease-in-out infinite;
        font-weight:650;
      }
      #${TAB_ID} .hs-backup-tab-mark{
        color:#d9aa42;
        filter:drop-shadow(0 0 4px rgba(218,170,66,.14));
      }
      #${PANEL_ID} .hs-backup-drop{
        transition:border-color .15s ease,background-color .15s ease;
      }
      #${PANEL_ID} .hs-backup-drop[data-dragging="true"]{
        border-color:var(--primary);
        background:color-mix(in srgb,var(--accent) 58%,transparent);
      }
      #${PANEL_ID} button:disabled{cursor:not-allowed;opacity:.55}
      @media(prefers-reduced-motion:reduce){
        .hs-backup-gold,.hs-backup-spin{animation:none!important}
      }
    `;
  }

  function headers(extra = {}) {
    const out = new Headers(extra);
    const token = localStorage.getItem('token');
    if (token && !out.has('Authorization')) out.set('Authorization', `Bearer ${token}`);
    return out;
  }

  async function api(path, options = {}) {
    const { headers: supplied, ...rest } = options;
    const response = await rawFetch(`/api/hs-plugin/backup${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...rest,
      headers: headers(supplied || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
    return data;
  }

  function switchMarkup(enabledState) {
    const state = enabledState ? 'checked' : 'unchecked';
    return `<button id="hs-backup-feature-toggle" type="button" role="switch" aria-checked="${enabledState ? 'true' : 'false'}" data-state="${state}" class="peer focus-visible:ring-ring focus-visible:ring-offset-background data-[state=checked]:bg-primary data-[state=unchecked]:bg-input inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"><span data-state="${state}" class="bg-background pointer-events-none block h-4 w-4 rounded-full shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"></span></button>`;
  }

  function syncSwitch(button, value) {
    if (!button) return;
    const state = value ? 'checked' : 'unchecked';
    button.setAttribute('aria-checked', value ? 'true' : 'false');
    button.dataset.state = state;
    const thumb = button.querySelector('span');
    if (thumb) thumb.dataset.state = state;
  }

  function featureList(root) {
    const nodeSlot = root?.querySelector('#hs-node-pro-slot');
    return nodeSlot?.parentElement?.parentElement || null;
  }

  function ensureFeatureCard() {
    const root = document.getElementById('hs-plugin-root');
    const list = featureList(root);
    if (!root || !list) return;

    let card = document.getElementById(FEATURE_CARD_ID);
    if (!card) {
      card = document.createElement('div');
      card.id = FEATURE_CARD_ID;
      card.className = 'bg-card hover:bg-accent/40 flex flex-row items-center justify-between gap-x-3 rounded-lg border p-3 transition-colors sm:p-4';
      card.innerHTML = `
        <div class="space-y-0.5">
          <div class="flex items-center gap-2 text-xs font-medium sm:text-sm">
            <span>Web Backup</span>
            <span class="hs-backup-gold text-[10px] tracking-wide">HS</span>
          </div>
          <p class="text-muted-foreground text-xs sm:text-sm">Add secure Export and Import controls to PasarGuard Settings using its native backup engine.</p>
        </div>
        <div id="hs-backup-feature-slot" class="shrink-0">${switchMarkup(enabled)}</div>`;
      list.appendChild(card);
      card.querySelector('#hs-backup-feature-toggle')?.addEventListener('click', toggleFeature);
    } else {
      syncSwitch(card.querySelector('#hs-backup-feature-toggle'), enabled);
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
    if (status) status.textContent = `Applying Web Backup…`;
    try {
      const data = await api('/feature', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({enabled: next}),
      });
      setEnabled(!!data.enabled);
      window.dispatchEvent(new CustomEvent('hs-plugin-feature-changed', {
        detail: {feature: 'backup_web', enabled: !!data.enabled},
      }));
      if (status) status.textContent = 'Changes applied.';
    } catch (error) {
      syncSwitch(button, current);
      if (status) status.textContent = error.message;
    } finally {
      featureBusy = false;
      button.disabled = false;
    }
  }

  function onSettingsPage() {
    return window.location.pathname === '/settings' || window.location.pathname.startsWith('/settings/');
  }

  function backupRequested() {
    try {
      return new URL(window.location.href).searchParams.get(QUERY_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function setBackupRequested(value, replace = false) {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(QUERY_KEY, '1');
    else url.searchParams.delete(QUERY_KEY);
    window.history[replace ? 'replaceState' : 'pushState']({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function findTabBar() {
    if (!onSettingsPage()) return null;
    const bars = [...document.querySelectorAll('div.scrollbar-hide.flex.overflow-x-auto.border-b')];
    return bars.find(bar => [...bar.children].some(child => child.tagName === 'BUTTON')) || null;
  }

  function normalizeNativeButton(button, activeState) {
    if (!button) return;
    if (!button.dataset.hsBackupOriginalClass) button.dataset.hsBackupOriginalClass = button.className;
    button.classList.remove('border-primary', 'text-foreground', 'border-b-2', 'text-muted-foreground', 'hover:text-foreground');
    if (activeState) button.classList.add('border-primary', 'text-foreground', 'border-b-2');
    else button.classList.add('text-muted-foreground', 'hover:text-foreground');
  }

  function restoreNativeButtonClasses(tabBar) {
    [...(tabBar?.children || [])].forEach(button => {
      if (button.id === TAB_ID) return;
      if (button.dataset.hsBackupOriginalClass) {
        button.className = button.dataset.hsBackupOriginalClass;
        delete button.dataset.hsBackupOriginalClass;
      }
    });
  }

  function tabMarkup() {
    return `<div class="flex items-center gap-1.5"><span class="hs-backup-tab-mark">${backupIcon}</span><span>Backup</span></div>`;
  }

  function ensureSettingsTab() {
    if (!enabled || !onSettingsPage()) return;
    const tabBar = findTabBar();
    if (!tabBar) return;

    let tab = document.getElementById(TAB_ID);
    if (!tab) {
      const native = [...tabBar.children].find(el => el.tagName === 'BUTTON');
      tab = native ? native.cloneNode(false) : document.createElement('button');
      tab.id = TAB_ID;
      tab.type = 'button';
      tab.removeAttribute('data-hs-backup-original-class');
      tab.className = 'relative flex-shrink-0 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors text-muted-foreground hover:text-foreground';
      tab.innerHTML = tabMarkup();
      tab.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        activateBackup(false);
      }, true);
      tabBar.appendChild(tab);
    }

    if (backupRequested() && !active) activateBackup(true);
    syncTabState();
  }

  function settingsParts() {
    const tabBar = findTabBar();
    const relative = tabBar?.closest('.relative.w-full') || null;
    const settingsRoot = relative?.parentElement || null;
    const header = settingsRoot ? [...settingsRoot.children].find(el => el !== relative && el.querySelector?.('h1')) : null;
    const nativeContent = tabBar?.nextElementSibling || null;
    return {tabBar, settingsRoot, header, nativeContent};
  }

  function alterHeader(header, useBackup) {
    if (!header) return;
    const title = header.querySelector('h1');
    const description = title?.closest('.flex.min-w-0')?.parentElement?.querySelector('span.text-muted-foreground') ||
      header.querySelector('span.text-muted-foreground');
    const help = header.querySelector('a[aria-label]');

    if (useBackup) {
      if (title && !title.dataset.hsBackupText) title.dataset.hsBackupText = title.textContent || '';
      if (description && !description.dataset.hsBackupText) description.dataset.hsBackupText = description.textContent || '';
      if (help && !help.dataset.hsBackupDisplay) help.dataset.hsBackupDisplay = help.style.display || '__empty__';
      if (title) title.textContent = 'Backup';
      if (description) description.textContent = 'Export and import PasarGuard backups securely from the dashboard.';
      if (help) help.style.display = 'none';
    } else {
      if (title?.dataset.hsBackupText !== undefined) {
        title.textContent = title.dataset.hsBackupText;
        delete title.dataset.hsBackupText;
      }
      if (description?.dataset.hsBackupText !== undefined) {
        description.textContent = description.dataset.hsBackupText;
        delete description.dataset.hsBackupText;
      }
      if (help?.dataset.hsBackupDisplay !== undefined) {
        help.style.display = help.dataset.hsBackupDisplay === '__empty__' ? '' : help.dataset.hsBackupDisplay;
        delete help.dataset.hsBackupDisplay;
      }
    }
  }

  function syncTabState() {
    const tabBar = findTabBar();
    const tab = document.getElementById(TAB_ID);
    if (!tabBar || !tab) return;
    [...tabBar.children].forEach(button => {
      if (button.id === TAB_ID) {
        normalizeNativeButton(button, active);
      } else if (active) {
        normalizeNativeButton(button, false);
      }
    });
  }

  function buttonClass() {
    return 'inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50';
  }

  function panelMarkup() {
    return `
      <section id="${PANEL_ID}" class="w-full p-4 sm:py-6 lg:py-8">
        <div class="mx-auto w-full max-w-5xl space-y-5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="space-y-1">
              <h3 class="text-base font-semibold sm:text-lg">Backup management</h3>
              <p class="text-muted-foreground max-w-3xl text-xs leading-relaxed sm:text-sm">Uses PasarGuard's native backup and restore engine. Backup files are generated on demand and never exposed publicly.</p>
            </div>
            <div id="hs-backup-agent-state" class="text-muted-foreground inline-flex items-center gap-2 text-xs">
              <span class="bg-muted-foreground/50 h-2 w-2 rounded-full"></span>
              <span>Checking backup service…</span>
            </div>
          </div>

          <div class="grid gap-4 lg:grid-cols-2">
            <div class="bg-card text-card-foreground rounded-xl border p-4 shadow-sm sm:p-5">
              <div class="flex h-full flex-col gap-5">
                <div class="space-y-1.5">
                  <div class="flex items-center gap-2">
                    <span class="text-muted-foreground">${exportIcon}</span>
                    <h4 class="font-semibold">Export Backup</h4>
                  </div>
                  <p class="text-muted-foreground text-xs leading-relaxed sm:text-sm">Create a fresh full PasarGuard backup and download it immediately. Large native split backups are packaged into one HS ZIP automatically.</p>
                </div>

                <div class="bg-muted/25 mt-auto rounded-lg border p-3">
                  <div class="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">Latest export</div>
                  <div id="hs-backup-export-meta" class="mt-1 text-xs">No backup created in this session.</div>
                </div>

                <div class="flex items-center justify-between gap-3">
                  <div id="hs-backup-export-status" class="text-muted-foreground min-h-5 text-xs"></div>
                  <button id="hs-backup-export" type="button" class="${buttonClass()}">
                    <span class="text-muted-foreground">${exportIcon}</span>
                    <span class="hs-backup-gold">Export</span>
                  </button>
                </div>
              </div>
            </div>

            <div class="bg-card text-card-foreground rounded-xl border p-4 shadow-sm sm:p-5">
              <div class="flex h-full flex-col gap-5">
                <div class="space-y-1.5">
                  <div class="flex items-center gap-2">
                    <span class="text-muted-foreground">${importIcon}</span>
                    <h4 class="font-semibold">Import Backup</h4>
                  </div>
                  <p class="text-muted-foreground text-xs leading-relaxed sm:text-sm">Upload a PasarGuard ZIP backup or an HS export. Import validates the archive first, then runs the native restore process on the host.</p>
                </div>

                <input id="hs-backup-file-input" type="file" accept=".zip,application/zip" class="hidden">
                <button id="hs-backup-drop" type="button" class="hs-backup-drop bg-muted/15 flex min-h-[104px] w-full items-center gap-3 rounded-lg border border-dashed p-3 text-left">
                  <span class="text-muted-foreground shrink-0">${fileIcon}</span>
                  <span class="min-w-0">
                    <span id="hs-backup-file-title" class="block truncate text-sm font-medium">Choose a backup file</span>
                    <span id="hs-backup-file-detail" class="text-muted-foreground mt-1 block text-xs">ZIP only · up to 1 GB · drag & drop supported</span>
                  </span>
                </button>

                <div class="flex items-center justify-between gap-3">
                  <div id="hs-backup-import-status" class="text-muted-foreground min-h-5 text-xs"></div>
                  <button id="hs-backup-import" type="button" disabled class="${buttonClass()}">
                    <span class="text-muted-foreground">${importIcon}</span>
                    <span class="hs-backup-gold">Import</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="bg-muted/20 text-muted-foreground rounded-lg border px-3 py-2.5 text-xs leading-relaxed">
            Import can restart or recreate PasarGuard services while restoring configuration and database data. The dashboard may disconnect temporarily; HS keeps the restore job on the host and reconnects automatically.
          </div>
        </div>
      </section>`;
  }

  function activateBackup(fromHistory) {
    if (!enabled || !onSettingsPage()) return;
    ensureSettingsTab();
    const {tabBar, header, nativeContent} = settingsParts();
    if (!tabBar || !nativeContent) return;

    active = true;
    if (!fromHistory && !backupRequested()) setBackupRequested(true);
    if (!nativeContent.dataset.hsBackupDisplay) nativeContent.dataset.hsBackupDisplay = nativeContent.style.display || '__empty__';
    nativeContent.style.display = 'none';

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      nativeContent.insertAdjacentHTML('afterend', panelMarkup());
      panel = document.getElementById(PANEL_ID);
      bindPanel();
    }
    panel.style.display = '';
    alterHeader(header, true);
    syncTabState();
    refreshAgentStatus();
  }

  function restoreNativeView({clearQuery = true} = {}) {
    const {tabBar, header, nativeContent} = settingsParts();
    active = false;
    if (nativeContent?.dataset.hsBackupDisplay !== undefined) {
      nativeContent.style.display = nativeContent.dataset.hsBackupDisplay === '__empty__' ? '' : nativeContent.dataset.hsBackupDisplay;
      delete nativeContent.dataset.hsBackupDisplay;
    }
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(MODAL_ID)?.remove();
    alterHeader(header, false);
    restoreNativeButtonClasses(tabBar);
    const tab = document.getElementById(TAB_ID);
    if (tab) normalizeNativeButton(tab, false);
    if (clearQuery && backupRequested()) setBackupRequested(false, true);
  }

  function removeSettingsTab() {
    if (active) restoreNativeView({clearQuery: true});
    document.getElementById(TAB_ID)?.remove();
  }

  function formatBytes(value) {
    let n = Number(value) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let unit = 0;
    while (Math.abs(n) >= 1024 && unit < units.length - 1) {
      n /= 1024;
      unit += 1;
    }
    const digits = unit === 0 || n >= 100 ? 0 : n >= 10 ? 1 : 2;
    return `${n.toFixed(digits)} ${units[unit]}`;
  }

  function setAgentState(kind, text) {
    const box = document.getElementById('hs-backup-agent-state');
    if (!box) return;
    const dotClass = kind === 'ok' ? 'bg-green-500' : kind === 'busy' ? 'bg-amber-500' : kind === 'error' ? 'bg-destructive' : 'bg-muted-foreground/50';
    box.innerHTML = `<span class="${dotClass} h-2 w-2 rounded-full"></span><span>${text}</span>`;
  }

  async function refreshAgentStatus() {
    if (!enabled || !active) return;
    try {
      const data = await api('/status');
      if (!data.available) setAgentState('error', 'Backup service unavailable');
      else if (data.busy) setAgentState('busy', 'Backup operation running');
      else setAgentState('ok', 'Backup service ready');
    } catch (error) {
      setAgentState('error', error.message || 'Backup service unavailable');
    }
  }

  function setSelectedFile(file) {
    if (!file) {
      selectedFile = null;
      const title = document.getElementById('hs-backup-file-title');
      const detail = document.getElementById('hs-backup-file-detail');
      if (title) title.textContent = 'Choose a backup file';
      if (detail) detail.textContent = 'ZIP only · up to 1 GB · drag & drop supported';
      const button = document.getElementById('hs-backup-import');
      if (button) button.disabled = true;
      return;
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setImportStatus('error', 'Select a ZIP backup file.');
      return;
    }
    if (file.size > 1024 * 1024 * 1024) {
      setImportStatus('error', 'The selected file is larger than 1 GB.');
      return;
    }
    selectedFile = file;
    const title = document.getElementById('hs-backup-file-title');
    const detail = document.getElementById('hs-backup-file-detail');
    if (title) title.textContent = file.name;
    if (detail) detail.textContent = `${formatBytes(file.size)} · Ready to import`;
    const button = document.getElementById('hs-backup-import');
    if (button) button.disabled = importBusy;
    setImportStatus('muted', 'Backup selected. Review and press Import.');
  }

  function statusHtml(kind, text) {
    const iconHtml = kind === 'busy' ? spinnerIcon : kind === 'ok' ? checkIcon : '';
    const cls = kind === 'error' ? 'text-destructive' : kind === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground';
    return `<span class="${cls} inline-flex items-center gap-1.5">${iconHtml}<span>${text}</span></span>`;
  }

  function setExportStatus(kind, text) {
    const el = document.getElementById('hs-backup-export-status');
    if (el) el.innerHTML = statusHtml(kind, text);
  }

  function setImportStatus(kind, text) {
    const el = document.getElementById('hs-backup-import-status');
    if (el) el.innerHTML = statusHtml(kind, text);
  }

  async function exportBackup() {
    if (exportBusy || !enabled) return;
    exportBusy = true;
    const button = document.getElementById('hs-backup-export');
    if (button) button.disabled = true;
    setExportStatus('busy', 'Creating fresh backup…');
    setAgentState('busy', 'Creating backup');

    try {
      const info = await api('/export', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: '{}',
      });
      setExportStatus('busy', 'Preparing download…');

      const response = await rawFetch(`/api/hs-plugin/backup/download/${encodeURIComponent(info.id)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: headers(),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || `Download failed (HTTP ${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = info.filename || 'pasarguard-backup.zip';
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }

      const meta = document.getElementById('hs-backup-export-meta');
      if (meta) {
        meta.textContent = `${info.filename || 'Backup'} · ${formatBytes(info.size)}${info.split_source ? ' · packaged from native split backup' : ''}`;
      }
      setExportStatus('ok', 'Backup downloaded.');
    } catch (error) {
      setExportStatus('error', error.message || 'Backup export failed.');
    } finally {
      exportBusy = false;
      if (button) button.disabled = false;
      refreshAgentStatus();
    }
  }

  function openConfirm() {
    if (!selectedFile || importBusy) return;
    document.getElementById(MODAL_ID)?.remove();
    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[1px]';
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="hs-backup-confirm-title" class="bg-background text-foreground w-full max-w-md rounded-xl border p-5 shadow-2xl sm:p-6">
        <div class="space-y-2">
          <h3 id="hs-backup-confirm-title" class="text-lg font-semibold">Import this backup?</h3>
          <p class="text-muted-foreground text-sm leading-relaxed">PasarGuard will validate <span class="text-foreground font-medium">${escapeHtml(selectedFile.name)}</span> and then run its native restore process. Current database and configuration can be replaced.</p>
        </div>
        <div class="bg-muted/25 mt-4 rounded-lg border p-3 text-xs">
          <div class="font-medium">${escapeHtml(selectedFile.name)}</div>
          <div class="text-muted-foreground mt-1">${formatBytes(selectedFile.size)}</div>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <button id="hs-backup-confirm-cancel" type="button" class="${buttonClass()}">Cancel</button>
          <button id="hs-backup-confirm-run" type="button" class="${buttonClass()}"><span class="text-muted-foreground">${importIcon}</span><span class="hs-backup-gold">Import</span></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#hs-backup-confirm-cancel')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#hs-backup-confirm-run')?.addEventListener('click', () => {
      overlay.remove();
      importBackup();
    });
    overlay.addEventListener('click', event => {
      if (event.target === overlay) overlay.remove();
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
    })[char]);
  }

  async function importBackup() {
    if (!selectedFile || importBusy || !enabled) return;
    importBusy = true;
    const file = selectedFile;
    const button = document.getElementById('hs-backup-import');
    if (button) button.disabled = true;
    setImportStatus('busy', `Uploading ${formatBytes(file.size)}…`);
    setAgentState('busy', 'Import in progress');

    try {
      const response = await rawFetch('/api/hs-plugin/backup/import', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: headers({
          'Content-Type': 'application/octet-stream',
          'X-HS-Backup-Filename': encodeURIComponent(file.name),
        }),
        body: file,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || `Upload failed (HTTP ${response.status})`);
      if (!data.job_id) throw new Error('Backup restore job was not created');

      setImportStatus('busy', 'Backup uploaded. Native restore is starting…');
      await pollJob(data.job_id);
    } catch (error) {
      setImportStatus('error', error.message || 'Backup import failed.');
    } finally {
      importBusy = false;
      if (button) button.disabled = !selectedFile;
      refreshAgentStatus();
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function pollJob(jobId) {
    const deadline = Date.now() + 45 * 60 * 1000;
    let consecutiveErrors = 0;

    while (Date.now() < deadline) {
      try {
        const job = await api(`/jobs/${encodeURIComponent(jobId)}`);
        consecutiveErrors = 0;
        if (job.status === 'succeeded') {
          setImportStatus('ok', 'Backup imported successfully. PasarGuard is ready.');
          return;
        }
        if (job.status === 'failed') {
          const failure = new Error(job.message || 'PasarGuard restore failed');
          failure.hsBackupFatal = true;
          throw failure;
        }

        const message = job.phase === 'staging'
          ? 'Validating and staging backup…'
          : job.phase === 'restoring'
            ? 'Restoring PasarGuard data and configuration…'
            : 'Restore queued…';
        setImportStatus('busy', message);
      } catch (error) {
        if (error?.hsBackupFatal) throw error;
        consecutiveErrors += 1;
        if (consecutiveErrors <= 2 && !navigator.onLine) {
          setImportStatus('busy', 'Connection interrupted. Waiting for PasarGuard…');
        } else if (consecutiveErrors <= 12) {
          setImportStatus('busy', 'PasarGuard may be restarting. Reconnecting…');
        } else {
          throw error;
        }
      }
      await sleep(2500);
    }
    throw new Error('Restore status timed out. Check the server before retrying.');
  }

  function bindPanel() {
    const input = document.getElementById('hs-backup-file-input');
    const drop = document.getElementById('hs-backup-drop');
    document.getElementById('hs-backup-export')?.addEventListener('click', exportBackup);
    document.getElementById('hs-backup-import')?.addEventListener('click', openConfirm);
    drop?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', () => setSelectedFile(input.files?.[0] || null));

    drop?.addEventListener('dragover', event => {
      event.preventDefault();
      drop.dataset.dragging = 'true';
    });
    drop?.addEventListener('dragleave', () => {
      drop.dataset.dragging = 'false';
    });
    drop?.addEventListener('drop', event => {
      event.preventDefault();
      drop.dataset.dragging = 'false';
      setSelectedFile(event.dataTransfer?.files?.[0] || null);
    });

    if (selectedFile) setSelectedFile(selectedFile);
  }

  function setEnabled(value) {
    enabled = !!value;
    ensureFeatureCard();
    if (!enabled) {
      removeSettingsTab();
      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
      return;
    }
    ensureSettingsTab();
    if (!statusTimer) statusTimer = setInterval(() => active && refreshAgentStatus(), 15000);
  }

  async function refreshFeature() {
    try {
      const data = await api('/feature');
      setEnabled(!!data.enabled);
    } catch (error) {
      console.warn('[HS Backup] feature state unavailable', error);
    }
  }

  function queueSync() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      ensureFeatureCard();
      if (enabled) ensureSettingsTab();
      if (enabled && backupRequested() && onSettingsPage() && !active) activateBackup(true);
      if ((!enabled || !onSettingsPage()) && active) restoreNativeView({clearQuery: !onSettingsPage()});
    });
  }

  function handleDocumentClick(event) {
    if (!active) return;
    const tabBar = findTabBar();
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!tabBar || !button || button.id === TAB_ID || !tabBar.contains(button)) return;
    restoreNativeView({clearQuery: true});
  }

  function start() {
    injectStyle();
    document.addEventListener('click', handleDocumentClick, true);
    window.addEventListener('popstate', () => {
      if (enabled && backupRequested() && onSettingsPage()) activateBackup(true);
      else if (active) restoreNativeView({clearQuery: false});
      queueSync();
    });
    window.addEventListener('hs-plugin-feature-changed', event => {
      if (event.detail?.feature === 'backup_web') setEnabled(!!event.detail.enabled);
    });

    observer = new MutationObserver(queueSync);
    observer.observe(document.documentElement, {childList: true, subtree: true});
    refreshFeature();
    setInterval(refreshFeature, 30000);
    queueSync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();

  window.HSBackup = {
    version: VERSION,
    refresh: refreshFeature,
    setEnabled,
    get enabled() { return enabled; },
    get active() { return active; },
  };
})();
