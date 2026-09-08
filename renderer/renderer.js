(function () {
  'use strict';

  const CARD_H = 132;
  const STEP_Y = 42; // also the height of the peeking tab strip
  const LEFT_STEP = 12; // horizontal stagger per depth
  const BASE_RIGHT = 0;

  const COLORS = ['#f4c869', '#a9d8b6', '#a7c8ec', '#f0a8a8', '#d3aee6', '#f2caa0'];

  let state = { folders: [] };
  let currentFolderId = null;
  let currentPageId = null;
  let saveTimer = null;
  let statusTimer = null;

  const els = {
    stackView: document.getElementById('stackView'),
    folderView: document.getElementById('folderView'),
    folderStack: document.getElementById('folderStack'),
    emptyHint: document.getElementById('emptyHint'),
    searchInput: document.getElementById('searchInput'),
    calcBtn: document.getElementById('calcBtn'),
    newFolderBtn: document.getElementById('newFolderBtn'),
    backBtn: document.getElementById('backBtn'),
    folderTitleInput: document.getElementById('folderTitleInput'),
    colorSwatches: document.getElementById('colorSwatches'),
    deleteFolderBtn: document.getElementById('deleteFolderBtn'),
    pageList: document.getElementById('pageList'),
    addPageBtn: document.getElementById('addPageBtn'),
    pageTitleInput: document.getElementById('pageTitleInput'),
    pageContentInput: document.getElementById('pageContentInput'),
    deletePageBtn: document.getElementById('deletePageBtn'),
    saveStatus: document.getElementById('saveStatus'),
    tooltip: document.getElementById('tooltip'),
    rteToolbar: document.getElementById('rteToolbar'),
    fontFamilySelect: document.getElementById('fontFamilySelect'),
    fontSizeSelect: document.getElementById('fontSizeSelect'),
    clearFormatBtn: document.getElementById('clearFormatBtn'),
    textColorInput: document.getElementById('textColorInput'),
    highlightColorInput: document.getElementById('highlightColorInput'),
    removeHighlightBtn: document.getElementById('removeHighlightBtn'),
    listStyleSelect: document.getElementById('listStyleSelect'),
    bulletBtn: document.getElementById('bulletBtn'),
    numberBtn: document.getElementById('numberBtn'),
    checklistBtn: document.getElementById('checklistBtn'),
    linkBtn: document.getElementById('linkBtn'),
    imageBtn: document.getElementById('imageBtn'),
    imageFileInput: document.getElementById('imageFileInput'),
    tableBtn: document.getElementById('tableBtn'),
    tableBorderColorInput: document.getElementById('tableBorderColorInput'),
    calcSelBtn: document.getElementById('calcSelBtn'),
    calcSendBtn: document.getElementById('calcSendBtn'),
    attachBtn: document.getElementById('attachBtn'),
    attachmentFileInput: document.getElementById('attachmentFileInput'),
    attachmentList: document.getElementById('attachmentList'),
    modalOverlay: document.getElementById('modalOverlay'),
    modalTitle: document.getElementById('modalTitle'),
    modalInput: document.getElementById('modalInput'),
    modalTextarea: document.getElementById('modalTextarea'),
    modalCopyBtn: document.getElementById('modalCopyBtn'),
    modalCopyStatus: document.getElementById('modalCopyStatus'),
    modalCancelBtn: document.getElementById('modalCancelBtn'),
    modalOkBtn: document.getElementById('modalOkBtn'),
  };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return `오늘 ${hh}:${mm}`;
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  }

  function summarize(text, max) {
    if (!text) return '';
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    return flat.slice(0, max) + '…';
  }

  // Page content is stored as HTML (rich text); previews/search need the
  // plain-text version so tags never leak into a summary line.
  const stripHtmlScratch = document.createElement('div');
  function stripHtml(html) {
    if (!html) return '';
    stripHtmlScratch.innerHTML = html;
    return stripHtmlScratch.textContent || '';
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  }

  function newPage(title) {
    return { id: uid(), title: title || '새 페이지', content: '', attachments: [], updatedAt: nowIso() };
  }

  function newFolder() {
    const color = COLORS[state.folders.length % COLORS.length];
    return {
      id: uid(),
      title: '새 폴더',
      color,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      pages: [newPage('첫 페이지')],
    };
  }

  let saveRetryTimer = null;

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(attemptSave, 300);
  }

  function attemptSave() {
    window.api.saveData(state).then((result) => {
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
    clearTimeout(statusTimer);
    els.saveStatus.style.color = 'var(--danger)';
    els.saveStatus.textContent = '⚠ 저장 실패 — 잠시 후 다시 시도합니다';
    clearTimeout(saveRetryTimer);
    saveRetryTimer = setTimeout(attemptSave, 3000);
  }

  function flashStatus(text) {
    els.saveStatus.style.color = '';
    els.saveStatus.textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      els.saveStatus.textContent = '';
    }, 1500);
  }

  // ---------- Stack view ----------

  function renderStack() {
    const query = els.searchInput.value.trim().toLowerCase();
    let list = state.folders;
    if (query) {
      list = state.folders.filter((f) => {
        if (f.title.toLowerCase().includes(query)) return true;
        return f.pages.some((p) => p.title.toLowerCase().includes(query) || stripHtml(p.content).toLowerCase().includes(query));
      });
    }

    els.folderStack.innerHTML = '';
    els.emptyHint.hidden = state.folders.length > 0;
    els.emptyHint.textContent = query && list.length === 0
      ? '검색 결과가 없습니다.'
      : '아직 폴더가 없습니다. "+ 새 폴더"로 시작해 보세요.';
    if (query) els.emptyHint.hidden = list.length > 0;

    const n = list.length;
    const totalHeight = n > 0 ? (n - 1) * STEP_Y + CARD_H : 0;
    els.folderStack.style.height = totalHeight + 'px';

    list.forEach((folder, i) => {
      const card = document.createElement('div');
      card.className = 'folder-card' + (i === 0 ? ' is-front' : '');
      card.style.top = i * STEP_Y + 'px';
      card.style.left = i * LEFT_STEP + 'px';
      card.style.right = BASE_RIGHT + 'px';
      card.style.height = CARD_H + 'px';
      card.style.zIndex = String(n - i);
      card.style.background = folder.color;

      const firstPage = folder.pages[0];
      const preview = summarize(stripHtml(firstPage ? firstPage.content : ''), 90) || '내용 없음';

      const main = document.createElement('div');
      main.className = 'card-main';
      main.innerHTML = `
        <div class="card-title"></div>
        <div class="card-preview"></div>
        <div class="card-meta"></div>
      `;
      main.querySelector('.card-title').textContent = folder.title;
      main.querySelector('.card-preview').textContent = preview;
      main.querySelector('.card-meta').textContent =
        `${folder.pages.length}개 페이지 · ${formatTime(folder.updatedAt)}`;

      const tab = document.createElement('div');
      tab.className = 'tab-strip';
      tab.style.height = STEP_Y + 'px';
      tab.innerHTML = `
        <span class="tab-title"></span>
        <span class="tab-summary"></span>
        <span class="tab-count"></span>
        <button class="tab-delete" title="폴더 삭제">×</button>
      `;
      tab.querySelector('.tab-title').textContent = folder.title;
      tab.querySelector('.tab-summary').textContent = preview;
      tab.querySelector('.tab-count').textContent = `${folder.pages.length}p`;

      tab.querySelector('.tab-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteFolder(folder.id);
      });

      card.appendChild(main);
      card.appendChild(tab);

      card.addEventListener('click', () => openFolder(folder.id));
      card.addEventListener('mouseenter', (e) => showTooltip(folder, e));
      card.addEventListener('mousemove', moveTooltip);
      card.addEventListener('mouseleave', hideTooltip);

      els.folderStack.appendChild(card);
    });
  }

  function showTooltip(folder, e) {
    const firstPage = folder.pages[0];
    const preview = summarize(stripHtml(firstPage ? firstPage.content : ''), 140) || '내용 없음';
    els.tooltip.innerHTML = `
      <div class="tt-title"></div>
      <div class="tt-preview"></div>
      <div class="tt-meta"></div>
    `;
    els.tooltip.querySelector('.tt-title').textContent = folder.title;
    els.tooltip.querySelector('.tt-preview').textContent = preview;
    els.tooltip.querySelector('.tt-meta').textContent =
      `${folder.pages.length}개 페이지 · 마지막 수정 ${formatTime(folder.updatedAt)}`;
    els.tooltip.hidden = false;
    moveTooltip(e);
  }

  function moveTooltip(e) {
    if (els.tooltip.hidden) return;
    const pad = 16;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const rect = els.tooltip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - pad;
    els.tooltip.style.left = x + 'px';
    els.tooltip.style.top = y + 'px';
  }

  function hideTooltip() {
    els.tooltip.hidden = true;
  }

  // ---------- Folder detail view ----------

  function openFolder(id) {
    const idx = state.folders.findIndex((f) => f.id === id);
    if (idx === -1) return;
    const [folder] = state.folders.splice(idx, 1);
    folder.updatedAt = nowIso();
    state.folders.unshift(folder);
    currentFolderId = folder.id;
    currentPageId = folder.pages[0] ? folder.pages[0].id : null;
    persist();
    showView('folder');
    renderFolderView();
  }

  function getCurrentFolder() {
    return state.folders.find((f) => f.id === currentFolderId) || null;
  }

  function renderFolderView() {
    const folder = getCurrentFolder();
    if (!folder) {
      showView('stack');
      return;
    }

    els.folderTitleInput.value = folder.title;

    els.colorSwatches.innerHTML = '';
    COLORS.forEach((c) => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (c === folder.color ? ' selected' : '');
      sw.style.background = c;
      sw.addEventListener('click', () => {
        folder.color = c;
        folder.updatedAt = nowIso();
        persist();
        renderFolderView();
      });
      els.colorSwatches.appendChild(sw);
    });

    if (!folder.pages.find((p) => p.id === currentPageId)) {
      currentPageId = folder.pages[0] ? folder.pages[0].id : null;
    }

    els.pageList.innerHTML = '';
    folder.pages.forEach((page) => {
      const item = document.createElement('div');
      item.className = 'page-item' + (page.id === currentPageId ? ' active' : '');
      item.innerHTML = `
        <div class="pi-title"></div>
        <div class="pi-preview"></div>
      `;
      item.querySelector('.pi-title').textContent = page.title || '(제목 없음)';
      item.querySelector('.pi-preview').textContent = summarize(stripHtml(page.content), 40) || '내용 없음';
      item.addEventListener('click', () => {
        currentPageId = page.id;
        renderFolderView();
      });
      els.pageList.appendChild(item);
    });

    const page = folder.pages.find((p) => p.id === currentPageId);
    els.pageTitleInput.value = page ? page.title : '';
    els.pageContentInput.innerHTML = page ? page.content || '' : '';
    els.pageTitleInput.disabled = !page;
    els.pageContentInput.contentEditable = page ? 'true' : 'false';
    els.deletePageBtn.disabled = folder.pages.length <= 1;
    renderAttachments(page);
  }

  function isImageAttachment(name) {
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
  }

  function bindAttachmentRemove(btn, att, page) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`"${att.name}" 첨부를 삭제할까요?`)) return;
      await window.api.removeAttachment(att.storedName);
      page.attachments = (page.attachments || []).filter((a) => a.storedName !== att.storedName);
      persist();
      renderAttachments(page);
    });
  }

  function renderAttachments(page) {
    els.attachmentList.innerHTML = '';
    if (!page) return;
    (page.attachments || []).forEach((att) => {
      const chip = document.createElement('div');
      chip.addEventListener('click', () => window.api.openAttachment(att.storedName));

      if (isImageAttachment(att.name)) {
        chip.className = 'attachment-chip attachment-chip-image';
        chip.title = `${att.name} (${formatFileSize(att.size || 0)})`;
        chip.innerHTML = `<img class="att-thumb" alt="" /><span class="att-remove">×</span>`;
        const imgEl = chip.querySelector('.att-thumb');
        window.api.readAttachmentDataUrl(att.storedName).then((url) => {
          if (url) imgEl.src = url;
        });
        bindAttachmentRemove(chip.querySelector('.att-remove'), att, page);
      } else {
        chip.className = 'attachment-chip';
        chip.title = att.name;
        chip.innerHTML = `
          <span>📎</span>
          <span class="att-name"></span>
          <span class="att-size"></span>
          <span class="att-remove">×</span>
        `;
        chip.querySelector('.att-name').textContent = att.name;
        chip.querySelector('.att-size').textContent = formatFileSize(att.size || 0);
        bindAttachmentRemove(chip.querySelector('.att-remove'), att, page);
      }

      els.attachmentList.appendChild(chip);
    });
  }

  function deleteFolder(id) {
    const folder = state.folders.find((f) => f.id === id);
    if (!folder) return;
    if (!confirm(`"${folder.title}" 폴더를 삭제할까요? 안의 모든 페이지가 함께 삭제됩니다.`)) return;
    state.folders = state.folders.filter((f) => f.id !== id);
    if (currentFolderId === id) {
      currentFolderId = null;
      showView('stack');
    }
    persist();
    renderStack();
  }

  // ---------- View switching ----------

  function showView(view) {
    if (view === 'stack') {
      els.stackView.hidden = false;
      els.folderView.hidden = true;
      renderStack();
    } else {
      els.stackView.hidden = true;
      els.folderView.hidden = false;
    }
  }

  // ---------- Events ----------

  els.newFolderBtn.addEventListener('click', () => {
    const folder = newFolder();
    state.folders.unshift(folder);
    currentFolderId = folder.id;
    currentPageId = folder.pages[0].id;
    persist();
    showView('folder');
    renderFolderView();
    els.folderTitleInput.focus();
    els.folderTitleInput.select();
  });

  els.backBtn.addEventListener('click', () => {
    currentFolderId = null;
    showView('stack');
  });

  els.folderTitleInput.addEventListener('input', () => {
    const folder = getCurrentFolder();
    if (!folder) return;
    folder.title = els.folderTitleInput.value.trim() || '제목 없음';
    folder.updatedAt = nowIso();
    persist();
    flashStatus('저장됨');
  });

  els.deleteFolderBtn.addEventListener('click', () => {
    if (currentFolderId) deleteFolder(currentFolderId);
  });

  els.addPageBtn.addEventListener('click', () => {
    const folder = getCurrentFolder();
    if (!folder) return;
    const page = newPage();
    folder.pages.push(page);
    folder.updatedAt = nowIso();
    currentPageId = page.id;
    persist();
    renderFolderView();
    els.pageTitleInput.focus();
    els.pageTitleInput.select();
  });

  els.deletePageBtn.addEventListener('click', () => {
    const folder = getCurrentFolder();
    if (!folder || folder.pages.length <= 1) return;
    if (!confirm('이 페이지를 삭제할까요?')) return;
    folder.pages = folder.pages.filter((p) => p.id !== currentPageId);
    folder.updatedAt = nowIso();
    currentPageId = folder.pages[0].id;
    persist();
    renderFolderView();
  });

  els.pageTitleInput.addEventListener('input', () => {
    const folder = getCurrentFolder();
    const page = folder && folder.pages.find((p) => p.id === currentPageId);
    if (!page) return;
    page.title = els.pageTitleInput.value;
    page.updatedAt = nowIso();
    folder.updatedAt = nowIso();
    persist();
    flashStatus('저장 중...');
  });

  els.pageContentInput.addEventListener('input', () => {
    const folder = getCurrentFolder();
    const page = folder && folder.pages.find((p) => p.id === currentPageId);
    if (!page) return;
    page.content = els.pageContentInput.innerHTML;
    page.updatedAt = nowIso();
    folder.updatedAt = nowIso();
    persist();
    flashStatus('저장 중...');
    // live-update the page list preview without losing focus
    const activeItem = els.pageList.querySelector('.page-item.active .pi-preview');
    if (activeItem) activeItem.textContent = summarize(stripHtml(page.content), 40) || '내용 없음';
  });

  // Checking a checklist box only flips its live DOM property, not the
  // `checked` HTML attribute — and saving serializes innerHTML, which only
  // ever reflects the attribute. Without this, every checked box reverts to
  // unchecked the moment the content is reloaded from storage.
  els.pageContentInput.addEventListener('change', (e) => {
    const target = e.target;
    if (!target || target.tagName !== 'INPUT' || target.type !== 'checkbox') return;
    if (target.checked) target.setAttribute('checked', '');
    else target.removeAttribute('checked');
    els.pageContentInput.dispatchEvent(new Event('input'));
  });

  // Pasting from Word/HWP/browsers can carry megabytes of hidden metadata
  // in HTML comments and style blocks (invisible, but it all lands in
  // notes.json), so rich HTML paste is intentionally not used. A screenshot
  // or copied image, though, has no such baggage — paste those as an image.
  els.pageContentInput.addEventListener('paste', (e) => {
    const cd = e.clipboardData || window.clipboardData;

    // A file copied from Explorer (Ctrl+C there, Ctrl+V here) arrives as a
    // real File with a path: images go inline, anything else becomes an
    // attachment chip — same as using the 📎/🖼 buttons.
    if (cd.files && cd.files.length > 0) {
      e.preventDefault();
      const nonImageFiles = [];
      Array.from(cd.files).forEach((file) => {
        if (file.type && file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = () => {
            document.execCommand('insertImage', false, reader.result);
            afterCommand();
          };
          reader.readAsDataURL(file);
        } else {
          nonImageFiles.push(file);
        }
      });
      if (nonImageFiles.length) attachFiles(nonImageFiles);
      return;
    }

    // A screenshot / copied bitmap (no real file on disk) shows up as a
    // clipboard item instead.
    const imageItem = cd.items && Array.from(cd.items).find((it) => it.type && it.type.startsWith('image/'));
    if (imageItem) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      const reader = new FileReader();
      reader.onload = () => {
        document.execCommand('insertImage', false, reader.result);
        afterCommand();
      };
      reader.readAsDataURL(file);
      return;
    }

    // Anything else (Word/HWP/browser rich text) — strip to plain text so
    // hidden metadata never bloats notes.json.
    e.preventDefault();
    document.execCommand('insertText', false, cd.getData('text/plain'));
  });

  els.searchInput.addEventListener('input', renderStack);

  els.calcBtn.addEventListener('click', () => window.api.openCalculator());

  // ---------- Rich text toolbar ----------
  // Uses the classic contenteditable + execCommand approach: still fully
  // supported by the Chromium version Electron ships, and far simpler than
  // wiring up a full editor library for this feature set.

  let savedRange = null;
  function saveSelection() {
    const sel = window.getSelection();
    if (sel.rangeCount > 0 && els.pageContentInput.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  }
  function restoreSelection() {
    if (!savedRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }
  els.pageContentInput.addEventListener('mouseup', saveSelection);
  els.pageContentInput.addEventListener('keyup', saveSelection);

  function afterCommand() {
    els.pageContentInput.focus();
    els.pageContentInput.dispatchEvent(new Event('input'));
  }

  // Electron's BrowserWindow does not implement window.prompt() — it
  // silently returns null with no dialog ever shown (window.alert/confirm
  // do work, prompt does not), which made every prompt()-based feature look
  // like a dead button. This is a real in-app replacement.
  function showPrompt(title, defaultValue) {
    return new Promise((resolve) => {
      els.modalTitle.textContent = title;
      els.modalInput.value = defaultValue || '';
      els.modalInput.hidden = false;
      els.modalTextarea.hidden = true;
      els.modalCopyBtn.hidden = true;
      els.modalCopyStatus.textContent = '';
      els.modalCancelBtn.hidden = false;
      els.modalOverlay.hidden = false;
      els.modalInput.focus();
      els.modalInput.select();

      function cleanup(result) {
        els.modalOverlay.hidden = true;
        els.modalOkBtn.removeEventListener('click', onOk);
        els.modalCancelBtn.removeEventListener('click', onCancel);
        els.modalInput.removeEventListener('keydown', onKeydown);
        resolve(result);
      }
      function onOk() {
        cleanup(els.modalInput.value.trim());
      }
      function onCancel() {
        cleanup(null);
      }
      function onKeydown(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          onOk();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }
      els.modalOkBtn.addEventListener('click', onOk);
      els.modalCancelBtn.addEventListener('click', onCancel);
      els.modalInput.addEventListener('keydown', onKeydown);
    });
  }

  // Shows read-only, selectable text with a one-click copy button — used
  // where alert() would technically "work" but its native OS message box
  // text usually isn't selectable, so there was no way to actually copy it.
  function showResult(title, text) {
    return new Promise((resolve) => {
      els.modalTitle.textContent = title;
      els.modalInput.hidden = true;
      els.modalTextarea.hidden = false;
      els.modalTextarea.value = text;
      els.modalCopyBtn.hidden = false;
      els.modalCopyStatus.textContent = '';
      els.modalCancelBtn.hidden = true;
      els.modalOverlay.hidden = false;
      els.modalOkBtn.textContent = '닫기';
      els.modalTextarea.focus();
      els.modalTextarea.select();

      function onCopy() {
        els.modalTextarea.select();
        document.execCommand('copy');
        els.modalCopyStatus.textContent = '복사됨';
      }
      function cleanup() {
        els.modalOverlay.hidden = true;
        els.modalOkBtn.textContent = '확인';
        els.modalOkBtn.removeEventListener('click', onOk);
        els.modalCopyBtn.removeEventListener('click', onCopy);
        resolve();
      }
      function onOk() {
        cleanup();
      }
      els.modalOkBtn.addEventListener('click', onOk);
      els.modalCopyBtn.addEventListener('click', onCopy);
    });
  }

  // Plain buttons: prevent the mousedown from stealing focus so the
  // current text selection survives long enough for execCommand to see it.
  els.rteToolbar.querySelectorAll('button[data-cmd]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      document.execCommand(btn.dataset.cmd, false, null);
      afterCommand();
    });
  });

  els.clearFormatBtn.addEventListener('mousedown', (e) => e.preventDefault());
  els.clearFormatBtn.addEventListener('click', () => {
    document.execCommand('removeFormat', false, null);
    afterCommand();
  });

  els.removeHighlightBtn.addEventListener('mousedown', (e) => e.preventDefault());
  els.removeHighlightBtn.addEventListener('click', () => {
    document.execCommand('hiliteColor', false, 'transparent');
    afterCommand();
  });

  // Color pickers / selects necessarily steal focus when they open, so we
  // explicitly save the selection beforehand and restore it before acting.
  [els.textColorInput, els.highlightColorInput, els.fontFamilySelect, els.fontSizeSelect, els.listStyleSelect, els.tableBorderColorInput].forEach((el) => {
    el.addEventListener('mousedown', saveSelection);
    el.addEventListener('focus', saveSelection);
  });

  els.textColorInput.addEventListener('input', () => {
    restoreSelection();
    document.execCommand('foreColor', false, els.textColorInput.value);
    afterCommand();
  });

  els.highlightColorInput.addEventListener('input', () => {
    restoreSelection();
    document.execCommand('hiliteColor', false, els.highlightColorInput.value);
    afterCommand();
  });

  els.fontFamilySelect.addEventListener('change', () => {
    if (!els.fontFamilySelect.value) return;
    restoreSelection();
    document.execCommand('fontName', false, els.fontFamilySelect.value);
    afterCommand();
    els.fontFamilySelect.value = '';
  });

  els.fontSizeSelect.addEventListener('change', () => {
    if (!els.fontSizeSelect.value) return;
    restoreSelection();
    document.execCommand('fontSize', false, els.fontSizeSelect.value);
    afterCommand();
    els.fontSizeSelect.value = '';
  });

  // Bullet/number toggles mark the current top-level line with a CSS class
  // instead of running execCommand('insertOrderedList'/'insertUnorderedList'),
  // which rebuilds the line into a real <ul>/<ol><li> and visibly moves or
  // merges it — not what toggling a bullet on an existing line should do.
  function toggleLineList(className) {
    const sel = window.getSelection();
    const anchor = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    let block = anchor ? getTopLevelBlock(anchor) : null;
    if (!block) {
      block = document.createElement('div');
      block.innerHTML = '<br>';
      els.pageContentInput.appendChild(block);
      placeCaretAtStart(block);
    }
    const turningOn = !block.classList.contains(className);
    block.classList.remove('list-bullet', 'list-number');
    if (turningOn) block.classList.add(className);
    else block.removeAttribute('data-num-style');
    afterCommand();
    return block;
  }

  els.bulletBtn.addEventListener('mousedown', (e) => e.preventDefault());
  els.bulletBtn.addEventListener('click', () => toggleLineList('list-bullet'));

  els.numberBtn.addEventListener('mousedown', (e) => e.preventDefault());
  els.numberBtn.addEventListener('click', () => {
    const block = toggleLineList('list-number');
    if (block.classList.contains('list-number') && els.listStyleSelect.value && els.listStyleSelect.value !== 'decimal') {
      block.dataset.numStyle = els.listStyleSelect.value;
    }
  });

  els.listStyleSelect.addEventListener('mousedown', (e) => e.stopPropagation());
  els.listStyleSelect.addEventListener('change', () => {
    restoreSelection();
    const sel = window.getSelection();
    const anchor = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    const block = anchor ? getTopLevelBlock(anchor) : null;
    if (!block) return;
    block.classList.remove('list-bullet');
    block.classList.add('list-number');
    if (els.listStyleSelect.value && els.listStyleSelect.value !== 'decimal') {
      block.dataset.numStyle = els.listStyleSelect.value;
    } else {
      block.removeAttribute('data-num-style');
    }
    afterCommand();
  });

  // Checklist items are built with direct DOM insertion (not execCommand,
  // which handled a block-level <div> mid-line inconsistently — repeated
  // clicks could pile several checkboxes onto one visual line instead of
  // each getting its own row). Enter continues the list like a normal
  // bullet list would; Enter on an empty item exits it.

  function getChkItemAncestor(node) {
    while (node && node !== els.pageContentInput) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('chk-item')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function getTopLevelBlock(node) {
    while (node && node.parentNode !== els.pageContentInput) {
      node = node.parentNode;
    }
    return node && node.parentNode === els.pageContentInput ? node : null;
  }

  function createChkItemElement() {
    const div = document.createElement('div');
    div.className = 'chk-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const span = document.createElement('span');
    span.innerHTML = '&nbsp;';
    div.appendChild(checkbox);
    div.appendChild(span);
    return div;
  }

  function placeCaretAtStart(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Inserts a new checklist row right after whichever one holds the caret
  // (list-continuation), or after the current top-level block if the caret
  // isn't in a checklist yet, or at the very end as a last resort — always
  // as a clean sibling block, never spliced into the middle of a line.
  // Any text after the caret in the current item is carried over into the
  // new row instead of being silently stranded, matching how a real <li>
  // splits on Enter.
  function insertChecklistItem() {
    const sel = window.getSelection();
    if (sel.rangeCount && !sel.getRangeAt(0).collapsed) {
      sel.getRangeAt(0).deleteContents();
    }
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    const anchor = range ? range.startContainer : null;
    const currentItem = anchor ? getChkItemAncestor(anchor) : null;
    const newItem = createChkItemElement();
    const newSpan = newItem.querySelector('span');
    if (currentItem && currentItem.parentNode) {
      const span = currentItem.querySelector('span');
      if (span && range) {
        const afterRange = document.createRange();
        afterRange.setStart(range.startContainer, range.startOffset);
        afterRange.setEndAfter(span.lastChild || span);
        let after = null;
        try { after = afterRange.extractContents(); } catch (err) { after = null; }
        if (after && after.textContent.length > 0) {
          newSpan.innerHTML = '';
          newSpan.appendChild(after);
        }
        if (!span.textContent) span.innerHTML = '&nbsp;';
        if (!newSpan.textContent) newSpan.innerHTML = '&nbsp;';
      }
      currentItem.parentNode.insertBefore(newItem, currentItem.nextSibling);
    } else {
      const topBlock = anchor ? getTopLevelBlock(anchor) : null;
      if (topBlock) topBlock.parentNode.insertBefore(newItem, topBlock.nextSibling);
      else els.pageContentInput.appendChild(newItem);
    }
    placeCaretAtStart(newSpan);
    afterCommand();
  }

  els.checklistBtn.addEventListener('mousedown', (e) => e.preventDefault());
  els.checklistBtn.addEventListener('click', insertChecklistItem);

  els.pageContentInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // Never intercept Enter while the Korean/Japanese/Chinese IME is mid
    // composition — this listener only exists for checklist rows, which is
    // exactly why the checklist (and nothing else) looked broken while
    // typing Hangul: stealing this keystroke cancels the composition
    // instead of just adding a line.
    if (e.isComposing || e.keyCode === 229) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const currentItem = getChkItemAncestor(sel.getRangeAt(0).startContainer);
    if (!currentItem) return;
    e.preventDefault();
    const span = currentItem.querySelector('span');
    const isEmpty = !span || span.textContent.replace(/ /g, '').trim() === '';
    if (isEmpty) {
      const div = document.createElement('div');
      div.innerHTML = '<br>';
      currentItem.parentNode.replaceChild(div, currentItem);
      placeCaretAtStart(div);
      afterCommand();
    } else {
      insertChecklistItem();
    }
  });

  // Tab in a contenteditable region normally moves focus to the next
  // focusable UI element instead of typing anything — here it inserts a
  // fixed indent instead, using non-breaking spaces so the browser doesn't
  // collapse them the way it would plain spaces. Shift+Tab removes one
  // indent's worth immediately before the caret.
  const TAB_INDENT = '    ';
  els.pageContentInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    if (e.shiftKey) {
      const range = sel.getRangeAt(0);
      if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) return;
      // Walk backward across text-node boundaries collecting up to one
      // indent's worth of NBSP — a single text node can run out (e.g. once
      // fully emptied by a prior outdent) without the actual indent run
      // being exhausted, since each Tab press can create its own text node.
      let node = range.startContainer;
      let offset = range.startOffset;
      let count = 0;
      while (count < TAB_INDENT.length) {
        if (offset === 0) {
          const prev = node.previousSibling;
          if (prev && prev.nodeType === Node.TEXT_NODE) {
            node = prev;
            offset = node.textContent.length;
            continue;
          }
          break;
        }
        if (node.textContent[offset - 1] !== ' ') break;
        offset--;
        count++;
      }
      if (count === 0) return;
      const delRange = document.createRange();
      delRange.setStart(node, offset);
      delRange.setEnd(range.startContainer, range.startOffset);
      delRange.deleteContents();
      sel.removeAllRanges();
      sel.addRange(delRange);
    } else {
      // Direct DOM insertion, not execCommand("insertText", ...) — Chromium's
      // insertText silently interleaves NBSP with plain spaces to keep the run
      // wrappable, which corrupted the exact NBSP count the outdent logic above
      // relies on. Inserting the text node ourselves keeps it exactly 4 NBSP.
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(TAB_INDENT);
      range.insertNode(textNode);
      range.setStart(textNode, textNode.length);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    afterCommand();
  });

  els.linkBtn.addEventListener('mousedown', (e) => { e.preventDefault(); saveSelection(); });
  els.linkBtn.addEventListener('click', async () => {
    const url = await showPrompt('링크 주소를 입력하세요', 'https://');
    if (!url) return;
    restoreSelection();
    if (window.getSelection().isCollapsed) {
      document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}" target="_blank">${escapeHtml(url)}</a>`);
    } else {
      document.execCommand('createLink', false, url);
    }
    afterCommand();
  });

  els.imageBtn.addEventListener('mousedown', (e) => { e.preventDefault(); saveSelection(); });
  els.imageBtn.addEventListener('click', () => els.imageFileInput.click());
  els.imageFileInput.addEventListener('change', () => {
    const file = els.imageFileInput.files[0];
    els.imageFileInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      restoreSelection();
      document.execCommand('insertImage', false, reader.result);
      afterCommand();
    };
    reader.readAsDataURL(file);
  });

  els.tableBtn.addEventListener('mousedown', (e) => { e.preventDefault(); saveSelection(); });
  els.tableBtn.addEventListener('click', async () => {
    const rowsStr = await showPrompt('행(가로줄) 개수', '3');
    if (!rowsStr) return;
    const colsStr = await showPrompt('열(세로줄) 개수', '3');
    if (!colsStr) return;
    const rows = Math.max(1, Math.min(20, parseInt(rowsStr, 10) || 1));
    const cols = Math.max(1, Math.min(10, parseInt(colsStr, 10) || 1));
    let html = '<table class="note-table"><tbody>';
    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) html += '<td>&nbsp;</td>';
      html += '</tr>';
    }
    html += '</tbody></table><div><br></div>';
    restoreSelection();
    document.execCommand('insertHTML', false, html);
    afterCommand();
  });

  // Cell size: Chromium gives table cells a native drag-to-resize handle
  // for free (see the CSS `resize` rule) — no extra code needed for that.
  // Border color still needs a control, since there's nothing native for it.
  els.tableBorderColorInput.addEventListener('input', () => {
    restoreSelection();
    const sel = window.getSelection();
    let node = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    let table = null;
    while (node && node !== els.pageContentInput) {
      if (node.nodeType === 1 && node.tagName === 'TABLE') { table = node; break; }
      node = node.parentNode;
    }
    if (!table) {
      showResult('표 테두리 색', '커서를 표 안의 셀에 두고 다시 선택해주세요.');
      return;
    }
    table.querySelectorAll('td, th').forEach((cell) => {
      cell.style.borderColor = els.tableBorderColorInput.value;
    });
    afterCommand();
  });

  els.attachBtn.addEventListener('mousedown', (e) => e.preventDefault());
  els.attachBtn.addEventListener('click', () => els.attachmentFileInput.click());
  async function attachFiles(files) {
    const folder = getCurrentFolder();
    const page = folder && folder.pages.find((p) => p.id === currentPageId);
    if (!page || files.length === 0) return;
    if (!page.attachments) page.attachments = [];
    for (const file of files) {
      try {
        const meta = await window.api.addAttachment(file.path, file.name);
        page.attachments.push(meta);
      } catch (err) {
        alert(`"${file.name}" 첨부에 실패했습니다.`);
      }
    }
    page.updatedAt = nowIso();
    folder.updatedAt = nowIso();
    persist();
    renderAttachments(page);
  }

  els.attachmentFileInput.addEventListener('change', () => {
    const files = Array.from(els.attachmentFileInput.files);
    els.attachmentFileInput.value = '';
    attachFiles(files);
  });

  els.calcSelBtn.addEventListener('mousedown', (e) => e.preventDefault());
  els.calcSelBtn.addEventListener('click', () => {
    const text = window.getSelection().toString();
    const nums = (text.match(/-?\d+(\.\d+)?/g) || []).map(Number);
    if (nums.length === 0) {
      showResult('계산 결과', '선택한 영역에 숫자가 없습니다.\n계산할 숫자를 드래그로 선택한 뒤 눌러주세요.');
      return;
    }
    const sum = nums.reduce((a, b) => a + b, 0);
    const avg = sum / nums.length;
    const product = nums.reduce((a, b) => a * b, 1);
    showResult(
      `선택한 숫자 ${nums.length}개`,
      `합계: ${sum}\n평균: ${avg.toFixed(2)}\n곱: ${product}`
    );
  });

  els.calcSendBtn.addEventListener('mousedown', (e) => e.preventDefault());
  els.calcSendBtn.addEventListener('click', () => {
    const text = window.getSelection().toString();
    const match = text.match(/-?\d+(\.\d+)?/);
    if (!match) {
      showResult('계산기로 보내기', '선택한 영역에 숫자가 없습니다.\n보낼 숫자를 드래그로 선택한 뒤 눌러주세요.');
      return;
    }
    window.api.sendToCalculator(parseFloat(match[0]));
  });

  window.addEventListener('resize', () => {
    if (!els.stackView.hidden) renderStack();
  });

  // ---------- Widget bridge ----------

  let ready = false;
  let pendingFolderId = null;
  let pendingCreateFolder = false;

  window.api.onGotoFolder((id) => {
    if (ready) openFolder(id);
    else pendingFolderId = id;
  });

  window.api.onCreateFolder(() => {
    if (ready) els.newFolderBtn.click();
    else pendingCreateFolder = true;
  });

  // The widget window can save independently (its quick-edit panel). Without
  // this, this window's `state` would go stale the moment the widget saves
  // anything, and the NEXT edit made here would silently overwrite the
  // widget's change on disk — a real data-loss race. Adopt the fresh copy
  // for everything except whatever folder is open here right now (that one
  // stays as our in-memory version, since it may have newer unsaved edits).
  window.api.onDataChanged(() => {
    if (!ready) return;
    window.api.getData().then((fresh) => {
      if (!fresh || !Array.isArray(fresh.folders)) return;
      const openFolderNow = getCurrentFolder();
      const freshFolders = fresh.folders;
      if (openFolderNow) {
        const idx = freshFolders.findIndex((f) => f.id === openFolderNow.id);
        if (idx !== -1) freshFolders[idx] = openFolderNow;
        else freshFolders.unshift(openFolderNow);
      }
      state.folders = freshFolders;
      if (!els.stackView.hidden) renderStack();
      else renderFolderView();
    });
  });

  // ---------- Init ----------

  async function init() {
    state = await window.api.getData();
    if (!state || !Array.isArray(state.folders)) state = { folders: [] };
    ready = true;
    showView('stack');
    if (pendingFolderId) {
      openFolder(pendingFolderId);
      pendingFolderId = null;
    } else if (pendingCreateFolder) {
      els.newFolderBtn.click();
      pendingCreateFolder = false;
    }
  }

  init();
})();
