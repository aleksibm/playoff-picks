import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_TIME, UPDATE_TIME_ZONE, nextDailyUpdate, previousDailyUpdate, createDailyScheduler,
} from '../schedule.mjs';

const epoch = text => Date.parse(text);
const iso = time => new Date(time).toISOString();

function fakeClock(initialTime) {
  let current = epoch(initialTime);
  let sequence = 0;
  const timers = new Map();
  const canceled = [];
  return {
    now: () => current,
    setTimer(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, delay, due: current + delay });
      return id;
    },
    clearTimer(id) {
      canceled.push(id);
      timers.delete(id);
    },
    timers,
    canceled,
    setTime(text) { current = epoch(text); },
    fire(id, at) {
      const timer = timers.get(id);
      assert.ok(timer, 'The timer exists before firing.');
      timers.delete(id);
      current = at ? epoch(at) : timer.due;
      return timer.callback();
    },
  };
}

test('the update time is noon in Helsinki, regardless of the host time zone', () => {
  assert.equal(UPDATE_TIME, '12:00');
  assert.equal(UPDATE_TIME_ZONE, 'Europe/Helsinki');
  assert.equal(iso(nextDailyUpdate(epoch('2026-01-15T09:59:59.999Z'))), '2026-01-15T10:00:00.000Z');
  assert.equal(iso(nextDailyUpdate(epoch('2026-07-15T08:59:59.999Z'))), '2026-07-15T09:00:00.000Z');
});

test('next noon is strictly future and the previous noon includes the exact cutoff', () => {
  const noon = epoch('2026-10-10T09:00:00.000Z');
  assert.equal(nextDailyUpdate(noon - 1), noon);
  assert.equal(previousDailyUpdate(noon - 1), epoch('2026-10-09T09:00:00.000Z'));
  assert.equal(nextDailyUpdate(noon), epoch('2026-10-11T09:00:00.000Z'));
  assert.equal(previousDailyUpdate(noon), noon);
  assert.equal(nextDailyUpdate(noon + 1), epoch('2026-10-11T09:00:00.000Z'));
  assert.equal(previousDailyUpdate(noon + 1), noon);
});

test('calendar dates follow Helsinki across UTC midnight and a year boundary', () => {
  assert.equal(iso(nextDailyUpdate(epoch('2026-10-09T22:30:00Z'))), '2026-10-10T09:00:00.000Z');
  assert.equal(iso(previousDailyUpdate(epoch('2026-10-09T22:30:00Z'))), '2026-10-09T09:00:00.000Z');
  assert.equal(iso(nextDailyUpdate(epoch('2026-12-31T23:30:00Z'))), '2027-01-01T10:00:00.000Z');
  assert.equal(iso(previousDailyUpdate(epoch('2026-12-31T23:30:00Z'))), '2026-12-31T10:00:00.000Z');
});

test('spring daylight saving creates a 23-hour interval between local noons', () => {
  const saturday = epoch('2026-03-28T10:00:00Z');
  const sunday = nextDailyUpdate(saturday);
  assert.equal(iso(sunday), '2026-03-29T09:00:00.000Z');
  assert.equal(sunday - saturday, 23 * 60 * 60 * 1000);
  assert.equal(previousDailyUpdate(sunday - 1), saturday);
  assert.equal(nextDailyUpdate(sunday), epoch('2026-03-30T09:00:00Z'));
});

test('autumn daylight saving creates a 25-hour interval between local noons', () => {
  const saturday = epoch('2026-10-24T09:00:00Z');
  const sunday = nextDailyUpdate(saturday);
  assert.equal(iso(sunday), '2026-10-25T10:00:00.000Z');
  assert.equal(sunday - saturday, 25 * 60 * 60 * 1000);
  assert.equal(previousDailyUpdate(sunday - 1), saturday);
  assert.equal(nextDailyUpdate(sunday), epoch('2026-10-26T10:00:00Z'));
});

test('invalid timestamps and missing update functions fail explicitly', () => {
  for (const value of [NaN, Infinity, -Infinity, '2026-10-10', null, 9e15]) {
    assert.throws(() => nextDailyUpdate(value), RangeError);
    assert.throws(() => previousDailyUpdate(value), RangeError);
  }
  assert.throws(() => createDailyScheduler({}), TypeError);
});

test('start schedules noon without fetching immediately and repeated start is idempotent', async () => {
  const clock = fakeClock('2026-10-10T07:00:00Z');
  let runs = 0;
  const scheduler = createDailyScheduler({ ...clock, run: () => { runs += 1; } });
  assert.equal(scheduler.getNextUpdate(), null);
  scheduler.start();
  scheduler.start();
  assert.equal(runs, 0);
  assert.equal(clock.timers.size, 1);
  assert.equal(clock.timers.get(1).delay, 2 * 60 * 60 * 1000);
  assert.equal(scheduler.getNextUpdate(), '2026-10-10T09:00:00.000Z');
  await clock.fire(1);
  assert.equal(runs, 1);
  assert.equal(clock.timers.size, 1);
  assert.equal(scheduler.getNextUpdate(), '2026-10-11T09:00:00.000Z');
  scheduler.stop();
});

test('a callback delayed by sleep runs once and schedules the next future local noon', async () => {
  const clock = fakeClock('2026-10-09T07:00:00Z');
  let runs = 0;
  const scheduler = createDailyScheduler({ ...clock, run: () => { runs += 1; } });
  scheduler.start();
  await clock.fire(1, '2026-10-12T11:30:00Z');
  assert.equal(runs, 1);
  assert.equal(clock.timers.size, 1);
  assert.equal(scheduler.getNextUpdate(), '2026-10-13T09:00:00.000Z');
  scheduler.stop();
});

test('each armed interval is recalculated at the spring and autumn transitions', async () => {
  for (const [start, first, second, hours] of [
    ['2026-03-28T09:00:00Z', '2026-03-28T10:00:00.000Z', '2026-03-29T09:00:00.000Z', 23],
    ['2026-10-24T08:00:00Z', '2026-10-24T09:00:00.000Z', '2026-10-25T10:00:00.000Z', 25],
  ]) {
    const clock = fakeClock(start);
    const scheduler = createDailyScheduler({ ...clock, run: () => {} });
    scheduler.start();
    assert.equal(scheduler.getNextUpdate(), first);
    await clock.fire(1);
    assert.equal(scheduler.getNextUpdate(), second);
    assert.equal(clock.timers.get(2).delay, hours * 60 * 60 * 1000);
    scheduler.stop();
  }
});

test('stop cancels pending work and even a queued canceled callback cannot run', async () => {
  const clock = fakeClock('2026-10-10T07:00:00Z');
  let runs = 0;
  const scheduler = createDailyScheduler({ ...clock, run: () => { runs += 1; } });
  scheduler.start();
  const oldCallback = clock.timers.get(1).callback;
  scheduler.stop();
  assert.deepEqual(clock.canceled, [1]);
  assert.equal(clock.timers.size, 0);
  assert.equal(scheduler.getNextUpdate(), null);
  scheduler.start();
  clock.setTime('2026-10-10T09:00:00Z');
  await oldCallback();
  assert.equal(runs, 0);
  assert.equal(clock.timers.size, 1);
  await clock.fire(2);
  assert.equal(runs, 1);
  scheduler.stop();
});

test('slow asynchronous fetches never overlap and stop prevents rearming', async () => {
  const clock = fakeClock('2026-10-10T07:00:00Z');
  let runs = 0;
  let finish;
  const scheduler = createDailyScheduler({ ...clock, run: () => {
    runs += 1;
    return new Promise(resolve => { finish = resolve; });
  } });
  scheduler.start();
  const pending = clock.fire(1);
  scheduler.start();
  assert.equal(runs, 1);
  assert.equal(clock.timers.size, 0);
  assert.equal(scheduler.getNextUpdate(), '2026-10-11T09:00:00.000Z');
  clock.setTime('2026-10-12T11:00:00Z');
  assert.equal(scheduler.getNextUpdate(), '2026-10-13T09:00:00.000Z');
  scheduler.stop();
  finish();
  await pending;
  assert.equal(clock.timers.size, 0);
  assert.equal(scheduler.getNextUpdate(), null);
});

test('stop then start during an active fetch waits for that fetch before rearming', async () => {
  const clock = fakeClock('2026-10-10T07:00:00Z');
  let finish;
  const scheduler = createDailyScheduler({ ...clock, run: () => new Promise(resolve => { finish = resolve; }) });
  scheduler.start();
  const pending = clock.fire(1);
  scheduler.stop();
  clock.setTime('2026-10-11T11:00:00Z');
  scheduler.start();
  assert.equal(clock.timers.size, 0);
  finish();
  await pending;
  assert.equal(clock.timers.size, 1);
  assert.equal(scheduler.getNextUpdate(), '2026-10-12T09:00:00.000Z');
  scheduler.stop();
});

test('a failed asynchronous fetch is contained and tomorrow is still scheduled', async () => {
  const clock = fakeClock('2026-10-10T07:00:00Z');
  let runs = 0;
  const scheduler = createDailyScheduler({ ...clock, run: async () => {
    runs += 1;
    throw new Error('Synthetic fetch failure.');
  } });
  scheduler.start();
  await assert.doesNotReject(clock.fire(1));
  assert.equal(runs, 1);
  assert.equal(scheduler.getNextUpdate(), '2026-10-11T09:00:00.000Z');
  await assert.doesNotReject(clock.fire(2));
  assert.equal(runs, 2);
  assert.equal(scheduler.getNextUpdate(), '2026-10-12T09:00:00.000Z');
  scheduler.stop();
});

test('a system clock moved backward does not run before the due local noon', async () => {
  const clock = fakeClock('2026-10-10T07:00:00Z');
  let runs = 0;
  const scheduler = createDailyScheduler({ ...clock, run: () => { runs += 1; } });
  scheduler.start();
  await clock.fire(1, '2026-10-10T08:30:00Z');
  assert.equal(runs, 0);
  assert.equal(clock.timers.get(2).delay, 30 * 60 * 1000);
  assert.equal(scheduler.getNextUpdate(), '2026-10-10T09:00:00.000Z');
  await clock.fire(2);
  assert.equal(runs, 1);
  scheduler.stop();
});
