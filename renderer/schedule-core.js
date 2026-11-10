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
  const REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly', 'yearlyLunar'];
  const REPEAT_LABELS = { none: '반복 안 함', daily: '매일', weekdays: '평일 (월~금)', weekly: '매주', monthly: '매월', yearly: '매년 (양력)', yearlyLunar: '매년 (음력) — 생일·제사' };
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
    if (rep === 'yearlyLunar') return matchesLunarAnniversary(ev.date, ymd);
    return false;
  }

  // ---------- Lunar calendar ----------

  const lunarCache = {};

  // { month, day, leap } for a solar "YYYY-MM-DD", or null if the runtime has no
  // lunar calendar data.
  function lunarOf(ymd) {
    if (lunarCache[ymd] !== undefined) return lunarCache[ymd];
    const p = ymd.split('-').map(Number);
    return (lunarCache[ymd] = lunarDateOf(new Date(p[0], p[1] - 1, p[2], 12)));
  }

  function lunarLabel(ymd) {
    const l = lunarOf(ymd);
    return l ? '음력 ' + (l.leap ? '윤' : '') + l.month + '월 ' + l.day + '일' : '';
  }

  // Same lunar month/day as the event's first date, in a regular (non-leap)
  // month. A 30th that the month doesn't have falls on the 29th.
  function matchesLunarAnniversary(startYmd, ymd) {
    const a = lunarOf(startYmd);
    const l = lunarOf(ymd);
    if (!a || !l || l.leap) return false;
    if (l.month !== a.month) return false;
    if (l.day === a.day) return true;
    if (a.day === 30 && l.day === 29) {
      const next = lunarOf(addDays(ymd, 1));
      return !!next && next.day === 1;
    }
    return false;
  }

  // The first solar date on/after `fromYmd` that falls on the given lunar date.
  function nextLunar(month, day, leap, fromYmd) {
    let ymd = fromYmd;
    for (let i = 0; i < 800; i++) {
      const l = lunarOf(ymd);
      if (!l) return null;
      if (l.month === month && l.day === day && l.leap === !!leap) return ymd;
      ymd = addDays(ymd, 1);
    }
    return null;
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

  // ---------- Korean public holidays ----------
  // Solar holidays are fixed; 설날 / 부처님오신날 / 추석 come from the lunar
  // calendar built into the runtime's ICU (Intl "chinese" calendar), and the
  // substitute-holiday rules are applied on top. One-off holidays (elections,
  // government-declared bridge days) can't be computed, so the known ones are
  // listed here and anything declared later has to be added by hand.
  const SPECIAL_HOLIDAYS = {
    '2024-04-10': '국회의원 선거일',
    '2024-10-01': '국군의 날 임시공휴일',
    '2025-01-27': '임시공휴일',
    '2025-06-03': '대통령 선거일',
    '2026-06-03': '전국동시지방선거일',
    '2028-04-12': '국회의원 선거일',
  };
  const holidayCache = {};

  function lunarDateOf(date) {
    try {
      const fmt = lunarDateOf.fmt || (lunarDateOf.fmt = new Intl.DateTimeFormat('en-u-ca-chinese', { month: 'numeric', day: 'numeric' }));
      const parts = fmt.formatToParts(date);
      const month = parts.find((p) => p.type === 'month').value;
      return { month: parseInt(month, 10), leap: /bis/i.test(month), day: parseInt(parts.find((p) => p.type === 'day').value, 10) };
    } catch (e) {
      return null;
    }
  }

  // The solar date of lunar month/day within a window of solar days.
  function findLunar(year, fromMonth, fromDay, toMonth, toDay, lunarMonth, lunarDay) {
    for (let d = new Date(year, fromMonth - 1, fromDay); d <= new Date(year, toMonth - 1, toDay); d.setDate(d.getDate() + 1)) {
      const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
      const l = lunarDateOf(noon);
      if (!l) return null;
      if (!l.leap && l.month === lunarMonth && l.day === lunarDay) return toYmd(noon);
    }
    return null;
  }

  function holidaysOf(year) {
    if (holidayCache[year]) return holidayCache[year];
    const map = {};
    const names = (ymd) => map[ymd];
    const add = (ymd, name) => { map[ymd] = map[ymd] ? map[ymd] + ' · ' + name : name; };
    const y = String(year);
    const solar = (mmdd, name) => { add(y + '-' + mmdd, name); return y + '-' + mmdd; };

    // `kind`: 'sunday' = the long 설날/추석 break (substitute only when it hits a
    // Sunday), 'weekend' = substitute on Sat/Sun, 'children' = also when it overlaps
    // another holiday. Anything else gets no substitute.
    const subs = [];
    solar('01-01', '신정');
    subs.push({ from: solar('03-01', '삼일절'), name: '삼일절', kind: 'weekend' });
    subs.push({ from: solar('05-05', '어린이날'), name: '어린이날', kind: 'children' });
    solar('06-06', '현충일');
    subs.push({ from: solar('08-15', '광복절'), name: '광복절', kind: 'weekend' });
    subs.push({ from: solar('10-03', '개천절'), name: '개천절', kind: 'weekend' });
    subs.push({ from: solar('10-09', '한글날'), name: '한글날', kind: 'weekend' });
    subs.push({ from: solar('12-25', '성탄절'), name: '성탄절', kind: 'weekend' });

    const seol = findLunar(year, 1, 15, 2, 25, 1, 1);
    if (seol) {
      add(addDays(seol, -1), '설날 연휴'); add(seol, '설날'); add(addDays(seol, 1), '설날 연휴');
      subs.push({ from: addDays(seol, 1), name: '설날', kind: 'sunday', span: [addDays(seol, -1), seol, addDays(seol, 1)] });
    }
    const buddha = findLunar(year, 4, 20, 6, 10, 4, 8);
    if (buddha) {
      add(buddha, '부처님오신날');
      subs.push({ from: buddha, name: '부처님오신날', kind: 'weekend' });
    }
    const chuseok = findLunar(year, 8, 20, 10, 10, 8, 15);
    if (chuseok) {
      add(addDays(chuseok, -1), '추석 연휴'); add(chuseok, '추석'); add(addDays(chuseok, 1), '추석 연휴');
      subs.push({ from: addDays(chuseok, 1), name: '추석', kind: 'sunday', span: [addDays(chuseok, -1), chuseok, addDays(chuseok, 1)] });
    }
    Object.keys(SPECIAL_HOLIDAYS).forEach((ymd) => { if (ymd.slice(0, 4) === y) add(ymd, SPECIAL_HOLIDAYS[ymd]); });

    // Substitute holidays, in date order; each lands on the next day that is
    // neither a weekend nor already a holiday.
    const isOff = (ymd) => {
      const wd = parseYmd(ymd).getDay();
      return wd === 0 || wd === 6 || !!names(ymd);
    };
    subs.sort((a, b) => (a.from < b.from ? -1 : 1));
    subs.forEach((s) => {
      const days = s.span || [s.from];
      const wds = days.map((d) => parseYmd(d).getDay());
      let needs = false;
      if (s.kind === 'sunday') needs = wds.includes(0);
      else if (s.kind === 'weekend') needs = wds[0] === 0 || wds[0] === 6;
      else needs = wds[0] === 0 || wds[0] === 6 || String(names(s.from)).indexOf('·') !== -1;
      if (!needs) return;
      let day = addDays(days[days.length - 1], 1);
      while (isOff(day)) day = addDays(day, 1);
      add(day, s.name + ' 대체공휴일');
    });
    holidayCache[year] = map;
    return map;
  }

  function holidayName(ymd) {
    const y = parseInt(ymd.slice(0, 4), 10);
    return holidaysOf(y)[ymd] || '';
  }

  // ---------- Quick-add sentences ("내일 오후 3시 팀 회의") ----------

  const MERIDIEM = '(오전|오후|아침|점심|저녁|밤|새벽)';

  function meridiemHour(h, mer, literal) {
    if (mer === '오전' || mer === '아침' || mer === '새벽') return h === 12 ? 0 : h;
    if (mer === '오후' || mer === '점심' || mer === '저녁' || mer === '밤') {
      if (mer === '밤' && h === 12) return 0;
      return h < 12 ? h + 12 : h;
    }
    // No am/pm given: 1-6 reads as the afternoon ("3시 회의"), 7-11 as the morning.
    return h >= 1 && h <= 6 && !literal ? h + 12 : h;
  }

  // Pulls a date and/or time out of free text. Returns the leftover words as the
  // title; `date` / `time` are null when the text didn't mention them.
  function parseQuick(text, nowArg) {
    const now = nowArg || new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const offset = (n) => toYmd(new Date(base.getFullYear(), base.getMonth(), base.getDate() + n));
    const upcomingMD = (month, day) => {
      let cand = toYmd(new Date(base.getFullYear(), month - 1, day));
      if (!parseYmd(cand) || new Date(base.getFullYear(), month - 1, day).getMonth() !== month - 1) return null;
      if (cand < toYmd(base)) {
        const next = new Date(base.getFullYear() + 1, month - 1, day);
        if (next.getMonth() !== month - 1) return null;
        cand = toYmd(next);
      }
      return cand;
    };
    let s = ' ' + String(text == null ? '' : text) + ' ';
    let date = null;
    let time = null;
    const cut = (re, fn) => {
      const m = re.exec(s);
      if (!m) return false;
      const r = fn(m);
      if (r === null) return false;
      s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
      return true;
    };

    // dates, most specific first
    cut(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/, (m) => {
      const ymd = m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
      if (!parseYmd(ymd)) return null;
      date = ymd;
    });
    if (!date) {
      cut(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/, (m) => { date = upcomingMD(+m[1], +m[2]); return date ? undefined : null; });
    }
    if (!date) {
      cut(/(?<![\d.:/-])(\d{1,2})[./](\d{1,2})(?![\d.:/a-zA-Z])/, (m) => { date = upcomingMD(+m[1], +m[2]); return date ? undefined : null; });
    }
    if (!date) {
      cut(/(이번|다음)\s*달\s*(\d{1,2})\s*일/, (m) => {
        const d = new Date(base.getFullYear(), base.getMonth() + (m[1] === '다음' ? 1 : 0), +m[2]);
        if (d.getDate() !== +m[2]) return null;
        date = toYmd(d);
      });
    }
    if (!date) cut(/(\d{1,3})\s*일\s*(?:뒤|후)/, (m) => { date = offset(+m[1]); });
    if (!date) cut(/(\d{1,2})\s*주\s*(?:뒤|후)/, (m) => { date = offset(7 * +m[1]); });
    if (!date) {
      cut(/내일\s*모레|모레|글피|내일|오늘/, (m) => {
        date = offset({ '오늘': 0, '내일': 1, '모레': 2, '내일모레': 2, '글피': 3 }[m[0].replace(/\s+/g, '')]);
      });
    }
    if (!date) {
      const idx = { '월': 0, '화': 1, '수': 2, '목': 3, '금': 4, '토': 5, '일': 6 };
      const nowIdx = (base.getDay() + 6) % 7; // Monday = 0
      const ok = cut(/(다다음|다음|이번)\s*주\s*(월|화|수|목|금|토|일)\s*요일?/, (m) => {
        date = offset({ '이번': 0, '다음': 7, '다다음': 14 }[m[1]] + idx[m[2]] - nowIdx);
      });
      if (!ok) {
        cut(/(월|화|수|목|금|토|일)요일/, (m) => {
          const diff = (idx[m[1]] - nowIdx + 7) % 7;
          date = offset(diff === 0 ? 7 : diff);
        });
      }
    }

    // times
    const hhmm = (h, mi) => (h > 23 || mi > 59 ? null : pad2(h) + ':' + pad2(mi));
    cut(new RegExp(MERIDIEM + '?\\s*(\\d{1,2})\\s*시\\s*(?:(\\d{1,2})\\s*분|(반))?'), (m) => {
      const t = hhmm(meridiemHour(+m[2], m[1], false), m[4] ? 30 : m[3] ? +m[3] : 0);
      if (!t) return null;
      time = t;
    });
    if (time === null) {
      cut(new RegExp(MERIDIEM + '?\\s*(\\d{1,2}):(\\d{2})'), (m) => {
        const t = hhmm(meridiemHour(+m[2], m[1], m[2].length === 2 && m[2][0] === '0'), +m[3]);
        if (!t) return null;
        time = t;
      });
    }
    if (time === null) cut(/정오/, () => { time = '12:00'; });

    let title = s.replace(/\s+/g, ' ').trim().replace(/^(에서|에|부터|까지)(\s+|$)/, '').trim();
    return { title, date, time, matched: date !== null || time !== null };
  }

  return {
    holidaysOf, holidayName, parseQuick, lunarOf, lunarLabel, nextLunar,
    DAY_MS, REPEATS, REPEAT_LABELS, REMIND_CHOICES, MAX_REMIND_MIN, ALLDAY_HOUR, WEEKDAYS,
    pad2, toYmd, parseYmd, addDays, dayNumber, daysInMonth, isTimed,
    occursOn, startMs, eventsOn, upcoming, remindersBetween,
    weekdayLabel, dateLabel, relativeDayLabel, remindLabel, timeLabel,
  };
});
