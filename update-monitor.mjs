import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { previousDailyUpdate } from './schedule.mjs';

const LABELS = { standings:'NHL standings', fantasy:'Fantasy scores', roster:'NHL player roster', history:'Price history', model:'MoneyPuck goalie data', contracts:'Player salaries', market:'Weekly prices' };
const HOUR = 60 * 60 * 1000;
const GRACE = 30 * 60 * 1000;
const blankConfig = () => ({ enabled:false, botToken:'', chatId:'' });
const problem = (status, message) => Object.assign(new Error(message), { status });

export function safeReason(error, secrets = []) {
  const parts = [], seen = new Set();
  for (let cause = error; cause && !seen.has(cause) && parts.length < 4; cause = cause.cause) {
    seen.add(cause);
    parts.push(typeof cause === 'string' ? cause : `${cause.message || cause.name || 'Unknown error'}${cause.code ? ` [${cause.code}]` : ''}`);
  }
  let text = parts.join(' → ') || 'Unknown error';
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[redacted]');
  return text.replace(/(?:bot)?\d{5,}:[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .replace(/https?:\/\/[^\s)]+/g, raw => {
      try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[URL]'; }
    })
    .replace(/\b(password|authorization|cookie|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1200);
}

function validateConfig(value) {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.botToken !== 'string' || typeof value.chatId !== 'string'
      || (value.botToken && !/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(value.botToken))
      || (value.chatId && !/^(?:-?[1-9]\d{0,19}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(value.chatId))
      || (value.enabled && (!value.botToken || !value.chatId))) {
    throw problem(400, 'Enter a valid BotFather token and Telegram chat ID before enabling alerts.');
  }
  return { enabled:value.enabled, botToken:value.botToken, chatId:value.chatId };
}

function privateJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode:0o600, flag:'wx' });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

async function telegramRequest(config, method, data, fetchImpl) {
  let response, body;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/${method}`, {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(8000),
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify(data),
    });
    body = await response.json();
  } catch (error) {
    throw new Error(`Telegram delivery failed: ${safeReason(error, [config.botToken])}`);
  }
  if (!response.ok || body?.ok !== true) {
    const error = new Error(`Telegram rejected the message (HTTP ${response.status}): ${safeReason(body?.description || 'Invalid response', [config.botToken])}`);
    error.retryAfter = Math.min(24 * HOUR, Math.max(0, Number(body?.parameters?.retry_after) || 0) * 1000);
    throw error;
  }
  return body.result;
}

export async function sendTelegram(config, text, fetchImpl = fetch) {
  return telegramRequest(config, 'sendMessage', { chat_id:config.chatId, text, link_preview_options:{ is_disabled:true } }, fetchImpl);
}

/** Private structured logs, durable incidents, and a bounded Telegram outbox. */
export function createUpdateMonitor({ directory = null, now = Date.now, fetchImpl = fetch,
  writeLine = line => console.error(line), maxLogBytes = 1024 * 1024, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let config = blankConfig(), state = { jobs:{}, recent:[], deliveryError:null, deliveredAt:null };
  let timer = null, running = null, active = false, closed = false, sources = () => [];
  const path = name => directory ? join(directory, name) : null;
  const secrets = () => [config.botToken];
  const stamp = () => new Date(now()).toISOString();
  const bootedAt = now();

  function emit(event, details = {}) {
    const entry = { time:stamp(), event, ...details };
    state.recent = [entry, ...state.recent].slice(0, 30);
    const line = JSON.stringify(entry);
    try { writeLine(line); } catch { /* Monitoring must not interrupt scores. */ }
    if (directory) {
      try {
        const log = path('update-events.jsonl');
        if (existsSync(log) && statSync(log).size + Buffer.byteLength(line) + 1 > maxLogBytes) {
          if (existsSync(`${log}.2`)) unlinkSync(`${log}.2`);
          if (existsSync(`${log}.1`)) renameSync(`${log}.1`, `${log}.2`);
          renameSync(log, `${log}.1`);
        }
        appendFileSync(log, `${line}\n`, { mode:0o600 });
      } catch (error) {
        try { writeLine(JSON.stringify({ time:stamp(), event:'monitor.log_failed', reason:safeReason(error, secrets()) })); } catch {}
      }
    }
  }
  function persist() {
    if (!directory) return;
    try { privateJSON(path('update-status.json'), state); }
    catch (error) { emit('monitor.state_failed', { reason:safeReason(error, secrets()) }); }
  }
  if (directory) {
    mkdirSync(directory, { recursive:true, mode:0o700 });
    chmodSync(directory, 0o700);
    for (const [name, load] of [
      ['telegram-alerts.json', value => { config = validateConfig(value); }],
      ['update-status.json', value => {
        const date = input => input === null || typeof input === 'string' && Number.isFinite(Date.parse(input));
        const incident = input => input && typeof input.id === 'string' && typeof input.reason === 'string' && date(input.since) && date(input.notifiedAt);
        if (!value || !value.jobs || typeof value.jobs !== 'object' || Array.isArray(value.jobs) || !Array.isArray(value.recent)
            || Object.entries(value.jobs).some(([job, saved]) => !Object.hasOwn(LABELS, job) || !saved || !date(saved.lastSuccessAt) || !date(saved.lastAttemptAt)
              || (saved.incident !== null && !incident(saved.incident)) || (saved.pending !== null && (!saved.pending
                || !['failure','recovery'].includes(saved.pending.type) || !incident(saved.pending.incident)
                || !Number.isFinite(saved.pending.due) || !Number.isSafeInteger(saved.pending.attempts) || saved.pending.attempts < 0)))) throw new Error('Invalid update monitor state');
        state = { ...value, recent:value.recent.slice(0, 30) };
      }],
    ]) {
      try {
        if (existsSync(path(name))) {
          if (statSync(path(name)).size > 256 * 1024) throw new Error('Oversized monitor settings');
          load(JSON.parse(readFileSync(path(name), 'utf8')));
          chmodSync(path(name), 0o600);
        }
      } catch (error) { emit('monitor.load_failed', { file:name, reason:safeReason(error, secrets()) }); }
    }
  }

  function jobState(job) {
    if (!Object.hasOwn(LABELS, job)) throw new Error('Unknown update job');
    return state.jobs[job] ??= { lastSuccessAt:null, lastAttemptAt:null, incident:null, pending:null };
  }
  function queue(job, type, incident) {
    const saved = jobState(job);
    saved.pending = { id:randomUUID(), type, incident:{ ...incident }, attempts:0, due:now() };
  }
  function fail(job, error, { lastSuccessAt, stage = 'refresh' } = {}) {
    const saved = jobState(job), reason = safeReason(error, secrets());
    if (lastSuccessAt !== undefined) saved.lastSuccessAt = lastSuccessAt;
    const incident = saved.incident ?? { id:randomUUID(), since:stamp(), notifiedAt:null };
    Object.assign(incident, { reason, stage, lastFailureAt:stamp() });
    saved.incident = incident;
    emit('update.failed', { job, stage, incidentId:incident.id, reason, lastSuccessAt:saved.lastSuccessAt });
    if ((!saved.pending || saved.pending.type === 'recovery') && (!incident.notifiedAt || now() - Date.parse(incident.notifiedAt) >= 6 * HOUR)) queue(job, 'failure', incident);
    persist();
    void deliver();
  }
  function success(job, fetchedAt = stamp()) {
    const saved = jobState(job), incident = saved.incident;
    saved.lastSuccessAt = fetchedAt;
    saved.incident = null;
    // A failure that was never delivered should not arrive after recovery.
    saved.pending = null;
    if (incident?.notifiedAt) queue(job, 'recovery', incident);
    emit(incident ? 'update.recovered' : 'update.succeeded', { job, lastSuccessAt:fetchedAt });
    persist();
    void deliver();
  }
  function message(job, pending) {
    const saved = jobState(job), incident = pending.incident;
    return [
      `The Playoff Pick — ${pending.type === 'recovery' ? 'update recovered' : 'update failed'}`,
      `Feed: ${LABELS[job]}`,
      `Time: ${new Date(now()).toLocaleString('en-GB', { timeZone:'Europe/Helsinki', hour12:false })} (Europe/Helsinki)`,
      `Reason: ${incident.reason}`,
      `Last verified update: ${saved.lastSuccessAt ?? 'None available'}`,
      `Incident: ${incident.id}`,
      pending.type === 'recovery' ? 'Verified updates are working again.' : 'The site keeps its last verified data. Check Update alerts in the local admin dashboard.',
    ].join('\n');
  }
  async function deliver() {
    if (closed || running || !config.enabled) return running;
    if (!Object.values(state.jobs).some(saved => saved.pending && saved.pending.due <= now())) return;
    running = (async () => {
      // One pending message per feed keeps a prolonged outage bounded.
      for (const [job, saved] of Object.entries(state.jobs)) {
        const pending = saved.pending;
        if (!pending || pending.due > now() || !config.enabled || closed) continue;
        const destination = config;
        try {
          await sendTelegram(destination, message(job, pending), fetchImpl);
          if (destination !== config) continue;
          state.deliveredAt = stamp(); state.deliveryError = null;
          if (saved.incident?.id === pending.incident.id) saved.incident.notifiedAt = stamp();
          if (saved.pending === pending) saved.pending = null;
          // The feed may recover while this request is in flight.
          if (!saved.incident && pending.type === 'failure' && !saved.pending) queue(job, 'recovery', { ...pending.incident, notifiedAt:stamp() });
          emit('telegram.delivered', { job, type:pending.type, incidentId:pending.incident.id });
        } catch (error) {
          if (destination !== config) continue;
          state.deliveryError = safeReason(error, [destination.botToken, config.botToken]);
          if (saved.pending === pending) {
            pending.attempts += 1;
            pending.due = now() + Math.max(error.retryAfter || 0, Math.min(HOUR, 60_000 * 2 ** Math.min(pending.attempts - 1, 6)));
          }
          emit('telegram.failed', { job, reason:state.deliveryError, retryAt:saved.pending ? new Date(saved.pending.due).toISOString() : null });
        }
        persist();
      }
    })();
    try { await running; } finally { running = null; }
  }
  function check(list = sources()) {
    if (now() - bootedAt < GRACE) return;
    const due = previousDailyUpdate(now() - GRACE);
    for (const source of list) {
      if (!source.enabled) continue;
      const saved = jobState(source.job);
      if (source.fetchedAt && !saved.lastSuccessAt) saved.lastSuccessAt = source.fetchedAt;
      if (!source.fetchedAt || Date.parse(source.fetchedAt) < due) {
        if (!saved.incident) fail(source.job, new Error(source.running
          ? 'The update is still running and has missed the 30-minute grace period.'
          : 'No verified snapshot arrived for the scheduled 12:00 Helsinki update; the timer may have been missed.'), { stage:'watchdog', lastSuccessAt:source.fetchedAt ?? null });
      }
    }
  }
  function arm() {
    if (!active || closed) return;
    timer = setTimer(async () => {
      timer = null;
      try { check(); await deliver(); } finally { arm(); }
    }, 60_000);
    timer?.unref?.();
  }
  function settings() {
    return { enabled:config.enabled, configured:Boolean(config.botToken && config.chatId), tokenSaved:Boolean(config.botToken),
      chatId:config.chatId, storageAvailable:Boolean(directory), deliveredAt:state.deliveredAt, deliveryError:state.deliveryError };
  }
  return {
    begin(job) { const saved = jobState(job); saved.lastAttemptAt = stamp(); emit('update.started', { job }); persist(); },
    fail, success, check, flush:deliver,
    status() { return { telegram:settings(), jobs:structuredClone(state.jobs), recent:structuredClone(state.recent) }; },
    saveSettings(body) {
      if (!directory) throw problem(409, 'Telegram setup requires the app to use a persistent private data directory.');
      if (Object.keys(body).some(key => !['enabled', 'botToken', 'chatId'].includes(key))
          || body.botToken !== undefined && typeof body.botToken !== 'string' || body.chatId !== undefined && typeof body.chatId !== 'string') throw problem(400, 'Send only valid Telegram notification settings.');
      const next = validateConfig({ enabled:body.enabled, botToken:typeof body.botToken === 'string' ? body.botToken.trim() || config.botToken : config.botToken,
        chatId:typeof body.chatId === 'string' ? body.chatId.trim() : config.chatId });
      try { privateJSON(path('telegram-alerts.json'), next); }
      catch { throw problem(503, 'Telegram settings could not be saved. Check the private data directory permissions and disk space.'); }
      config = next;
      state.deliveryError = null;
      for (const [job, saved] of Object.entries(state.jobs)) {
        saved.pending = null;
        if (config.enabled && saved.incident) { saved.incident.notifiedAt = null; queue(job, 'failure', saved.incident); }
      }
      emit('telegram.configured', { enabled:config.enabled }); persist();
      void deliver();
      return settings();
    },
    async findChats(body) {
      if (Object.keys(body).some(key => key !== 'botToken') || (body.botToken !== undefined && typeof body.botToken !== 'string')) throw problem(400, 'Send a bot token only.');
      const candidate = validateConfig({ enabled:false, chatId:'', botToken:body.botToken?.trim() || config.botToken });
      if (!candidate.botToken) throw problem(400, 'Enter the bot token first, then send /start to your bot in Telegram.');
      try {
        const updates = await telegramRequest(candidate, 'getUpdates', { limit:100, timeout:0, allowed_updates:['message'] }, fetchImpl);
        const chats = new Map();
        for (const update of Array.isArray(updates) ? updates : []) {
          const chat = update.message?.chat;
          if (chat && ['private','group','supergroup'].includes(chat.type) && Number.isSafeInteger(chat.id)) chats.set(String(chat.id), {
            id:String(chat.id), name:String(chat.title || [chat.first_name,chat.last_name].filter(Boolean).join(' ') || chat.username || chat.id).slice(0, 120),
          });
        }
        return [...chats.values()];
      } catch (error) { throw problem(502, safeReason(error, [candidate.botToken, config.botToken])); }
    },
    async test() {
      if (!config.botToken || !config.chatId) throw problem(409, 'Save a bot token and chat ID first.');
      try {
        await sendTelegram(config, 'The Playoff Pick — test notification\nTelegram setup works. Update failures and recoveries will be reported here when alerts are enabled.', fetchImpl);
        state.deliveredAt = stamp(); state.deliveryError = null;
        emit('telegram.test_delivered'); persist();
      } catch (error) {
        state.deliveryError = safeReason(error, secrets());
        emit('telegram.test_failed', { reason:state.deliveryError }); persist();
        throw problem(502, state.deliveryError);
      }
      return settings();
    },
    start(getSources) { if (active || closed) return; sources = getSources; active = true; arm(); void deliver(); },
    async close() { closed = true; active = false; if (timer) clearTimer(timer); if (running) await running; },
  };
}
