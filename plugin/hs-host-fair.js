(() => {
  'use strict';

  const HOST_ID = 'hs-host-fair-use';
  const GROUP_ID = 'hs-group-fair-use';
  const GROUP_BAR_ID = 'hs-host-group-bar';
  const FAIR_STATUS = 'fair_limited';
  const input = 'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

  let raw = window.fetch.bind(window);
  let state = null;
  let settings = null;
  let hosts = [];
  let groups = [];
  let loading = false;
  let reloadQueued = false;
  let listEnabled = false;
  let activeHostStatusField = null;
  let fairStatusHosts = new Set();
  const users = new Map();

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
    const mode = kind === 'group' ? (q('mode')?.value || 'always') : 'threshold';
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
    const mode = kind === 'group' ? (q('mode')?.value || 'always') : 'threshold';
    field.dataset.enabled = enabled ? '1' : '0';
    toggle?.setAttribute('aria-checked', String(enabled));
    if (q('gb')) q('gb').disabled = !enabled || mode === 'always';
    for (const name of ['base', 'percent']) if (q(name)) q(name).disabled = !enabled;
    if (q('mode')) q('mode').disabled = !enabled;
    const rate = Number(q('base')?.value || 0) * Number(q('percent')?.value || 0) / 100;
    field.querySelector('[data-rate]').textContent = enabled
      ? `Fair Use enabled · ${Number(q('base').value)} Mbps × ${Number(q('percent').value)}% = ${rate.toFixed(2)} Mbps`
      : 'Fair Use disabled';
  }

  function wire(field, kind) {
    updateField(field, kind);
    field.querySelectorAll('input,select,label').forEach(element => element.addEventListener('click', event => event.stopPropagation()));
    const dirty = () => {
      field.dataset.dirty = '1';
      updateField(field, kind);
      field.querySelector('[data-result]').textContent = 'Will be saved with ' + (kind === 'group' ? 'Group' : 'Host') + '.';
    };
    field.addEventListener('input', dirty);
    field.addEventListener('change', dirty);
  }

  function hostField(dialog) {
    if (dialog.querySelector('#' + HOST_ID)) return;
    const form = dialog.querySelector('form');
    if (!form?.querySelector('[name=remark]')) return;
    const id = identifyHost(dialog), policy = settings?.policies?.[id], shared = settings?.shared_hosts?.[id] || [];
    const field = document.createElement('details');
    field.id = HOST_ID;
    field.dataset.hostId = id;
    field.className = 'rounded-sm border px-4';
    field.innerHTML = `<summary class="flex cursor-pointer items-center gap-2 py-4 text-sm font-medium">Fair Use <span class="hs-gold text-xs">HS</span><span style="margin-inline-start:auto">⌄</span></summary><div class="space-y-4 pb-4"><label class="flex items-center gap-2 text-sm"><input type="checkbox" data-fair="enabled" ${policy?'checked':''}> Enable Fair Use</label><div class="grid gap-3 sm:grid-cols-3"><label class="space-y-2 text-xs">After traffic (GB)<input class="${input}" type="number" min="0.001" step="0.001" data-fair="gb" value="${policy?policy.threshold_bytes/1e9:100}"></label><label class="space-y-2 text-xs">Full speed (Mbps)<input class="${input}" type="number" min="0.1" max="100000" step="0.1" data-fair="base" value="${policy?.baseline_mbps||100}"></label><label class="space-y-2 text-xs">Limited speed (%)<input class="${input}" type="number" min="1" max="100" data-fair="percent" value="${policy?.speed_percent||20}"></label></div><p class="text-muted-foreground text-xs" data-rate></p><p class="text-muted-foreground text-xs">${shared.length>1?`Shared inbound: this policy is automatically identical on all ${shared.length} Hosts using it.`:'This policy belongs to the Host inbound. If another Host uses the same inbound later, it inherits the same policy.'}</p><p class="text-muted-foreground text-xs">Each user's charged traffic is evaluated separately. Resetting that user's traffic restores full speed until the threshold is reached again.</p><p class="text-muted-foreground text-xs">${settings?.enforcement_available?'HS rate adapter connected.':'Node setup required: HS-enabled Xray core and HS service agent.'}</p><p role="status" class="text-xs" data-result>${id?'Changes are saved by the normal Host Save button.':'Create the Host with the normal Save button; Fair Use is saved with it.'}</p></div>`;
    const target = [...form.querySelectorAll('div')].find(element => element.children.length > 1 && String(element.className).includes('overflow-y-auto')) || form;
    target.appendChild(field);
    wire(field, 'host');
  }

  function groupField(dialog) {
    if (dialog.querySelector('#' + GROUP_ID) || !String(location.pathname + location.hash).includes('groups')) return;
    const form = dialog.querySelector('form');
    if (!form?.querySelector('[name=name]') || form.querySelector('[name=remark]')) return;
    const id = identifyGroup(dialog), policy = settings?.group_policies?.[id];
    const field = document.createElement('details');
    field.id = GROUP_ID;
    field.dataset.groupId = id;
    field.className = 'rounded-sm border px-4';
    field.innerHTML = `<summary class="flex cursor-pointer items-center gap-2 py-4 text-sm font-medium">Fair Use <span class="hs-gold text-xs">HS</span><span style="margin-inline-start:auto">⌄</span></summary><div class="space-y-4 pb-4"><label class="flex items-center gap-2 text-sm"><input type="checkbox" data-fair="enabled" ${policy?'checked':''}> Limit users in this Group</label><div class="grid gap-3 sm:grid-cols-4"><label class="space-y-2 text-xs">Mode<select class="${input}" data-fair="mode"><option value="always" ${policy?.mode==='always'?'selected':''}>Always</option><option value="threshold" ${policy?.mode==='threshold'?'selected':''}>After usage</option></select></label><label class="space-y-2 text-xs">Traffic (GB)<input class="${input}" type="number" min="0.001" step="0.001" data-fair="gb" value="${policy?.mode==='threshold'?policy.threshold_bytes/1e9:100}"></label><label class="space-y-2 text-xs">Full speed (Mbps)<input class="${input}" type="number" min="0.1" max="100000" step="0.1" data-fair="base" value="${policy?.baseline_mbps||100}"></label><label class="space-y-2 text-xs">Limited speed (%)<input class="${input}" type="number" min="1" max="100" data-fair="percent" value="${policy?.speed_percent||33}"></label></div><p class="text-muted-foreground text-xs" data-rate></p><p class="text-muted-foreground text-xs">Always applies the cap immediately. After usage applies it only after each user's own charged traffic reaches the threshold.</p><p class="text-muted-foreground text-xs">The Group policy applies to every inbound assigned to this Group. If Host and Group policies overlap, the strictest active speed cap wins.</p><p role="status" class="text-xs" data-result>${id?'Changes are saved by the normal Group Save button.':'Create the Group with the normal Save button; Fair Use is saved with it.'}</p></div>`;
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
        badge.append('Fair limited');
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
    const native = [...document.querySelectorAll('[role=option]')].find(option =>
      !option.dataset.hsFairStatusOption && /^(active|فعال|disabled|غیرفعال|limited|محدود|expired|منقضی شده|on hold|در انتظار)$/i.test(option.textContent.trim()));
    if (!native) return;
    const parent = native.parentElement;
    if (!parent) return;
    let option = parent.querySelector('[data-hs-fair-status-option]');
    if (!option) {
      option = native.cloneNode(true);
      option.dataset.hsFairStatusOption = '1';
      option.removeAttribute('id');
      option.removeAttribute('data-disabled');
      option.removeAttribute('aria-disabled');
      option.removeAttribute('disabled');
      const label = option.querySelector('span.text-sm') || [...option.querySelectorAll('span')].at(-1);
      if (label) label.textContent = 'Fair limited'; else option.textContent = 'Fair limited';
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
    option.dataset.state = checked ? 'checked' : 'unchecked';
    const checkbox = option.querySelector('[role=checkbox]');
    if (checkbox) {
      checkbox.setAttribute('aria-checked', String(checked));
      checkbox.dataset.state = checked ? 'checked' : 'unchecked';
    }
  }

  function isHostsRoute() {
    return /(^|[\/#])hosts(?:[?#/]|$)/.test(String(location.pathname + location.hash));
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
      title.textContent = 'Groups';
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
      if (user.hs_status === FAIR_STATUS) {
        if (!badge.hasAttribute('data-hs-original-display')) badge.dataset.hsOriginalDisplay = badge.style.display;
        badge.style.display = 'none';
        if (!previous) {
          const fair = badge.cloneNode(true);
          fair.removeAttribute('data-hs-original-display');
          fair.dataset.hsFairBadge = '1';
          fair.style.display = '';
          fair.textContent = 'Fair limited';
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

  function setFairFilter(enabled, navigate = true) {
    const url = new URL(location.href);
    if (url.hash.startsWith('#/')) {
      const route = hashParams(url);
      url.searchParams.delete('hs_fair_limited');
      if (enabled) route.params.set('hs_fair_limited', '1'); else route.params.delete('hs_fair_limited');
      for (const key of ['status', 'offset', 'page']) route.params.delete(key);
      const query = route.params.toString();
      url.hash = route.path + (query ? '?' + query : '');
    } else {
      if (enabled) url.searchParams.set('hs_fair_limited', '1'); else url.searchParams.delete('hs_fair_limited');
      for (const key of ['status', 'offset', 'page']) url.searchParams.delete(key);
    }
    if (navigate) location.assign(url.href); else history.replaceState(history.state, '', url.href);
  }

  function clearFairFilter(navigate = false) {
    setFairFilter(false, navigate);
    const button = document.getElementById('hs-fair-filter');
    if (button) { button.setAttribute('aria-pressed', 'false'); button.dataset.state = 'off'; }
  }

  function userFairFilter() {
    const existing = document.getElementById('hs-fair-filter');
    if (existing) {
      const active = fairFilterSelected();
      existing.setAttribute('aria-pressed', String(active));
      existing.dataset.state = active ? 'on' : 'off';
      return;
    }
    const activeButton = [...document.querySelectorAll('button')].find(button =>
      /^(Active|فعال)$/i.test(button.textContent.trim()) && button.parentElement?.querySelectorAll(':scope>button').length >= 5);
    if (!activeButton) return;
    const group = activeButton.parentElement;
    const button = activeButton.cloneNode(true);
    button.id = 'hs-fair-filter';
    button.type = 'button';
    button.textContent = 'Fair limited';
    button.removeAttribute('disabled');
    button.removeAttribute('data-disabled');
    const active = fairFilterSelected();
    button.setAttribute('aria-pressed', String(active));
    button.dataset.state = active ? 'on' : 'off';
    button.onclick = event => { event.preventDefault(); event.stopPropagation(); setFairFilter(!fairFilterSelected(), true); };
    if (!group.dataset.hsFairCapture) {
      group.dataset.hsFairCapture = '1';
      group.addEventListener('click', event => {
        const native = event.target.closest('button');
        if (native && native.parentElement === group && native.id !== 'hs-fair-filter') clearFairFilter(false);
      }, true);
    }
    group.appendChild(button);
  }

  function scan() {
    if (state?.features?.fair_use?.enabled) {
      document.querySelectorAll('[role=dialog]').forEach(dialog => {
        hostField(dialog);
        groupField(dialog);
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
      document.querySelectorAll('#' + HOST_ID + ',#' + GROUP_ID + ',#hs-fair-filter,[data-hs-fair-badge],[data-hs-fair-status-badge],[data-hs-fair-status-option]').forEach(element => element.remove());
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

  async function completePending(pending, result) {
    if (!result.id) throw Error((pending.kind === 'group' ? 'Group' : 'Host') + ' ID missing from save response');
    if (pending.policy?.present) {
      const path = '/api/hs-services/' + (pending.kind === 'group' ? 'groups/' : 'hosts/') + result.id + '/fair-use';
      await api(path, pending.policy.body, pending.policy.body ? 'PUT' : 'DELETE');
      pending.policy.field.dataset.dirty = '0';
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
    raw = window.fetch.bind(window);
    window.fetch = async (inputValue, init = {}) => {
      let url = new URL(typeof inputValue === 'string' ? inputValue : inputValue.url, location.origin);
      const method = (init.method || (typeof inputValue === 'string' ? null : inputValue.method) || 'GET').toUpperCase();
      let pending = null;
      const hostMutation = url.origin === location.origin && /\/api\/host(?:\/\d+)?\/?$/.test(url.pathname) && ['POST', 'PUT'].includes(method);
      const groupMutation = url.origin === location.origin && /\/api\/group(?:\/\d+)?\/?$/.test(url.pathname) && ['POST', 'PUT'].includes(method);
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
          catch (exc) { error((pending.kind === 'group' ? 'Group' : 'Host') + ' saved, but HS status/Fair Use failed: ' + exc.message); }
        }
        if (url.pathname === '/api/users') {
          const payload = await response.clone().json();
          listEnabled = payload.hs_fair_use_enabled === true;
          users.clear();
          for (const user of payload.users || []) users.set(user.username, user);
          requestAnimationFrame(scan);
        }
        if (url.pathname === '/api/groups' || hostMutation || groupMutation || (method === 'DELETE' && /\/api\/(?:host|group)\/\d+\/?$/.test(url.pathname))) {
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
