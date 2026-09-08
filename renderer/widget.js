(function () {
  'use strict';

  let folders = [];
  let expanded = false;
  let pinned = false;
  let activeFolderId = null;
  let activePageId = null;
  let leaveTimer = null;
  let saveTimer = null;

  const els = {
    widget: document.getElementById('widget'),
    tabs: document.getElementById('tabs'),
    panel: document.getElementById('panel'),
    dragHandle: document.getElementById('dragHandle'),
    panelColorDot: document.getElementById('panelColorDot'),
    panelTitleInput: document.getElementById('panelTitleInput'),
    panelPageList: document.getElementById('panelPageList'),
    panelBodyInput: document.getElementById('panelBodyInput'),
    panelSaveStatus: document.getElementById('panelSaveStatus'),
    panelEditBtn: document.getElementById('panelEditBtn'),
    panelDeleteBtn: document.getElementById('panelDeleteBtn'),
    pinBtn: document.getElementById('pinBtn'),
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function renderTabs() {
    els.tabs.innerHTML = '';
    folders.forEach((folder) => {
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.style.background = folder.color;
      tab.textContent = folder.title;
      tab.title = folder.title;
      tab.addEventListener('mouseenter', () => showFolder(folder.id));
      tab.addEventListener('click', () => window.api.openFolderInMain(folder.id));
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

  function expand() {
    els.panel.classList.add('visible');
    if (!expanded) {
      expanded = true;
      window.api.setWidgetExpanded(true);
    }
  }

  function collapse() {
    if (!expanded) return;
    expanded = false;
    activeFolderId = null;
    els.panel.classList.remove('visible');
    window.api.setWidgetExpanded(false);
  }

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
    els.panel.classList.remove('visible');
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

  els.pinBtn.addEventListener('click', () => {
    pinned = !pinned;
    els.pinBtn.classList.toggle('active', pinned);
    window.api.setPinned(pinned);
  });

  // ---------- Drag to reposition vertically ----------

  els.dragHandle.addEventListener('mousedown', (e) => {
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
})();
