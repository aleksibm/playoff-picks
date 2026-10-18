export const FANTASY_SEASON = '20262027';
export const BUDGET = 40_000_000;
export const TRANSFERS_PER_MONTH = 2;
export const SLOTS = [{ role: 'F', label: 'Attacker' }, { role: 'F', label: 'Attacker' }, { role: 'F', label: 'Attacker' }, { role: 'D', label: 'Defenseman' }, { role: 'D', label: 'Defenseman' }, { role: 'G', label: 'Goalie' }];
export const playerRole = p => p.position === 'G' ? 'G' : p.position === 'D' ? 'D' : 'F';
export const money = dollars => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(dollars);
export const points = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value) : '—';
export function transferMonth(time = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit' }).formatToParts(new Date(time));
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}
export function rosterProgress(ids, players, funds = BUDGET) {
  const byId = players instanceof Map ? players : new Map(players.map(p => [p.id, p]));
  const selected = ids.map(id => byId.get(id)).filter(Boolean);
  const counts = { F: 0, D: 0, G: 0 };
  let cost = 0;
  for (const p of selected) { counts[playerRole(p)]++; cost += p.price; }
  const valid = selected.length === ids.length && new Set(ids).size === ids.length && counts.F <= 3 && counts.D <= 2 && counts.G <= 1 && ids.length <= 6 && Number.isSafeInteger(funds) && cost <= funds;
  return { counts, cost, remaining: funds - cost, valid, complete: valid && counts.F === 3 && counts.D === 2 && counts.G === 1 };
}
export function validateRoster(ids, players, complete = false, funds = BUDGET) {
  if (!Array.isArray(ids) || ids.length > 6 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Choose up to six unique NHL players.');
  const progress = rosterProgress(ids, players, funds);
  if (!progress.valid) throw new Error('Stay within your available funds and choose at most 1 goalie, 2 defensemen and 3 attackers.');
  if (complete && !progress.complete) throw new Error('Complete your team: 1 goalie, 2 defensemen and 3 attackers.');
  return [...ids];
}
