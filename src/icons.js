// Agent, map and rank icons (plus agent and map names) from valorant-api.com, a community-run mirror of
// Valorant's game assets. Icons are saved into site/img/{agents,maps,ranks}/<id>.png so the site serves them
// itself; names go into data/icons.json and from there into site.json.
//
// The originals are big (agent portraits are 1024x1024, about 570 KB each), so they're shrunk on the way in:
// agents and ranks to 96x96, map banners to 228x50. Every playable agent and every rank is fetched once
// (so new agents show up, and the demo has art), maps as they appear in games.
//
//   node src/icons.js      fetch whatever is missing

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const API = 'https://valorant-api.com/v1';
const RETRY_MISSING_MS = 24 * 3600e3;
const RECHECK_AGENTS_MS = 7 * 24 * 3600e3; // look for newly released agents about once a week
const SQUARE_PX = 96;
const MAP_W = 228, MAP_H = 50;

export const iconFile = (dir, id) => path.join(dir, `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.png`);

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'valorant-team-tracker/1.0' }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}
const getJson = async (url) => (await (await get(url)).json()).data;

// ---- shrinking images
// Done here because the project has no image library to lean on.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }; // by PNG color type
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** { w, h, rgba } for a plain 8-bit PNG, or null for anything else (interlaced, 16-bit, not a PNG). */
export function readPng(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let w, h, depth, color, interlace, palette, alphas;
  const idat = [];
  for (let pos = 8; pos + 8 <= buf.length;) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') alphas = data;
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const ch = PNG_CHANNELS[color];
  if (depth !== 8 || interlace || !ch || (color === 3 && !palette)) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch;
  if (raw.length < (stride + 1) * h) return null;

  const px = Buffer.alloc(stride * h);
  for (let y = 0, from = 0, to = 0; y < h; y++) {
    const filter = raw[from++];
    if (filter > 4) return null;
    for (let x = 0; x < stride; x++, from++, to++) {
      const a = x >= ch ? px[to - ch] : 0, b = y ? px[to - stride] : 0, c = x >= ch && y ? px[to - stride - ch] : 0;
      px[to] = raw[from] + [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
    }
  }

  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = i * ch, o = i * 4;
    if (color === 3) { palette.copy(rgba, o, px[p] * 3, px[p] * 3 + 3); rgba[o + 3] = alphas?.[px[p]] ?? 255; }
    else if (color < 4 && color !== 2) { rgba.fill(px[p], o, o + 3); rgba[o + 3] = 255; }
    else if (color === 4) { rgba.fill(px[p], o, o + 3); rgba[o + 3] = px[p + 1]; }
    else { px.copy(rgba, o, p, p + 3); rgba[o + 3] = color === 6 ? px[p + 3] : 255; }
  }
  return { w, h, rgba };
}


/** The image's center, cropped to the out size's shape and averaged down to outW x outH. */
function thumb({ w, h, rgba }, outW, outH) {
  const scale = Math.min(w / outW, h / outH), cw = outW * scale, ch = outH * scale;
  const left = (w - cw) / 2, top = (h - ch) / 2, out = Buffer.alloc(outW * outH * 4);
  for (let dy = 0, o = 0; dy < outH; dy++) {
    const y0 = Math.floor(top + dy * scale), y1 = Math.max(y0 + 1, Math.ceil(top + (dy + 1) * scale));
    for (let dx = 0; dx < outW; dx++, o += 4) {
      const x0 = Math.floor(left + dx * scale), x1 = Math.max(x0 + 1, Math.ceil(left + (dx + 1) * scale));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < Math.min(y1, h); y++) {
        for (let x = x0; x < Math.min(x1, w); x++, n++) {
          const i = (y * w + x) * 4, alpha = rgba[i + 3];
          r += rgba[i] * alpha; g += rgba[i + 1] * alpha; b += rgba[i + 2] * alpha; a += alpha;
        }
      }
      if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = Math.round(a / n); }
    }
  }
  return out;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(w, h, rgba) {
  const opaque = rgba.every((v, i) => i % 4 !== 3 || v === 255), ch = opaque ? 3 : 4, stride = w * ch;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0, to = 0; y < h; y++) {
    raw[to++] = 4; // Paeth filter on every row
    for (let x = 0; x < stride; x++, to++) {
      const at = (col, row) => (col < 0 || row < 0 ? 0 : rgba[(row * w + Math.floor(col / ch)) * 4 + (col % ch)]);
      raw[to] = at(x, y) - paeth(at(x - ch, y), at(x, y - 1), x >= ch && y ? at(x - ch, y - 1) : 0);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

/** An outW x outH version of a larger PNG (center crop). Anything it can't read, or that's already small, comes back unchanged. */
export function shrinkPng(buf, outW = SQUARE_PX, outH = outW) {
  try {
    const img = readPng(buf);
    return img && (img.w > outW || img.h > outH) ? writePng(outW, outH, thumb(img, outW, outH)) : buf;
  } catch {
    return buf;
  }
}

// ---- syncing

/** Agent and map ids used in the stored matches, everyone's included. */
export function idsInMatches(matches) {
  const agents = new Set(), maps = new Map();
  for (const m of matches) {
    if (m.mapId) maps.set(m.mapId, m.map);
    for (const p of [...Object.values(m.players), ...(m.others ?? [])]) if (p.agentId) agents.add(p.agentId);
  }
  return { agents, maps };
}

/**
 * @param ids     { agents: Set<agentId>, maps: Map<mapId, name> } from idsInMatches
 * @param imgDir  site/img (icons go in agents/, maps/ and ranks/ under it)
 * @param state   { names: {id: name}, maps: [competitive map ids], agentsAt, missing: {id: lastCheckedMs} }, updated in place
 * @returns number of icons downloaded
 */
export async function syncIcons(ids, imgDir, state, now = Date.now()) {
  state.names ??= {};
  state.missing ??= {};
  const has = (kind, id) => fs.existsSync(iconFile(path.join(imgDir, kind), id));
  const due = (id) => !(now - (state.missing[id] ?? 0) < RETRY_MISSING_MS);
  let saved = 0;
  async function save(kind, id, url, [w, h]) {
    if (has(kind, id)) { delete state.missing[id]; return; }
    if (!url) { state.missing[id] = now; return; }
    try {
      const file = iconFile(path.join(imgDir, kind), id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, shrinkPng(Buffer.from(await (await get(url)).arrayBuffer()), w, h));
      delete state.missing[id];
      saved++;
    } catch {
      state.missing[id] = now;
    }
  }

  // Agents: every playable one, about once a week, or sooner when a game has one we don't know.
  const unknownAgent = [...ids.agents].some((id) => (!has('agents', id) || !state.names[id]) && due(id));
  if (unknownAgent || !(now - (state.agentsAt ?? 0) < RECHECK_AGENTS_MS)) {
    for (const a of await getJson(`${API}/agents?isPlayableCharacter=true`)) {
      const id = a.uuid.toLowerCase();
      state.names[id] = a.displayName;
      await save('agents', id, a.displayIconSmall ?? a.displayIcon, [SQUARE_PX, SQUARE_PX]);
    }
    for (const id of ids.agents) if (!has('agents', id)) state.missing[id] = now;
    state.agentsAt = now;
  }

  // Ranks: the current set of rank emblems, by tier number (0 = unranked, 3 = Iron 1 ... 27 = Radiant).
  const tiers = [0, ...Array.from({ length: 25 }, (_, i) => i + 3)];
  if (tiers.some((t) => !has('ranks', t)) && due('ranks')) {
    const sets = await getJson(`${API}/competitivetiers`);
    for (const t of sets.at(-1)?.tiers ?? []) {
      if (tiers.includes(t.tier)) await save('ranks', t.tier, t.largeIcon ?? t.smallIcon, [SQUARE_PX, SQUARE_PX]);
    }
    if (tiers.some((t) => !has('ranks', t))) state.missing.ranks = now;
  }

  // Maps: banners for maps in games (plus the competitive pool, for the demo). Matched by id, else by name.
  const wanted = [...ids.maps].filter(([id, name]) => (!has('maps', id) || !state.names[id]) && due(id) && (id || name));
  if (wanted.length || !state.maps) {
    const all = await getJson(`${API}/maps`);
    const byId = new Map(all.map((m) => [m.uuid.toLowerCase(), m]));
    const byName = new Map(all.map((m) => [m.displayName.toLowerCase(), m]));
    for (const [id, name] of wanted) {
      const m = byId.get(id) ?? byName.get(String(name).toLowerCase());
      if (m) state.names[id] = m.displayName;
      await save('maps', id, m?.listViewIcon, [MAP_W, MAP_H]);
    }
    if (!state.maps) {
      // Bomb maps ("A/B Sites") are the ones ranked is played on.
      const pool = all.filter((m) => /sites/i.test(m.tacticalDescription ?? ''));
      for (const m of pool) {
        const id = m.uuid.toLowerCase();
        state.names[id] = m.displayName;
        await save('maps', id, m.listViewIcon, [MAP_W, MAP_H]);
      }
      state.maps = pool.map((m) => m.uuid.toLowerCase()).sort();
    }
  }
  return saved;
}

/** Ids that have an icon file, for site.json. */
export function listIcons(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort() : [];
}

// ---- run directly
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ROOT, DataStore } = await import('./store.js');
  const store = new DataStore(path.join(ROOT, 'data'));
  const n = await syncIcons(idsInMatches(store.matches.values()), path.join(ROOT, 'site', 'img'), store.icons);
  store.save();
  console.log(`icons: ${n} downloaded, ${Object.keys(store.icons.names).length} names, ${Object.keys(store.icons.missing).length} without an icon`);
}
