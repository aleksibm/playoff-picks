import { SLOTS, playerRole, money } from './fantasy-rules.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const rinkLines = '<svg class="half-rink-lines" viewBox="0 0 400 360" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false"><path class="rink-boards" d="M12 10H388V270Q388 348 310 348H90Q12 348 12 270Z"/><path class="rink-red" d="M13 11H387"/><path class="rink-blue" d="M13 117H387"/><path class="rink-goal-line" d="M22 307H378"/><circle class="rink-faceoff" cx="104" cy="220" r="49"/><circle class="rink-faceoff" cx="296" cy="220" r="49"/><circle class="rink-dot" cx="104" cy="220" r="3"/><circle class="rink-dot" cx="296" cy="220" r="3"/><path class="rink-crease" d="M166 307V291A34 34 0 0 1 234 291V307Z"/><path class="rink-net" d="M178 307V328H222V307"/></svg>';

// Keep a left wing on the left and a right wing on the right when available.
// The primary NHL position determines the fantasy role, just as it does for picks.
function formation(players) {
  const pools = { F: [], D: [], G: [] };
  for (const p of Array.isArray(players) ? players : []) if (p && typeof p === 'object') pools[playerRole(p)].push(p);
  const attackers = [null, null, null], overflow = [];
  for (const p of pools.F) {
    const spot = p.position === 'LW' ? 0 : p.position === 'RW' ? 2 : 1;
    if (!attackers[spot]) attackers[spot] = p;
    else overflow.push(p);
  }
  for (const p of overflow) {
    const spot = attackers.indexOf(null);
    if (spot !== -1) attackers[spot] = p;
  }
  pools.F = attackers;
  return SLOTS.map(slot => ({ slot, player: pools[slot.role].shift() }));
}

/** Read-only lineup, sharing the proportions and formation of the team editor. */
export function renderTeamRink(players) {
  const slots = formation(players).map(({ slot, player: p }) => {
    const role = slot.role === 'F' ? 'ATTACK' : slot.role === 'D' ? 'DEFENSE' : 'GOALIE';
    if (!p) return `<div class="roster-slot"><div class="slot-role">${role}</div><div class="slot-main"><strong>No ${slot.label.toLowerCase()} selected</strong></div></div>`;
    const validId = Number.isSafeInteger(p.id) && p.id > 0;
    return `<div class="roster-slot"><div class="slot-role">${role}</div><div class="slot-main filled"><span aria-hidden="true">${esc(p.team)}</span><strong>${esc(p.name)}</strong><small>${Number.isFinite(p.price) ? money(p.price) : '—'}</small></div>${validId ? `<button type="button" class="slot-game-link" data-games="${p.id}" aria-label="View game-by-game points for ${esc(p.name)}">Game log</button>` : ''}</div>`;
  }).join('');
  return `<div class="half-rink team-lineup-rink" role="group" aria-label="Half a hockey rink: three attackers in front, two defensemen behind them, and a goalie in the crease"><div class="rink-scene">${rinkLines}<div class="roster-slots">${slots}</div></div></div>`;
}
