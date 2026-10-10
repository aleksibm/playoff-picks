// Team names and alignment: https://www.nhl.com/info/teams/
// Prediction rules mirror the NHL's three division berths and two wild cards.
export const SEASON = '2026–27';

export const DIVISIONS = Object.freeze([
  { id: 'Atlantic', name: 'Atlantic', conference: 'East' },
  { id: 'Metropolitan', name: 'Metropolitan', conference: 'East' },
  { id: 'Central', name: 'Central', conference: 'West' },
  { id: 'Pacific', name: 'Pacific', conference: 'West' },
].map(Object.freeze));

export const TEAMS = Object.freeze([
  { id: 'BOS', city: 'Boston', name: 'Bruins', color: '#FFB81C', division: 'Atlantic', conference: 'East' },
  { id: 'BUF', city: 'Buffalo', name: 'Sabres', color: '#003087', division: 'Atlantic', conference: 'East' },
  { id: 'DET', city: 'Detroit', name: 'Red Wings', color: '#CE1126', division: 'Atlantic', conference: 'East' },
  { id: 'FLA', city: 'Florida', name: 'Panthers', color: '#C8102E', division: 'Atlantic', conference: 'East' },
  { id: 'MTL', city: 'Montréal', name: 'Canadiens', color: '#AF1E2D', division: 'Atlantic', conference: 'East' },
  { id: 'OTT', city: 'Ottawa', name: 'Senators', color: '#C52032', division: 'Atlantic', conference: 'East' },
  { id: 'TBL', city: 'Tampa Bay', name: 'Lightning', color: '#002868', division: 'Atlantic', conference: 'East' },
  { id: 'TOR', city: 'Toronto', name: 'Maple Leafs', color: '#003E7E', division: 'Atlantic', conference: 'East' },
  { id: 'CAR', city: 'Carolina', name: 'Hurricanes', color: '#CC0000', division: 'Metropolitan', conference: 'East' },
  { id: 'CBJ', city: 'Columbus', name: 'Blue Jackets', color: '#002654', division: 'Metropolitan', conference: 'East' },
  { id: 'NJD', city: 'New Jersey', name: 'Devils', color: '#CE1126', division: 'Metropolitan', conference: 'East' },
  { id: 'NYI', city: 'New York', name: 'Islanders', color: '#00539B', division: 'Metropolitan', conference: 'East' },
  { id: 'NYR', city: 'New York', name: 'Rangers', color: '#0038A8', division: 'Metropolitan', conference: 'East' },
  { id: 'PHI', city: 'Philadelphia', name: 'Flyers', color: '#F74902', division: 'Metropolitan', conference: 'East' },
  { id: 'PIT', city: 'Pittsburgh', name: 'Penguins', color: '#FCB514', division: 'Metropolitan', conference: 'East' },
  { id: 'WSH', city: 'Washington', name: 'Capitals', color: '#C8102E', division: 'Metropolitan', conference: 'East' },
  { id: 'CHI', city: 'Chicago', name: 'Blackhawks', color: '#CF0A2C', division: 'Central', conference: 'West' },
  { id: 'COL', city: 'Colorado', name: 'Avalanche', color: '#6F263D', division: 'Central', conference: 'West' },
  { id: 'DAL', city: 'Dallas', name: 'Stars', color: '#006847', division: 'Central', conference: 'West' },
  { id: 'MIN', city: 'Minnesota', name: 'Wild', color: '#154734', division: 'Central', conference: 'West' },
  { id: 'NSH', city: 'Nashville', name: 'Predators', color: '#FFB81C', division: 'Central', conference: 'West' },
  { id: 'STL', city: 'St. Louis', name: 'Blues', color: '#002F87', division: 'Central', conference: 'West' },
  { id: 'UTA', city: 'Utah', name: 'Mammoth', color: '#69B3E7', division: 'Central', conference: 'West' },
  { id: 'WPG', city: 'Winnipeg', name: 'Jets', color: '#041E42', division: 'Central', conference: 'West' },
  { id: 'ANA', city: 'Anaheim', name: 'Ducks', color: '#F47A38', division: 'Pacific', conference: 'West' },
  { id: 'CGY', city: 'Calgary', name: 'Flames', color: '#C8102E', division: 'Pacific', conference: 'West' },
  { id: 'EDM', city: 'Edmonton', name: 'Oilers', color: '#FF4C00', division: 'Pacific', conference: 'West' },
  { id: 'LAK', city: 'Los Angeles', name: 'Kings', color: '#A2AAAD', division: 'Pacific', conference: 'West' },
  { id: 'SJS', city: 'San Jose', name: 'Sharks', color: '#006D75', division: 'Pacific', conference: 'West' },
  { id: 'SEA', city: 'Seattle', name: 'Kraken', color: '#99D9D9', division: 'Pacific', conference: 'West' },
  { id: 'VAN', city: 'Vancouver', name: 'Canucks', color: '#00843D', division: 'Pacific', conference: 'West' },
  { id: 'VGK', city: 'Vegas', name: 'Golden Knights', color: '#B4975A', division: 'Pacific', conference: 'West' },
].map(Object.freeze));

const teamsById = new Map(TEAMS.map(team => [team.id, team]));
const conferenceNames = { East: 'Eastern', West: 'Western' };

function emptyCounts() {
  return {
    East: 0,
    West: 0,
    divisions: Object.fromEntries(DIVISIONS.map(division => [division.id, 0])),
  };
}

/** Recover a usable draft from untrusted saved data without changing its order. */
export function sanitizePicks(input) {
  if (!Array.isArray(input)) return [];
  const picks = [];
  const seen = new Set();
  const counts = emptyCounts();
  for (const id of input) {
    const team = teamsById.get(id);
    if (!team || seen.has(id)) continue;
    seen.add(id);
    if (counts[team.conference] >= 8 || counts.divisions[team.division] >= 5) continue;
    picks.push(id);
    counts[team.conference] += 1;
    counts.divisions[team.division] += 1;
  }
  return picks;
}

export function getProgress(input) {
  const picks = sanitizePicks(input);
  const counts = emptyCounts();
  for (const id of picks) {
    const team = teamsById.get(id);
    counts[team.conference] += 1;
    counts.divisions[team.division] += 1;
  }
  return {
    total: picks.length,
    east: counts.East,
    west: counts.West,
    divisions: counts.divisions,
    complete: counts.East === 8 && counts.West === 8
      && Object.values(counts.divisions).every(count => count >= 3 && count <= 5),
  };
}

/** Remove picks freely; reserve space for the other division when adding. */
export function togglePick(input, id) {
  const picks = sanitizePicks(input);
  const team = teamsById.get(id);
  if (!team) return { picks, error: 'That team is not available. Please choose a team from the board.' };
  if (picks.includes(id)) return { picks: picks.filter(pick => pick !== id), error: null };
  const progress = getProgress(picks);
  if (progress.divisions[team.division] >= 5) {
    return { picks, error: `You can pick up to 5 teams from the ${team.division} Division. Remove a pick to make room.` };
  }
  if (progress[team.conference === 'East' ? 'east' : 'west'] >= 8) {
    return { picks, error: `Your ${conferenceNames[team.conference]} Conference is full. Remove a pick to make room.` };
  }
  return { picks: [...picks, id], error: null };
}

export function createPickSheet(input) {
  const picks = sanitizePicks(input);
  const chosen = new Set(picks);
  const progress = getProgress(picks);
  const lines = [
    `PLAYOFF PICKS · ${SEASON}`,
    `${progress.total}/16 teams picked${progress.complete ? ' · Complete prediction' : ' · Draft prediction'}`,
  ];
  for (const conference of ['East', 'West']) {
    lines.push('', `${conferenceNames[conference]} Conference (${progress[conference === 'East' ? 'east' : 'west']}/8)`);
    for (const division of DIVISIONS.filter(item => item.conference === conference)) {
      lines.push(`${division.name} Division`);
      const teams = TEAMS.filter(team => team.division === division.id && chosen.has(team.id));
      lines.push(...(teams.length ? teams.map(team => `  • ${team.city} ${team.name}`) : ['  — No teams picked yet']));
    }
  }
  lines.push('', 'Pick 8 teams per conference, with at least 3 from each division.', 'A fan prediction, independent of the NHL.');
  return lines.join('\n');
}

/** Canonical, compact query value; independent of selection order. */
export function encodePicks(input) {
  return sanitizePicks(input).sort().join('.');
}

/** Shared links must be wholly valid; never silently alter a shared prediction. */
export function decodePicks(encoded) {
  if (typeof encoded !== 'string') return null;
  if (encoded === '') return [];
  if (!/^[A-Z]{3}(?:\.[A-Z]{3}){0,15}$/.test(encoded)) return null;
  const picks = encoded.split('.');
  const valid = sanitizePicks(picks);
  return valid.length === picks.length ? valid : null;
}
