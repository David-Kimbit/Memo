// Date/recurrence maths shared by the main process (reminders) and every
// renderer (calendar grid, widget list), so both always agree on which days an
// event falls on. Dates are local "YYYY-MM-DD" strings; times are "HH:MM".
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Schedule = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
  const REPEAT_LABELS = { none: '반복 안 함', daily: '매일', weekdays: '평일 (월~금)', weekly: '매주', monthly: '매월', yearly: '매년' };
  const REMIND_CHOICES = [0, 5, 10, 30, 60, 1440];
  const MAX_REMIND_MIN = 7 * 1440;
  const ALLDAY_HOUR = 9; // all-day events remind relative to 09:00
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  const pad2 = (n) => (n < 10 ? '0' : '') + n;

  function toYmd(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  function addDays(ymd, n) {
    const d = parseYmd(ymd);
    d.setDate(d.getDate() + n);
    return toYmd(d);
  }

  function dayNumber(ymd) {
    const p = ymd.split('-');
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / DAY_MS);
  }

  function daysInMonth(year, month1) {
    return new Date(year, month1, 0).getDate();
  }

  function isTimed(ev) {
    return !!ev && /^\d{2}:\d{2}$/.test(ev.time || '');
  }

  // Does this event land on the given day?
  function occursOn(ev, ymd) {
    if (!ev || !ev.date || ymd < ev.date) return false;
    if (ev.repeatUntil && ymd > ev.repeatUntil) return false;
    if (ev.skip && ev.skip.indexOf(ymd) !== -1) return false;
    const rep = ev.repeat || 'none';
    if (rep === 'none') return ymd === ev.date;
    if (rep === 'daily') return true;
    const p = ymd.split('-').map(Number);
    const a = ev.date.split('-').map(Number);
    if (rep === 'weekdays') {
      const wd = new Date(p[0], p[1] - 1, p[2]).getDay();
      return wd >= 1 && wd <= 5;
    }
    if (rep === 'weekly') return (dayNumber(ymd) - dayNumber(ev.date)) % 7 === 0;
    // The 31st on a 30-day month (or Feb 29 in a common year) falls on the
    // month's last day instead of being skipped.
    if (rep === 'monthly') return p[2] === Math.min(a[2], daysInMonth(p[0], p[1]));
    if (rep === 'yearly') return p[1] === a[1] && p[2] === Math.min(a[2], daysInMonth(p[0], p[1]));
    return false;
  }

  function startMs(ev, ymd) {
    const p = ymd.split('-').map(Number);
    if (isTimed(ev)) {
      const t = ev.time.split(':').map(Number);
      return new Date(p[0], p[1] - 1, p[2], t[0], t[1]).getTime();
    }
    return new Date(p[0], p[1] - 1, p[2], ALLDAY_HOUR, 0).getTime();
  }

  // All-day first, then by time, then title.
  function compareOccurrences(a, b) {
    const at = isTimed(a.event), bt = isTimed(b.event);
    if (at !== bt) return at ? 1 : -1;
    if (at && a.event.time !== b.event.time) return a.event.time < b.event.time ? -1 : 1;
    return String(a.event.title).localeCompare(String(b.event.title), 'ko');
  }

  function eventsOn(events, ymd) {
    const out = [];
    for (const ev of events) {
      if (occursOn(ev, ymd)) out.push({ event: ev, date: ymd, startMs: startMs(ev, ymd) });
    }
    return out.sort(compareOccurrences);
  }

  // Occurrences from `fromYmd` for `days` days, in date order.
  function upcoming(events, fromYmd, days) {
    const out = [];
    let day = fromYmd;
    for (let i = 0; i < days; i++) {
      out.push(...eventsOn(events, day));
      day = addDays(day, 1);
    }
    return out;
  }

  // Reminders whose fire time falls in (fromMs, toMs]. An occurrence can fire up
  // to MAX_REMIND_MIN before it starts, so the day range extends that far ahead.
  function remindersBetween(events, fromMs, toMs) {
    const out = [];
    const firstDay = toYmd(new Date(fromMs));
    for (const ev of events) {
      const rm = Array.isArray(ev.remind) ? ev.remind : [];
      if (!rm.length) continue;
      const lastDay = toYmd(new Date(toMs + Math.max.apply(null, rm) * 60000));
      for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
        if (!occursOn(ev, day)) continue;
        const start = startMs(ev, day);
        for (const m of rm) {
          const fireAt = start - m * 60000;
          if (fireAt > fromMs && fireAt <= toMs) out.push({ eventId: ev.id, date: day, remindMin: m, fireAt, startMs: start });
        }
      }
    }
    return out.sort((a, b) => a.fireAt - b.fireAt);
  }

  function weekdayLabel(ymd) {
    return WEEKDAYS[parseYmd(ymd).getDay()];
  }

  function dateLabel(ymd) {
    const p = ymd.split('-').map(Number);
    return p[1] + '월 ' + p[2] + '일 (' + weekdayLabel(ymd) + ')';
  }

  // 오늘 / 내일 / 모레, otherwise "11/14 (토)".
  function relativeDayLabel(ymd, todayYmd) {
    const diff = dayNumber(ymd) - dayNumber(todayYmd);
    if (diff === 0) return '오늘';
    if (diff === 1) return '내일';
    if (diff === 2) return '모레';
    const p = ymd.split('-').map(Number);
    return p[1] + '/' + p[2] + ' (' + weekdayLabel(ymd) + ')';
  }

  function remindLabel(min) {
    if (min === 0) return '정각';
    if (min === 1440) return '1일 전';
    if (min % 60 === 0) return min / 60 + '시간 전';
    return min + '분 전';
  }

  function timeLabel(ev) {
    if (!isTimed(ev)) return '종일';
    return /^\d{2}:\d{2}$/.test(ev.endTime || '') ? ev.time + '–' + ev.endTime : ev.time;
  }

  return {
    DAY_MS, REPEATS, REPEAT_LABELS, REMIND_CHOICES, MAX_REMIND_MIN, ALLDAY_HOUR, WEEKDAYS,
    pad2, toYmd, parseYmd, addDays, dayNumber, daysInMonth, isTimed,
    occursOn, startMs, eventsOn, upcoming, remindersBetween,
    weekdayLabel, dateLabel, relativeDayLabel, remindLabel, timeLabel,
  };
});
