import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { normalizeMatch, normalizeRr, parsePatch } from '../src/store.js';
import { idsInMatches, readPng, shrinkPng } from '../src/icons.js';

const player = (puuid, team, agent) => ({
  puuid, name: `name-${puuid}`, tag: 'NA1', team_id: team, party_id: `party-${puuid}`,
  agent: { id: `AGENT-${agent}`, name: agent }, tier: { id: 19, name: 'Diamond 2' },
  stats: { score: 4200, kills: 20, deaths: 14, assists: 5, headshots: 10, bodyshots: 28, legshots: 2, damage: { dealt: 3150, received: 2800 } },
  ability_casts: { ability1: 1 }, economy: {}, behavior: {},
});

const raw = {
  metadata: {
    match_id: 'm-1', map: { id: 'MAP-ASCENT', name: 'Ascent' }, game_version: 'release-11.10-shipping-17-3953720',
    game_length_in_ms: 2_100_000, started_at: '2026-11-16T05:00:00.000Z', is_completed: true,
    queue: { id: 'competitive', name: 'Competitive', mode_type: 'Standard' }, season: { id: 's', short: 'e11a3' },
  },
  players: [player('team', 'Red', 'Jett'), player('foe', 'Blue', 'Sova')],
  teams: [{ team_id: 'Red', rounds: { won: 13, lost: 8 }, won: true }, { team_id: 'Blue', rounds: { won: 8, lost: 13 }, won: false }],
  rounds: Array.from({ length: 21 }, (_, i) => ({ id: i })),
  kills: [{ round: 0 }],
};

test('a saved game keeps the scoreboard, team scores and basics, and drops round-by-round data', () => {
  const m = normalizeMatch(raw, new Set(['team']));
  assert.equal(m.id, 'm-1');
  assert.equal(m.start, Date.UTC(2026, 10, 16, 5));
  assert.equal(m.length, 2100);
  assert.equal(m.queue, 'competitive');
  assert.equal(m.map, 'Ascent');
  assert.equal(m.mapId, 'map-ascent'); // ids are lowercased to match the icon files
  assert.equal(m.patch, '11.10');
  assert.equal(m.rounds, 21);
  assert.deepEqual(m.teams, { Red: { won: 13, lost: 8, win: true }, Blue: { won: 8, lost: 13, win: false } });
  assert.deepEqual(m.players.team, {
    team: 'Red', agent: 'Jett', agentId: 'agent-jett', tier: 19, score: 4200, k: 20, d: 14, a: 5, hs: 10, bs: 28, ls: 2, dmg: 3150, party: 'party-team',
  });
  assert.equal(m.others.length, 1);
  assert.equal(m.others[0].name, 'name-foe');
  assert.equal(m.others[0].agent, 'Sova');
  assert.ok(!('puuid' in m.others[0]));
  assert.ok(!('kills' in m) && !('ability_casts' in m.players.team));
});

test('agent and map ids are collected from everyone in the game', () => {
  const ids = idsInMatches([normalizeMatch(raw, new Set(['team']))]);
  assert.deepEqual([...ids.agents].sort(), ['agent-jett', 'agent-sova']);
  assert.deepEqual([...ids.maps], [['map-ascent', 'Ascent']]);
});

test('RR history items from either HenrikDev format are saved the same way', () => {
  const v2 = normalizeRr({
    match_id: 'm-1', tier: { id: 19, name: 'Diamond 2' }, rr: 45, last_change: -18, elo: 1645, refunded_rr: 0,
    was_derank_protected: true, date: '2026-11-16T05:35:00.000Z', tier_before_update: { id: 19, name: 'Diamond 2' },
  });
  assert.deepEqual(v2, { t: Date.UTC(2026, 10, 16, 5, 35), tier: 19, rr: 45, change: -18, before: 19, protected: true });
  const v1 = normalizeRr({ match_id: 'm-2', tier: { id: 12, name: 'Gold 1' }, ranking_in_tier: 30, last_mmr_change: 22, elo: 930, date: '2026-11-15T01:00:00Z' });
  assert.deepEqual(v1, { t: Date.UTC(2026, 10, 15, 1), tier: 12, rr: 30, change: 22 });
});

test('patch numbers come from the game version', () => {
  assert.equal(parsePatch('release-09.05-shipping-12-2486839'), '9.05');
  assert.equal(parsePatch(undefined), null);
});

// ---- icon shrinking

function makePng(w, h, color, pixel) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = color;
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(0);
    for (let x = 0; x < w; x++) rows.push(...pixel(x, y));
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const RED = [255, 0, 0, 255], GREEN = [0, 200, 0, 255];
const pixelAt = (img, x, y) => [...img.rgba.subarray((y * img.w + x) * 4, (y * img.w + x + 1) * 4)];

test('a big square portrait shrinks to a small square, averaging colors', () => {
  const out = readPng(shrinkPng(makePng(8, 8, 6, (x) => (x < 4 ? RED : GREEN)), 2));
  assert.deepEqual([out.w, out.h], [2, 2]);
  assert.deepEqual(pixelAt(out, 0, 0), RED);
  assert.deepEqual(pixelAt(out, 1, 1), GREEN);
});

test('a map banner keeps its shape: the center is cropped to the target aspect', () => {
  // 12x2 with green only in the middle 8 columns; shrunk to 4x1 (same 4:1 shape after cropping to 8x2)
  const out = readPng(shrinkPng(makePng(12, 2, 6, (x) => (x >= 2 && x < 10 ? GREEN : RED)), 4, 1));
  assert.deepEqual([out.w, out.h], [4, 1]);
  for (let x = 0; x < 4; x++) assert.deepEqual(pixelAt(out, x, 0), GREEN);
});

test('images that are small already, or unreadable, are saved unchanged', () => {
  const small = makePng(4, 4, 6, () => RED);
  assert.equal(shrinkPng(small, 96), small);
  const notPng = Buffer.from('not an image at all, just some text padding it out');
  assert.equal(shrinkPng(notPng, 96), notPng);
});
