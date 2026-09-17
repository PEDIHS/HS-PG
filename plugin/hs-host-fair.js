(() => {
  'use strict';

  const HOST_ID = 'hs-host-fair-use';
  const GROUP_ID = 'hs-group-fair-use';
  const USER_ID = 'hs-user-fair-use';
  const GROUP_BAR_ID = 'hs-host-group-bar';
  const STYLE_ID = 'hs-host-fair-style';
  const FAIR_STATUS = 'fair_limited';
  const input = 'border-border bg-input placeholder:text-input-placeholder focus-visible:ring-ring flex h-9 w-full rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';

  let raw = window.fetch.bind(window);
  let state = null;
  let settings = null;
  let hosts = [];
  let groups = [];
  let loading = false;
  let reloadQueued = false;
  let listEnabled = false;
  let activeHostStatusField = null;
  let fairRefreshClick = false;
  let fairStatusHosts = new Set();
  const users = new Map();


  const hsTagMarkup = () => '<span class="hs-fair-hs-tag" aria-label="HS Plugin">HS</span>';
  const checkIcon = () => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

  const css = `
    .hs-fair-hs-tag{display:inline-flex;height:18px;min-width:22px;align-items:center;justify-content:center;border:1px solid rgba(212,167,44,.28);border-radius:999px;padding:0 6px;background:rgba(212,167,44,.075);color:#b18422;font-size:9px;font-weight:700;line-height:1;letter-spacing:.04em;vertical-align:middle}
    .hs-fair-section{overflow:hidden;background:hsl(var(--card)/.35);transition:border-color .18s,background-color .18s}
    .hs-fair-section[open]{border-color:hsl(var(--border));background:hsl(var(--card)/.58)}
    .hs-fair-summary{list-style:none;user-select:none}
    .hs-fair-summary::-webkit-details-marker{display:none}
    .hs-fair-summary-title{display:flex;min-width:0;align-items:center;gap:.5rem}
    .hs-fair-summary-meta{margin-inline-start:auto;display:flex;align-items:center;gap:.5rem}
    .hs-fair-summary-state{border-radius:999px;padding:.16rem .45rem;background:hsl(var(--muted)/.55);color:hsl(var(--muted-foreground));font-size:10px;font-weight:600}
    .hs-fair-summary-state[data-state=on]{background:rgba(34,197,94,.1);color:#16a34a}
    .hs-fair-chevron{color:hsl(var(--muted-foreground));font-size:12px;transition:transform .18s ease}
    .hs-fair-section[open] .hs-fair-chevron{transform:rotate(180deg)}
    .hs-fair-body{border-top:1px solid hsl(var(--border)/.65);padding:14px 2px 16px}
    .hs-fair-enable-row{display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid hsl(var(--border)/.75);border-radius:10px;background:hsl(var(--muted)/.22);padding:12px}
    .hs-fair-enable-copy{min-width:0}
    .hs-fair-enable-title{font-size:13px;font-weight:600;color:hsl(var(--foreground))}
    .hs-fair-enable-help{margin-top:3px;color:hsl(var(--muted-foreground));font-size:11px;line-height:1.45}
    .hs-fair-switch{display:inline-flex;height:20px;width:36px;flex:none;align-items:center;border:2px solid transparent;border-radius:999px;background:hsl(var(--input));box-shadow:0 1px 2px rgba(0,0,0,.06);cursor:pointer;transition:background-color .16s;outline:none}
    .hs-fair-switch:focus-visible{box-shadow:0 0 0 2px hsl(var(--ring))}
    .hs-fair-switch[data-state=checked]{background:hsl(var(--primary))}
    .hs-fair-switch-thumb{display:block;height:16px;width:16px;border-radius:999px;background:hsl(var(--background));box-shadow:0 1px 3px rgba(0,0,0,.25);transform:translateX(0);transition:transform .16s}
    .hs-fair-switch[data-state=checked] .hs-fair-switch-thumb{transform:translateX(16px)}
    [dir=rtl] .hs-fair-switch[data-state=checked] .hs-fair-switch-thumb{transform:translateX(-16px)}
    .hs-fair-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;margin-top:14px}
    .hs-fair-control{display:flex;min-width:0;flex-direction:column;gap:5px}
    .hs-fair-control[data-disabled=true]{opacity:.58}
    .hs-fair-label{font-size:11px;font-weight:600;color:hsl(var(--foreground))}
    .hs-fair-help{color:hsl(var(--muted-foreground));font-size:10px;line-height:1.35}
    .hs-fair-rate{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;border-radius:9px;background:hsl(var(--muted)/.3);padding:9px 11px;color:hsl(var(--muted-foreground));font-size:11px}
    .hs-fair-rate strong{color:hsl(var(--foreground));font-weight:650;font-variant-numeric:tabular-nums}
    .hs-fair-note{margin-top:10px;border-inline-start:2px solid rgba(212,167,44,.32);padding:3px 0 3px 10px;color:hsl(var(--muted-foreground));font-size:10.5px;line-height:1.5}
    [dir=rtl] .hs-fair-note{padding:3px 10px 3px 0}
    .hs-fair-save-note{margin-top:10px;color:hsl(var(--muted-foreground));font-size:10.5px}
    .hs-fair-status-option .hs-fair-hs-tag{margin-inline-start:auto;margin-inline-end:4px}
    .hs-fair-status-option [data-hs-fair-checkbox] svg{width:13px;height:13px;color:hsl(var(--primary-foreground))}
    [data-hs-fair-status-badge] .hs-fair-hs-tag,[data-hs-fair-badge] .hs-fair-hs-tag{height:16px;min-width:20px;padding:0 5px;font-size:8px}
    .hs-fair-split-badge{display:inline-flex!important;align-items:stretch!important;overflow:hidden!important;border:0!important;border-radius:999px!important;background:transparent!important;padding:0!important;box-shadow:0 0 0 1px hsl(var(--border)/.22)!important}
    .hs-fair-split-native,.hs-fair-split-limit{display:inline-flex;min-height:24px;align-items:center;justify-content:center;gap:4px;padding:0 8px;font-size:11px;font-weight:600;line-height:1;white-space:nowrap}
    .hs-fair-split-native{border-radius:999px 0 0 999px!important}
    .hs-fair-split-limit{border-radius:0 999px 999px 0;background:rgba(249,115,22,.12);color:#c2410c}
    .dark .hs-fair-split-limit{color:#fdba74}
    [dir=rtl] .hs-fair-split-native{border-radius:0 999px 999px 0!important}
    [dir=rtl] .hs-fair-split-limit{border-radius:999px 0 0 999px}
    .hs-fair-split-limit .hs-fair-hs-tag{border-color:rgba(249,115,22,.3);background:rgba(249,115,22,.08);color:currentColor}
    #${GROUP_BAR_ID} .hs-fair-hs-tag{height:16px;min-width:20px;font-size:8px}
    #hs-fair-filter .hs-fair-hs-tag{height:15px;min-width:18px;margin-inline-start:5px;padding:0 4px;font-size:7.5px}
    @media(min-width:640px){.hs-fair-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.hs-fair-section[data-kind=host] .hs-fair-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media(prefers-reduced-motion:reduce){.hs-fair-chevron,.hs-fair-switch,.hs-fair-switch-thumb{transition:none}}
  `;

  function injectStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }

  function hsTagElement() {
    const tag = document.createElement('span');
    tag.className = 'hs-fair-hs-tag';
    tag.setAttribute('aria-label', 'HS Plugin');
    tag.textContent = 'HS';
    return tag;
  }

  const headers = () => {
    const h = {'Content-Type': 'application/json'};
    const token = localStorage.getItem('token');
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  };

  async function api(path, body, method) {
    const response = await raw(path, {
      credentials: 'same-origin',
      headers: headers(),
      method: method || (body ? 'PUT' : 'GET'),
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data));
    return data;
  }

  function error(message) {
    let element = document.getElementById('hs-fair-error');
    if (!element) {
      element = document.createElement('div');
      element.id = 'hs-fair-error';
      element.setAttribute('role', 'alert');
      element.className = 'bg-card text-destructive fixed bottom-4 right-4 z-50 max-w-md rounded-lg border p-4 shadow';
      document.body.appendChild(element);
    }
    element.textContent = message;
  }

  async function load() {
    if (loading) { reloadQueued = true; return; }
    loading = true;
    listEnabled = false;
    try {
      [state, settings] = await Promise.all([api('/api/hs-plugin/state'), api('/api/hs-services/fair-use')]);
      hosts = state.hosts || [];
      fairStatusHosts = new Set((settings.fair_status_hosts || []).map(value => String(value)));
      try {
        const nativeGroups = await api('/api/groups');
        groups = Array.isArray(nativeGroups.groups) ? nativeGroups.groups : (settings.groups || []);
      } catch {
        groups = settings.groups || [];
      }
      if (!state.features?.fair_use?.enabled && fairFilterSelected()) clearFairFilter(false);
    } catch (exc) {
      console.warn('HS Fair Use load failed', exc);
    } finally {
      loading = false;
      scan();
      if (reloadQueued) { reloadQueued = false; queueMicrotask(load); }
    }
  }

  function identifyHost(dialog) {
    const direct = dialog.querySelector('#hs-host-usage-ratio')?.dataset.hostId;
    if (Number(direct) > 0) return String(direct);
    const remark = dialog.querySelector('[name=remark]')?.value;
    const matches = hosts.filter(host => host.remark === remark);
    return matches.length === 1 ? String(matches[0].id) : '';
  }

  function identifyGroup(dialog) {
    const direct = dialog.querySelector('#' + GROUP_ID)?.dataset.groupId;
    if (Number(direct) > 0) return String(direct);
    const name = dialog.querySelector('[name=name]')?.value;
    const matches = groups.filter(group => group.name === name);
    return matches.length === 1 ? String(matches[0].id) : '';
  }

  function policyData(field, kind) {
    const q = name => field.querySelector('[data-fair=' + name + ']');
    if (!q('enabled').checked) return null;
    const mode = kind === 'group' ? (q('mode')?.value || 'always') : kind === 'user' ? 'always' : 'threshold';
    const value = {
      mode,
      threshold_bytes: mode === 'always' ? 0 : Math.round(Number(q('gb').value) * 1e9),
      baseline_mbps: Number(q('base').value),
      speed_percent: Number(q('percent').value),
    };
    if ((mode === 'threshold' && (value.threshold_bytes <= 0 || !Number.isSafeInteger(value.threshold_bytes))) ||
        !Number.isFinite(value.baseline_mbps) || !Number.isFinite(value.speed_percent) ||
        value.baseline_mbps < .1 || value.baseline_mbps > 100000 || value.speed_percent < 1 || value.speed_percent > 100) {
      throw Error('Enter a valid traffic threshold, baseline speed and percentage between 1 and 100.');
    }
    return value;
  }

  function updateField(field, kind) {
    const q = name => field.querySelector('[data-fair=' + name + ']');
    const toggle = q('enabled');
    const enabled = !!toggle?.checked;
    const mode = kind === 'group' ? (q('mode')?.value || 'always') : kind === 'user' ? 'always' : 'threshold';
    field.dataset.enabled = enabled ? '1' : '0';
    toggle?.setAttribute('aria-checked', String(enabled));

    const switchButton = field.querySelector('[data-fair-switch]');
    if (switchButton) {
      switchButton.dataset.state = enabled ? 'checked' : 'unchecked';
      switchButton.setAttribute('aria-checked', String(enabled));
    }
    const summaryState = field.querySelector('[data-fair-summary-state]');
    if (summaryState) {
      summaryState.textContent = enabled ? 'Enabled' : 'Off';
      summaryState.dataset.state = enabled ? 'on' : 'off';
    }

    if (q('gb')) q('gb').disabled = !enabled || mode === 'always';
    for (const name of ['base', 'percent']) if (q(name)) q(name).disabled = !enabled;
    if (q('mode')) q('mode').disabled = !enabled;
    for (const control of field.querySelectorAll('.hs-fair-control')) {
      const name = control.querySelector('[data-fair]')?.dataset.fair;
      const disabled = !enabled || (name === 'gb' && mode === 'always');
      control.dataset.disabled = disabled ? 'true' : 'false';
    }

    const base = Number(q('base')?.value || 0);
    const percent = Number(q('percent')?.value || 0);
    const rate = base * percent / 100;
    const rateBox = field.querySelector('[data-rate]');
    if (rateBox) {
      rateBox.innerHTML = enabled
        ? `<span>Effective limited speed</span><strong>${rate.toFixed(2)} Mbps · ${percent}%</strong>`
        : '<span>Fair Use is disabled</span><strong>Full speed</strong>';
    }
  }

  function wire(field, kind) {
    updateField(field, kind);
    field.querySelectorAll('input,select,label,button[data-fair-switch]').forEach(element => element.addEventListener('click', event => event.stopPropagation()));
    const hidden = field.querySelector('[data-fair=enabled]');
    const switchButton = field.querySelector('[data-fair-switch]');
    switchButton?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (!hidden) return;
      hidden.checked = !hidden.checked;
      hidden.dispatchEvent(new Event('change', {bubbles: true}));
    });
    const dirty = () => {
      field.dataset.dirty = '1';
      updateField(field, kind);
      const result = field.querySelector('[data-result]');
      if (result) result.textContent = 'Will be saved with ' + (kind === 'group' ? 'Group' : kind === 'user' ? 'User' : 'Host') + '.';
    };
    field.addEventListener('input', dirty);
    field.addEventListener('change', dirty);
  }

  function fairSummary(kind, enabled) {
    return `<summary class="hs-fair-summary flex cursor-pointer items-center gap-2 py-4 text-sm font-medium"><span class="hs-fair-summary-title"><span>Fair Use</span>${hsTagMarkup()}</span><span class="hs-fair-summary-meta"><span class="hs-fair-summary-state" data-fair-summary-state data-state="${enabled?'on':'off'}">${enabled?'Enabled':'Off'}</span><span class="hs-fair-chevron">⌄</span></span></summary>`;
  }

  function fairToggle(label, help, enabled) {
    return `<div class="hs-fair-enable-row"><div class="hs-fair-enable-copy"><div class="hs-fair-enable-title">${label}</div><div class="hs-fair-enable-help">${help}</div></div><input class="sr-only" type="checkbox" data-fair="enabled" ${enabled?'checked':''}><button type="button" class="hs-fair-switch" role="switch" data-fair-switch data-state="${enabled?'checked':'unchecked'}" aria-checked="${enabled?'true':'false'}" aria-label="${label}"><span class="hs-fair-switch-thumb"></span></button></div>`;
  }

  function fairControl(label, help, control) {
    return `<label class="hs-fair-control"><span class="hs-fair-label">${label}</span>${control}<span class="hs-fair-help">${help}</span></label>`;
  }

  function hostField(dialog) {
    if (dialog.querySelector('#' + HOST_ID)) return;
    const form = dialog.querySelector('form');
    if (!form?.querySelector('[name=remark]')) return;
    const id = identifyHost(dialog), policy = settings?.policies?.[id], shared = settings?.shared_hosts?.[id] || [];
    const field = document.createElement('details');
    field.id = HOST_ID;
    field.dataset.hostId = id;
    field.dataset.kind = 'host';
    field.className = 'hs-fair-section rounded-sm border px-4';
    const enabled = !!policy;
    const sharedText = shared.length > 1
      ? `Shared inbound · the same policy is kept in sync across all ${shared.length} Hosts using this inbound.`
      : 'Inbound policy · another Host using this inbound will inherit the same Fair Use values.';
    field.innerHTML = `${fairSummary('host', enabled)}<div class="hs-fair-body">${fairToggle('Enable Fair Use','Limit this Host only after each user reaches the configured charged-traffic threshold.',enabled)}<div class="hs-fair-grid">${fairControl('After traffic','Per-user charged traffic before limiting.',`<input class="${input}" type="number" min="0.001" step="0.001" data-fair="gb" value="${policy?policy.threshold_bytes/1e9:100}">`)}${fairControl('Full speed','Baseline speed before the threshold.',`<input class="${input}" type="number" min="0.1" max="100000" step="0.1" data-fair="base" value="${policy?.baseline_mbps||100}">`)}${fairControl('Limited speed','Percentage of baseline kept after the threshold.',`<div class="relative"><input class="${input} pr-8" type="number" min="1" max="100" data-fair="percent" value="${policy?.speed_percent||20}"><span class="text-muted-foreground pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs">%</span></div>`)}</div><div class="hs-fair-rate" data-rate></div><div class="hs-fair-note">${sharedText}<br>Traffic reset restores full speed until that user reaches the threshold again. ${settings?.enforcement_available?'HS rate adapter is connected.':'Node setup is required for enforcement.'}</div><p role="status" class="hs-fair-save-note" data-result>${id?'Saved together with the normal Host Save button.':'Create the Host first; Fair Use will be saved with it.'}</p></div>`;
    const target = [...form.querySelectorAll('div')].find(element => element.children.length > 1 && String(element.className).includes('overflow-y-auto')) || form;
    target.appendChild(field);
    wire(field, 'host');
  }

  async function resolveUser(dialog) {
    const input = dialog.querySelector('[name=username]');
    const username = input?.value?.trim();
    if (!username || (!input.disabled && !input.readOnly)) return null;
    const cached = users.get(username);
    if (cached?.id) return cached;
    try {
      const user = await api('/api/user/' + encodeURIComponent(username));
      if (user?.id) users.set(username, user);
      return user?.id ? user : null;
    } catch {
      return null;
    }
  }

  async function userField(dialog) {
    if (dialog.querySelector('#' + USER_ID) || dialog.dataset.hsUserFairLoading === '1' || !isUsersRoute()) return;
    const form = dialog.querySelector('form');
    const username = form?.querySelector('[name=username]');
    if (!username) return;
    dialog.dataset.hsUserFairLoading = '1';
    const user = await resolveUser(dialog);
    delete dialog.dataset.hsUserFairLoading;
    if (!user || !dialog.isConnected || dialog.querySelector('#' + USER_ID)) return;
    const id = String(user.id);
    const policy = settings?.user_policies?.[id];
    const field = document.createElement('details');
    field.id = USER_ID;
    field.dataset.userId = id;
    field.dataset.kind = 'user';
    field.className = 'hs-fair-section mt-4 rounded-sm border px-4';
    const enabled = !!policy;
    field.innerHTML = `${fairSummary('user', enabled)}<div class="hs-fair-body">${fairToggle('Enable Fair Use for this User','Immediately apply a user-specific speed cap while the native User status is Active.',enabled)}<div class="hs-fair-grid">${fairControl('Full speed','Baseline speed used to calculate this User cap.',`<input class="${input}" type="number" min="0.1" max="100000" step="0.1" data-fair="base" value="${policy?.baseline_mbps||100}">`)}${fairControl('Limited speed','Percentage of baseline retained while this User is Fair limited.',`<div class="relative"><input class="${input} pr-8" type="number" min="1" max="100" data-fair="percent" value="${policy?.speed_percent||20}"><span class="text-muted-foreground pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs">%</span></div>`)}</div><div class="hs-fair-rate" data-rate></div><div class="hs-fair-note">This rule applies immediately to every inbound assigned to this User. If Host or Group Fair Use also applies, the strictest active cap wins.<br>After the HS rate adapter acknowledges the policy, this User appears under the Fair Use filter automatically.</div><p role="status" class="hs-fair-save-note" data-result>${id?'Saved together with the normal User Save button.':'Create the User first; Fair Use will be saved with it.'}</p></div>`;
    const target = [...form.querySelectorAll('div')].find(element => String(element.className).includes('overflow-y-auto') && String(element.className).includes('max-h-')) || form;
    target.appendChild(field);
    wire(field, 'user');
    if (!form.dataset.hsUserFairSubmit) {
      form.dataset.hsUserFairSubmit = '1';
      form.addEventListener('submit', () => {
        const current = form.querySelector('#' + USER_ID + '[data-dirty="1"]');
        if (!current?.dataset.userId) return;
        let body;
        try { body = policyData(current, 'user'); }
        catch (exc) { error(exc.message); return; }
        current.dataset.dirty = 'saving';
        queueMicrotask(async () => {
          try {
            const path = '/api/hs-services/users/' + current.dataset.userId + '/fair-use';
            await api(path, body, body ? 'PUT' : 'DELETE');
            current.dataset.dirty = '0';
            refreshUsersAfterFairSave();
            await load();
          } catch (exc) {
            current.dataset.dirty = '1';
            error('User saved, but HS Fair Use failed: ' + exc.message);
          }
        });
      });
    }
  }

  function groupField(dialog) {
    if (dialog.querySelector('#' + GROUP_ID) || !String(location.pathname + location.hash).includes('groups')) return;
    const form = dialog.querySelector('form');
    if (!form?.querySelector('[name=name]') || form.querySelector('[name=remark]')) return;
    const id = identifyGroup(dialog), policy = settings?.group_policies?.[id];
    const field = document.createElement('details');
    field.id = GROUP_ID;
    field.dataset.groupId = id;
    field.dataset.kind = 'group';
    field.className = 'hs-fair-section rounded-sm border px-4';
    const enabled = !!policy;
    field.innerHTML = `${fairSummary('group', enabled)}<div class="hs-fair-body">${fairToggle('Enable Fair Use for Group','Apply one shared rule to every inbound assigned to this Group.',enabled)}<div class="hs-fair-grid">${fairControl('Mode','Always limits immediately; After usage waits for each user threshold.',`<select class="${input}" data-fair="mode"><option value="always" ${policy?.mode==='always'?'selected':''}>Always</option><option value="threshold" ${policy?.mode==='threshold'?'selected':''}>After usage</option></select>`)}${fairControl('Traffic threshold','Used only when Mode is After usage.',`<input class="${input}" type="number" min="0.001" step="0.001" data-fair="gb" value="${policy?.mode==='threshold'?policy.threshold_bytes/1e9:100}">`)}${fairControl('Full speed','Baseline speed before the Group cap.',`<input class="${input}" type="number" min="0.1" max="100000" step="0.1" data-fair="base" value="${policy?.baseline_mbps||100}">`)}${fairControl('Limited speed','Percentage of baseline retained while limited.',`<div class="relative"><input class="${input} pr-8" type="number" min="1" max="100" data-fair="percent" value="${policy?.speed_percent||33}"><span class="text-muted-foreground pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs">%</span></div>`)}</div><div class="hs-fair-rate" data-rate></div><div class="hs-fair-note">The Group rule covers all assigned inbounds. If a Host rule and Group rule overlap, the strictest active speed cap wins.</div><p role="status" class="hs-fair-save-note" data-result>${id?'Saved together with the normal Group Save button.':'Create the Group first; Fair Use will be saved with it.'}</p></div>`;
    const target = [...form.querySelectorAll('div')].find(element => String(element.className).includes('overflow-y-auto') && String(element.className).includes('max-h-')) || form;
    target.appendChild(field);
    wire(field, 'group');
  }

  function findHostStatusField(dialog) {
    for (const label of dialog.querySelectorAll('label')) {
      if (!/^(status|وضعیت)$/i.test(label.textContent.trim())) continue;
      let current = label.parentElement;
      for (let depth = 0; current && depth < 5; depth++, current = current.parentElement) {
        if (current.querySelector('button[role=combobox]')) return current;
      }
    }
    return null;
  }

  function fairStatusBadgeBox(field) {
    return [...field.querySelectorAll('div')].find(element =>
      String(element.className).includes('flex-wrap') && String(element.className).includes('gap-1')) || null;
  }

  function syncHostSaveButton(field) {
    const button = field.closest('[role=dialog]')?.querySelector('form button[type=submit]');
    if (!button) return;
    if (field.dataset.hsFairDirty === '1') {
      if (!button.hasAttribute('data-hs-original-disabled')) button.dataset.hsOriginalDisabled = button.disabled ? '1' : '0';
      button.disabled = false;
      button.removeAttribute('disabled');
    } else if (button.hasAttribute('data-hs-original-disabled')) {
      button.disabled = button.dataset.hsOriginalDisabled === '1';
      delete button.dataset.hsOriginalDisabled;
    }
  }

  function renderHostFairStatus(field) {
    const selected = field.dataset.hsFairSelected === '1';
    const box = fairStatusBadgeBox(field);
    if (box) {
      box.querySelector('[data-hs-fair-status-badge]')?.remove();
      const empty = [...box.querySelectorAll('span')].find(span =>
        !span.dataset.hsFairStatusBadge && String(span.className).includes('text-muted-foreground'));
      if (empty) empty.style.display = selected ? 'none' : '';
      if (selected) {
        const nativeBadge = [...box.children].find(child => child.tagName === 'SPAN' && !String(child.className).includes('text-muted-foreground'));
        const badge = document.createElement('span');
        badge.dataset.hsFairStatusBadge = '1';
        badge.className = nativeBadge?.className || 'bg-muted/80 flex items-center gap-2 rounded-md px-2 py-1 text-sm';
        const label = document.createElement('span');
        label.textContent = 'Fair limited';
        badge.append(label, hsTagElement());
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'hover:text-destructive';
        remove.textContent = '×';
        remove.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); setHostFairStatus(field, false); });
        badge.appendChild(remove);
        box.appendChild(badge);
      }
    }
    syncHostSaveButton(field);
    updateFairStatusOption();
  }

  function setHostFairStatus(field, enabled) {
    field.dataset.hsFairSelected = enabled ? '1' : '0';
    field.dataset.hsFairDirty = '1';
    renderHostFairStatus(field);
  }

  function enhanceHostStatus(dialog) {
    if (!state?.features?.fair_use?.enabled || !dialog.querySelector('form [name=remark]')) return;
    const field = findHostStatusField(dialog);
    if (!field) return;
    const id = identifyHost(dialog);
    field.dataset.hsHostId = id;
    field.dataset.hsFairStatusField = '1';
    if (!field.dataset.hsFairReady) {
      field.dataset.hsFairReady = '1';
      field.dataset.hsFairSelected = fairStatusHosts.has(id) ? '1' : '0';
      const combo = field.querySelector('button[role=combobox]');
      combo?.addEventListener('pointerdown', () => { activeHostStatusField = field; requestAnimationFrame(updateFairStatusOption); });
      combo?.addEventListener('click', () => { activeHostStatusField = field; requestAnimationFrame(updateFairStatusOption); });
    } else if (field.dataset.hsFairDirty !== '1') {
      field.dataset.hsFairSelected = fairStatusHosts.has(id) ? '1' : '0';
    }
    renderHostFairStatus(field);
  }

  function updateFairStatusOption() {
    const field = activeHostStatusField;
    if (!field || !document.body.contains(field)) { activeHostStatusField = null; return; }
    const natives = [...document.querySelectorAll('[role=option]')].filter(option =>
      !option.dataset.hsFairStatusOption && /^(active|فعال|disabled|غیرفعال|limited|محدود|expired|منقضی شده|on hold|در انتظار)$/i.test(option.textContent.trim()));
    const native = natives.find(option => option.querySelector('[role=checkbox][data-state="unchecked"]')) || natives[0];
    if (!native) return;
    const parent = native.parentElement;
    if (!parent) return;
    let option = parent.querySelector('[data-hs-fair-status-option]');
    if (!option) {
      option = native.cloneNode(true);
      option.dataset.hsFairStatusOption = '1';
      option.classList.add('hs-fair-status-option');
      option.removeAttribute('id');
      option.removeAttribute('data-disabled');
      option.removeAttribute('aria-disabled');
      option.removeAttribute('disabled');

      const outerIndicator = [...option.children].find(child => child.tagName === 'SPAN' && String(child.className).includes('absolute'));
      outerIndicator?.replaceChildren();
      const content = option.querySelector('div.flex.w-full') || option.querySelector('div');
      let checkbox = content?.querySelector('[role=checkbox]') || option.querySelector('[role=checkbox]');
      const label = content?.querySelector('span.text-sm') || [...option.querySelectorAll('span')].at(-1);
      if (checkbox) {
        checkbox.dataset.hsFairCheckbox = '1';
        checkbox.removeAttribute('disabled');
        checkbox.removeAttribute('data-disabled');
        checkbox.replaceChildren();
        checkbox.dataset.state = 'unchecked';
        checkbox.setAttribute('aria-checked', 'false');
      }
      if (label) label.textContent = 'Fair limited';
      if (content) {
        content.querySelector('.hs-fair-hs-tag')?.remove();
        content.appendChild(hsTagElement());
      } else if (label) {
        label.after(hsTagElement());
      }
      option.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        setHostFairStatus(field, field.dataset.hsFairSelected !== '1');
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
      });
      option.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
      parent.appendChild(option);
    }
    const checked = field.dataset.hsFairSelected === '1';
    option.setAttribute('aria-selected', String(checked));
    option.dataset.hsSelected = checked ? '1' : '0';
    const checkbox = option.querySelector('[data-hs-fair-checkbox]') || option.querySelector('[role=checkbox]');
    if (checkbox) {
      checkbox.setAttribute('aria-checked', String(checked));
      checkbox.dataset.state = checked ? 'checked' : 'unchecked';
      checkbox.replaceChildren();
      if (checked) checkbox.innerHTML = checkIcon();
    }
  }

  function isHostsRoute() {
    return /(^|[\/#])hosts(?:[?#/]|$)/.test(String(location.pathname + location.hash));
  }

  function isUsersRoute() {
    return /(^|[\/#])users(?:[?#/]|$)/.test(String(location.pathname + location.hash));
  }

  function selectedHostGroup() {
    const value = sessionStorage.getItem('hs-host-group') || '';
    return groups.some(group => String(group.id) === value) ? value : '';
  }

  function setSelectedHostGroup(value) {
    if (value) sessionStorage.setItem('hs-host-group', value); else sessionStorage.removeItem('hs-host-group');
    renderHostGroupBar(true);
  }

  function hostRenderedItem(host) {
    const exact = [...document.querySelectorAll('span,div,td')].filter(element => element.textContent.trim() === host.remark);
    for (const element of exact) {
      const row = element.closest('tr');
      if (row) return row;
      let current = element;
      for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
        if (current.classList?.contains('group') && current.classList.contains('relative')) {
          return current.parentElement?.classList?.contains('cursor-default') ? current.parentElement : current;
        }
      }
    }
    return null;
  }

  function applyHostGroupFilter() {
    for (const element of document.querySelectorAll('[data-hs-group-display]')) {
      element.style.display = element.dataset.hsGroupDisplay || '';
      delete element.dataset.hsGroupDisplay;
    }
    if (!isHostsRoute()) return;
    const selected = selectedHostGroup();
    if (!selected) return;
    const group = groups.find(item => String(item.id) === selected);
    const tags = new Set(group?.inbound_tags || []);
    for (const host of hosts) {
      const element = hostRenderedItem(host);
      if (!element || element.hasAttribute('data-hs-group-display')) continue;
      element.dataset.hsGroupDisplay = element.style.display || '';
      if (!tags.has(host.inbound_tag)) element.style.display = 'none';
    }
  }

  function renderHostGroupBar(force = false) {
    let bar = document.getElementById(GROUP_BAR_ID);
    if (!isHostsRoute()) {
      bar?.remove();
      applyHostGroupFilter();
      return;
    }
    const search = [...document.querySelectorAll('input')].find(element => !element.closest('[role=dialog]') && element.placeholder && element.type !== 'number');
    const toolbar = search?.closest('.mb-4');
    if (!toolbar?.parentElement) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = GROUP_BAR_ID;
      bar.className = 'mb-3 flex items-center gap-2 overflow-x-auto rounded-md border bg-card p-2';
      toolbar.parentElement.insertBefore(bar, toolbar);
    }
    const selected = selectedHostGroup();
    const signature = JSON.stringify([selected, groups.map(group => [group.id, group.name, group.inbound_tags || []]), hosts.map(host => [host.id, host.inbound_tag])]);
    if (force || bar.dataset.signature !== signature) {
      bar.dataset.signature = signature;
      bar.replaceChildren();
      const title = document.createElement('span');
      title.className = 'text-muted-foreground shrink-0 px-1 text-xs font-medium';
      title.append('Groups ', hsTagElement());
      bar.appendChild(title);
      const buttonClass = 'inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border px-3 text-sm font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
      const make = (value, label, count) => {
        const button = document.createElement('button');
        button.type = 'button';
        const active = selected === value;
        button.className = buttonClass + (active ? ' border-primary bg-primary text-primary-foreground' : ' border-input bg-background hover:bg-accent hover:text-accent-foreground');
        button.dataset.state = active ? 'on' : 'off';
        button.setAttribute('aria-pressed', String(active));
        button.textContent = `${label} ${count}`;
        button.addEventListener('click', () => setSelectedHostGroup(value));
        return button;
      };
      bar.appendChild(make('', 'All', hosts.length));
      for (const group of groups) {
        const tags = new Set(group.inbound_tags || []);
        const count = hosts.filter(host => tags.has(host.inbound_tag)).length;
        bar.appendChild(make(String(group.id), group.name, count));
      }
    }
    applyHostGroupFilter();
  }

  function badges() {
    for (const row of document.querySelectorAll('tbody tr')) {
      const user = [...users.values()].find(item => [...row.querySelectorAll('span')].some(span => span.textContent === item.username));
      if (!user) continue;
      const badge = row.querySelector('.pointer-events-none.rounded-full');
      if (!badge) continue;
      const previous = row.querySelector('[data-hs-fair-badge]');
      if (user.hs_status === FAIR_STATUS || user.hs_fair_configured === true) {
        if (!badge.hasAttribute('data-hs-original-display')) badge.dataset.hsOriginalDisplay = badge.style.display;
        badge.style.display = 'none';
        if (!previous) {
          const fair = document.createElement('span');
          fair.dataset.hsFairBadge = '1';
          fair.className = 'hs-fair-split-badge';
          const native = badge.cloneNode(true);
          native.removeAttribute('data-hs-original-display');
          native.classList.add('hs-fair-split-native');
          native.style.display = '';
          const limited = document.createElement('span');
          limited.className = 'hs-fair-split-limit';
          const label = document.createElement('span');
          label.textContent = 'Fair Use';
          limited.append(label, hsTagElement());
          fair.append(native, limited);
          badge.after(fair);
        }
      } else {
        badge.style.display = badge.dataset.hsOriginalDisplay || '';
        delete badge.dataset.hsOriginalDisplay;
        previous?.remove();
      }
    }
  }

  function hashParams(url) {
    const rawHash = url.hash.startsWith('#/') ? url.hash.slice(1) : '';
    const index = rawHash.indexOf('?');
    return {path: index >= 0 ? rawHash.slice(0, index) : rawHash, params: new URLSearchParams(index >= 0 ? rawHash.slice(index + 1) : '')};
  }

  function fairFilterSelected() {
    const url = new URL(location.href);
    if (url.searchParams.has('hs_fair_limited')) return true;
    return hashParams(url).params.has('hs_fair_limited');
  }

  function statusChipGroup() {
    const pattern = /^(Active|فعال|Disabled|غیرفعال|Limited|محدود|Expired|منقضی شده|On Hold|در انتظار)$/i;
    for (const group of document.querySelectorAll('div')) {
      if (group.closest('[role=dialog]')) continue;
      const buttons = [...group.children].filter(child => child.tagName === 'BUTTON' && pattern.test(child.textContent.trim()));
      if (buttons.length >= 3) return {group, buttons};
    }
    return null;
  }

  function nativeStatusSelected(button) {
    const className = String(button.className);
    return !className.includes('text-muted-foreground') && !className.includes('bg-transparent');
  }

  function clearNativeStatusSelection() {
    const found = statusChipGroup();
    const selected = found?.buttons.find(nativeStatusSelected);
    if (!selected) return false;
    fairRefreshClick = true;
    selected.click();
    queueMicrotask(() => { fairRefreshClick = false; });
    return true;
  }

  function syncNativeStatusChipsForFair(active) {
    const found = statusChipGroup();
    if (!found) return;
    const {buttons} = found;
    const inactive = buttons.find(button => String(button.className).includes('text-muted-foreground'));
    const inactiveClass = inactive?.className || '';
    for (const button of buttons) {
      if (active) {
        if (inactiveClass) button.className = inactiveClass;
        button.setAttribute('aria-pressed', 'false');
        button.dataset.hsFairMuted = '1';
      } else if (button.dataset.hsFairMuted === '1') {
        if (inactiveClass) button.className = inactiveClass;
        button.setAttribute('aria-pressed', 'false');
        delete button.dataset.hsFairMuted;
      }
    }
  }

  function triggerUsersRefresh() {
    const found = statusChipGroup();
    const isRefresh = button => !button.disabled &&
      (button.querySelector('svg.lucide-refresh-cw') || /refresh/i.test(button.getAttribute('aria-label') || '') || /refresh/i.test(button.title || ''));
    let scope = found?.group || null;
    for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
      const refresh = [...scope.querySelectorAll('button')].find(button => button !== document.getElementById('hs-fair-filter') && isRefresh(button));
      if (refresh) {
        refresh.click();
        return true;
      }
    }
    const fallback = found?.buttons.find(button => /^(Active|فعال)$/i.test(button.textContent.trim())) || found?.buttons[0];
    if (fallback) {
      fairRefreshClick = true;
      fallback.click();
      queueMicrotask(() => { fairRefreshClick = false; });
      return true;
    }
    return false;
  }

  function fairFilterBaseClass(button) {
    return String(button.className).split(/\s+/).filter(token =>
      token && !['text-muted-foreground','bg-transparent'].includes(token) && token !== 'hover:bg-accent').join(' ');
  }

  function styleFairFilterButton(button, active) {
    const base = button.dataset.hsFairBaseClass || fairFilterBaseClass(button);
    button.dataset.hsFairBaseClass = base;
    button.className = `${base} ${active ? 'border-0 bg-orange-500/10 text-orange-700 dark:text-orange-300' : 'text-muted-foreground hover:bg-accent bg-transparent'}`.trim();
    button.setAttribute('aria-pressed', String(active));
    button.dataset.state = active ? 'on' : 'off';
  }

  async function fairUserIds() {
    const payload = await api('/api/users?limit=10000&offset=0&hs_fair_limited=true');
    return [...new Set((payload.users || []).map(user => Number(user.id)).filter(id => Number.isInteger(id) && id > 0))];
  }

  async function setFairFilter(enabled, navigate = true) {
    const oldURL = location.href;
    const url = new URL(oldURL);
    const route = hashParams(url);
    for (const key of ['hs_fair_limited', 'status', 'offset', 'page', 'ids', 'is_id']) route.params.delete(key);
    for (const key of ['hs_fair_limited', 'status', 'offset', 'page', 'ids', 'is_id']) url.searchParams.delete(key);
    if (enabled) {
      let ids = [];
      try { ids = await fairUserIds(); } catch (exc) { error('Fair Use users could not be loaded: ' + exc.message); return false; }
      route.params.set('hs_fair_limited', '1');
      if (ids.length) route.params.set('ids', ids.join(','));
      else { route.params.set('search', '__hs_no_fair_users__'); route.params.delete('ids'); }
    } else {
      route.params.delete('search');
    }
    const query = route.params.toString();
    url.hash = route.path + (query ? '?' + query : '');
    history.replaceState(history.state, '', url.href);
    syncNativeStatusChipsForFair(enabled);
    const button = document.getElementById('hs-fair-filter');
    if (button) styleFairFilterButton(button, enabled);
    if (navigate) {
      window.dispatchEvent(new HashChangeEvent('hashchange', {oldURL, newURL: url.href}));
      requestAnimationFrame(triggerUsersRefresh);
    }
    return true;
  }

  function clearFairFilter(navigate = false) {
    void setFairFilter(false, navigate);
  }

  function userFairFilter() {
    const found = statusChipGroup();
    if (!found) return;
    const {group, buttons} = found;
    let button = document.getElementById('hs-fair-filter');
    const active = fairFilterSelected();
    if (!button) {
      const source = buttons.find(item => String(item.className).includes('text-muted-foreground')) || buttons[0];
      if (!source) return;
      button = source.cloneNode(false);
      button.id = 'hs-fair-filter';
      button.type = 'button';
      button.removeAttribute('disabled');
      button.removeAttribute('data-disabled');
      button.dataset.hsFairBaseClass = fairFilterBaseClass(source);
      const label = document.createElement('span');
      label.textContent = 'Fair Use';
      button.append(label, hsTagElement());
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const enable = !fairFilterSelected();
        if (enable) clearNativeStatusSelection();
        void setFairFilter(enable, true);
      });
      group.appendChild(button);
    }
    styleFairFilterButton(button, active);
    syncNativeStatusChipsForFair(active);
    if (!group.dataset.hsFairCapture) {
      group.dataset.hsFairCapture = '1';
      group.addEventListener('click', event => {
        const native = event.target.closest?.('button');
        if (!fairRefreshClick && native && native.parentElement === group && native.id !== 'hs-fair-filter') clearFairFilter(false);
      }, true);
    }
  }

  function scan() {
    if (state?.features?.fair_use?.enabled) {
      document.querySelectorAll('[role=dialog]').forEach(dialog => {
        hostField(dialog);
        groupField(dialog);
        userField(dialog);
        enhanceHostStatus(dialog);
      });
    }
    renderHostGroupBar();
    updateFairStatusOption();
    if (listEnabled || state?.features?.fair_use?.enabled) {
      badges();
      userFairFilter();
    } else {
      document.querySelectorAll('[data-hs-original-display]').forEach(element => {
        element.style.display = element.dataset.hsOriginalDisplay;
        delete element.dataset.hsOriginalDisplay;
      });
      document.querySelectorAll('#' + HOST_ID + ',#' + GROUP_ID + ',#' + USER_ID + ',#hs-fair-filter,[data-hs-fair-badge],[data-hs-fair-status-badge],[data-hs-fair-status-option]').forEach(element => element.remove());
    }
  }

  function hostSavePending() {
    const policyField = document.querySelector('#' + HOST_ID + '[data-dirty="1"]');
    const statusField = document.querySelector('[data-hs-fair-status-field][data-hs-fair-dirty="1"]');
    if (!policyField && !statusField) return null;
    let policy;
    if (policyField) policy = {present: true, body: policyData(policyField, 'host'), field: policyField};
    const fairStatus = statusField ? {enabled: statusField.dataset.hsFairSelected === '1', field: statusField} : null;
    return {kind: 'host', policy, fairStatus};
  }

  function userSavePending() {
    const field = document.querySelector('#' + USER_ID + '[data-dirty="1"]');
    if (!field) return null;
    return {kind: 'user', policy: {present: true, body: policyData(field, 'user'), field}};
  }

  function refreshUsersAfterFairSave() {
    requestAnimationFrame(triggerUsersRefresh);
    setTimeout(triggerUsersRefresh, 1200);
    setTimeout(triggerUsersRefresh, 10500);
  }

  async function completePending(pending, result) {
    if (!result.id) throw Error((pending.kind === 'group' ? 'Group' : pending.kind === 'user' ? 'User' : 'Host') + ' ID missing from save response');
    if (pending.policy?.present) {
      const resource = pending.kind === 'group' ? 'groups/' : pending.kind === 'user' ? 'users/' : 'hosts/';
      const path = '/api/hs-services/' + resource + result.id + '/fair-use';
      await api(path, pending.policy.body, pending.policy.body ? 'PUT' : 'DELETE');
      pending.policy.field.dataset.dirty = '0';
      if (pending.kind === 'user') {
        pending.policy.field.dataset.userId = String(result.id);
        refreshUsersAfterFairSave();
      }
    }
    if (pending.fairStatus) {
      await api('/api/hs-services/hosts/' + result.id + '/fair-status', {enabled: pending.fairStatus.enabled}, 'PUT');
      pending.fairStatus.field.dataset.hsFairDirty = '0';
      pending.fairStatus.field.dataset.hsHostId = String(result.id);
      if (pending.fairStatus.enabled) fairStatusHosts.add(String(result.id)); else fairStatusHosts.delete(String(result.id));
      syncHostSaveButton(pending.fairStatus.field);
    }
  }

  function boot() {
    injectStyle();
    raw = window.fetch.bind(window);
    window.fetch = async (inputValue, init = {}) => {
      let url = new URL(typeof inputValue === 'string' ? inputValue : inputValue.url, location.origin);
      const method = (init.method || (typeof inputValue === 'string' ? null : inputValue.method) || 'GET').toUpperCase();
      let pending = null;
      const hostMutation = url.origin === location.origin && /\/api\/host(?:\/\d+)?\/?$/.test(url.pathname) && ['POST', 'PUT'].includes(method);
      const groupMutation = url.origin === location.origin && /\/api\/group(?:\/\d+)?\/?$/.test(url.pathname) && ['POST', 'PUT'].includes(method);
      const userMutation = url.origin === location.origin && ((method === 'POST' && url.pathname === '/api/user') ||
        (method === 'PUT' && /^\/api\/user\/(?:by-username\/[^/]+|by-id\/\d+|[^/]+)\/?$/.test(url.pathname)));
      if (hostMutation) {
        try { pending = hostSavePending(); } catch (exc) { error(exc.message); throw exc; }
      }
      if (groupMutation) {
        const field = document.querySelector('#' + GROUP_ID + '[data-dirty="1"]');
        if (field) {
          try { pending = {kind: 'group', policy: {present: true, field, body: policyData(field, 'group')}}; }
          catch (exc) { error(exc.message); throw exc; }
        }
      }
      if (userMutation) {
        try { pending = userSavePending(); } catch (exc) { error(exc.message); throw exc; }
      }
      if (url.origin === location.origin && url.pathname === '/api/users' && fairFilterSelected()) {
        url.searchParams.set('hs_fair_limited', 'true');
        url.searchParams.delete('status');
        inputValue = typeof inputValue === 'string' ? url.href : new Request(url.href, inputValue);
      }
      const response = await raw(inputValue, init);
      if (response.ok && url.origin === location.origin) {
        if (pending) {
          const result = await response.clone().json();
          try { await completePending(pending, result); load(); }
          catch (exc) { error((pending.kind === 'group' ? 'Group' : pending.kind === 'user' ? 'User' : 'Host') + ' saved, but HS status/Fair Use failed: ' + exc.message); }
        }
        if (url.pathname === '/api/users') {
          const payload = await response.clone().json();
          listEnabled = payload.hs_fair_use_enabled === true;
          users.clear();
          for (const user of payload.users || []) users.set(user.username, user);
          requestAnimationFrame(scan);
        }
        if (url.pathname === '/api/groups' || hostMutation || groupMutation || userMutation || (method === 'DELETE' && /\/api\/(?:host|group)\/\d+\/?$/.test(url.pathname))) {
          requestAnimationFrame(load);
        }
      }
      return response;
    };

    let queued = false;
    new MutationObserver(() => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(() => { queued = false; scan(); });
      }
    }).observe(document.body, {childList: true, subtree: true});
    window.addEventListener('hs-plugin-feature-changed', load);
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once: true});
  else boot();
})();
