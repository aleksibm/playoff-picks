import { TEAMS } from './dist/game.js';

export const TARGET_SEASON = 20262027;

// This NHL endpoint returns cumulative regular-season standings, not goals or
// playoff results. Do not replace an unavailable season with the previous one.
const STANDINGS_URL = 'https://api-web.nhle.com/v1/standings/now';
const TEAM_IDS = new Set(TEAMS.map(team => team.id));
const SEASON_LABEL = '2026–27';
const MAX_FEED_BYTES = 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid NHL standings: ${label} must be a nonnegative integer.`);
  }
  return value;
}

function requireDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError('Invalid NHL standings: a valid standings date is required.');
  }
  return value;
}

function validateTeamCounts(team, id) {
  if (!isRecord(team)) throw new TypeError(`Invalid NHL standings for ${id}.`);
  const points = requireCount(team.points, `${id} points`);
  const gamesPlayed = requireCount(team.gamesPlayed, `${id} games played`);
  const wins = requireCount(team.wins, `${id} wins`);
  const otLosses = requireCount(team.otLosses, `${id} overtime losses`);
  // Use the feed's points as the authority. Rule 84.2 permits forfeiting an
  // overtime point after pulling the goalie, so 2*wins + otLosses is an upper
  // bound rather than a formula from which to rebuild the official total.
  // https://media.nhl.com/site/asset/public/ext/2025-26/2025-26Rules.pdf
  if (wins + otLosses > gamesPlayed || points < 2 * wins || points > 2 * wins + otLosses) {
    throw new TypeError(`Invalid NHL standings: ${id} points do not match its regular-season record.`);
  }
  if (team.losses !== undefined) {
    const losses = requireCount(team.losses, `${id} losses`);
    if (wins + losses + otLosses !== gamesPlayed) {
      throw new TypeError(`Invalid NHL standings: ${id} games played do not match its record.`);
    }
  }
  return { points, gamesPlayed, wins, otLosses };
}

/** Convert the official NHL standings JSON into a fully checked season snapshot. */
export function parseStandings(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.standings)
      || payload.standings.length !== TEAM_IDS.size) {
    throw new TypeError('Invalid NHL standings: all 32 teams are required.');
  }
  if (payload.gameTypeId !== undefined && payload.gameTypeId !== 2) {
    throw new TypeError('Only NHL regular-season standings can be scored.');
  }
  if (payload.seasonId !== undefined && payload.seasonId !== TARGET_SEASON) {
    throw new TypeError(`NHL standings are not available for the ${SEASON_LABEL} season.`);
  }
  const teams = {};
  let asOf;
  for (const row of payload.standings) {
    if (!isRecord(row)) throw new TypeError('Invalid NHL standings: malformed team record.');
    if (row.seasonId !== TARGET_SEASON) {
      throw new TypeError(`NHL standings are not available for the ${SEASON_LABEL} season.`);
    }
    // The official standings endpoint is regular-season only. Some response
    // schemas omit gameTypeId; reject an explicit contrary type when present.
    if (row.gameTypeId !== undefined && row.gameTypeId !== 2) {
      throw new TypeError('Only NHL regular-season standings can be scored.');
    }
    const id = row.teamAbbrev?.default;
    if (!TEAM_IDS.has(id)) throw new TypeError('Invalid NHL standings: an unknown team was returned.');
    if (Object.hasOwn(teams, id)) throw new TypeError(`Invalid NHL standings: duplicate team ${id}.`);
    const date = requireDate(row.date);
    if (asOf !== undefined && date !== asOf) {
      throw new TypeError('Invalid NHL standings: team records have inconsistent dates.');
    }
    asOf = date;
    teams[id] = validateTeamCounts(row, id);
  }
  return { season: TARGET_SEASON, asOf, teams, fetchedAt: new Date().toISOString() };
}

function validateSnapshot(snapshot) {
  if (!isRecord(snapshot) || snapshot.season !== TARGET_SEASON || !isRecord(snapshot.teams)
      || Object.keys(snapshot.teams).length !== TEAM_IDS.size) {
    throw new TypeError(`A complete ${SEASON_LABEL} NHL standings snapshot is required to score predictions.`);
  }
  requireDate(snapshot.asOf);
  for (const id of TEAM_IDS) {
    if (!Object.hasOwn(snapshot.teams, id)) {
      throw new TypeError(`Invalid NHL standings: missing team ${id}.`);
    }
    validateTeamCounts(snapshot.teams[id], id);
  }
}

/** Each selected team's NHL standings point contributes exactly one pool point. */
export function scorePrediction(teamIds, snapshot) {
  validateSnapshot(snapshot);
  if (!Array.isArray(teamIds)) throw new TypeError('Prediction team IDs must be an array.');
  const seen = new Set();
  let points = 0;
  for (const id of teamIds) {
    if (!TEAM_IDS.has(id)) throw new TypeError('Prediction contains an unknown team.');
    if (seen.has(id)) throw new TypeError('Prediction contains a duplicate team.');
    seen.add(id);
    points += snapshot.teams[id].points;
  }
  return points;
}

/** Equal scores share competition ranks; usernames only order the tied rows. */
export function rankEntries(entries, snapshot) {
  if (!Array.isArray(entries)) throw new TypeError('Leaderboard entries must be an array.');
  validateSnapshot(snapshot);
  const scored = entries.map(entry => {
    if (!isRecord(entry) || typeof entry.username !== 'string') {
      throw new TypeError('Invalid leaderboard entry.');
    }
    return { ...entry, points: scorePrediction(entry.teamIds, snapshot) };
  });
  scored.sort((left, right) => right.points - left.points
    || left.username.localeCompare(right.username, 'en', { sensitivity: 'base' }));
  let rank = 0;
  let previousPoints;
  return scored.map((entry, index) => {
    if (entry.points !== previousPoints) rank = index + 1;
    previousPoints = entry.points;
    return { ...entry, rank };
  });
}

/** Fetch only official NHL data, with a bounded wait and strict season checks. */
export async function fetchStandings(fetchImpl = fetch) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const response = await fetchImpl(STANDINGS_URL, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response?.ok) {
    throw new Error(`The official NHL standings feed is unavailable (HTTP ${response?.status ?? 'unknown'}).`);
  }
  // A corrupted or unexpectedly large upstream response must not exhaust the
  // hosting laptop. The fixed endpoint never accepts user-supplied URLs.
  if (Number(response.headers.get('content-length')) > MAX_FEED_BYTES) {
    await response.body?.cancel();
    throw new Error('The NHL standings response is too large.');
  }
  if (!response.body) throw new Error('The NHL standings response is empty.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) {
        await reader.cancel();
        throw new Error('The NHL standings response is too large.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return parseStandings(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
}
