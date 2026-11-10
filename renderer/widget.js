(function () {
  'use strict';

  let folders = [];
  let expanded = false;
  let pinned = false;
  let activeFolderId = null;
  let activePageId = null;
  let leaveTimer = null;
  let saveTimer = null;
  let events = [];
  let showingSchedule = false;
  let quickDayOffset = 0;
  const S = window.Schedule;

  const els = {
    widget: document.getElementById('widget'),
    tabs: document.getElementById('tabs'),
    panel: document.getElementById('panel'),
    schedPanel: document.getElementById('schedPanel'),
    schedList: document.getElementById('schedList'),
    schedToday: document.getElementById('schedToday'),
    schedStatus: document.getElementById('schedStatus'),
    schedPinBtn: document.getElementById('schedPinBtn'),
    schedOpenBtn: document.getElementById('schedOpenBtn'),
    schedDragHandle: document.getElementById('schedDragHandle'),
    quickAdd: document.getElementById('quickAdd'),
    qaTitle: document.getElementById('qaTitle'),
    qaTime: document.getElementById('qaTime'),
    qaDays: document.getElementById('qaDays'),
    dragHandle: document.getElementById('dragHandle'),
    panelColorDot: document.getElementById('panelColorDot'),
    panelTitleInput: document.getElementById('panelTitleInput'),
    panelPageList: document.getElementById('panelPageList'),
    panelBodyInput: document.getElementById('panelBodyInput'),
    panelSaveStatus: document.getElementById('panelSaveStatus'),
    panelEditBtn: document.getElementById('panelEditBtn'),
    panelDeleteBtn: document.getElementById('panelDeleteBtn'),
    pinBtn: document.getElementById('pinBtn'),
    panelBulletBtn: document.getElementById('panelBulletBtn'),
    panelItalicBtn: document.getElementById('panelItalicBtn'),
    panelFontSelect: document.getElementById('panelFontSelect'),
  };

  function nowIso() {
    return new Date().toISOString();
  }

  let draggedFolderId = null;

  function clearDragOverMarks() {
    els.tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('drag-over-top', 'drag-over-bottom'));
  }

  function reorderFolders(sourceId, targetId, dropBefore) {
    const sourceIndex = folders.findIndex((f) => f.id === sourceId);
    if (sourceIndex === -1) return;
    const [moved] = folders.splice(sourceIndex, 1);
    let targetIndex = folders.findIndex((f) => f.id === targetId);
    if (targetIndex === -1) { folders.push(moved); } else {
      folders.splice(dropBefore ? targetIndex : targetIndex + 1, 0, moved);
    }
    renderTabs();
    persist();
  }

  // How many of today's events are still ahead (all-day ones count all day).
  function remainingToday() {
    const now = Date.now();
    return S.eventsOn(events, S.toYmd(new Date())).filter((o) => !S.isTimed(o.event) || o.startMs >= now).length;
  }

  let schedTabEl = null;
  function updateSchedTab() {
    if (!schedTabEl) return;
    const left = remainingToday();
    schedTabEl.textContent = '일정';
    if (left > 0) {
      const badge = document.createElement('span');
      badge.className = 'tab-count';
      badge.textContent = String(left);
      schedTabEl.append(' ', badge);
    }
  }

  function renderTabs() {
    els.tabs.innerHTML = '';

    schedTabEl = document.createElement('div');
    schedTabEl.className = 'tab tab-sched';
    schedTabEl.title = '일정';
    schedTabEl.addEventListener('mouseenter', showSchedule);
    schedTabEl.addEventListener('click', () => window.api.openCalendar({ type: 'show' }));
    updateSchedTab();
    els.tabs.appendChild(schedTabEl);

    folders.forEach((folder) => {
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.style.background = folder.color;
      tab.textContent = folder.title;
      tab.title = folder.title;
      tab.draggable = true;
      tab.addEventListener('mouseenter', () => showFolder(folder.id));
      tab.addEventListener('click', () => window.api.openFolderInMain(folder.id));

      // Tabs double as a reorderable list — native drag-and-drop, not the
      // mousedown/mousemove scheme the drag-handle uses, since a real drag
      // gesture already suppresses the subsequent click on its source
      // element for free, so a plain click still opens the folder.
      tab.addEventListener('dragstart', (e) => {
        draggedFolderId = folder.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', folder.id);
      });
      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        draggedFolderId = null;
        clearDragOverMarks();
      });
      tab.addEventListener('dragover', (e) => {
        if (!draggedFolderId || draggedFolderId === folder.id) return;
        e.preventDefault();
        const rect = tab.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        tab.classList.toggle('drag-over-top', before);
        tab.classList.toggle('drag-over-bottom', !before);
      });
      tab.addEventListener('dragleave', () => {
        tab.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        const before = tab.classList.contains('drag-over-top');
        clearDragOverMarks();
        if (!draggedFolderId || draggedFolderId === folder.id) return;
        reorderFolders(draggedFolderId, folder.id, before);
      });
      els.tabs.appendChild(tab);
    });

    const addTab = document.createElement('div');
    addTab.className = 'tab-add';
    addTab.textContent = '+';
    addTab.title = '새 폴더 만들기';
    addTab.addEventListener('click', () => window.api.requestNewFolder());
    els.tabs.appendChild(addTab);
  }

  function showFolder(id) {
    const folder = folders.find((f) => f.id === id);
    if (!folder) return;
    showingSchedule = false;
    activeFolderId = id;
    if (!activePageId || !folder.pages.find((p) => p.id === activePageId)) {
      activePageId = folder.pages[0] ? folder.pages[0].id : null;
    }
    els.panelColorDot.style.background = folder.color;
    els.panelTitleInput.value = folder.title;
    renderPanelPages(folder);
    showPageContent(folder);
    expand();
  }

  // Folders can hold several pages, but the panel only has room to edit one
  // at a time — this lets you switch between them without opening the full
  // editor. Only shown when there's more than one page to avoid clutter.
  function renderPanelPages(folder) {
    els.panelPageList.innerHTML = '';
    if (!folder || folder.pages.length <= 1) return;
    folder.pages.forEach((page) => {
      const tab = document.createElement('div');
      tab.className = 'panel-page-tab' + (page.id === activePageId ? ' active' : '');
      tab.textContent = page.title || '(제목 없음)';
      tab.title = page.title;
      tab.addEventListener('click', () => {
        activePageId = page.id;
        renderPanelPages(folder);
        showPageContent(folder);
      });
      els.panelPageList.appendChild(tab);
    });
  }

  function showPageContent(folder) {
    const page = folder.pages.find((p) => p.id === activePageId);
    els.panelBodyInput.innerHTML = page ? page.content || '' : '';
  }

  // The memo panel and the schedule panel share the same spot; hovering a tab
  // shows whichever one it belongs to.
  function expand() {
    els.panel.classList.toggle('visible', !showingSchedule);
    els.schedPanel.classList.toggle('visible', showingSchedule);
    if (!expanded) {
      expanded = true;
      els.widget.classList.add('open');
      window.api.setWidgetExpanded(true);
    }
  }

  function hidePanels() {
    els.panel.classList.remove('visible');
    els.schedPanel.classList.remove('visible');
    els.widget.classList.remove('open');
  }

  function collapse() {
    if (!expanded) return;
    expanded = false;
    activeFolderId = null;
    hidePanels();
    window.api.setWidgetExpanded(false);
  }

  // ---------- Schedule panel ----------

  function schedRow(o, today, withDay) {
    const ev = o.event;
    const row = document.createElement('div');
    row.className = 'sched-row' + (o.date === today && S.isTimed(ev) && o.startMs < Date.now() ? ' past' : '');
    row.style.setProperty('--c', ev.color);
    const when = document.createElement('span');
    when.className = 'sched-when';
    when.textContent = (withDay ? S.relativeDayLabel(o.date, today) + ' ' : '') + (S.isTimed(ev) ? ev.time : '종일');
    const name = document.createElement('span');
    name.className = 'sched-name';
    name.textContent = ev.title;
    name.title = ev.title;
    row.append(when, name);
    const icons = (ev.repeat !== 'none' ? '🔁' : '') + (ev.remind.length ? '🔔' : '') + (ev.folderId ? '📂' : '');
    if (icons) {
      const ic = document.createElement('span');
      ic.className = 'sched-icons';
      ic.textContent = icons;
      row.appendChild(ic);
    }
    row.addEventListener('click', () => window.api.openCalendar({ type: 'edit', eventId: ev.id, date: o.date }));
    return row;
  }

  function sectionLabel(text) {
    const el = document.createElement('div');
    el.className = 'sched-section';
    el.textContent = text;
    return el;
  }

  // Only the list is redrawn, never the quick-add form, so a half-typed title
  // survives a refresh.
  function renderSchedule() {
    const today = S.toYmd(new Date());
    els.schedToday.textContent = S.dateLabel(today);
    const list = els.schedList;
    list.innerHTML = '';

    list.appendChild(sectionLabel('오늘'));
    const todays = S.eventsOn(events, today);
    if (!todays.length) {
      const empty = document.createElement('div');
      empty.className = 'sched-empty';
      empty.textContent = '오늘은 일정이 없어요';
      list.appendChild(empty);
    }
    todays.forEach((o) => list.appendChild(schedRow(o, today, false)));

    const later = S.upcoming(events, S.addDays(today, 1), 7).slice(0, 12);
    if (later.length) {
      list.appendChild(sectionLabel('다가오는 일정 (7일)'));
      later.forEach((o) => list.appendChild(schedRow(o, today, true)));
    }
  }

  function showSchedule() {
    showingSchedule = true;
    activeFolderId = null;
    renderSchedule();
    expand();
  }

  function flashSchedStatus(text, isError) {
    els.schedStatus.style.color = isError ? '#b3402f' : '';
    els.schedStatus.textContent = text;
    clearTimeout(flashSchedStatus._t);
    flashSchedStatus._t = setTimeout(() => {
      els.schedStatus.textContent = '';
    }, 1800);
  }

  // "14:30", "1430", "14" or "9" -> "HH:MM"; '' for blank; null when unreadable.
  function parseTimeInput(text) {
    const s = text.trim();
    if (!s) return '';
    const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(s);
    if (!m) return null;
    const h = Number(m[1]);
    const mi = m[2] === undefined ? 0 : Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return S.pad2(h) + ':' + S.pad2(mi);
  }

  async function submitQuickAdd() {
    const title = els.qaTitle.value.trim();
    if (!title) {
      els.qaTitle.focus();
      return;
    }
    const time = parseTimeInput(els.qaTime.value);
    els.qaTime.classList.toggle('invalid', time === null);
    if (time === null) {
      flashSchedStatus('시간은 14:30 처럼 입력해 주세요', true);
      els.qaTime.focus();
      return;
    }
    const base = new Date();
    base.setDate(base.getDate() + quickDayOffset);
    const res = await window.api.upsertEvent({
      title,
      date: S.toYmd(base),
      time,
      repeat: 'none',
      remind: time ? [5] : [0],
    });
    if (!res || !res.ok) {
      flashSchedStatus((res && res.error) || '추가하지 못했어요', true);
      return;
    }
    els.qaTitle.value = '';
    els.qaTime.value = '';
    flashSchedStatus('추가됨');
    await loadEvents();
  }

  els.quickAdd.addEventListener('submit', (e) => {
    e.preventDefault();
    submitQuickAdd();
  });
  els.qaTime.addEventListener('input', () => els.qaTime.classList.remove('invalid'));
  els.qaDays.addEventListener('click', (e) => {
    const btn = e.target.closest('.qa-day');
    if (!btn) return;
    quickDayOffset = Number(btn.dataset.off);
    els.qaDays.querySelectorAll('.qa-day').forEach((b) => b.classList.toggle('on', b === btn));
  });
  els.schedOpenBtn.addEventListener('click', () => window.api.openCalendar({ type: 'show' }));

  async function loadEvents() {
    events = (await window.api.getEvents()) || [];
    updateSchedTab();
    if (showingSchedule) renderSchedule();
  }
  window.api.onEventsChanged(loadEvents);
  // Roll the tab count and "today" over without needing a data change. Only the
  // label is touched — rebuilding the tabs under a resting cursor would re-fire
  // hover and reload the memo panel mid-typing.
  setInterval(() => {
    updateSchedTab();
    if (showingSchedule && expanded) renderSchedule();
  }, 60 * 1000);

  function flashStatus(text) {
    els.panelSaveStatus.style.color = '';
    els.panelSaveStatus.textContent = text;
    clearTimeout(flashStatus._t);
    flashStatus._t = setTimeout(() => {
      els.panelSaveStatus.textContent = '';
    }, 1200);
  }

  let saveRetryTimer = null;

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(attemptSave, 300);
  }

  function attemptSave() {
    window.api.saveData({ folders }).then((result) => {
      if (result && result.ok) {
        clearTimeout(saveRetryTimer);
        saveRetryTimer = null;
        flashStatus('저장됨');
      } else {
        handleSaveFailure();
      }
    }).catch(handleSaveFailure);
  }

  function handleSaveFailure() {
    clearTimeout(flashStatus._t);
    els.panelSaveStatus.style.color = '#b3402f';
    els.panelSaveStatus.textContent = '⚠ 저장 실패 — 재시도 중';
    clearTimeout(saveRetryTimer);
    saveRetryTimer = setTimeout(attemptSave, 3000);
  }

  function getActiveFolder() {
    return folders.find((f) => f.id === activeFolderId) || null;
  }

  els.panelTitleInput.addEventListener('input', () => {
    const folder = getActiveFolder();
    if (!folder) return;
    folder.title = els.panelTitleInput.value.trim() || '제목 없음';
    folder.updatedAt = nowIso();
    renderTabs();
    persist();
    flashStatus('저장됨');
  });

  els.panelBodyInput.addEventListener('input', () => {
    const folder = getActiveFolder();
    if (!folder) return;
    let page = folder.pages.find((p) => p.id === activePageId);
    if (!page) {
      page = { id: Date.now().toString(36), title: '첫 페이지', content: '', updatedAt: nowIso() };
      folder.pages.unshift(page);
      activePageId = page.id;
    }
    page.content = els.panelBodyInput.innerHTML;
    page.updatedAt = nowIso();
    folder.updatedAt = nowIso();
    persist();
    flashStatus('저장 중...');
  });

  // Same attribute-vs-property gotcha as the main editor: toggling a
  // checklist box only flips its live DOM property, so without syncing the
  // `checked` attribute back, saved innerHTML always shows it unchecked.
  els.panelBodyInput.addEventListener('change', (e) => {
    const target = e.target;
    if (!target || target.tagName !== 'INPUT' || target.type !== 'checkbox') return;
    if (target.checked) target.setAttribute('checked', '');
    else target.removeAttribute('checked');
    els.panelBodyInput.dispatchEvent(new Event('input'));
  });

  // Same reasoning as the main editor: never let a rich clipboard paste
  // (Word/HWP/browser) dump megabytes of hidden metadata into notes.json,
  // but a screenshot or copied image has no such baggage — allow those.
  els.panelBodyInput.addEventListener('paste', (e) => {
    const cd = e.clipboardData || window.clipboardData;
    const fileImage = cd.files && Array.from(cd.files).find((f) => f.type && f.type.startsWith('image/'));
    const clipboardItem = cd.items && Array.from(cd.items).find((it) => it.type && it.type.startsWith('image/'));
    const imageFile = fileImage || (clipboardItem && clipboardItem.getAsFile());
    if (imageFile) {
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        document.execCommand('insertImage', false, reader.result);
        els.panelBodyInput.dispatchEvent(new Event('input'));
      };
      reader.readAsDataURL(imageFile);
      return;
    }
    e.preventDefault();
    document.execCommand('insertText', false, cd.getData('text/plain'));
  });

  // ---------- Quick formatting (bullet / italic / font) ----------

  // Same reasoning as the main editor: a bullet toggle marks the current
  // top-level line with a CSS class in place rather than running
  // execCommand('insertUnorderedList'), which rebuilds the line into a real
  // <ul><li> and visibly moves/merges it.
  function getTopLevelBlock(node) {
    while (node && node.parentNode !== els.panelBodyInput) node = node.parentNode;
    return node && node.parentNode === els.panelBodyInput ? node : null;
  }
  function placeCaretAtStart(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function toggleBullet() {
    const sel = window.getSelection();
    const anchor = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    let block = anchor ? getTopLevelBlock(anchor) : null;
    if (!block) {
      block = document.createElement('div');
      block.innerHTML = '<br>';
      els.panelBodyInput.appendChild(block);
      placeCaretAtStart(block);
    }
    block.classList.toggle('list-bullet');
    els.panelBodyInput.dispatchEvent(new Event('input'));
  }

  // A <select> steals focus when it opens, so the selection has to be saved
  // beforehand and restored before acting on it, same as the main editor.
  let savedRange = null;
  function saveSelection() {
    const sel = window.getSelection();
    if (sel.rangeCount) savedRange = sel.getRangeAt(0).cloneRange();
  }
  function restoreSelection() {
    if (!savedRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }

  els.panelBulletBtn.addEventListener('mouseenter', () => {
    if (window.Shortcuts) els.panelBulletBtn.title = '글머리 기호 (' + window.Shortcuts.load().bullet + ')';
  });
  els.panelBulletBtn.addEventListener('mousedown', (e) => e.preventDefault());
  els.panelBulletBtn.addEventListener('click', toggleBullet);

  els.panelItalicBtn.addEventListener('mousedown', (e) => e.preventDefault());
  els.panelItalicBtn.addEventListener('click', () => {
    document.execCommand('italic', false, null);
    els.panelBodyInput.dispatchEvent(new Event('input'));
  });

  els.panelFontSelect.addEventListener('mousedown', saveSelection);
  els.panelFontSelect.addEventListener('focus', saveSelection);
  els.panelFontSelect.addEventListener('change', () => {
    if (!els.panelFontSelect.value) return;
    restoreSelection();
    document.execCommand('fontName', false, els.panelFontSelect.value);
    els.panelBodyInput.dispatchEvent(new Event('input'));
    els.panelFontSelect.value = '';
  });

  // Bold/italic/underline already have Chromium's built-in contenteditable
  // shortcuts (Ctrl+B/I/U) — only the bullet toggle needs its own binding,
  // whose key is user-configurable from the main window's 단축키 settings.
  els.panelBodyInput.addEventListener('keydown', (e) => {
    if (window.Shortcuts && window.Shortcuts.matches(e, 'bullet')) {
      e.preventDefault();
      toggleBullet();
    }
  });

  // ---------- Hover reveal / click-through toggling ----------

  // Interactivity (click-through on/off) is driven from the main process by
  // the same 'widget:hover' signal that expands/collapses the panel — not by
  // this mouseenter/mouseleave pair. mouseenter/mouseleave on a transparent,
  // forwarding window are not reliable enough on their own (this is also why
  // the watchdog exists for collapsing) to gate whether clicks land on us or
  // pass through to whatever is behind — tying it to expand/collapse instead
  // means the panel can never be visibly open yet still click-through.
  els.widget.addEventListener('mouseenter', () => {
    clearTimeout(leaveTimer);
  });

  els.widget.addEventListener('mouseleave', () => {
    if (pinned) return;
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(collapse, 180);
  });

  // Belt-and-suspenders: the main process also watches the real cursor
  // position and force-collapses if a mouseleave event ever gets missed.
  window.api.onForceCollapse(() => {
    clearTimeout(leaveTimer);
    expanded = false;
    activeFolderId = null;
    hidePanels();
  });

  // After the widget hops to another monitor it nudges in from the edge.
  window.api.onArrive(() => {
    els.widget.classList.remove('arrive');
    void els.widget.offsetWidth; // restart the animation if it is already running
    els.widget.classList.add('arrive');
  });

  els.panelEditBtn.addEventListener('click', () => {
    if (activeFolderId) window.api.openFolderInMain(activeFolderId);
  });

  // Quick-delete right from the widget — creating a folder here shouldn't
  // require a trip into the full editor just to undo it.
  els.panelDeleteBtn.addEventListener('click', () => {
    const folder = getActiveFolder();
    if (!folder) return;
    if (!confirm(`"${folder.title}" 폴더를 삭제할까요? 안의 모든 페이지가 함께 삭제됩니다.`)) return;
    folders = folders.filter((f) => f.id !== folder.id);
    window.api.saveData({ folders });
    collapse();
    renderTabs();
  });

  // Both panels carry a pin button; they share one state.
  function togglePinned() {
    pinned = !pinned;
    els.pinBtn.classList.toggle('active', pinned);
    els.schedPinBtn.classList.toggle('active', pinned);
    window.api.setPinned(pinned);
  }
  els.pinBtn.addEventListener('click', togglePinned);
  els.schedPinBtn.addEventListener('click', togglePinned);

  // ---------- Drag to reposition vertically ----------

  [els.dragHandle, els.schedDragHandle].forEach((handle) => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const onMove = (ev) => {
        if (ev.movementY) window.api.dragBy(ev.movementY);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        window.api.dragEnd();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  // ---------- Data sync ----------

  async function load() {
    const data = await window.api.getData();
    const freshFolders = (data && data.folders) || [];
    // The main editor window can save independently too. Adopt the fresh
    // copy for everything except the folder open in our own panel right
    // now, since it may hold an edit that hasn't finished its save debounce
    // yet — otherwise an external change could wipe it out on arrival.
    if (activeFolderId) {
      const activeFolder = folders.find((f) => f.id === activeFolderId);
      if (activeFolder) {
        const idx = freshFolders.findIndex((f) => f.id === activeFolderId);
        if (idx !== -1) freshFolders[idx] = activeFolder;
        else freshFolders.unshift(activeFolder);
      }
    }
    folders = freshFolders;
    renderTabs();
    if (activeFolderId && !folders.find((f) => f.id === activeFolderId)) {
      collapse();
    }
  }

  window.api.onDataChanged(load);

  load();
  loadEvents();
})();
