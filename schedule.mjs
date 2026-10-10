export const UPDATE_TIME_ZONE = 'Europe/Helsinki';
export const UPDATE_TIME = '12:00';

const helsinkiDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: UPDATE_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

function dateParts(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || Number.isNaN(new Date(epochMs).getTime())) {
    throw new RangeError('The update time must be a valid epoch timestamp.');
  }
  return Object.fromEntries(helsinkiDate.formatToParts(epochMs)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
}

function utcCalendar(year, month, day, hour = 0, minute = 0, second = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function localNoon({ year, month, day }, dayOffset = 0) {
  const calendar = new Date(utcCalendar(year, month, day + dayOffset, 12));
  const target = calendar.getTime();
  let candidate = target;
  // Convert this local calendar noon to UTC using the zone's offset on that
  // particular date. Noon is unambiguous on Helsinki's daylight-saving days.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = dateParts(candidate);
    const localClock = utcCalendar(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
    const corrected = candidate + target - localClock;
    if (corrected === candidate) return candidate;
    candidate = corrected;
  }
  return candidate;
}

export function nextDailyUpdate(nowMs = Date.now()) {
  const parts = dateParts(nowMs);
  const today = localNoon(parts);
  return today > nowMs ? today : localNoon(parts, 1);
}

export function previousDailyUpdate(nowMs = Date.now()) {
  const parts = dateParts(nowMs);
  const today = localNoon(parts);
  return today <= nowMs ? today : localNoon(parts, -1);
}

export function createDailyScheduler({
  run,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (typeof run !== 'function') throw new TypeError('A daily update function is required.');
  let active = false;
  let running = false;
  let timer = null;
  let nextUpdate = null;

  function arm() {
    if (!active || running || timer) return;
    const current = now();
    const due = nextDailyUpdate(current);
    const pending = { id: null, due };
    timer = pending;
    nextUpdate = new Date(due).toISOString();
    pending.id = setTimer(() => onTimer(pending), due - current);
    pending.id?.unref?.();
  }

  async function onTimer(pending) {
    if (!active || timer !== pending) return;
    timer = null;
    nextUpdate = null;
    if (now() < pending.due) {
      // A clock adjustment must not make the next day's update happen early.
      arm();
      return;
    }
    running = true;
    try {
      await run();
    } catch {
      // The caller reports fetch failures; a failure must not stop tomorrow's
      // update. Keep the next invocation serialized with this one.
    } finally {
      running = false;
      arm();
    }
  }

  return {
    start() {
      active = true;
      arm();
    },
    stop() {
      active = false;
      if (timer) clearTimer(timer.id);
      timer = null;
      nextUpdate = null;
    },
    getNextUpdate() {
      if (!active) return null;
      if (running) return new Date(nextDailyUpdate(now())).toISOString();
      return nextUpdate;
    },
  };
}
