(function () {
  'use strict';

  const S = window.Schedule;
  const COLORS = ['#f4c869', '#a9d8b6', '#a7c8ec', '#f0a8a8', '#d3aee6', '#f2caa0'];
  const DEFAULT_COLOR = COLORS[2];

  let events = [];
  let folders = [];
  let viewYear = 0;
  let viewMonth = 0; // 0-based
  let selected = '';
  let ready = false;
  const queued = [];
  let editing = null; // { id, occDate, repeat } while the editor is open
  let colorValue = DEFAULT_COLOR;
  let remindTouched = false;
  let colorTouched = false;
  let renderedToday = '';

  const $ = (id) => document.getElementById(id);
  const els = {
    monthTitle: $('monthTitle'),
    grid: $('grid'),
    agendaTitle: $('agendaTitle'),
    agendaList: $('agendaList'),
    pinBtn: $('pinBtn'),
    editor: $('editor'),
    form: $('editorForm'),
    heading: $('editorHeading'),
    repeatNotice: $('repeatNotice'),
    title: $('fTitle'),
    date: $('fDate'),
    allDay: $('fAllDay'),
    timeRow: $('timeRow'),
    time: $('fTime'),
    end: $('fEnd'),
    repeat: $('fRepeat'),
    untilRow: $('untilRow'),
    until: $('fUntil'),
    remind: $('fRemind'),
    allDayHint: $('allDayHint'),
    colors: $('fColors'),
    folder: $('fFolder'),
    openFolderBtn: $('openFolderBtn'),
    note: $('fNote'),
    error: $('editorError'),
    deleteOne: $('deleteOneBtn'),
    del: $('deleteBtn'),
  };

  const today = () => S.toYmd(new Date());
  const folderById = (id) => folders.find((f) => f.id === id) || null;

  // ---------- Month grid ----------

  function setView(ymd) {
    const d = S.parseYmd(ymd) || new Date();
    viewYear = d.getFullYear();
    viewMonth = d.getMonth();
  }

  function renderGrid() {
    const t = today();
    renderedToday = t;
    els.monthTitle.textContent = viewYear + '년 ' + (viewMonth + 1) + '월';
    const first = new Date(viewYear, viewMonth, 1);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 42; i++) {
      const d = new Date(viewYear, viewMonth, 1 - first.getDay() + i);
      const ymd = S.toYmd(d);
      const items = S.eventsOn(events, ymd);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'day' +
        (d.getMonth() !== viewMonth ? ' other' : '') +
        (ymd === t ? ' today' : '') +
        (ymd === selected ? ' selected' : '') +
        (d.getDay() === 0 ? ' sun' : d.getDay() === 6 ? ' sat' : '');
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(d.getDate());
      const dots = document.createElement('div');
      dots.className = 'dots';
      items.slice(0, 3).forEach((o) => {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = o.event.color;
        dots.appendChild(dot);
      });
      if (items.length > 3) {
        const more = document.createElement('span');
        more.className = 'more';
        more.textContent = '+';
        dots.appendChild(more);
      }
      cell.append(num, dots);
      if (items.length) cell.title = items.map((o) => S.timeLabel(o.event) + ' ' + o.event.title).join('\n');
      cell.addEventListener('click', () => selectDay(ymd));
      cell.addEventListener('dblclick', () => openEditor({ date: ymd }));
      frag.appendChild(cell);
    }
    els.grid.innerHTML = '';
    els.grid.appendChild(frag);
  }

  function selectDay(ymd) {
    selected = ymd;
    const d = S.parseYmd(ymd);
    if (d.getFullYear() !== viewYear || d.getMonth() !== viewMonth) setView(ymd);
    renderAll();
  }

  // ---------- Day agenda ----------

  function renderAgenda() {
    els.agendaTitle.textContent = S.dateLabel(selected) + (selected === today() ? ' · 오늘' : '');
    const items = S.eventsOn(events, selected);
    els.agendaList.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '이 날은 일정이 없어요';
      els.agendaList.appendChild(empty);
      return;
    }
    const now = Date.now();
    items.forEach((o) => {
      const ev = o.event;
      const row = document.createElement('div');
      row.className = 'ag-item' + (S.isTimed(ev) && o.startMs < now ? ' past' : '');
      row.style.setProperty('--c', ev.color);
      const time = document.createElement('span');
      time.className = 'ag-time';
      time.textContent = S.isTimed(ev) ? ev.time : '종일';
      const title = document.createElement('span');
      title.className = 'ag-title';
      title.textContent = ev.title;
      title.title = ev.title + (ev.note ? '\n' + ev.note : '');
      row.append(time, title);

      const icons = (ev.repeat !== 'none' ? '🔁' : '') + (ev.remind.length ? '🔔' : '');
      if (icons) {
        const ic = document.createElement('span');
        ic.className = 'ag-icons';
        ic.textContent = icons;
        row.appendChild(ic);
      }
      const folder = ev.folderId && folderById(ev.folderId);
      if (folder) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ag-folder';
        chip.textContent = '📂 ' + folder.title;
        chip.title = '메모 폴더 열기: ' + folder.title;
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          window.api.openFolderInMain(folder.id);
        });
        row.appendChild(chip);
      }
      row.addEventListener('click', () => openEditor({ ev, date: o.date }));
      els.agendaList.appendChild(row);
    });
  }

  function renderAll() {
    renderGrid();
    renderAgenda();
  }

  // ---------- Editor ----------

  function buildStaticFields() {
    S.REPEATS.forEach((r) => {
      const o = document.createElement('option');
      o.value = r;
      o.textContent = S.REPEAT_LABELS[r];
      els.repeat.appendChild(o);
    });
    S.REMIND_CHOICES.forEach((m) => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = String(m);
      label.append(cb, document.createTextNode(S.remindLabel(m)));
      cb.addEventListener('change', () => {
        remindTouched = true;
        label.classList.toggle('on', cb.checked);
      });
      els.remind.appendChild(label);
    });
    COLORS.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.background = c;
      b.dataset.color = c;
      b.addEventListener('click', () => {
        colorTouched = true;
        setColor(c);
      });
      els.colors.appendChild(b);
    });
  }

  function setColor(c) {
    colorValue = c;
    els.colors.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.color === c));
  }

  function setReminds(list) {
    els.remind.querySelectorAll('input').forEach((cb) => {
      cb.checked = list.includes(Number(cb.value));
      cb.parentElement.classList.toggle('on', cb.checked);
    });
  }

  function getReminds() {
    return Array.from(els.remind.querySelectorAll('input')).filter((cb) => cb.checked).map((cb) => Number(cb.value));
  }

  function refreshFolderOptions(selectedId) {
    els.folder.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '연결 안 함';
    els.folder.appendChild(none);
    folders.forEach((f) => {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.title;
      els.folder.appendChild(o);
    });
    els.folder.value = selectedId && folderById(selectedId) ? selectedId : '';
    els.openFolderBtn.hidden = !els.folder.value;
  }

  function syncAllDay() {
    const allDay = els.allDay.checked;
    els.timeRow.hidden = allDay;
    els.allDayHint.hidden = !allDay;
    if (!remindTouched) setReminds(allDay ? [0] : [5]);
  }

  function syncRepeat() {
    els.untilRow.hidden = els.repeat.value === 'none';
  }

  function nextHour() {
    const d = new Date();
    return S.pad2((d.getHours() + 1) % 24) + ':00';
  }

  // opts: { ev } to edit, or { date, folderId, title } to create.
  function openEditor(opts) {
    const ev = opts.ev || null;
    remindTouched = !!ev;
    colorTouched = !!ev;
    els.error.hidden = true;
    editing = ev ? { id: ev.id, occDate: opts.date, repeat: ev.repeat } : { id: null, occDate: opts.date, repeat: 'none' };

    els.heading.textContent = ev ? '일정 수정' : '새 일정';
    els.title.value = ev ? ev.title : opts.title || '';
    els.date.value = ev ? ev.date : opts.date || selected;
    els.allDay.checked = ev ? !S.isTimed(ev) : false;
    const defaultDate = els.date.value === today();
    els.time.value = ev ? ev.time : defaultDate ? nextHour() : '09:00';
    els.end.value = ev ? ev.endTime : '';
    els.repeat.value = ev ? ev.repeat : 'none';
    els.until.value = ev && ev.repeatUntil ? ev.repeatUntil : '';
    els.note.value = ev ? ev.note : '';
    setReminds(ev ? ev.remind : [5]);
    const linked = ev ? ev.folderId : opts.folderId || null;
    refreshFolderOptions(linked);
    const linkedFolder = folderById(els.folder.value);
    setColor(ev ? ev.color : linkedFolder && COLORS.includes(linkedFolder.color) ? linkedFolder.color : DEFAULT_COLOR);
    syncAllDay();
    syncRepeat();

    const repeating = !!ev && ev.repeat !== 'none';
    els.repeatNotice.hidden = !repeating;
    if (repeating) els.repeatNotice.textContent = '반복 일정이에요. 수정하면 모든 반복에 적용됩니다. (선택한 날: ' + S.dateLabel(opts.date) + ')';
    els.deleteOne.hidden = !repeating;
    els.del.hidden = !ev;
    els.del.textContent = repeating ? '전체 삭제' : '삭제';

    els.editor.hidden = false;
    els.title.focus();
    els.title.select();
  }

  function closeEditor() {
    els.editor.hidden = true;
    editing = null;
  }

  function showError(msg) {
    els.error.textContent = msg;
    els.error.hidden = false;
  }

  async function saveEditor() {
    const title = els.title.value.trim();
    const allDay = els.allDay.checked;
    if (!title) return showError('제목을 입력해 주세요.');
    if (!S.parseYmd(els.date.value)) return showError('날짜를 입력해 주세요.');
    if (!allDay && !els.time.value) return showError('시간을 입력하거나 "종일"을 선택해 주세요.');
    if (!allDay && els.end.value && els.end.value <= els.time.value) return showError('종료 시간이 시작 시간보다 늦어야 해요.');
    const repeat = els.repeat.value;
    if (repeat !== 'none' && els.until.value && els.until.value < els.date.value) return showError('반복 끝 날짜가 시작일보다 빠릅니다.');

    const payload = {
      id: editing.id,
      title,
      date: els.date.value,
      time: allDay ? '' : els.time.value,
      endTime: allDay ? '' : els.end.value,
      repeat,
      repeatUntil: repeat !== 'none' && els.until.value ? els.until.value : null,
      remind: getReminds(),
      color: colorValue,
      folderId: els.folder.value || null,
      note: els.note.value,
    };
    const res = await window.api.upsertEvent(payload);
    if (!res || !res.ok) return showError((res && res.error) || '저장하지 못했어요.');
    const isNew = !editing.id;
    closeEditor();
    await refresh();
    if (isNew) selectDay(payload.date);
  }

  async function deleteEditing(onlyThisDay) {
    if (!editing || !editing.id) return;
    const msg = onlyThisDay
      ? S.dateLabel(editing.occDate) + ' 일정만 삭제할까요?'
      : editing.repeat !== 'none' ? '반복 일정 전체를 삭제할까요?' : '이 일정을 삭제할까요?';
    if (!confirm(msg)) return;
    if (onlyThisDay) await window.api.skipEventDate(editing.id, editing.occDate);
    else await window.api.deleteEvent(editing.id);
    closeEditor();
    await refresh();
  }

  // ---------- Data ----------

  async function refresh() {
    events = (await window.api.getEvents()) || [];
    renderAll();
  }

  async function refreshFolders() {
    folders = (await window.api.getFolderList()) || [];
    renderAgenda();
    if (!els.editor.hidden) {
      const keep = els.folder.value;
      refreshFolderOptions(keep);
    }
  }

  function runCommand(cmd) {
    if (!cmd) return;
    if (cmd.type === 'edit') {
      const ev = events.find((e) => e.id === cmd.eventId);
      const date = cmd.date || (ev && ev.date) || today();
      selectDay(date);
      if (ev) openEditor({ ev, date });
      return;
    }
    const date = S.parseYmd(cmd.date || '') ? cmd.date : cmd.type === 'show' ? today() : selected;
    selectDay(date);
    if (cmd.type === 'new') openEditor({ date, folderId: cmd.folderId, title: typeof cmd.title === 'string' ? cmd.title : '' });
  }

  // ---------- Wiring ----------

  $('prevBtn').addEventListener('click', () => {
    const d = new Date(viewYear, viewMonth - 1, 1);
    viewYear = d.getFullYear();
    viewMonth = d.getMonth();
    renderGrid();
  });
  $('nextBtn').addEventListener('click', () => {
    const d = new Date(viewYear, viewMonth + 1, 1);
    viewYear = d.getFullYear();
    viewMonth = d.getMonth();
    renderGrid();
  });
  $('todayBtn').addEventListener('click', () => selectDay(today()));
  $('addBtn').addEventListener('click', () => openEditor({ date: selected }));
  $('closeBtn').addEventListener('click', () => window.api.closeCalendar());
  els.pinBtn.addEventListener('click', () => {
    const on = !els.pinBtn.classList.contains('active');
    els.pinBtn.classList.toggle('active', on);
    window.api.setCalendarOnTop(on);
  });

  els.allDay.addEventListener('change', syncAllDay);
  els.repeat.addEventListener('change', syncRepeat);
  els.folder.addEventListener('change', () => {
    els.openFolderBtn.hidden = !els.folder.value;
    const f = folderById(els.folder.value);
    if (f && !colorTouched && COLORS.includes(f.color)) setColor(f.color);
  });
  els.openFolderBtn.addEventListener('click', () => {
    if (els.folder.value) window.api.openFolderInMain(els.folder.value);
  });
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveEditor();
  });
  $('cancelBtn').addEventListener('click', closeEditor);
  els.deleteOne.addEventListener('click', () => deleteEditing(true));
  els.del.addEventListener('click', () => deleteEditing(false));
  els.editor.addEventListener('mousedown', (e) => {
    if (e.target === els.editor) closeEditor();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.editor.hidden) closeEditor();
  });

  window.api.onEventsChanged(refresh);
  window.api.onDataChanged(refreshFolders);
  window.api.onCalendarCommand((cmd) => {
    if (ready) runCommand(cmd);
    else queued.push(cmd);
  });

  // Keep "today" and the dimmed past events right when the window stays open.
  setInterval(() => {
    if (today() !== renderedToday) renderAll();
    else renderAgenda();
  }, 60 * 1000);

  (async function init() {
    buildStaticFields();
    selected = today();
    setView(selected);
    try {
      const state = await window.api.getCalendarState();
      els.pinBtn.classList.toggle('active', !!(state && state.onTop));
    } catch (e) {
      // pin state is cosmetic
    }
    await Promise.all([refresh(), refreshFolders()]);
    ready = true;
    queued.splice(0).forEach(runCommand);
  })();
})();
