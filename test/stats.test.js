import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ladderScore, tierName, tierAtScore, resultOf, perRound, gameTotals, rankHistory, rankAt, matchTime,
  weekOf, weekOfFrom, weekFromKey, weekRange, weeklySummary, RANKED_QUEUE,
} from '../src/stats.js';

const TZ = 'America/Los_Angeles';
const HOUR = 3600e3;

test('tier numbers have the in-game names', () => {
  assert.equal(tierName(3), 'Iron 1');
  assert.equal(tierName(5), 'Iron 3');
  assert.equal(tierName(19), 'Diamond 2');
  assert.equal(tierName(23), 'Ascendant 3');
  assert.equal(tierName(24), 'Immortal 1');
  assert.equal(tierName(27), 'Radiant');
  assert.equal(tierName(0), 'Unranked');
  assert.equal(tierName(null), 'Unranked');
});

test('ladderScore puts every rank on one scale, with Immortal and up sharing one RR scale', () => {
  assert.equal(ladderScore({ tier: 3, rr: 0 }), 0);
  assert.equal(ladderScore({ tier: 13, rr: 50 }), 1050); // Gold 2
  assert.equal(ladderScore({ tier: 23, rr: 99 }), 2099); // Ascendant 3
  assert.equal(ladderScore({ tier: 24, rr: 0 }), 2100); // Immortal 1
  assert.equal(ladderScore({ tier: 26, rr: 250 }), 2350); // Immortal 3, 250 RR
  assert.equal(ladderScore({ tier: 27, rr: 500 }), 2600); // Radiant
  assert.equal(ladderScore({ tier: 0, rr: 0 }), null);
  assert.equal(ladderScore(null), null);
  // Deranking from Diamond 1 10 RR to Platinum 3 85 RR is -25, not a whole division.
  assert.equal(ladderScore({ tier: 17, rr: 85 }) - ladderScore({ tier: 18, rr: 10 }), -25);
  assert.equal(tierAtScore(1050), 13);
  assert.equal(tierAtScore(2350, 26), 26);
  assert.equal(tierAtScore(2350, 20), 24); // an apex score is at least Immortal 1
});

test('results come from the winning team; no winner is a draw; other modes have none', () => {
  const m = { teams: { Red: { won: 13, lost: 8, win: true }, Blue: { won: 8, lost: 13, win: false } } };
  assert.equal(resultOf(m, { team: 'Red' }), 'W');
  assert.equal(resultOf(m, { team: 'Blue' }), 'L');
  const draw = { teams: { Red: { won: 12, lost: 12, win: false }, Blue: { won: 12, lost: 12, win: false } } };
  assert.equal(resultOf(draw, { team: 'Red' }), 'D');
  assert.equal(resultOf({ teams: {} }, { team: 'Red' }), null); // Deathmatch
  assert.equal(resultOf({ teams: { a: {}, b: {}, c: {} } }, { team: 'a' }), null);
});

test('ACS, ADR and headshot % are per round / per shot, and empty when there is nothing to divide by', () => {
  assert.deepEqual(perRound({ score: 4200, dmg: 3150, hs: 10, bs: 28, ls: 2 }, 21), { acs: 200, adr: 150, hs: 25 });
  assert.deepEqual(perRound({ score: 10, dmg: 10, hs: 0, bs: 0, ls: 0 }, 0), { acs: null, adr: null, hs: null });
});

test('game totals add up records and keep sums for the ratios', () => {
  const t = gameTotals([
    { result: 'W', k: 20, d: 10, a: 5, score: 5000, dmg: 3500, hs: 10, bs: 20, ls: 0, rounds: 20 },
    { result: 'L', k: 10, d: 15, a: 2, score: 3000, dmg: 2500, hs: 5, bs: 15, ls: 0, rounds: 20 },
    { result: 'D', k: 5, d: 5, a: 1, score: 1000, dmg: 800, hs: 0, bs: 5, ls: 0, rounds: 24 },
    { result: null, k: 30, d: 20, a: 0, score: 999, dmg: 999, hs: 3, bs: 3, ls: 0, rounds: null }, // Deathmatch
  ]);
  assert.deepEqual(t, { games: 4, wins: 1, losses: 1, draws: 1, kills: 65, deaths: 50, assists: 8, score: 9000, rounds: 64, dmg: 6800, hs: 18, shots: 61 });
});

test('weeks start Monday midnight Pacific, across the DST change', () => {
  // DST ends Sun Nov 1 2026, so Mon Nov 2 00:00 PST = 08:00 UTC.
  assert.equal(weekOf(Date.UTC(2026, 10, 2, 7, 59), TZ).key, '2026-10-26');
  const w = weekOf(Date.UTC(2026, 10, 2, 8, 0), TZ);
  assert.equal(w.key, '2026-11-02');
  assert.equal(w.start, Date.UTC(2026, 10, 2, 8));
  assert.equal(w.end, Date.UTC(2026, 10, 9, 8));
  const prev = weekOf(Date.UTC(2026, 9, 28), TZ);
  assert.equal(prev.start, Date.UTC(2026, 9, 26, 7)); // PDT
  assert.equal(prev.end, w.start);
  const range = weekRange(Date.UTC(2026, 9, 20), Date.UTC(2026, 10, 5), TZ);
  assert.deepEqual(range.map((x) => x.key), ['2026-11-02', '2026-10-26', '2026-10-19']);
});

test('weeks can start Wednesday 10pm Pacific and are named by their Thursday', () => {
  const at = (key) => weekOf(key, TZ, 3, 22 * 60);
  assert.equal(at(Date.UTC(2026, 10, 5, 5, 59)).key, '2026-10-29');
  const w = at(Date.UTC(2026, 10, 5, 6, 0));
  assert.equal(w.key, '2026-11-05');
  assert.equal(w.start, Date.UTC(2026, 10, 5, 6));
  assert.equal(w.end, Date.UTC(2026, 10, 12, 6));
  const dst = at(Date.UTC(2026, 9, 31));
  assert.equal(dst.start, Date.UTC(2026, 9, 29, 5)); // Wed Oct 28 22:00 PDT
  assert.equal(dst.end, w.start);
  assert.deepEqual(weekFromKey('2026-11-05', TZ, 22 * 60), { key: '2026-11-05', start: w.start, end: w.end });
});

test('switching to a 10pm start leaves earlier weeks alone and stretches the last old week', () => {
  const at = (t) => weekOfFrom(t, TZ, 3, 22 * 60, '2026-11-11');
  const stretched = { key: '2026-11-04', start: Date.UTC(2026, 10, 4, 8), end: Date.UTC(2026, 10, 12, 6) };
  assert.deepEqual(at(Date.UTC(2026, 10, 11, 9)), stretched);
  assert.deepEqual(at(Date.UTC(2026, 10, 12, 6)), { key: '2026-11-12', start: Date.UTC(2026, 10, 12, 6), end: Date.UTC(2026, 10, 19, 6) });
  const range = weekRange(Date.UTC(2026, 9, 29), Date.UTC(2026, 10, 20), TZ, 3, 22 * 60, '2026-11-11');
  assert.ok(range.every((x, i) => i === 0 || x.end === range[i - 1].start), 'weeks leave no gaps');
});

test('a game counts at its end time', () => {
  assert.equal(matchTime({ start: 1_000_000, length: 2000 }), 1_000_000 + 2_000_000);
});

test('rank history starts just before the first game and keeps Immortal tiers apart', () => {
  const games = [
    { t: 1000, tier: 23, rr: 90, change: 20 }, // Ascendant 3 70 -> 90
    { t: 2000, tier: 24, rr: 10, change: 20 }, // promoted to Immortal 1
    { t: 3000, tier: 24, rr: 10, change: 0 },  // a draw: no new point
  ];
  const snaps = [{ t: 500, tier: 23, rr: 70 }, { t: 3500, tier: 25, rr: 10 }]; // same RR, but now Immortal 2
  assert.deepEqual(rankHistory(games, snaps), [
    [500, 2070, 23],
    [1000, 2090, 23],
    [2000, 2110, 24],
    [3500, 2110, 25],
  ]);
  // Without a rank check before it, the first game's starting rank comes from its RR change.
  assert.deepEqual(rankHistory(games.slice(0, 1)), [[999, 2070, 23], [1000, 2090, 23]]);
  assert.deepEqual(rankAt(rankHistory(games, snaps), 2500), { tier: 24, rr: 10 });
  assert.equal(rankAt(rankHistory(games, snaps), 100), null);
});

test('weekly summary sums RR per week, flags games without RR, and leaves weeks before any data empty', () => {
  const weeks = [weekFromKey('2026-11-09', TZ), weekFromKey('2026-11-02', TZ), weekFromKey('2026-10-26', TZ)];
  const at = (key, hours) => weekFromKey(key, TZ).start + hours * HOUR;
  const games = [
    { id: 'a', time: at('2026-11-02', 20), queue: RANKED_QUEUE, result: 'W', k: 20, d: 10, a: 3, score: 4000, dmg: 3000, hs: 5, bs: 15, ls: 0, rounds: 20 },
    { id: 'b', time: at('2026-11-02', 22), queue: RANKED_QUEUE, result: 'L', k: 10, d: 15, a: 3, score: 3000, dmg: 2000, hs: 5, bs: 15, ls: 0, rounds: 20 },
    { id: 'c', time: at('2026-11-02', 23), queue: 'unrated', result: 'W', k: 9, d: 9, a: 9, score: 1, dmg: 1, hs: 1, bs: 1, ls: 0, rounds: 20 },
    { id: 'd', time: at('2026-11-09', 5), queue: RANKED_QUEUE, result: 'W', k: 15, d: 10, a: 3, score: 3500, dmg: 2600, hs: 4, bs: 12, ls: 0, rounds: 22 },
  ];
  const rrGames = [{ id: 'a', time: games[0].time, change: 21 }, { id: 'b', time: games[1].time, change: -17 }];
  const points = [[at('2026-11-02', 20), 1590, 18], [at('2026-11-02', 22), 1573, 18]];
  const out = weeklySummary({ games, rrGames, weeks, now: at('2026-11-09', 10), points, since: at('2026-11-02', 19) });
  assert.equal(out['2026-11-02'].rr, 4);
  assert.equal(out['2026-11-02'].missing, 0);
  assert.equal(out['2026-11-02'].otherGames, 1);
  assert.deepEqual([out['2026-11-02'].ranked.wins, out['2026-11-02'].ranked.losses, out['2026-11-02'].ranked.kills], [1, 1, 30]);
  assert.deepEqual(out['2026-11-02'].endRank, { tier: 18, rr: 73 });
  assert.equal(out['2026-11-09'].rr, 0);
  assert.equal(out['2026-11-09'].missing, 1); // game d has no RR yet
  assert.equal(out['2026-10-26'].rr, null); // before the player's first data
  assert.equal(out['2026-10-26'].endRank, null);
});
