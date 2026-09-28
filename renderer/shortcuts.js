(function () {
  'use strict';

  const STORAGE_KEY = 'memo-shortcuts';

  const ACTIONS = [
    { id: 'bullet', label: '글머리 기호', def: 'Ctrl+Shift+8' },
    { id: 'number', label: '번호 매기기', def: 'Ctrl+Shift+7' },
    { id: 'checklist', label: '체크리스트', def: 'Ctrl+Shift+9' },
  ];

  // Already claimed by the browser's own editing commands.
  const RESERVED = ['Ctrl+B', 'Ctrl+I', 'Ctrl+U', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A'];

  function load() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (err) {
      saved = {};
    }
    const result = {};
    ACTIONS.forEach((a) => { result[a.id] = saved[a.id] || a.def; });
    return result;
  }

  function save(map) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (err) { /* storage unavailable: shortcuts just fall back to defaults */ }
  }

  // Built from e.code, not e.key: with Shift held, e.key for the 8 key is
  // "*", which would make "Ctrl+Shift+8" impossible to match or record.
  function comboFromEvent(e) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
    let base;
    if (e.code.startsWith('Key')) base = e.code.slice(3);
    else if (e.code.startsWith('Digit')) base = e.code.slice(5);
    else if (e.key.length === 1) base = e.key.toUpperCase();
    else base = e.key;
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    parts.push(base);
    return parts.join('+');
  }

  function isAcceptable(combo) {
    if (!combo) return false;
    if (RESERVED.includes(combo)) return false;
    return combo.startsWith('Ctrl+') || combo.startsWith('Alt+');
  }

  function matches(e, actionId) {
    return comboFromEvent(e) === load()[actionId];
  }

  window.Shortcuts = { ACTIONS, load, save, comboFromEvent, isAcceptable, matches };
})();
