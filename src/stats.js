// Pure functions: rank math, game results, week math, weekly roll-ups.
// No I/O here so everything is unit-testable.

export const RANKED_QUEUE = 'competitive';

// Riot's competitive tier numbers: 0 = unranked, 1-2 unused, 3 = Iron 1, 4 = Iron 2, ... 26 = Immortal 3, 27 = Radiant.
export const TIER_GROUPS = ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Ascendant', 'Immortal', 'Radiant'];
export const IMMORTAL = 24;
export const RADIANT = 27;
export const APEX_BASE = (IMMORTAL - 3) * 100; // Immortal 1, 0 RR on the ladder

/** "Diamond 2", "Radiant", "Unranked". */
export function tierName(tier) {
  if (!(tier >= 3)) return 'Unranked';
  if (tier >= RADIANT) return 'Radiant';
  return `${TIER_GROUPS[Math.floor((tier - 3) / 3)]} ${((tier - 3) % 3) + 1}`;
}

/**
 * One number per rank so RR can be compared across promotions: Iron 1 0 RR = 0, each division = 100.
 * Immortal 1-3 and Radiant share one scale from 2100, since RR there keeps counting up instead of resetting.
 */
export function ladderScore(r) {
  if (!r || !(r.tier >= 3) || !Number.isFinite(r.rr)) return null;
  return r.tier >= IMMORTAL ? APEX_BASE + r.rr : (r.tier - 3) * 100 + r.rr;
}

/** The tier a ladder score falls in. Above Immortal 1 the score alone can't tell Immortal 1-3/Radiant apart, so `apexTier` is used. */
export function tierAtScore(score, apexTier = IMMORTAL) {
  if (score == null) return null;
  return score >= APEX_BASE ? Math.max(IMMORTAL, apexTier ?? IMMORTAL) : 3 + Math.floor(Math.max(0, score) / 100);
}

// ---------------------------------------------------------------- games

/** When the game ended (ms). */
export const matchTime = (m) => m.start + (m.length ?? 0) * 1000;

/**
 * 'W', 'L' or 'D' for one player in a two-team game, null for anything else (Deathmatch, missing data).
 * Riot marks the winning team; a game with no winner is a draw.
 */
export function resultOf(m, p) {
  const mine = m.teams?.[p.team];
  const foes = Object.entries(m.teams ?? {}).filter(([id]) => id !== p.team);
  if (!mine || foes.length !== 1) return null;
  if (mine.win) return 'W';
  if (foes[0][1].win) return 'L';
  return 'D';
}

/** Per-round numbers for one player: ACS, ADR and headshot %. Null when the game has no rounds (or no shots). */
export function perRound(p, rounds) {
  const shots = (p.hs ?? 0) + (p.bs ?? 0) + (p.ls ?? 0);
  return {
    acs: rounds ? Math.round(p.score / rounds) : null,
    adr: rounds ? Math.round(p.dmg / rounds) : null,
    hs: shots ? Math.round((100 * p.hs) / shots) : null,
  };
}

/**
 * Totals for a list of games ([{result, k, d, a, score, dmg, hs, bs, ls, rounds}]). Kept as sums so the site can
 * add players together and work out win rate, K/D, ACS, HS% and ADR from them.
 */
export function gameTotals(list) {
  const t = { games: list.length, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0, assists: 0, score: 0, rounds: 0, dmg: 0, hs: 0, shots: 0 };
  for (const g of list) {
    if (g.result === 'W') t.wins++;
    else if (g.result === 'L') t.losses++;
    else if (g.result === 'D') t.draws++;
    t.kills += g.k ?? 0;
    t.deaths += g.d ?? 0;
    t.assists += g.a ?? 0;
    if (g.rounds) {
      t.score += g.score ?? 0;
      t.dmg += g.dmg ?? 0;
      t.rounds += g.rounds;
    }
    t.hs += g.hs ?? 0;
    t.shots += (g.hs ?? 0) + (g.bs ?? 0) + (g.ls ?? 0);
  }
  return t;
}

// ---------------------------------------------------------------- rank history

/**
 * Every known rank for a player, oldest first, as [t, ladderScore, tier]: the rank after each ranked game
 * (from RR history) plus the tracker's own rank checks. A starting point is added just before the first game
 * (its rank minus that game's RR change), so the line shows the first game too. Repeats are dropped.
 *
 * @param games  [{t, tier, rr, change, before?}] rank right after each ranked game (before = tier going in)
 * @param snaps  [{t, tier, rr}] rank checks
 */
export function rankHistory(games, snaps = []) {
  const pts = [];
  for (const s of snaps) if (s.tier >= 3) pts.push([s.t, ladderScore(s), s.tier]);
  const sorted = games.filter((g) => g.tier >= 3).sort((a, b) => a.t - b.t);
  if (sorted.length && sorted[0].change) {
    const f = sorted[0], start = ladderScore(f) - f.change;
    if (start >= 0) pts.push([f.t - 1, start, f.before >= 3 ? f.before : tierAtScore(start, f.tier)]);
  }
  for (const g of sorted) pts.push([g.t, ladderScore(g), g.tier]);
  pts.sort((a, b) => a[0] - b[0]);
  return pts.filter(([, v, tier], i) => v != null && (i === 0 || v !== pts[i - 1][1] || tier !== pts[i - 1][2]));
}

/** The rank in effect at time t, from rankHistory points; null if unknown or unranked. */
export function rankAt(points, t) {
  let found = null;
  for (const p of points) {
    if (p[0] > t) break;
    found = p;
  }
  if (!found) return null;
  const [, score, tier] = found;
  return { tier, rr: tier >= IMMORTAL ? score - APEX_BASE : score % 100 };
}

// ---------------------------------------------------------------- week math

const fmtCache = new Map();
function zonedParts(t, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
  return {
    y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second,
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

function tzOffset(t, tz) {
  const p = zonedParts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
}

/** UTC ms of local time on y-m-d in tz, `minutes` after midnight (DST-safe; out-of-range days roll over). */
export function zonedTime(y, m, d, minutes, tz) {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}

/** UTC ms of local midnight on y-m-d in tz (DST-safe). */
export const zonedMidnight = (y, m, d, tz) => zonedTime(y, m, d, 0, tz);

/**
 * Week containing instant t. Weeks start on weekday `weekStartsOn` (0 = Sunday) at `startMinutes` after local
 * midnight. key = local date of the week's first full day: the start day itself when weeks start at midnight,
 * otherwise the day after (weeks starting Wednesday 22:00 are named by their Thursday), e.g. "2026-11-05".
 */
export function weekOf(t, tz, weekStartsOn = 1, startMinutes = 0) {
  const p = zonedParts(t, tz);
  let back = (p.wd - weekStartsOn + 7) % 7;
  if (back === 0 && p.h * 60 + p.mi < startMinutes) back = 7; // on the start day, but before the start time
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d - back + (startMinutes ? 1 : 0)));
  return weekFromKey(day.toISOString().slice(0, 10), tz, startMinutes);
}

export function weekFromKey(key, tz, startMinutes = 0) {
  const [y, m, d] = key.split('-').map(Number);
  const startDay = startMinutes ? d - 1 : d;
  return { key, start: zonedTime(y, m, startDay, startMinutes, tz), end: zonedTime(y, m, startDay + 7, startMinutes, tz) };
}

/**
 * Like weekOf, but the start time only applies from the week starting on local date `since` (a start day).
 * Weeks before then keep starting at midnight, and the last of them runs on until the new start time.
 */
export function weekOfFrom(t, tz, weekStartsOn = 1, startMinutes = 0, since = null) {
  if (!since || !startMinutes) return weekOf(t, tz, weekStartsOn, startMinutes);
  const [y, m, d] = since.split('-').map(Number);
  const change = zonedTime(y, m, d, startMinutes, tz);
  if (t >= change) return weekOf(t, tz, weekStartsOn, startMinutes);
  const w = weekOf(t, tz, weekStartsOn, 0);
  if (w.end < zonedMidnight(y, m, d, tz)) return w;
  const last = weekFromKey(new Date(Date.UTC(y, m - 1, d - 7)).toISOString().slice(0, 10), tz);
  return { ...last, end: change };
}

/** Every week from the one containing `from` to the one containing `to`, newest first. */
export function weekRange(from, to, tz, weekStartsOn = 1, startMinutes = 0, since = null) {
  const at = (t) => weekOfFrom(t, tz, weekStartsOn, startMinutes, since);
  const weeks = [];
  let w = at(to);
  const first = at(from).key;
  while (true) {
    weeks.push(w);
    if (w.key <= first) break;
    w = at(w.start - 1);
  }
  return weeks;
}


// ---------------------------------------------------------------- weekly roll-up

/**
 * @param games    [{id, time, queue, result, k, d, a, score, dmg, hs, bs, ls, rounds}] all of the player's games
 * @param rrGames  [{id, time, change}] RR change for each ranked game (from the RR history, so exact)
 * @param weeks    [{key, start, end}]
 * @param now      ms; caps "end of week" for the week in progress
 * @param points   rankHistory points, for the rank at the end of each week
 * @param since    ms; the player's earliest known data. Weeks that ended before it have no RR (null), not 0.
 */
export function weeklySummary({ games, rrGames, weeks, now, points = [], since = null }) {
  const withRr = new Set(rrGames.map((g) => g.id));
  const out = {};
  for (const w of weeks) {
    const inWeek = (t) => t >= w.start && t < w.end;
    const ranked = games.filter((g) => g.queue === RANKED_QUEUE && inWeek(g.time));
    const rrIn = rrGames.filter((g) => inWeek(g.time));
    const known = since != null && since < w.end;
    out[w.key] = {
      rr: known ? rrIn.reduce((sum, g) => sum + (g.change ?? 0), 0) : null,
      // ranked games that week with no RR recorded (the week's net RR leaves them out)
      missing: ranked.filter((g) => !withRr.has(g.id)).length,
      ranked: gameTotals(ranked),
      otherGames: games.filter((g) => g.queue !== RANKED_QUEUE && inWeek(g.time)).length,
      endRank: rankAt(points, Math.min(w.end - 1, now)),
    };
  }
  return out;
}
