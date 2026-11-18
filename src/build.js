// Turn data/ (rank checks, RR history, games) into the JSON the website reads:
//   site/data/site.json         players, current ranks, weekly RR + stats, rank history
//   site/data/weeks/<key>.json  every tracked player's games that week, with RR changes
//   site/data/lobbies/<id>.json the full scoreboard of one game, for the scoreboard popup (not committed)
//
//   node src/build.js [--data data] [--out site/data] [--config config.json]

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, arg, loadConfig, DataStore, writeJson } from './store.js';
import { listIcons } from './icons.js';
import { RANKED_QUEUE, ladderScore, matchTime, perRound, rankHistory, resultOf, weekRange, weeklySummary } from './stats.js';

const cfg = loadConfig(arg('config', path.join(ROOT, 'config.json')));
const store = new DataStore(arg('data', path.join(ROOT, 'data')));
const outDir = arg('out', path.join(ROOT, 'site', 'data'));
const now = Number(arg('now', Date.now()));
const from = cfg.trackFromMs ?? 0;

const players = cfg.players
  .map((p) => ({ ...p, rec: store.players[p.key] }))
  .filter((p) => p.rec?.puuid);
const slugOf = new Map(players.map((p) => [p.rec.puuid, p.slug]));
// Games before trackFrom stay on disk but are left off the site.
const matches = [...store.matches.values()].filter((m) => Number.isFinite(m.start) && matchTime(m) >= from);
const matchById = new Map(matches.map((m) => [m.id, m]));

/** Score of the player's own team and the other team, when it's a two-team game. */
function scoreLine(m, team) {
  const mine = m.teams?.[team];
  const foes = Object.entries(m.teams ?? {}).filter(([id]) => id !== team);
  return mine && foes.length === 1 ? { us: mine.won, them: foes[0][1].won } : { us: null, them: null };
}

// ---- per player: games, RR per game, rank history
const perPlayer = [];
let earliest = now;
for (const p of players) {
  const puuid = p.rec.puuid;
  const snaps = [...(store.snapshots[puuid] ?? [])].sort((a, b) => a.t - b.t);
  // RR per ranked game, timed by the game's end when we have the game (the RR history's date otherwise)
  const rr = Object.entries(store.rr[puuid] ?? {})
    .map(([id, e]) => ({ id, ...e, time: matchById.has(id) ? matchTime(matchById.get(id)) : e.t }))
    .filter((e) => Number.isFinite(e.time) && e.time >= from)
    .sort((a, b) => a.time - b.time);
  const games = [];
  for (const m of matches) {
    const pp = m.players[puuid];
    if (!pp) continue;
    games.push({ id: m.id, time: matchTime(m), queue: m.queue, result: resultOf(m, pp), rounds: m.rounds, ...pp });
  }
  games.sort((a, b) => a.time - b.time);
  const history = rankHistory(rr.map((e) => ({ ...e, t: e.time })), snaps);
  const since = Math.min(snaps[0]?.t ?? Infinity, rr[0]?.time ?? Infinity, games[0]?.time ?? Infinity, history[0]?.[0] ?? Infinity);
  if (Number.isFinite(since)) earliest = Math.min(earliest, since);
  perPlayer.push({ p, snaps, rr, games, history, since: Number.isFinite(since) ? since : null });
}

const weeks = weekRange(earliest, now, cfg.timezone, cfg.weekStartsOn, cfg.weekStartMinutes, cfg.weekStartsAtFrom);

// Week numbers count from config.weekOne (the first day of week 1, e.g. the act's first week).
// Weeks before it, or every week when weekOne isn't set, have no number.
const dayIndex = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400e3; };
if (cfg.weekOne && !/^\d{4}-\d{2}-\d{2}$/.test(cfg.weekOne)) throw new Error(`weekOne "${cfg.weekOne}" must look like 2026-09-23`);
// The "Check for new games" button's worker (worker/update-button.js); no button without it.
if (cfg.updateUrl && !/^https:\/\/\S+$/.test(cfg.updateUrl)) throw new Error(`updateUrl "${cfg.updateUrl}" must be an https:// URL`);
const weekNumber = (key) => {
  if (!cfg.weekOne) return null;
  const n = Math.floor((dayIndex(key) - dayIndex(cfg.weekOne)) / 7) + 1;
  return n >= 1 ? n : null;
};

// ---- site.json
const rank = (r) => (r && r.tier >= 3 ? { tier: r.tier, rr: r.rr } : null);
const site = {
  teamName: cfg.teamName ?? 'Valorant Team',
  updateUrl: cfg.updateUrl ?? null,
  timezone: cfg.timezone,
  rankedQueue: RANKED_QUEUE,
  queueNames: cfg.queueNames ?? {},
  latestActivity: null,
  // Ids with an icon in site/img/agents, maps and ranks (the site falls back to text otherwise), and names.
  agentIcons: listIcons(path.join(ROOT, 'site', 'img', 'agents')),
  mapIcons: listIcons(path.join(ROOT, 'site', 'img', 'maps')),
  rankIcons: listIcons(path.join(ROOT, 'site', 'img', 'ranks')).map(Number).sort((a, b) => a - b),
  names: store.icons.names ?? {},
  weeks: weeks.map(({ key, start, end }) => ({ key, start, end, num: weekNumber(key) })),
  players: perPlayer.map(({ p, snaps, rr, games, history, since }) => {
    // Rank right now: the latest rank check, or the rank after their latest ranked game if that's newer.
    const lastSnap = snaps.at(-1), lastGame = rr.filter((e) => e.tier != null).at(-1);
    const current = lastGame && (!lastSnap || lastGame.time > lastSnap.t) ? lastGame : lastSnap;
    const peakSeen = [...snaps, ...rr].filter((s) => ladderScore(s) != null)
      .reduce((best, s) => (!best || ladderScore(s) > ladderScore(best) ? s : best), null);
    return {
      slug: p.slug,
      name: p.name,
      riotId: p.rec.riotId ?? p.riotId,
      current: rank(current),
      // HenrikDev's all-time peak, else the best rank the tracker has seen
      peak: p.rec.peak ?? (peakSeen ? { ...rank(peakSeen), season: null } : null),
      trackedSince: snaps[0]?.t ?? null,
      weeks: weeklySummary({ games, rrGames: rr, weeks, now, points: history, since }),
      history,
    };
  }),
};
for (const { snaps, games } of perPlayer) {
  const latest = Math.max(snaps.at(-1)?.t ?? 0, games.at(-1)?.time ?? 0);
  site.latestActivity = Math.max(site.latestActivity ?? 0, latest) || null;
}
writeJson(path.join(outDir, 'site.json'), site, 3);
// When this build ran: the site's "Last updated" line. Its own small file, kept out of git (.gitignore),
// so a check that finds nothing new doesn't make a commit.
writeJson(path.join(outDir, 'status.json'), { updatedAt: now }, 1);

// ---- lobbies/<matchId>.json: fetched only when someone opens the popup, so the week files stay small.
// Rebuilt from data/ on every run and kept out of git (.gitignore).
const lobbyDir = path.join(outDir, 'lobbies');
const lobbyFiles = new Set();
const line = (m, pp) => ({ agent: pp.agent, agentId: pp.agentId, tier: pp.tier, k: pp.k, d: pp.d, a: pp.a, ...perRound(pp, m.rounds), party: pp.party });
/** Writes the game's scoreboard file and returns its number of players. */
function writeLobby(m) {
  const all = [
    ...Object.entries(m.players).filter(([puuid]) => slugOf.has(puuid)).map(([puuid, pp]) => ({ player: slugOf.get(puuid), team: pp.team, ...line(m, pp) })),
    ...(m.others ?? []).map((o) => ({ name: o.name, tag: o.tag, team: o.team, ...line(m, o) })),
  ];
  // Two-team games: one table per team, the team's own side first. Anything else (Deathmatch): one table.
  const twoTeams = Object.keys(m.teams ?? {}).length === 2 && all.every((x) => m.teams[x.team]);
  const groups = twoTeams
    ? Object.entries(m.teams).map(([id, t]) => ({ id, won: t.won, lost: t.lost, win: t.win, players: all.filter((x) => x.team === id) }))
      .sort((a, b) => b.players.filter((x) => x.player).length - a.players.filter((x) => x.player).length)
    : [{ id: null, players: all }];
  for (const g of groups) g.players.sort((a, b) => (b.acs ?? -1) - (a.acs ?? -1) || b.k - a.k);
  const file = `${m.id}.json`;
  writeJson(path.join(lobbyDir, file), { id: m.id, teams: groups }, 0);
  lobbyFiles.add(file);
  return all.length;
}

// ---- weeks/<key>.json
const rrOf = new Map(); // `${matchId}|${puuid}` -> RR entry
for (const { p, rr } of perPlayer) for (const e of rr) rrOf.set(`${e.id}|${p.rec.puuid}`, e);
const byWeek = new Map(weeks.map((w) => [w.key, []]));
for (const m of matches) {
  const entries = Object.entries(m.players)
    .filter(([puuid]) => slugOf.has(puuid))
    .map(([puuid, pp]) => {
      const e = rrOf.get(`${m.id}|${puuid}`);
      return {
        player: slugOf.get(puuid),
        team: pp.team,
        result: resultOf(m, pp),
        ...scoreLine(m, pp.team),
        agent: pp.agent,
        agentId: pp.agentId,
        tier: pp.tier,
        k: pp.k,
        d: pp.d,
        a: pp.a,
        ...perRound(pp, m.rounds),
        rr: e ? { change: e.change, placement: e.placement, protected: e.protected, refunded: e.refunded } : null,
      };
    })
    .sort((a, b) => (b.acs ?? -1) - (a.acs ?? -1));
  if (!entries.length) continue;
  const time = matchTime(m);
  const week = weeks.find((w) => time >= w.start && time < w.end);
  if (!week) continue;
  byWeek.get(week.key).push({
    id: m.id, time, queue: m.queue, queueName: m.queueName, map: m.map, mapId: m.mapId, patch: m.patch,
    length: m.length, rounds: m.rounds, lobby: writeLobby(m), entries,
  });
}
const weekDir = path.join(outDir, 'weeks');
fs.mkdirSync(weekDir, { recursive: true });
const keep = new Set();
for (const [key, list] of byWeek) {
  list.sort((a, b) => b.time - a.time);
  writeJson(path.join(weekDir, `${key}.json`), { key, matches: list }, 2);
  keep.add(`${key}.json`);
}
for (const f of fs.readdirSync(weekDir)) if (!keep.has(f)) fs.rmSync(path.join(weekDir, f));
fs.mkdirSync(lobbyDir, { recursive: true });
for (const f of fs.readdirSync(lobbyDir)) if (!lobbyFiles.has(f)) fs.rmSync(path.join(lobbyDir, f));

const totalMatches = [...byWeek.values()].reduce((s, l) => s + l.length, 0);
console.log(`built ${outDir}: ${players.length} players, ${weeks.length} weeks, ${totalMatches} games`);
