// Config + on-disk storage. Data files are written one record per line so
// git diffs (and the commit history of data/) stay readable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zonedMidnight } from './stats.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export function loadEnv() {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
}

// Windows editors sometimes save JSON with a byte-order mark, which JSON.parse rejects.
const parse = (text) => JSON.parse(text.replace(/^﻿/, ''));

export function loadConfig(file = path.join(ROOT, 'config.json')) {
  const cfg = parse(fs.readFileSync(file, 'utf8'));
  cfg.region = (cfg.region ?? 'na').toLowerCase();
  cfg.platform = (cfg.platform ?? 'pc').toLowerCase();
  cfg.timezone ??= 'America/Los_Angeles';
  cfg.weekStartsOn ??= 1;
  cfg.players ??= [];
  // Time of day the week starts, e.g. "22:00" (default midnight). Weeks are named after their first full day.
  const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(cfg.weekStartsAt ?? '00:00');
  if (!clock) throw new Error(`weekStartsAt "${cfg.weekStartsAt}" must be a 24-hour time like 22:00`);
  cfg.weekStartMinutes = Number(clock[1]) * 60 + Number(clock[2]);
  // Optional: the start day (date) weekStartsAt begins on. Earlier weeks keep starting at midnight.
  if (cfg.weekStartsAtFrom) {
    const [y, m, d] = cfg.weekStartsAtFrom.split('-').map(Number);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.weekStartsAtFrom) || new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== cfg.weekStartsOn) {
      throw new Error(`weekStartsAtFrom "${cfg.weekStartsAtFrom}" must be a date like 2026-11-11 that falls on weekStartsOn`);
    }
  }
  // trackFrom means midnight in the team's timezone, not UTC.
  if (cfg.trackFrom) {
    const [y, m, d] = cfg.trackFrom.split('-').map(Number);
    cfg.trackFromMs = zonedMidnight(y, m, d, cfg.timezone);
    if (!Number.isFinite(cfg.trackFromMs)) throw new Error(`trackFrom "${cfg.trackFrom}" must look like 2026-11-01`);
  }
  cfg.players = cfg.players.map((p) => {
    const hash = p.riotId.lastIndexOf('#');
    if (hash < 1) throw new Error(`Riot ID "${p.riotId}" must look like Name#TAG`);
    const gameName = p.riotId.slice(0, hash).trim();
    const tagLine = p.riotId.slice(hash + 1).trim();
    return {
      ...p,
      gameName,
      tagLine,
      key: `${gameName}#${tagLine}`.toLowerCase(),
      name: p.name || gameName,
      slug: slugify(p.name || gameName),
    };
  });
  const slugs = new Set();
  for (const p of cfg.players) {
    while (slugs.has(p.slug)) p.slug += '-2';
    slugs.add(p.slug);
  }
  return cfg;
}

export function slugify(s) {
  return s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'player';
}

// ---------------------------------------------------------------- JSON files

export function readJson(file, fallback) {
  try {
    return parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Pretty-print the first `depth` levels, keep everything deeper on one line. */
export function stringifyLines(value, depth = 1, indent = '') {
  if (depth <= 0 || value === null || typeof value !== 'object') return JSON.stringify(value);
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => inner + stringifyLines(v, depth - 1, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (!entries.length) return '{}';
  return `{\n${entries
    .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${stringifyLines(v, depth - 1, inner)}`)
    .join(',\n')}\n${indent}}`;
}

export function writeJson(file, value, depth = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = stringifyLines(value, depth) + '\n';
  // Skip identical writes so file mtimes / git stay quiet.
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

// ---------------------------------------------------------------- data store

export class DataStore {
  constructor(dir) {
    this.dir = dir;
    // { [riotId key]: { riotId, puuid, peak, rrBackfilled, matchesBackfilled, backfilledFrom } }
    this.players = readJson(path.join(dir, 'players.json'), {});
    // Rank checks, saved only when the rank changes: { [puuid]: [{ t, tier, rr }] }
    this.snapshots = readJson(path.join(dir, 'snapshots.json'), {});
    // RR for each ranked game: { [puuid]: { [matchId]: { t, tier, rr, change, before?, placement?, protected?, refunded? } } }
    this.rr = readJson(path.join(dir, 'rr.json'), {});
    // Ranked games HenrikDev couldn't return: { [matchId]: lastTriedMs }, so they're retried only now and then
    this.unavailable = readJson(path.join(dir, 'unavailable.json'), {});
    // From valorant-api.com: agent and map names, and ids it had no icon for
    this.icons = readJson(path.join(dir, 'icons.json'), { names: {}, missing: {} });
    this.matches = new Map();
    const mdir = path.join(dir, 'matches');
    if (fs.existsSync(mdir)) {
      for (const f of fs.readdirSync(mdir).filter((f) => f.endsWith('.json')).sort()) {
        for (const m of Object.values(readJson(path.join(mdir, f), {}))) this.matches.set(m.id, m);
      }
    }
  }

  save() {
    let changed = false;
    changed = writeJson(path.join(this.dir, 'players.json'), this.players, 2) || changed;
    changed = writeJson(path.join(this.dir, 'snapshots.json'), this.snapshots, 2) || changed;
    changed = writeJson(path.join(this.dir, 'rr.json'), this.rr, 2) || changed;
    if (Object.keys(this.unavailable).length) changed = writeJson(path.join(this.dir, 'unavailable.json'), this.unavailable, 1) || changed;
    if (Object.keys(this.icons.names ?? {}).length || Object.keys(this.icons.missing ?? {}).length) {
      changed = writeJson(path.join(this.dir, 'icons.json'), this.icons, 2) || changed;
    }
    const byMonth = new Map();
    for (const m of [...this.matches.values()].sort((a, b) => a.start - b.start)) {
      const month = new Date(m.start).toISOString().slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, {});
      byMonth.get(month)[m.id] = m;
    }
    for (const [month, ms] of byMonth) {
      changed = writeJson(path.join(this.dir, 'matches', `${month}.json`), ms, 1) || changed;
    }
    return changed;
  }
}

// ---------------------------------------------------------------- normalization

/** "release-11.10-shipping-17-3953720" -> "11.10" */
export function parsePatch(version = '') {
  const m = /(\d+)\.(\d+)/.exec(version ?? '');
  return m ? `${Number(m[1])}.${m[2]}` : null;
}

const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : null);

/** One player's line on the scoreboard. tier = their rank going into the game (0 = unranked). */
function normalizePlayer(p) {
  const s = p.stats ?? {};
  return {
    team: p.team_id ?? null,
    agent: p.agent?.name ?? null,
    agentId: lower(p.agent?.id),
    tier: p.tier?.id ?? null,
    score: s.score ?? 0,
    k: s.kills ?? 0,
    d: s.deaths ?? 0,
    a: s.assists ?? 0,
    hs: s.headshots ?? 0,
    bs: s.bodyshots ?? 0,
    ls: s.legshots ?? 0,
    dmg: s.damage?.dealt ?? 0,
    party: p.party_id ?? null,
  };
}

/**
 * Keep only what the site needs from a HenrikDev v4 match: the scoreboard (full line for tracked players,
 * plus Riot ID for everyone else), team scores and the basics. Round-by-round and kill data are dropped.
 */
export function normalizeMatch(raw, trackedPuuids) {
  const md = raw.metadata;
  const players = {};
  const others = [];
  for (const p of raw.players ?? []) {
    if (trackedPuuids.has(p.puuid)) players[p.puuid] = normalizePlayer(p);
    else others.push({ name: p.name ?? null, tag: p.tag ?? null, ...normalizePlayer(p) });
  }
  const teams = {};
  for (const t of raw.teams ?? []) {
    if (t.team_id) teams[t.team_id] = { won: t.rounds?.won ?? 0, lost: t.rounds?.lost ?? 0, win: !!t.won };
  }
  return {
    id: md.match_id,
    start: Date.parse(md.started_at),
    length: Math.round((md.game_length_in_ms ?? 0) / 1000),
    queue: lower(md.queue?.id),
    queueName: md.queue?.name ?? null,
    map: md.map?.name ?? null,
    mapId: lower(md.map?.id),
    season: md.season?.short ?? null,
    patch: parsePatch(md.game_version),
    rounds: Array.isArray(raw.rounds) ? raw.rounds.length : null,
    teams,
    players,
    others,
  };
}

/** One RR history item (HenrikDev mmr-history v2, or stored-mmr-history v1) as saved in data/rr.json. */
export function normalizeRr(h) {
  const v2 = 'last_change' in h;
  const e = {
    t: Date.parse(h.date),
    tier: h.tier?.id ?? null,
    rr: v2 ? h.rr : h.ranking_in_tier,
    change: v2 ? h.last_change : h.last_mmr_change,
  };
  if (h.tier_before_update?.id != null) e.before = h.tier_before_update.id;
  if (h.is_placement_match) e.placement = true;
  if (h.was_derank_protected) e.protected = true;
  if (h.refunded_rr) e.refunded = h.refunded_rr;
  return e;
}
