// Poll the HenrikDev API once: record each player's rank (only when it changed), the RR of each ranked game,
// and any games we haven't stored yet.
//
//   node src/poll.js [--max-calls 250] [--data data] [--config config.json]

import path from 'node:path';
import { HenrikClient } from './henrik.js';
import { ROOT, arg, loadEnv, loadConfig, DataStore, normalizeMatch, normalizeRr } from './store.js';
import { syncIcons, idsInMatches } from './icons.js';

const PAGE = 10; // HenrikDev returns at most 10 games per call
const RR_PAGE = 25;
const RETRY_UNAVAILABLE_MS = 3 * 24 * 3600e3;

loadEnv();
const cfg = loadConfig(arg('config', path.join(ROOT, 'config.json')));
const store = new DataStore(arg('data', path.join(ROOT, 'data')));
// Caps API use per run, so a big backfill (new players, an earlier trackFrom) spreads over several runs
// instead of timing out. Every player's regular check still runs.
const maxCalls = Number(arg('max-calls', 250));
const api = new HenrikClient(process.env.HENRIK_API_KEY, { region: cfg.region, platform: cfg.platform, perMinute: cfg.requestsPerMinute ?? 30 });
const startTime = cfg.trackFromMs ?? 0;
const now = Date.now();
const spare = () => api.requests < maxCalls;

let errors = 0;
const log = (...a) => console.log(...a);

// 1. Riot ID -> PUUID (cached in data/players.json)
for (const p of cfg.players) {
  let rec = store.players[p.key];
  if (!rec?.puuid) {
    try {
      const acct = await api.account(p.gameName, p.tagLine);
      if (!acct?.puuid) {
        console.error(`✗ Riot ID not found: ${p.riotId} (check spelling and tag in config.json)`);
        errors++;
        continue;
      }
      rec = store.players[p.key] = { riotId: `${acct.name}#${acct.tag}`, puuid: acct.puuid };
      log(`resolved ${p.riotId}`);
    } catch (err) {
      console.error(`✗ account lookup failed for ${p.riotId}: ${err.message}`);
      errors++;
      continue;
    }
  }
  p.puuid = rec.puuid;
  p.rec = rec;
}
const active = cfg.players.filter((p) => p.puuid);
const tracked = new Set(active.map((p) => p.puuid));

// 2. Current rank (a snapshot only when it changed) and the RR each ranked game gave or took.
let snapsAdded = 0, rrAdded = 0;
const addRr = (games, h) => {
  const e = normalizeRr(h);
  if (!h.match_id || !Number.isFinite(e.t) || e.t < startTime) return false;
  const isNew = !games[h.match_id];
  games[h.match_id] = { ...games[h.match_id], ...e };
  if (isNew) rrAdded++;
  return true;
};
for (const p of active) {
  try {
    const mmr = await api.mmr(p.puuid);
    const cur = mmr?.current;
    const snap = { t: now, tier: cur?.tier?.id ?? 0, rr: cur?.rr ?? 0 };
    const list = (store.snapshots[p.puuid] ??= []);
    const last = list.at(-1);
    if (!last || last.tier !== snap.tier || last.rr !== snap.rr) {
      list.push(snap);
      snapsAdded++;
      log(`rank  ${p.name}: ${cur?.tier?.name ?? 'Unranked'}${snap.tier >= 3 ? ` ${snap.rr} RR` : ''}`);
    }
    if (mmr?.peak?.tier?.id >= 3) p.rec.peak = { tier: mmr.peak.tier.id, rr: mmr.peak.rr ?? null, season: mmr.peak.season?.short ?? null };

    const games = (store.rr[p.puuid] ??= {});
    // First run for this player: their older RR history, a page at a time, back to trackFrom.
    const firstRun = !p.rec.rrBackfilled;
    if (firstRun) {
      for (let page = 1; spare(); page++) {
        const items = await api.storedMmrHistory(p.puuid, { page, size: RR_PAGE });
        let older = false;
        for (const h of items) if (!addRr(games, h) && Date.parse(h.date) < startTime) older = true;
        if (items.length < RR_PAGE || older) { p.rec.rrBackfilled = true; break; }
      }
    }
    // Recent games, with details the stored history lacks (placements, derank protection, refunds).
    // Skipped when the latest RR update is one we already have.
    const latest = mmr?.latest_update?.match_id;
    if (firstRun || !latest || !games[latest]) {
      for (const h of await api.mmrHistory(p.puuid)) addRr(games, h);
    }
  } catch (err) {
    console.error(`✗ rank lookup failed for ${p.name}: ${err.message}`);
    errors++;
  }
}

// 3. Games, all modes. HenrikDev returns full games (every player), 10 per call, newest first. The first run
//    pages back to trackFrom; later runs stop at the first page with a game we already have.
let fetched = 0;
for (const p of active) {
  const rec = p.rec;
  // Caught up = games already downloaded back to (at least) the current trackFrom.
  const caughtUp = rec.matchesBackfilled && (rec.backfilledFrom ?? Infinity) <= startTime;
  let added = 0, reachedEnd = false;
  try {
    for (let start = 0; start === 0 || spare(); start += PAGE) {
      const list = await api.matches(p.puuid, { start, size: PAGE });
      let known = 0, older = false;
      for (const raw of list) {
        const md = raw?.metadata;
        if (!md?.match_id || md.is_completed === false) continue;
        if (Date.parse(md.started_at) < startTime) { older = true; continue; }
        if (store.matches.get(md.match_id)?.players[p.puuid]) { known++; continue; }
        store.matches.set(md.match_id, normalizeMatch(raw, tracked));
        added++;
      }
      if (list.length < PAGE || older) { reachedEnd = true; break; }
      if (caughtUp && known) break;
    }
    if (reachedEnd) {
      rec.matchesBackfilled = true;
      rec.backfilledFrom = Math.min(rec.backfilledFrom ?? Infinity, startTime);
    }
    fetched += added;
    if (added) log(`games ${p.name}: +${added}${caughtUp || reachedEnd ? '' : ' (backfill continues next run)'}`);
  } catch (err) {
    console.error(`✗ match history failed for ${p.name}: ${err.message}`);
    errors++;
  }
  store.save(); // save as we go so an interrupted backfill keeps its progress
}

// 3b. Ranked games with RR but no stored game (older than the match list reaches): fetch them one by one,
//     newest first, with what's left of this run's calls. Ones HenrikDev can't find are retried after a few days.
let filled = 0;
{
  const want = new Map();
  for (const p of active) {
    for (const [id, e] of Object.entries(store.rr[p.puuid] ?? {})) {
      if (!store.matches.has(id) && !(now - (store.unavailable[id] ?? 0) < RETRY_UNAVAILABLE_MS)) want.set(id, e.t);
    }
  }
  for (const [id] of [...want].sort((a, b) => b[1] - a[1])) {
    if (!spare()) break;
    try {
      const raw = await api.match(id);
      if (!raw?.metadata?.match_id) { store.unavailable[id] = now; continue; }
      store.matches.set(id, normalizeMatch(raw, tracked));
      delete store.unavailable[id];
      filled++;
    } catch (err) {
      console.error(`✗ download of ${id} failed: ${err.message}`);
      break;
    }
  }
  if (filled) log(`games filled in ${filled} older ranked game(s)${want.size > filled ? `, ${want.size - filled} left` : ''}`);
}

// 4. Agent, map and rank icons for anything that doesn't have one yet. Warnings only.
try {
  const n = await syncIcons(idsInMatches(store.matches.values()), path.join(ROOT, 'site', 'img'), store.icons);
  if (n) log(`icons ${n} new icon(s)`);
} catch (err) {
  console.warn(`! icon download failed: ${err.message}`);
}

store.save();
log(`done: ${snapsAdded} rank change(s), ${rrAdded} RR update(s), ${fetched + filled} new game(s), ${api.requests} API calls`);
if (errors && errors >= Math.max(1, active.length)) process.exit(1);
