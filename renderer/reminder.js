(function () {
  'use strict';
  const S = window.Schedule;
  const listEl = document.getElementById('list');
  const countEl = document.getElementById('count');
  const footEl = document.getElementById('foot');
  let reminders = [];

  function whenText(r) {
    if (r.snoozed) return '다시 알림';
    if (r.late) return '놓친 알림';
    if (r.remindMin === 0) return '지금 시작';
    if (r.remindMin === 1440) return '하루 뒤 시작';
    if (r.remindMin % 60 === 0) return r.remindMin / 60 + '시간 뒤 시작';
    return r.remindMin + '분 뒤 시작';
  }

  function button(text, act, id, cls) {
    const b = document.createElement('button');
    b.className = 'btn' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.dataset.act = act;
    b.dataset.id = id;
    return b;
  }

  function render() {
    const today = S.toYmd(new Date());
    listEl.innerHTML = '';
    reminders.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'item';
      item.style.setProperty('--c', r.color || '#a7c8ec');

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = r.title;

      const when = document.createElement('div');
      when.className = 'when';
      when.textContent = S.relativeDayLabel(r.date, today) + ' ' + (r.time || '종일') + ' · ' + whenText(r);
      if (r.late) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '놓침';
        when.appendChild(tag);
      }

      const acts = document.createElement('div');
      acts.className = 'acts';
      acts.appendChild(button('확인', 'dismiss', r.id, 'primary'));
      [[5, '5분 뒤'], [30, '30분 뒤'], [60, '1시간 뒤']].forEach(([m, label]) => {
        const b = button(label, 'snooze', r.id);
        b.dataset.min = String(m);
        acts.appendChild(b);
      });
      acts.appendChild(button('열기', 'open', r.id, 'spacer'));

      item.append(title, when, acts);
      listEl.appendChild(item);
    });
    countEl.textContent = reminders.length > 1 ? reminders.length + '건' : '';
    footEl.hidden = reminders.length < 2;
  }

  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.act === 'dismiss') window.api.dismissReminder(id);
    else if (b.dataset.act === 'snooze') window.api.snoozeReminder(id, Number(b.dataset.min));
    else if (b.dataset.act === 'open') window.api.openReminder(id);
  });
  document.getElementById('dismissAll').addEventListener('click', () => window.api.dismissAllReminders());

  window.api.onRemindersChanged((list) => {
    reminders = list || [];
    render();
  });
  window.api.getReminders().then((list) => {
    reminders = list || [];
    render();
  });
})();
