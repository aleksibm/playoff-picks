import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, chmodSync, lstatSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { sanitizePicks, getProgress } from './dist/game.js';
import { FANTASY_SEASON, BUDGET, TRANSFERS_PER_MONTH, transferMonth, validateRoster, rosterProgress } from './dist/fantasy-rules.js';

const deriveKey = promisify(scrypt);
const SEASON = '20262027';
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_SESSIONS_PER_ACCOUNT = 10;
// OWASP's 32 MiB scrypt configuration is suitable for a small hosting laptop.
const PASSWORD_SCHEME = 'scrypt-32768-8-3';
const LEGACY_PASSWORD_SCHEME = 'scrypt-16384-8-1';
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const LEGACY_SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_AUTHENTICATIONS = 2;
let activeAuthentications = 0;
const DUMMY_SALT = Buffer.alloc(32, 0x73);
const DUMMY_HASH = Buffer.alloc(64, 0x5a);

function failure(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Reject excess work before it enters libuv's unbounded crypto queue. This gate
// is shared by every store in the process and covers legacy password upgrades.
async function authenticate(action) {
  if (activeAuthentications >= MAX_AUTHENTICATIONS) {
    throw failure(503, 'Sign-in is busy. Please try again in a moment.');
  }
  activeAuthentications += 1;
  try { return await action(); } finally { activeAuthentications -= 1; }
}

function passwordLength(password) {
  // A Unicode code point uses at most two UTF-16 units. Bound the allocation
  // before counting, and do not truncate or normalize the supplied password.
  return typeof password === 'string' && password.length <= 256 ? Array.from(password).length : -1;
}

function validateUsername(username) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,24}$/.test(username)) {
    throw failure(400, 'Use a username with 3–24 letters, numbers, or underscores.');
  }
  return username.toLowerCase();
}

function validatePassword(password) {
  const length = passwordLength(password);
  if (length < 7 || length > 128) {
    throw failure(400, 'Use a password with 7–128 characters.');
  }
}

function validatePicks(teamIds, complete = false) {
  if (!Array.isArray(teamIds) || teamIds.length > 16) {
    throw failure(400, 'Choose up to 16 NHL teams.');
  }
  const valid = sanitizePicks(teamIds);
  if (valid.length !== teamIds.length || valid.some((id, index) => id !== teamIds[index])) {
    throw failure(400, 'Choose unique NHL teams, with at most 8 per conference and 5 per division.');
  }
  if (complete && !getProgress(valid).complete) {
    throw failure(400, 'Choose 16 teams: 8 per conference, with at least 3 from each division.');
  }
  return valid;
}

function validateRevision(revision) {
  if (revision !== undefined && revision !== null && (!Number.isSafeInteger(revision) || revision < 0)) {
    throw failure(400, 'The prediction revision must be a non-negative integer.');
  }
}

const publicUser = row => ({ id: row.id, username: row.username, displayName: row.display_name });
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
const samePicks = (left, right) => left.length === right.length && left.every(id => right.includes(id));

/** Local, durable accounts and one prediction per account for the current season. */
export function createAccountStore(dbPath, { fantasyPlayers = [], fantasyPrices = null, now: fantasyNow = Date.now } = {}) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    if (existsSync(dbPath)) {
      if (!lstatSync(dbPath).isFile()) throw new Error('The account database must be a regular file.');
      chmodSync(dbPath, 0o600);
    }
  }
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 4) {
    db.close();
    throw new Error('This account database was created by a newer version of the site.');
  }
  if (version === 0) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX sessions_by_expiry ON sessions(expires_at);
      CREATE TABLE predictions (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        season TEXT NOT NULL,
        team_ids TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('draft', 'submitted')),
        submitted_at TEXT,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        PRIMARY KEY (user_id, season),
        CHECK ((state = 'draft' AND submitted_at IS NULL) OR (state = 'submitted' AND submitted_at IS NOT NULL))
      );
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }

  if (version <= 1) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE users ADD COLUMN password_scheme TEXT NOT NULL DEFAULT '${LEGACY_PASSWORD_SCHEME}'
        CHECK (password_scheme IN ('${LEGACY_PASSWORD_SCHEME}', '${PASSWORD_SCHEME}'));
      CREATE INDEX sessions_by_user ON sessions(user_id, created_at);
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }
  if (version <= 2) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE fantasy_entries (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        season TEXT NOT NULL, player_ids TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('draft','submitted')),
        submitted_at TEXT, updated_at TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(user_id, season)
      );
      CREATE TABLE fantasy_lineups (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        season TEXT NOT NULL, player_ids TEXT NOT NULL, effective_at TEXT NOT NULL,
        transfer_month TEXT NOT NULL, transfers INTEGER NOT NULL CHECK(transfers BETWEEN 0 AND 2)
      );
      CREATE INDEX fantasy_lineups_by_user ON fantasy_lineups(user_id, season, id);
      PRAGMA user_version = 3;
      COMMIT;`);
  }
  if(version<=3){
    db.exec(`BEGIN IMMEDIATE; ALTER TABLE fantasy_entries ADD COLUMN cash_balance INTEGER CHECK(cash_balance>=0);
      CREATE TABLE fantasy_trades(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),season TEXT NOT NULL,
        traded_at TEXT NOT NULL,price_version TEXT NOT NULL,sales TEXT NOT NULL,purchases TEXT NOT NULL,cash_before INTEGER NOT NULL,cash_after INTEGER NOT NULL);
      PRAGMA user_version=4;`);
    try{
      const original=new Map(fantasyPlayers.map(p=>[p.id,p.price]));
      for(const entry of db.prepare('SELECT user_id,season FROM fantasy_entries WHERE submitted_at IS NOT NULL').all()){
        const lineup=db.prepare('SELECT player_ids FROM fantasy_lineups WHERE user_id=? AND season=? ORDER BY id DESC LIMIT 1').get(entry.user_id,entry.season);
        const ids=JSON.parse(lineup?.player_ids??'[]');
        if(ids.some(id=>!original.has(id)))throw Error('Fantasy catalog is required to migrate existing teams.');
        const cash=BUDGET-ids.reduce((n,id)=>n+original.get(id),0);
        if(cash<0)throw Error('Existing fantasy cash could not be verified.');
        db.prepare('UPDATE fantasy_entries SET cash_balance=? WHERE user_id=? AND season=?').run(cash,entry.user_id,entry.season);
      }
      db.exec('COMMIT;');
    }catch(error){db.exec('ROLLBACK;');db.close();throw error;}
  }
  if (dbPath !== ':memory:') {
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  const query = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT id, username, display_name FROM users WHERE id = ?'),
    userCredentials: db.prepare('SELECT password_hash FROM users WHERE id = ?'),
    renameUser: db.prepare('UPDATE users SET username = ?, display_name = ? WHERE id = ?'),
    resetPassword: db.prepare('UPDATE users SET password_salt = ?, password_hash = ?, password_scheme = ? WHERE id = ?'),
    revokeUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    addUser: db.prepare('INSERT INTO users (username, display_name, password_salt, password_hash, password_scheme, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    upgradePassword: db.prepare('UPDATE users SET password_salt = ?, password_hash = ?, password_scheme = ? WHERE id = ? AND password_hash = ?'),
    addSession: db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'),
    session: db.prepare(`SELECT u.id, u.username, u.display_name, s.csrf_token, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    trimSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash IN (
      SELECT token_hash FROM sessions WHERE user_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`),
    prediction: db.prepare('SELECT team_ids, state, submitted_at, updated_at, revision FROM predictions WHERE user_id = ? AND season = ?'),
    savePrediction: db.prepare(`INSERT INTO predictions (user_id, season, team_ids, state, submitted_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, season) DO UPDATE SET team_ids = excluded.team_ids, state = excluded.state,
        submitted_at = excluded.submitted_at, updated_at = excluded.updated_at, revision = excluded.revision`),
    submitted: db.prepare(`SELECT u.id, u.username, u.display_name, p.team_ids, p.submitted_at
      FROM predictions p JOIN users u ON u.id = p.user_id
      WHERE p.season = ? AND p.state = 'submitted' ORDER BY p.submitted_at ASC, u.id ASC`),
    accounts: db.prepare(`SELECT u.id, u.username, u.display_name, u.created_at,
      p.team_ids, p.state, p.submitted_at, p.updated_at, p.revision
      FROM users u LEFT JOIN predictions p ON p.user_id = u.id AND p.season = ?
      ORDER BY u.created_at DESC, u.id DESC`),
  };
  const fantasyQuery = {
    entry: db.prepare('SELECT * FROM fantasy_entries WHERE user_id = ? AND season = ?'),
    history: db.prepare('SELECT player_ids, effective_at FROM fantasy_lineups WHERE user_id = ? AND season = ? ORDER BY id'),
    latest: db.prepare('SELECT player_ids FROM fantasy_lineups WHERE user_id = ? AND season = ? ORDER BY id DESC LIMIT 1'),
    used: db.prepare('SELECT COALESCE(SUM(transfers),0) AS total FROM fantasy_lineups WHERE user_id = ? AND season = ? AND transfer_month = ?'),
    write: db.prepare(`INSERT INTO fantasy_entries(user_id,season,player_ids,state,submitted_at,updated_at,revision)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,season) DO UPDATE SET player_ids=excluded.player_ids,
      state=excluded.state,submitted_at=excluded.submitted_at,updated_at=excluded.updated_at,revision=excluded.revision`),
    lineup: db.prepare('INSERT INTO fantasy_lineups(user_id,season,player_ids,effective_at,transfer_month,transfers) VALUES(?,?,?,?,?,?)'),
    cash: db.prepare('UPDATE fantasy_entries SET cash_balance=? WHERE user_id=? AND season=?'),
    trade: db.prepare('INSERT INTO fantasy_trades(user_id,season,traded_at,price_version,sales,purchases,cash_before,cash_after) VALUES(?,?,?,?,?,?,?,?)'),
    submitted: db.prepare(`SELECT u.id,u.username,u.display_name,e.submitted_at FROM fantasy_entries e JOIN users u ON u.id=e.user_id WHERE e.season=? AND e.state='submitted' ORDER BY e.submitted_at,u.id`),
  };
  let lastSessionPrune = Date.now();
  query.deleteExpired.run(lastSessionPrune);

  function pruneSessions(now = Date.now(), force = false) {
    if (force || now - lastSessionPrune >= SESSION_PRUNE_INTERVAL_MS) {
      query.deleteExpired.run(now);
      lastSessionPrune = now;
    }
  }

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function requireUser(userId) {
    if (!Number.isSafeInteger(userId) || userId < 1) throw failure(404, 'Account not found.');
    const row = query.userById.get(userId);
    if (!row) throw failure(404, 'Account not found.');
    return row;
  }

  function newSession(user) {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    pruneSessions(now, true);
    query.addSession.run(tokenHash(token), user.id, csrfToken, now + SESSION_LIFETIME_MS, new Date(now).toISOString());
    query.trimSessions.run(user.id, user.id, MAX_SESSIONS_PER_ACCOUNT);
    return { user: publicUser(user), token, csrfToken };
  }

  function requireAdminUser(userId, expectedUsername) {
    const user = requireUser(userId);
    if (typeof expectedUsername !== 'string') throw failure(400, 'Reload the account before making changes.');
    if (user.username !== expectedUsername) throw failure(409, 'This account changed. Reload it before making changes.');
    return user;
  }

  function readPrediction(userId) {
    const row = query.prediction.get(userId, SEASON);
    return row ? {
      teamIds: JSON.parse(row.team_ids), state: row.state, submittedAt: row.submitted_at,
      updatedAt: row.updated_at, revision: row.revision,
    } : null;
  }

  function writePrediction(userId, teamIds, state, expectedRevision) {
    const picks = validatePicks(teamIds, state === 'submitted');
    validateRevision(expectedRevision);
    return transaction(() => {
      requireUser(userId);
      const current = readPrediction(userId);
      if (current?.state === 'submitted') {
        if (state === 'submitted' && samePicks(current.teamIds, picks)) return current;
        throw failure(409, 'Your prediction is already submitted and locked for this season.');
      }
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== (current?.revision ?? 0)) {
        throw failure(409, 'This prediction changed. Reload it before saving.');
      }
      const now = new Date().toISOString();
      query.savePrediction.run(userId, SEASON, JSON.stringify(picks), state, state === 'submitted' ? now : null,
        now, (current?.revision ?? 0) + 1);
      return readPrediction(userId);
    });
  }

  function readFantasy(userId) {
    const row = fantasyQuery.entry.get(userId,FANTASY_SEASON);
    const month = transferMonth(fantasyNow());
    const used = fantasyQuery.used.get(userId,FANTASY_SEASON,month).total;
    return { playerIds: row ? JSON.parse(row.player_ids) : [], state: row?.state ?? 'draft',
      submittedAt: row?.submitted_at ?? null, updatedAt: row?.updated_at ?? null, revision: row?.revision ?? 0,cashBalance:row?.cash_balance??BUDGET,
      activePlayerIds: JSON.parse(fantasyQuery.latest.get(userId,FANTASY_SEASON)?.player_ids ?? '[]'),
      transfers: { month, used, remaining: Math.max(0,TRANSFERS_PER_MONTH-used), limit: TRANSFERS_PER_MONTH, timeZone:'Europe/Helsinki' } };
  }

  function writeFantasy(userId, playerIds, revision, submit, expectedPrices) {
    if (!Number.isSafeInteger(revision) || revision<0) throw failure(400,'Reload your fantasy team before saving.');
    return transaction(() => {
      requireUser(userId);
      const current=readFantasy(userId);
      if (revision!==current.revision) throw failure(409,'Your fantasy team changed in another tab. Reload it before saving.');
      const prices=fantasyPrices?.()??{players:fantasyPlayers,version:'base'};
      if(expectedPrices!==undefined&&expectedPrices!==prices.version)throw failure(409,'Player prices changed. Reload the market and review your team.');
      const priced=new Map(prices.players.map(p=>[p.id,p]));
      const funds=current.activePlayerIds.length?current.cashBalance+current.activePlayerIds.reduce((n,id)=>n+priced.get(id).price,0):BUDGET;
      let ids;try{ids=validateRoster(playerIds,priced,submit,funds);}catch(error){throw failure(400,error.message);}
      const timestamp=new Date(fantasyNow()).toISOString();
      let cash=current.cashBalance;
      if (submit) {
        const changes=current.activePlayerIds.length ? ids.filter(id=>!current.activePlayerIds.includes(id)).length : 0;
        if (changes>current.transfers.remaining) throw failure(409,`You have ${current.transfers.remaining} transfer${current.transfers.remaining===1?'':'s'} left this month. Each player replacement uses one.`);
        if (!current.activePlayerIds.length || changes){
          cash=rosterProgress(ids,priced,funds).remaining;
          fantasyQuery.lineup.run(userId,FANTASY_SEASON,JSON.stringify(ids),timestamp,current.transfers.month,changes);
          const sales=current.activePlayerIds.filter(id=>!ids.includes(id)).map(id=>({id,price:priced.get(id).price}));
          const purchases=ids.filter(id=>!current.activePlayerIds.includes(id)).map(id=>({id,price:priced.get(id).price}));
          fantasyQuery.trade.run(userId,FANTASY_SEASON,timestamp,prices.version,JSON.stringify(sales),JSON.stringify(purchases),current.cashBalance,cash);
        }
      }
      fantasyQuery.write.run(userId,FANTASY_SEASON,JSON.stringify(ids),submit?'submitted':current.state,
        current.submittedAt ?? (submit?timestamp:null),timestamp,current.revision+1);
      if(submit)fantasyQuery.cash.run(cash,userId,FANTASY_SEASON);
      return readFantasy(userId);
    });
  }

  return {
    getFantasy(userId) { requireUser(userId); return readFantasy(userId); },
    saveFantasyDraft(userId,ids,revision,prices) { return writeFantasy(userId,ids,revision,false,prices); },
    submitFantasy(userId,ids,revision,prices) { return writeFantasy(userId,ids,revision,true,prices); },
    fantasyHistory(userId) { requireUser(userId); return fantasyQuery.history.all(userId,FANTASY_SEASON).map(r=>({playerIds:JSON.parse(r.player_ids),effectiveAt:r.effective_at})); },
    listFantasySubmitted() { return fantasyQuery.submitted.all(FANTASY_SEASON).map(r=>({...publicUser(r),submittedAt:r.submitted_at})); },
    async register(username, password) {
      const canonicalName = validateUsername(username);
      validatePassword(password);
      return authenticate(async () => {
        const salt = randomBytes(32);
        const hash = await deriveKey(password, salt, 64, SCRYPT_OPTIONS);
        return transaction(() => {
          if (query.userByName.get(canonicalName)) throw failure(409, 'That username is already taken.');
          const result = query.addUser.run(canonicalName, username, salt.toString('hex'), hash.toString('hex'), PASSWORD_SCHEME, new Date().toISOString());
          return newSession(requireUser(Number(result.lastInsertRowid)));
        });
      });
    },

    async login(username, password) {
      // All failed logins share a message, and unknown accounts still perform scrypt.
      const canonicalName = typeof username === 'string' && /^[A-Za-z0-9_]{3,24}$/.test(username)
        ? username.toLowerCase() : null;
      const length = passwordLength(password);
      const validPassword = length >= 7 && length <= 128;
      return authenticate(async () => {
        const user = canonicalName ? query.userByName.get(canonicalName) : null;
        const legacy = user?.password_scheme === LEGACY_PASSWORD_SCHEME;
        const salt = user ? Buffer.from(user.password_salt, 'hex') : DUMMY_SALT;
        const expected = user ? Buffer.from(user.password_hash, 'hex') : DUMMY_HASH;
        const actual = await deriveKey(validPassword ? password : '', salt, 64, legacy ? LEGACY_SCRYPT_OPTIONS : SCRYPT_OPTIONS);
        const matches = expected.length === actual.length && timingSafeEqual(actual, expected);
        if (!user || !validPassword || !matches) throw failure(401, 'Incorrect username or password.');
        let upgradedPassword = null;
        if (legacy) {
          const newSalt = randomBytes(32);
          const hash = await deriveKey(password, newSalt, 64, SCRYPT_OPTIONS);
          upgradedPassword = {salt:newSalt.toString('hex'), hash:hash.toString('hex')};
        }
        return transaction(() => {
          // An admin reset must also stop a login that was hashing the old password.
          if (query.userCredentials.get(user.id)?.password_hash !== user.password_hash) {
            throw failure(401, 'Incorrect username or password.');
          }
          if (upgradedPassword) query.upgradePassword.run(upgradedPassword.salt, upgradedPassword.hash, PASSWORD_SCHEME, user.id, user.password_hash);
          return newSession(requireUser(user.id));
        });
      });
    },

    logout(token) {
      if (validToken(token)) query.deleteSession.run(tokenHash(token));
    },

    getSession(token) {
      if (!validToken(token)) return null;
      pruneSessions();
      const hash = tokenHash(token);
      const session = query.session.get(hash);
      if (!session) return null;
      if (session.expires_at <= Date.now()) {
        query.deleteSession.run(hash);
        return null;
      }
      return { user: publicUser(session), csrfToken: session.csrf_token };
    },

    getPrediction(userId) {
      requireUser(userId);
      return readPrediction(userId);
    },

    saveDraft(userId, teamIds, expectedRevision) {
      return writePrediction(userId, teamIds, 'draft', expectedRevision);
    },

    submitPrediction(userId, teamIds, expectedRevision) {
      return writePrediction(userId, teamIds, 'submitted', expectedRevision);
    },

    adminRenameUser(userId, username, expectedUsername) {
      const canonicalName = validateUsername(username);
      return transaction(() => {
        requireAdminUser(userId, expectedUsername);
        const existing = query.userByName.get(canonicalName);
        if (existing && existing.id !== userId) throw failure(409, 'That username is already taken.');
        query.renameUser.run(canonicalName, username, userId);
        return publicUser(requireUser(userId));
      });
    },

    async adminResetPassword(userId, password, expectedUsername) {
      validatePassword(password);
      requireAdminUser(userId, expectedUsername);
      return authenticate(async () => {
        const salt = randomBytes(32);
        const hash = await deriveKey(password, salt, 64, SCRYPT_OPTIONS);
        return transaction(() => {
          const user = requireAdminUser(userId, expectedUsername);
          query.resetPassword.run(salt.toString('hex'), hash.toString('hex'), PASSWORD_SCHEME, userId);
          query.revokeUserSessions.run(userId);
          return publicUser(user);
        });
      });
    },

    adminResetPrediction(userId, expectedRevision, expectedUsername) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw failure(400, 'Reload the prediction before resetting it.');
      return transaction(() => {
        requireAdminUser(userId, expectedUsername);
        const current = readPrediction(userId);
        if ((current?.revision ?? 0) !== expectedRevision) throw failure(409, 'This prediction changed. Reload it before resetting.');
        if (!current) return null;
        query.savePrediction.run(userId, SEASON, '[]', 'draft', null, new Date().toISOString(), current.revision + 1);
        return readPrediction(userId);
      });
    },

    listSubmitted() {
      return query.submitted.all(SEASON).map(row => ({ ...publicUser(row), teamIds: JSON.parse(row.team_ids), submittedAt: row.submitted_at }));
    },

    // Only the separate localhost administrator listener uses this safe projection.
    listAccounts() {
      return query.accounts.all(SEASON).map(row => ({
        ...publicUser(row), createdAt: row.created_at,
        prediction: row.state ? {
          teamIds: JSON.parse(row.team_ids), state: row.state, submittedAt: row.submitted_at,
          updatedAt: row.updated_at, revision: row.revision,
        } : null,
      }));
    },

    close() { db.close(); },
  };
}
