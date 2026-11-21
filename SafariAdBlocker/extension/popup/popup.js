(function () {
  'use strict';
  const B = globalThis.browser || globalThis.chrome;
  const $ = (id) => document.getElementById(id);
  let tab = null;
  let info = null;

  function render() {
    const paused = info.paused;
    $('site').textContent = info.site || '—';
    $('toggle').checked = !paused;
    $('status').textContent = paused ? 'Paused here' : 'Protecting';
    $('status').classList.toggle('paused', paused);
    $('hidden').textContent = String(info.hidden || 0);
    $('reset').hidden = !info.pickerCount;
    const usable = info.supported;
    $('unsupported').hidden = usable;
    for (const id of ['site-card', 'stats']) $(id).hidden = !usable;
    $('picker').disabled = !usable || paused;
  }

  async function init() {
    [tab] = await B.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    info = await B.runtime.sendMessage({ type: 'getTabState', tabId: tab.id });
    if (info) render();
  }

  $('toggle').addEventListener('change', async (ev) => {
    const paused = !ev.target.checked;
    await B.runtime.sendMessage({ type: 'setPaused', site: info.site, paused });
    info.paused = paused;
    render();
    $('reload-note').hidden = false;
  });

  $('reload').addEventListener('click', () => {
    B.tabs.reload(tab.id);
    window.close();
  });

  $('picker').addEventListener('click', async () => {
    await B.runtime.sendMessage({ type: 'startPicker', tabId: tab.id });
    window.close();
  });

  $('reset').addEventListener('click', async () => {
    await B.runtime.sendMessage({ type: 'resetPicker', host: info.host });
    info.pickerCount = 0;
    render();
    $('reload-note').hidden = false;
  });

  init();
})();
