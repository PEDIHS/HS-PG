(() => {
  'use strict';

  const VERSION = '1.0.0';
  const BUTTON = 'hs-node-ip-toggle';
  const VALUE = 'hs-node-ip-value';
  const MASK = '••••••••••••••';
  const shown = new Set();
  let queued = false;

  const eye = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>';
  const eyeOff = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 18 18"/><path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c6.5 0 10 6 10 6a16.4 16.4 0 0 1-3 3.8M6.5 6.5C3.7 8.1 2 12 2 12s3.5 6 10 6a9.9 9.9 0 0 0 4.1-.9M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  function style() {
    if (document.getElementById('hs-node-ip-fix-style')) return;
    const el = document.createElement('style');
    el.id = 'hs-node-ip-fix-style';
    el.textContent = `
      .${BUTTON}{position:relative!important;z-index:40!important;pointer-events:auto!important;touch-action:manipulation!important;}
      .${BUTTON} *{pointer-events:none!important;}
    `;
    document.head.appendChild(el);
  }

  function stateId(button, span) {
    return String(button?.dataset?.hsIpNodeId || span?.dataset?.hsIpNodeId || '');
  }

  function syncButton(button) {
    if (!(button instanceof HTMLElement)) return;
    const span = button.previousElementSibling;
    if (!(span instanceof HTMLElement) || !span.classList.contains(VALUE)) return;

    const id = stateId(button, span);
    if (!id) return;
    const endpoint = span.dataset.hsRealEndpoint || '';
    if (!endpoint) return;

    const isShown = shown.has(id);
    const desiredText = isShown ? endpoint : MASK;
    if (span.textContent !== desiredText) span.textContent = desiredText;

    const desiredState = isShown ? 'shown' : 'hidden';
    if (button.dataset.hsIpFixState !== desiredState) {
      button.dataset.hsIpFixState = desiredState;
      button.innerHTML = isShown ? eyeOff : eye;
      button.setAttribute('aria-label', isShown ? 'Hide IP address' : 'Show IP address');
      button.title = isShown ? 'Hide IP' : 'Show IP';
    }
  }

  function syncAll() {
    queued = false;
    document.querySelectorAll(`.${BUTTON}`).forEach(syncButton);
  }

  function queueSync() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(syncAll);
  }

  function handleToggle(event) {
    const target = event.target instanceof Element ? event.target.closest(`.${BUTTON}`) : null;
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

    const span = target.previousElementSibling;
    const id = stateId(target, span);
    if (!id) return;

    if (shown.has(id)) shown.delete(id);
    else shown.add(id);
    syncButton(target);
  }

  function start() {
    style();
    document.addEventListener('click', handleToggle, true);
    document.addEventListener('pointerup', event => {
      const target = event.target instanceof Element ? event.target.closest(`.${BUTTON}`) : null;
      if (target) event.stopPropagation();
    }, true);

    const observer = new MutationObserver(queueSync);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    queueSync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.HSNodeIpFix = { version: VERSION, sync: syncAll };
})();