// Valorant team tracker front end. Plain ES module, no dependencies.
// Reads data/site.json + data/weeks/<week>.json produced by src/build.js.

const app = document.getElementById('app');
const tip = document.getElementById('tooltip');
const lobbyEl = document.getElementById('lobby');
const RANKED = 'competitive';
const APEX = 2100; // Immortal 1, 0 RR on the ladder score scale (see src/stats.js)
const GROUPS = ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Ascendant', 'Immortal', 'Radiant'];
const QUEUES = {
  competitive: 'Competitive', unrated: 'Unrated', swiftplay: 'Swiftplay', spikerush: 'Spike Rush', deathmatch: 'Deathmatch',
  hurm: 'Team Deathmatch', ggteam: 'Escalation', premier: 'Premier', custom: 'Custom', newmap: 'New Map', onefa: 'Replication', snowball: 'Snowball Fight',
};

let site;
const weekCache = new Map();
// "?v=<build time>" on data URLs, so each build's files are fetched fresh past GitHub Pages' CDN cache
// (which can keep serving the previous build's copy for a few minutes after a deploy).
let dataVersion = '';
const ui = { sort: { key: 'rank', dir: -1 }, rankedOnly: false };
let redraws = [];
let renderId = 0;

// ---------------------------------------------------------------- helpers

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  setProps(el, props);
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
function s(tag, props, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  setProps(el, props);
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
function setProps(el, props) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else el.setAttribute(k, v === true ? '' : v);
  }
}

// Ranks: tier numbers as Riot uses them (3 = Iron 1 ... 26 = Immortal 3, 27 = Radiant), RR within the tier.
// Immortal and Radiant share one RR scale that keeps counting up, like the ladder score in src/stats.js.
const groupOf = (tier) => (tier >= 27 ? 'Radiant' : tier >= 3 ? GROUPS[Math.floor((tier - 3) / 3)] : null);
const tierName = (tier) => (!(tier >= 3) ? 'Unranked' : tier >= 27 ? 'Radiant' : `${groupOf(tier)} ${((tier - 3) % 3) + 1}`);
const isRanked = (r) => !!r && r.tier >= 3;
const scoreOf = (r) => (!isRanked(r) ? null : r.tier >= 24 ? APEX + r.rr : (r.tier - 3) * 100 + r.rr);
const rankText = (r) => (!isRanked(r) ? 'Unranked' : `${tierName(r.tier)} · ${r.rr} RR`);
const rrInTier = (v) => (v >= APEX ? v - APEX : v % 100);
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
const deltaClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const pct = (x) => (x == null ? '—' : `${Math.round(x)}%`);
const whole = (x) => (x == null ? '—' : String(Math.round(x)));
const kdText = (x) => (x == null ? '—' : x.toFixed(2));
const queueName = (m) => site.queueNames?.[m.queue] ?? QUEUES[m.queue] ?? m.queueName ?? 'Other mode';
const player = (slug) => site.players.find((p) => p.slug === slug);
const initials = (name) => name.replace(/[^A-Za-z0-9 ]/g, '').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

/** Win rate, K/D, ACS, HS% and ADR from game totals (sums, so players can be added together first). */
function rates(t) {
  if (!t) return {};
  const decided = t.wins + t.losses + t.draws;
  return {
    winRate: decided ? (100 * t.wins) / decided : null,
    kd: t.deaths ? t.kills / t.deaths : t.kills ? t.kills : null,
    acs: t.rounds ? t.score / t.rounds : null,
    hs: t.shots ? (100 * t.hs) / t.shots : null,
    adr: t.rounds ? t.dmg / t.rounds : null,
  };
}
const record = (t) => (!t?.games ? '—' : `${t.wins}–${t.losses}${t.draws ? `–${t.draws}` : ''}`);

function scoreLabel(v, step) {
  if (v >= APEX) return v === APEX ? 'Immortal' : `${v - APEX} RR`; // Immortal and up share one RR scale
  const tier = 3 + Math.floor(v / 100);
  return step >= 300 ? groupOf(tier) : tierName(tier);
}

let fmtDateTime;
function initFormats() {
  const tz = site.timezone;
  fmtDateTime = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
let fmtLocalDay;
/** "Nov 4 – 11": the week's name date through the local day it ends on (weeks can run long or start late in a day). */
function weekLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const a = new Date(Date.UTC(y, m - 1, d));
  const week = site.weeks.find((w) => w.key === key);
  fmtLocalDay ??= new Intl.DateTimeFormat('en-US', { timeZone: site.timezone, year: 'numeric', month: 'numeric', day: 'numeric' });
  const last = week && Object.fromEntries(fmtLocalDay.formatToParts(week.end - 1).map((p) => [p.type, Number(p.value)]));
  const b = last ? new Date(Date.UTC(last.year, last.month - 1, last.day)) : new Date(Date.UTC(y, m - 1, d + 6));
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  return `${f.format(a)} – ${a.getUTCMonth() === b.getUTCMonth() ? b.getUTCDate() : f.format(b)}`;
}
// Week numbers (from config weekOne) lead; dates are secondary. Weeks without a number fall back to dates.
const weekNum = (key) => site.weeks.find((w) => w.key === key)?.num ?? null;
const weekName = (key) => (weekNum(key) ? `Week ${weekNum(key)}` : `Week of ${weekLabel(key)}`);
const weekFull = (key) => (weekNum(key) ? `Week ${weekNum(key)} · ${weekLabel(key)}` : `Week of ${weekLabel(key)}`);
const weekShort = (key) => (weekNum(key) ? `Wk ${weekNum(key)}` : weekLabel(key).split(' – ')[0]);
/** "Week 7" in bold with the dates smaller and muted beside it. */
const weekTitle = (key, tag = 'strong') =>
  [h(tag, { class: 'week-num' }, weekName(key)), weekNum(key) ? h('span', { class: 'week-dates' }, weekLabel(key)) : null];
const duration = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

async function loadWeek(key) {
  if (!weekCache.has(key)) {
    weekCache.set(key, fetch(`data/weeks/${key}.json${dataVersion}`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : { key, matches: [] })));
  }
  return weekCache.get(key);
}

// ---------------------------------------------------------------- tooltip

function showTip(lines, x, y) {
  tip.replaceChildren(...lines.map(([cls, text, key]) =>
    h('div', { class: cls }, key ? h('span', { class: 'key', style: typeof key === 'string' ? `background: ${key}` : null }) : null, text)));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 14));
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
const hideTip = () => { tip.hidden = true; };
function tipAtElement(el, lines) {
  const r = el.getBoundingClientRect();
  showTip(lines, r.left + r.width / 2, r.top);
}

// ---------------------------------------------------------------- shared pieces

function tile(label, value, note, cls) {
  return h('div', { class: 'tile' },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${cls ?? ''}` }, value),
    note ? h('div', { class: 'note' }, note) : null);
}

let rankIconSet, agentIconSet, mapIconSet;
/** Riot's emblem for a rank, none when unranked. Decorative: the rank is written next to it. */
function rankCrest(r, cls = 'rank-crest') {
  rankIconSet ??= new Set(site.rankIcons ?? []);
  return isRanked(r) && rankIconSet.has(r.tier) ? h('img', { class: cls, src: `img/ranks/${r.tier}.png`, alt: '', width: 20, height: 20 }) : null;
}

/** RR for one ranked game, with Riot's notes on it (placement, derank protection, refunds). */
function rrBlock(e, m) {
  if (m.queue !== RANKED) return h('div', { class: 'entry-lp' });
  if (!e.rr) {
    return h('div', { class: 'entry-lp', title: 'No RR recorded for this game' },
      h('span', { class: 'lp muted' }, '—'), h('span', { class: 'note' }, 'RR n/a'));
  }
  const { change, placement, refunded } = e.rr;
  const placementOnly = placement && !change;
  const notes = [placement && !placementOnly ? 'placement' : null, e.rr.protected ? 'derank protected' : null,
    refunded ? `${signed(refunded)} refunded` : null].filter(Boolean);
  return h('div', { class: 'entry-lp' },
    h('span', { class: `lp ${deltaClass(change)}` }, placementOnly ? 'Placement' : `${signed(change)} RR`),
    notes.length ? h('span', { class: 'note' }, notes.join(' · ')) : null);
}

/** Win / Loss / Draw with the round score under it. */
function resultBadge(e) {
  const word = { W: 'Win', L: 'Loss', D: 'Draw' }[e.result];
  const score = word && e.us != null && e.them != null ? `${e.us}–${e.them}` : null;
  const label = word ? `${word}${score ? ` ${score}` : ''}` : 'No team result in this mode';
  return h('div', { class: `result ${word ? word.toLowerCase() : 'none'}`, title: label, 'aria-label': label, role: 'img' },
    h('span', { class: 'word', 'aria-hidden': 'true' }, word ?? '—'),
    score ? h('span', { class: 'score', 'aria-hidden': 'true' }, score) : null);
}

/** The agent's portrait, with the player's rank going into the game in the bottom-right corner. */
function agentBadge(e) {
  agentIconSet ??= new Set(site.agentIcons ?? []);
  const name = e.agent ?? site.names?.[e.agentId] ?? 'Unknown agent';
  const label = `${name}${isRanked({ tier: e.tier }) ? ` · ${tierName(e.tier)} at the time` : ''}`;
  return h('div', { class: 'agent', title: label, 'aria-label': label, role: 'img' },
    e.agentId && agentIconSet.has(e.agentId)
      ? h('img', { src: `img/agents/${e.agentId}.png`, alt: '', loading: 'lazy', width: 46, height: 46 })
      : h('div', { class: 'blank' }, initials(name)),
    rankCrest({ tier: e.tier, rr: 0 }, 'corner-rank'));
}

/** Small agent portrait for the scoreboard. */
function agentMini(b) {
  agentIconSet ??= new Set(site.agentIcons ?? []);
  const name = b.agent ?? site.names?.[b.agentId] ?? 'Unknown agent';
  return b.agentId && agentIconSet.has(b.agentId)
    ? h('img', { class: 'agent-mini', src: `img/agents/${b.agentId}.png`, alt: name, title: name, loading: 'lazy', width: 26, height: 26 })
    : h('span', { class: 'agent-mini blank', title: name, 'aria-label': name }, initials(name));
}

/** The map's name on a strip of its art. */
function mapChip(m) {
  mapIconSet ??= new Set(site.mapIcons ?? []);
  const name = m.map ?? site.names?.[m.mapId] ?? 'Unknown map';
  const art = m.mapId && mapIconSet.has(m.mapId);
  return h('span', { class: `map${art ? ' art' : ''}`, style: art ? `background-image: url(img/maps/${m.mapId}.png)` : null }, name);
}

const stat = (label, value, cls) =>
  h('div', { class: `stat ${cls ?? ''}` }, h('span', { class: 'v' }, value), h('span', { class: 'l' }, label));

function entryRow(e, m, showName) {
  const p = player(e.player);
  return h('div', { class: 'entry' },
    h('div', { class: 'entry-left' }, resultBadge(e), agentBadge(e)),
    h('div', { class: 'board' },
      h('div', { class: 'name-line' },
        showName ? h('a', { class: 'name', href: `#/player/${e.player}` }, p?.name ?? e.player) : null,
        h('span', { class: 'agent-name' }, e.agent ?? site.names?.[e.agentId] ?? '')),
      h('div', { class: 'stats' },
        stat('K / D / A', `${e.k} / ${e.d} / ${e.a}`, 'kda'),
        stat('K/D', kdText(e.d ? e.k / e.d : e.k)),
        stat('ACS', whole(e.acs)),
        stat('HS%', pct(e.hs)),
        stat('ADR', whole(e.adr)))),
    rrBlock(e, m));
}

/** One game. With `focus` set, only that player's line is shown (no teammates). */
function matchCard(m, focus) {
  const entries = focus ? m.entries.filter((e) => e.player === focus) : m.entries;
  return h('article', { class: 'match' },
    h('div', { class: 'match-head' },
      h('span', { class: 'queue' }, queueName(m)),
      mapChip(m),
      h('span', {}, fmtDateTime.format(m.time)),
      h('span', {}, duration(m.length)),
      m.patch ? h('span', {}, `Patch ${m.patch}`) : null,
      m.lobby > 1 ? lobbyButton(m) : null),
    entries.map((e) => entryRow(e, m, !focus)));
}

// ---------------------------------------------------------------- scoreboard popup
// Floats over the page from a game's "Scoreboard" button, so nothing moves. Hovering shows it; clicking or
// tapping keeps it open until Esc, the ×, or a click elsewhere. Each game's scoreboard is its own small file
// (data/lobbies/<id>.json), fetched the first time it's wanted.

const HOVER_OPEN_MS = 150, HOVER_CLOSE_MS = 220;
const lobbyCache = new Map();
const lobby = { btn: null, pinned: false, token: 0, timer: 0 }; // token: newest open/close, so a slow fetch can't undo it

function loadLobby(id) {
  if (!lobbyCache.has(id)) {
    const req = fetch(`data/lobbies/${id}.json`).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
    req.catch(() => lobbyCache.delete(id)); // a later hover can try again
    lobbyCache.set(id, req);
  }
  return lobbyCache.get(id);
}

/**
 * The scoreboard: one table (so both teams' columns line up), a header row per team. Teammates link to their
 * page and are highlighted. Rank is each player's rank going into the game.
 */
const SB_COLUMNS = ['Player', 'Rank', 'ACS', 'K', 'D', 'A', '+/−', 'HS%', 'ADR'];
function scoreboard(teams) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'sb' },
    h('thead', {}, h('tr', {}, SB_COLUMNS.map((c, i) =>
      h('th', { class: i > 1 ? 'r' : null, title: c === 'Rank' ? 'Rank going into this game' : null }, c)))),
    teams.map(lobbyTeam)));
}
function lobbyTeam(g) {
  const outcome = g.id == null ? null : g.win ? 'Won' : g.won === g.lost ? 'Draw' : 'Lost';
  const rows = g.players.map((b) => {
    const p = b.player ? player(b.player) : null;
    const diff = b.k - b.d;
    return h('tr', { class: p ? 'team' : null },
      h('td', {}, h('span', { class: 'sb-player' }, agentMini(b),
        p ? h('a', { href: `#/player/${b.player}` }, p.name) : h('span', { title: b.tag ? `${b.name}#${b.tag}` : null }, b.name ?? 'Unknown player'))),
      h('td', {}, h('span', { class: 'rank-cell' }, rankCrest({ tier: b.tier, rr: 0 }) ?? h('span', { class: 'rank-crest' }),
        isRanked({ tier: b.tier }) ? tierName(b.tier) : h('span', { class: 'muted' }, 'Unranked'))),
      h('td', { class: 'r' }, whole(b.acs)),
      h('td', { class: 'r' }, b.k),
      h('td', { class: 'r' }, b.d),
      h('td', { class: 'r' }, b.a),
      h('td', { class: `r ${deltaClass(diff)}` }, signed(diff)),
      h('td', { class: 'r' }, pct(b.hs)),
      h('td', { class: 'r' }, whole(b.adr)));
  });
  return h('tbody', {},
    h('tr', { class: 'sb-team-row' }, h('th', { colspan: SB_COLUMNS.length, scope: 'rowgroup' },
      h('span', { class: `sb-head${g.id ? ` side-${g.id.toLowerCase()}` : ''}` },
        h('span', { class: 'sb-team' }, g.id ? `${g.id} team` : 'Players'),
        g.id ? h('span', { class: 'sb-score' }, g.won) : null,
        outcome ? h('span', { class: `sb-outcome ${outcome.toLowerCase()}` }, outcome) : null))),
    rows);
}

/** Just under the button, or above it if there's no room, kept on screen (it may cover the button on short screens). */
function placeLobby(btn) {
  const b = btn.getBoundingClientRect(), p = lobbyEl.getBoundingClientRect();
  const edge = 8, gap = 6, vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const above = b.top - gap - p.height;
  const top = b.bottom + gap + p.height <= vh - edge ? b.bottom + gap : above >= edge ? above : Math.max(edge, vh - p.height - edge);
  lobbyEl.style.left = `${Math.max(edge, Math.min(vw - p.width - edge, b.right - p.width))}px`;
  lobbyEl.style.top = `${top}px`;
}

function closeLobby({ refocus = false } = {}) {
  clearTimeout(lobby.timer);
  lobby.token++;
  const { btn } = lobby;
  lobby.btn = null;
  lobby.pinned = false;
  lobbyEl.hidden = true;
  lobbyEl.replaceChildren();
  btn?.setAttribute('aria-expanded', 'false');
  if (refocus) btn?.focus({ preventScroll: true });
}

async function openLobby(btn, m, pin) {
  clearTimeout(lobby.timer);
  const token = ++lobby.token;
  lobby.pinned = pin;
  let teams = null;
  try { ({ teams } = await loadLobby(m.id)); } catch {} // shown as a message below
  if (token !== lobby.token) return;
  lobby.btn?.setAttribute('aria-expanded', 'false');
  lobby.btn = btn;
  btn.setAttribute('aria-expanded', 'true');
  const close = h('button', { class: 'lobby-close', type: 'button', 'aria-label': 'Close', onclick: () => closeLobby({ refocus: true }) }, '×');
  lobbyEl.replaceChildren(
    h('div', { class: 'lobby-head' },
      h('span', { class: 'queue' }, queueName(m)),
      mapChip(m),
      h('span', {}, fmtDateTime.format(m.time)),
      h('span', {}, duration(m.length)),
      close),
    teams ? scoreboard(teams) : h('p', { class: 'muted' }, 'Couldn’t load this game’s scoreboard.'));
  lobbyEl.hidden = false;
  placeLobby(btn);
  if (pin) close.focus({ preventScroll: true });
}

function hoverLobby(btn, m) {
  clearTimeout(lobby.timer);
  if (lobby.btn === btn || lobby.pinned) return; // a popup that was clicked open stays until it's closed
  loadLobby(m.id).catch(() => {}); // start fetching now, so it's ready when the popup opens
  lobby.timer = setTimeout(() => openLobby(btn, m, false), lobby.btn ? 0 : HOVER_OPEN_MS);
}

function leaveLobby() {
  clearTimeout(lobby.timer);
  if (lobby.pinned) return;
  lobby.token++; // a hover that's still fetching shouldn't open after the pointer has left
  if (lobby.btn) lobby.timer = setTimeout(closeLobby, HOVER_CLOSE_MS);
}

function clickLobby(btn, m) {
  if (lobby.btn === btn && lobby.pinned) return closeLobby({ refocus: true });
  if (lobby.btn !== btn) return openLobby(btn, m, true);
  clearTimeout(lobby.timer); // already open from hovering: keep it open
  lobby.pinned = true;
  lobbyEl.querySelector('.lobby-close').focus({ preventScroll: true });
}

function lobbyButton(m) {
  const btn = h('button', {
    class: 'lobby-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    onpointerenter: (e) => { if (e.pointerType !== 'touch') hoverLobby(btn, m); },
    onpointerleave: (e) => { if (e.pointerType !== 'touch') leaveLobby(); },
    onclick: () => clickLobby(btn, m),
  }, 'Scoreboard');
  return btn;
}

lobbyEl.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') clearTimeout(lobby.timer); });
lobbyEl.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') leaveLobby(); });
// The popup often covers its own button, so a click anywhere in it keeps it open too.
lobbyEl.addEventListener('click', () => { if (lobby.btn) { clearTimeout(lobby.timer); lobby.pinned = true; } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lobbyEl.hidden) closeLobby({ refocus: lobby.pinned }); });
document.addEventListener('pointerdown', (e) => { if (!lobbyEl.hidden && !lobbyEl.contains(e.target) && !e.target.closest('.lobby-btn')) closeLobby(); });
window.addEventListener('scroll', () => { if (!lobbyEl.hidden && !lobby.pinned) closeLobby(); }, { passive: true });
window.addEventListener('resize', () => { if (!lobbyEl.hidden) placeLobby(lobby.btn); });

// How many games the newest list is showing (it grows with "Show more"), so a live refresh can keep them open.
let shownCount = 0, keepShown = 0;
function matchList(matches, focus, pageSize = 25) {
  const box = h('div', { class: 'matches' });
  let shown = 0;
  const target = keepShown;
  keepShown = 0;
  const more = h('button', { class: 'btn more', onclick: () => next() }, 'Show more');
  function next() {
    more.remove();
    for (const m of matches.slice(shown, shown + pageSize)) box.append(matchCard(m, focus));
    shown += pageSize;
    shownCount = shown;
    if (shown < matches.length) box.append(more);
  }
  shownCount = 0;
  if (!matches.length) box.append(h('p', { class: 'muted' }, 'No games.'));
  else do next(); while (shown < target && shown < matches.length);
  return box;
}

/**
 * Table sorted by sortState. Columns with `sort` can be sorted by; only those that are also
 * `clickable` get a header button (others, like the default rank order, sort but can't be picked).
 */
function sortableTable(columns, rows, sortState, onSort) {
  const col = columns.find((c) => c.key === sortState.key && c.sort) ?? columns.find((c) => c.sort);
  const sorted = [...rows].sort((a, b) => {
    const va = col.sort(a), vb = col.sort(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * sortState.dir;
  });
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, columns.map((c) =>
      h('th', { class: c.right ? 'r' : null, 'aria-sort': c.key === sortState.key ? (sortState.dir > 0 ? 'ascending' : 'descending') : null },
        c.sort && c.clickable ? h('button', { onclick: () => onSort(c) }, c.label) : c.label)))),
    h('tbody', {}, sorted.map((r) => h('tr', {}, columns.map((c) => h('td', { class: c.right ? 'r' : null }, c.cell(r))))))));
}

// ---------------------------------------------------------------- charts

function niceTicks(lo, hi, count = 4) {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  const ticks = [];
  // Round both ends outward so the axis always contains the data (no bar past the top/bottom line).
  const end = Math.ceil(hi / step - 1e-9) * step;
  for (let v = Math.floor(lo / step + 1e-9) * step; v <= end + 1e-9; v += step) ticks.push(v);
  return ticks;
}

function chartBox(draw) {
  const box = h('div', { class: 'chart' });
  const run = () => draw(box, box.clientWidth || 600);
  redraws.push(run);
  requestAnimationFrame(run);
  return box;
}

/**
 * SVG path through [[x, y]] as a smooth curve that never overshoots the points
 * (monotone cubic, like d3's curveMonotoneX), so it can't poke past the highest/lowest value.
 */
function smoothPath(P) {
  const n = P.length;
  if (n < 3) return P.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('');
  const dx = [], sl = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = P[i + 1][0] - P[i][0]; sl[i] = (P[i + 1][1] - P[i][1]) / dx[i]; }
  const tan = [sl[0]];
  for (let i = 1; i < n - 1; i++) {
    tan[i] = sl[i - 1] * sl[i] <= 0 ? 0
      : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / sl[i - 1] + (dx[i] + 2 * dx[i - 1]) / sl[i]);
  }
  tan[n - 1] = sl[n - 2];
  let d = `M${P[0][0]},${P[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h3 = dx[i] / 3;
    d += `C${P[i][0] + h3},${P[i][1] + tan[i] * h3} ${P[i + 1][0] - h3},${P[i + 1][1] - tan[i + 1] * h3} ${P[i + 1][0]},${P[i + 1][1]}`;
  }
  return d;
}

/** Rank over time: one point per game, evenly spaced, smooth line with a soft fill. */
function rankChart(p) {
  const pts = p.history.filter(([, v]) => v != null);
  if (pts.length < 2) {
    return h('div', { class: 'empty-chart' }, 'The rank line appears once the tracker has seen this player’s rank change.');
  }
  return chartBox((box, W) => {
    const H = 260, m = { l: 84, r: 120, t: 12, b: 28 };
    const vals = pts.map(([, v]) => v);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const step = hi - lo > 500 ? 300 : 100; // label tiers when the range is wide, divisions when narrow
    lo = Math.max(0, Math.floor((lo - 20) / step) * step);
    hi = Math.ceil((hi + 20) / step) * step;
    if (hi - lo < 2 * step) hi = lo + 2 * step;
    // Games are spaced evenly (not by clock time), so busy days don't turn into spikes.
    const X = (i) => m.l + (i / (pts.length - 1)) * (W - m.l - m.r);
    const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

    const P = pts.map(([, v], i) => [X(i), Y(v)]);
    // The line is colored by tier: a left-to-right gradient with one stop per game, so the
    // color is solid within a tier and blends over the one game where the rank changes.
    const gid = `rank-color-${p.slug}`;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', tabindex: 0,
      'aria-label': `${p.name}'s rank over time, from ${scoreLabel(pts[0][1], 100)} to ${rankText(p.current)}. Use left and right arrow keys to step through games.` },
      s('defs', {},
        s('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: m.l, y1: 0, x2: W - m.r, y2: 0 },
          pts.map(([, , tier], i) => s('stop', { offset: i / (pts.length - 1), style: `stop-color: ${tierColor(tier)}` })))));
    // Background: a faint band per tier, so tier breaks show behind the line.
    for (const [from, to, group] of tierBands()) {
      const y1 = Y(Math.min(hi, to)), y2 = Y(Math.max(lo, from));
      if (y2 - y1 <= 0) continue;
      svg.append(s('rect', { class: 'band', x: m.l, y: y1, width: W - m.l - m.r, height: y2 - y1, style: `fill: ${tierColor(group)}` }));
    }
    for (let v = lo; v <= hi; v += step) {
      svg.append(s('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }),
        s('text', { class: 'tick', x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, scoreLabel(v, step)));
    }
    // A faint line marks where each week starts; its label is centered under that week's stretch.
    const spans = [...site.weeks].reverse()
      .map((w) => ({ w, i: pts.findIndex(([t]) => t >= w.start && t < w.end) }))
      .filter((x) => x.i >= 0);
    let lastX = -Infinity;
    spans.forEach(({ w, i }, k) => {
      const x1 = i === 0 ? m.l : X(i), x2 = k + 1 < spans.length ? X(spans[k + 1].i) : W - m.r;
      if (i > 0) svg.append(s('line', { class: 'weekline', x1, x2: x1, y1: m.t, y2: H - m.b }));
      const x = (x1 + x2) / 2;
      if (x - lastX < 60) return;
      svg.append(s('text', { class: 'tick', x, y: H - 8, 'text-anchor': 'middle' }, weekShort(w.key)));
      lastX = x;
    });
    svg.append(s('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
    // Tier breaks: a stronger line wherever one tier's band meets the next (drawn over the gridlines).
    for (const [from] of tierBands()) {
      if (from > lo && from < hi) svg.append(s('line', { class: 'tierline', x1: m.l, x2: W - m.r, y1: Y(from), y2: Y(from) }));
    }

    const line = smoothPath(P);
    const [, lastV, lastTier] = pts.at(-1), endX = X(pts.length - 1);
    svg.append(
      s('path', { class: 'series smooth', d: line, style: `stroke: url(#${gid})` }),
      s('circle', { class: 'dot', cx: endX, cy: Y(lastV), r: 4, style: `fill: ${tierColor(lastTier)}` }),
      s('text', { class: 'endlabel', x: endX + 10, y: Y(lastV) + 4 }, p.current ? rankText(p.current).replace(' · ', ' ') : scoreLabel(lastV, 100)));

    const cross = s('line', { class: 'crosshair', y1: m.t, y2: H - m.b, visibility: 'hidden' });
    const hoverDot = s('circle', { class: 'dot', r: 5, visibility: 'hidden' });
    svg.append(cross, hoverDot);
    let idx = pts.length - 1;
    const show = (i, cx, cy) => {
      idx = i;
      const [t, v, tier] = pts[i];
      const prev = i > 0 ? pts[i - 1][1] : null;
      hoverDot.style.fill = tierColor(tier);
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', X(i)); hoverDot.setAttribute('cy', Y(v)); hoverDot.setAttribute('visibility', 'visible');
      const rect = svg.getBoundingClientRect();
      showTip([
        ['tv', `${tierName(tier)} · ${rrInTier(v)} RR`, tierColor(tier)],
        ['tl', prev == null ? 'Starting rank' : `${signed(v - prev)} RR`],
        ['tl', fmtDateTime.format(t)],
      ], cx ?? rect.left + (X(i) / W) * rect.width, cy ?? rect.top + (Y(v) / H) * rect.height);
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); hoverDot.setAttribute('visibility', 'hidden'); hideTip(); };
    const hit = s('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
    hit.addEventListener('pointermove', (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.round(((px - m.l) / (W - m.l - m.r)) * (pts.length - 1));
      show(Math.max(0, Math.min(pts.length - 1, i)), ev.clientX, ev.clientY);
    });
    hit.addEventListener('pointerleave', hide);
    svg.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft') { show(Math.max(0, idx - 1)); ev.preventDefault(); }
      if (ev.key === 'ArrowRight') { show(Math.min(pts.length - 1, idx + 1)); ev.preventDefault(); }
    });
    svg.addEventListener('focus', () => show(idx));
    svg.addEventListener('blur', hide);
    svg.append(hit);
    box.replaceChildren(svg);
  });
}
/** [fromScore, toScore, group] for every tier group on the ladder score scale: Iron-Ascendant are 300 points each, then Immortal+. */
const tierBands = () => [...GROUPS.slice(0, 7).map((g, i) => [i * 300, i * 300 + 300, g]), [APEX, Infinity, 'Immortal']];
/** Color for a tier number (3-27) or a group name ('Gold'). */
function tierColor(tier) {
  const group = typeof tier === 'number' ? groupOf(tier) : tier;
  return group ? `var(--t-${group.toLowerCase()})` : 'var(--pos)';
}

/** Net RR per week: diverging columns from a zero baseline. */
function weeklyChart(p, selKey) {
  const weeks = site.weeks.filter((w) => p.weeks[w.key]?.rr != null).reverse();
  if (!weeks.length) return h('div', { class: 'empty-chart' }, 'No tracked weeks yet.');
  return chartBox((box, W) => {
    const H = 240, m = { l: 48, r: 12, t: 12, b: 28 };
    const vals = weeks.map((w) => p.weeks[w.key].rr);
    const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals, 10));
    const lo = ticks[0], hi = ticks.at(-1);
    const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const band = (W - m.l - m.r) / weeks.length;
    const bw = Math.min(24, band * 0.6);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `${p.name}'s net RR by week. Values are in the table below.` });
    for (const v of ticks) {
      svg.append(s('line', { class: v === 0 ? 'baseline' : 'gridline', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }),
        s('text', { class: 'tick', x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0'));
    }
    const every = Math.ceil(weeks.length / Math.max(1, Math.floor((W - m.l - m.r) / 56)));
    weeks.forEach((w, i) => {
      const wk = p.weeks[w.key];
      const cx = m.l + band * (i + 0.5);
      const y0 = Y(0), y1 = Y(wk.rr);
      const hgt = Math.abs(y1 - y0), r = Math.min(4, hgt, bw / 2), x = cx - bw / 2;
      const up = wk.rr >= 0;
      const d = hgt < 0.5 ? '' : up
        ? `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 + r}V${y0}Z`
        : `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 - r}V${y0}Z`;
      const lines = [
        ['tv', `${signed(wk.rr)} RR${wk.missing ? ` (${wk.missing} game${wk.missing === 1 ? '' : 's'} without RR)` : ''}`],
        ['tl', `${wk.ranked.games} ranked game${wk.ranked.games === 1 ? '' : 's'}${wk.ranked.games ? ` · ${record(wk.ranked)}` : ''}`],
        ['tl', weekFull(w.key)],
      ];
      const hit = s('rect', { class: `hit ${w.key === selKey ? 'sel' : ''}`, x: cx - band / 2, y: m.t, width: band, height: H - m.t - m.b, tabindex: 0,
        'aria-label': `${weekFull(w.key)}: ${signed(wk.rr)} RR`, 'aria-current': w.key === selKey ? 'true' : null });
      hit.addEventListener('pointermove', (ev) => showTip(lines, ev.clientX, ev.clientY));
      hit.addEventListener('pointerleave', hideTip);
      hit.addEventListener('focus', () => tipAtElement(hit, lines));
      hit.addEventListener('blur', hideTip);
      hit.addEventListener('click', () => { location.hash = `#/player/${p.slug}/${w.key}`; });
      svg.append(hit, s('path', { class: `bar ${up ? 'pos' : 'neg'}`, d, 'pointer-events': 'none' }));
      if (i % every === 0) svg.append(s('text', { class: 'tick', x: cx, y: H - 8, 'text-anchor': 'middle' }, weekShort(w.key)));
    });
    box.replaceChildren(svg);
  });
}

// ---------------------------------------------------------------- week helpers

/** Index into site.weeks (newest first) for a week key; unknown/missing -> current week (0). */
const weekIndex = (key) => Math.max(0, site.weeks.findIndex((w) => w.key === key));
/** Week part of a URL: omitted for the current week so links stay short. */
const weekPath = (key) => (key && key !== site.weeks[0].key ? `/${key}` : '');
const teamHref = (key) => (weekPath(key) ? `#/week/${key}` : '#/');
const playerHref = (slug, key) => `#/player/${slug}${weekPath(key)}`;

// Drawn chevrons for the ‹ › buttons: text glyphs sit low in the line, these center exactly.
const chevron = (dir) => s('svg', { class: 'chev', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
  s('path', { d: dir < 0 ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5' }));

function weekNav(idx, hrefFor) {
  const weeks = site.weeks;
  const older = idx < weeks.length - 1, newer = idx > 0;
  return h('div', { class: 'week-nav' },
    h('a', { class: 'btn', href: older ? hrefFor(weeks[idx + 1].key) : null, 'aria-disabled': older ? null : 'true', 'aria-label': 'Previous week' }, chevron(-1)),
    h('div', { class: 'week-label' }, weekTitle(weeks[idx].key), idx === 0 ? h('span', { class: 'pill' }, 'This week') : null),
    h('a', { class: 'btn', href: newer ? hrefFor(weeks[idx - 1].key) : null, 'aria-disabled': newer ? null : 'true', 'aria-label': 'Next week' }, chevron(1)));
}

const rrCell = (w) => (w?.rr == null
  ? h('span', { class: 'muted', title: 'Not tracked yet' }, '—')
  : h('span', { class: deltaClass(w.rr), title: w.missing ? `${w.missing} ranked game${w.missing === 1 ? '' : 's'} this week have no RR recorded` : null },
    signed(w.rr) + (w.missing ? '*' : '')));

// ---------------------------------------------------------------- team overview

function teamTotals(key) {
  const t = { games: 0, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0, assists: 0, score: 0, rounds: 0, dmg: 0, hs: 0, shots: 0 };
  let rr = 0, tracked = 0;
  for (const p of site.players) {
    const w = p.weeks[key];
    if (!w) continue;
    for (const k of Object.keys(t)) t[k] += w.ranked[k] ?? 0;
    if (w.rr != null) { rr += w.rr; tracked++; }
  }
  return { ...t, ...rates(t), rr: tracked ? rr : null, tracked };
}

function renderOverview(key) {
  const idx = weekIndex(key);
  const week = site.weeks[idx];
  const T = teamTotals(week.key);

  const tiles = h('div', { class: 'tiles' },
    tile('Team net RR', T.rr == null ? '—' : signed(T.rr), T.tracked < site.players.length ? `${T.tracked} of ${site.players.length} players (RR unknown for the rest)` : 'all players combined', T.rr != null ? deltaClass(T.rr) : ''),
    tile('Ranked games', String(T.games), 'all players combined'),
    tile('Win rate', pct(T.winRate), T.games ? `${record(T)} W–L, ranked games` : 'ranked games'),
    tile('Average ACS', whole(T.acs), T.kd != null ? `K/D ${kdText(T.kd)}, ranked games` : 'ranked games'));

  const isCurrent = idx === 0;
  const R = (r) => rates(r.w?.ranked);
  const columns = [
    { key: 'name', label: 'Player', cell: (r) => h('span', { class: 'player-cell' }, h('a', { href: playerHref(r.p.slug, week.key) }, r.p.name), h('span', { class: 'muted' }, r.p.riotId)) },
    { key: 'rank', label: isCurrent ? 'Rank' : 'Rank at end of week', sort: (r) => scoreOf(r.rank), cell: (r) => (r.rank || isCurrent ? h('span', { class: 'rank-cell' }, rankCrest(r.rank) ?? h('span', { class: 'rank-crest' }), rankText(r.rank)) : h('span', { class: 'muted', title: 'Rank was not being tracked yet' }, '—')) },
    { key: 'rr', label: 'Net RR', right: true, clickable: true, sort: (r) => r.w?.rr, cell: (r) => rrCell(r.w) },
    { key: 'games', label: 'Games', right: true, clickable: true, sort: (r) => r.w?.ranked.games ?? 0, cell: (r) => r.w?.ranked.games ?? 0 },
    { key: 'record', label: 'W–L', right: true, clickable: true, sort: (r) => (r.w?.ranked.games ? r.w.ranked.wins - r.w.ranked.losses : null), cell: (r) => record(r.w?.ranked) },
    { key: 'win', label: 'Win %', right: true, clickable: true, sort: (r) => R(r).winRate, cell: (r) => pct(R(r).winRate) },
    { key: 'kd', label: 'K/D', right: true, clickable: true, sort: (r) => R(r).kd, cell: (r) => kdText(R(r).kd) },
    { key: 'acs', label: 'ACS', right: true, clickable: true, sort: (r) => R(r).acs, cell: (r) => whole(R(r).acs) },
    { key: 'hs', label: 'HS%', right: true, clickable: true, sort: (r) => R(r).hs, cell: (r) => pct(R(r).hs) },
  ];
  const rows = site.players.map((p) => ({ p, w: p.weeks[week.key], rank: isCurrent ? p.current : p.weeks[week.key]?.endRank }));
  // Clicking a column cycles: best first -> reversed -> back to rank.
  const board = sortableTable(columns, rows, ui.sort, (c) => {
    if (ui.sort.key !== c.key) ui.sort = { key: c.key, dir: -1 };
    else if (ui.sort.dir === -1) ui.sort = { key: c.key, dir: 1 };
    else ui.sort = { key: 'rank', dir: -1 };
    render();
  });

  app.replaceChildren(
    h('div', { class: 'filters' }, weekNav(idx, teamHref)),
    tiles,
    h('section', { class: 'card' }, h('h2', {}, 'Leaderboard'),
      h('p', { class: 'sub' }, 'Ranked games only. Click a column to sort, or a player to see their games this week.'), board));
}

// ---------------------------------------------------------------- player page

async function renderPlayer(slug, weekKey, myId) {
  const p = player(slug);
  if (!p) {
    app.replaceChildren(h('p', { class: 'notice' }, 'Player not found. ', h('a', { href: '#/' }, 'Back to the team page')));
    return;
  }
  const idx = weekIndex(weekKey);
  const week = site.weeks[idx];
  const w = p.weeks[week.key];
  const isCurrent = idx === 0;

  const head = h('section', { class: 'card' },
    h('div', { class: 'player-head' },
      h('div', {},
        h('h1', {}, p.name, ' ', h('span', { class: 'riot-id' }, p.riotId)),
        h('div', { class: 'hero' }, rankCrest(p.current), rankText(p.current)),
        isRanked(p.peak) ? h('div', { class: 'peak' }, 'Peak ', rankCrest(p.peak, 'peak-crest'), tierName(p.peak.tier),
          p.peak.season ? h('span', { class: 'muted' }, ` · ${p.peak.season.toUpperCase()}`) : null) : null)));

  const nav = h('div', { class: 'filters' }, weekNav(idx, (k) => playerHref(slug, k)));

  const R = rates(w?.ranked);
  const rrNote = w?.rr == null ? 'not tracked this week'
    : w.missing ? `* ${w.missing} game${w.missing === 1 ? '' : 's'} without RR`
    : isCurrent ? 'so far this week'
    : w.endRank ? `ended at ${rankText(w.endRank)}` : 'ranked games';
  const tiles = h('div', { class: 'tiles' },
    tile('Net RR', w?.rr == null ? '—' : signed(w.rr) + (w.missing ? '*' : ''), rrNote, w?.rr != null ? deltaClass(w.rr) : ''),
    tile('Ranked games', String(w?.ranked.games ?? 0), w?.otherGames ? `+ ${w.otherGames} other` : null),
    tile('Win rate', pct(R.winRate), w?.ranked.games ? `${record(w.ranked)} W–L` : 'ranked games'),
    tile('ACS', whole(R.acs), R.kd != null ? `K/D ${kdText(R.kd)} · HS ${pct(R.hs)}` : 'ranked games'));

  // The games list header: title on the left, the ranked-only filter on the right.
  const gamesTitle = () => h('div', { class: 'card-head' },
    h('h2', { class: 'week-title' }, `${weekName(week.key)} games`, weekNum(week.key) ? h('span', { class: 'week-dates' }, weekLabel(week.key)) : null),
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: ui.rankedOnly, onchange: (e) => { ui.rankedOnly = e.target.checked; render(); } }),
      'Ranked games only'));
  const games = h('section', { class: 'card' }, gamesTitle(), h('p', { class: 'sub' }, 'Loading…'));

  const charts = h('div', { class: 'grid-2' },
    h('section', { class: 'card' }, h('h2', {}, 'Net RR by week'), h('p', { class: 'sub' }, 'Click a bar to see that week’s games.'), weeklyChart(p, week.key)),
    h('section', { class: 'card' }, h('h2', {}, 'Rank over time'), h('p', { class: 'sub' }, 'Rank after each ranked game, oldest to newest. Hover for details.'), rankChart(p)));

  const weekRows = site.weeks.filter((x) => p.weeks[x.key] && (p.weeks[x.key].ranked.games || p.weeks[x.key].rr || p.weeks[x.key].otherGames));
  const weekTable = h('section', { class: 'card' }, h('h2', {}, 'Week by week'), h('p', { class: 'sub' }, 'Click a week to see its games.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Week', 'Net RR', 'Ranked games', 'W–L', 'Win %', 'K/D', 'ACS', 'HS%', 'Other games', 'Rank at end'].map((c, i) => h('th', { class: i && i < 9 ? 'r' : null }, c)))),
      h('tbody', {}, weekRows.map((x) => {
        const wk = p.weeks[x.key];
        const r = rates(wk.ranked);
        return h('tr', { class: `link ${x.key === week.key ? 'selected' : ''}`, tabindex: 0,
          onclick: () => { location.hash = playerHref(slug, x.key); },
          onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); } },
          h('td', { class: 'week-cell' }, weekTitle(x.key, 'span')),
          h('td', { class: 'r' }, rrCell(wk)),
          h('td', { class: 'r' }, wk.ranked.games),
          h('td', { class: 'r' }, record(wk.ranked)),
          h('td', { class: 'r' }, pct(r.winRate)),
          h('td', { class: 'r' }, kdText(r.kd)),
          h('td', { class: 'r' }, whole(r.acs)),
          h('td', { class: 'r' }, pct(r.hs)),
          h('td', { class: 'r' }, wk.otherGames),
          h('td', {}, wk.endRank ? h('span', { class: 'rank-cell' }, rankCrest(wk.endRank), rankText(wk.endRank)) : h('span', { class: 'muted' }, 'not tracked')));
      })))));

  app.replaceChildren(head, nav, tiles, charts, games, weekTable);

  const data = await loadWeek(week.key);
  if (myId !== renderId) return;
  const mine = data.matches.filter((m) => m.entries.some((e) => e.player === slug) && (!ui.rankedOnly || m.queue === RANKED));
  games.replaceChildren(
    gamesTitle(),
    h('p', { class: 'sub' }, `${mine.length} ${ui.rankedOnly ? 'ranked ' : ''}game${mine.length === 1 ? '' : 's'}, newest first.`),
    matchList(mine, slug, 20));
}

// ---------------------------------------------------------------- boot + routing

/** Header tabs: Team, Recent games, then one per player. Links keep the week you're looking at. */
function renderPages(route, slug, weekKey) {
  const nav = document.getElementById('pages');
  const players = [...site.players].sort((x, y) => x.name.localeCompare(y.name));
  nav.replaceChildren(
    h('a', { href: teamHref(weekKey), 'aria-current': route !== 'player' && route !== 'recent' ? 'page' : null }, 'Team'),
    h('a', { href: '#/recent', 'aria-current': route === 'recent' ? 'page' : null }, 'Recent games'),
    h('span', { class: 'sep', 'aria-hidden': 'true' }),
    ...players.map((p) => h('a', { href: playerHref(p.slug, weekKey), 'aria-current': route === 'player' && slug === p.slug ? 'page' : null }, p.name)));
  nav.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------------------------------------------------------------- recent games page

async function renderRecent(myId) {
  const head = () => [h('h2', { class: 'section-title' }, 'Most recent games')];
  const recent = h('section', { class: 'card' }, head(), h('p', { class: 'muted' }, 'Loading…'));
  app.replaceChildren(recent);

  const weeks = await Promise.all(site.weeks.slice(0, 2).map((w) => loadWeek(w.key)));
  if (myId !== renderId) return;
  const matches = weeks.flatMap((w) => w.matches).sort((x, y) => y.time - x.time);
  recent.replaceChildren(...head(), matchList(matches, null, 10));
}

async function render() {
  const myId = ++renderId;
  redraws = [];
  hideTip();
  closeLobby();
  app.classList.add('loading');
  const [route, a, b] = location.hash.replace(/^#\/?/, '').split('/');
  const weekKey = site.weeks[weekIndex(route === 'player' ? b : route === 'week' ? a : null)].key;
  renderPages(route, a, weekKey);
  try {
    if (route === 'player') await renderPlayer(a, weekKey, myId);
    else if (route === 'recent') await renderRecent(myId);
    else renderOverview(weekKey);
  } finally {
    if (myId === renderId) app.classList.remove('loading');
  }
}

// Light/dark toggle. The theme itself is picked in index.html before first paint;
// this flips it and remembers the choice (storage can be blocked, so that's best effort).
function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  const root = document.documentElement;
  const label = () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    btn.setAttribute('aria-label', `Switch to ${next} mode`);
    btn.title = `Switch to ${next} mode`;
  };
  btn.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch {}
    label();
  });
  // Follow the system setting until the person picks one.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let saved = null;
    try { saved = localStorage.getItem('theme'); } catch {}
    if (!saved) { root.dataset.theme = e.matches ? 'dark' : 'light'; label(); }
  });
  label();
}

// ---------------------------------------------------------------- live refresh
// The data is rebuilt about every 15 minutes, and each build stamps data/status.json with its time.
// An open page shows "Last updated X minutes ago" from that stamp (re-counted every 30 seconds on the
// viewer's clock), checks the stamp every 2 minutes and whenever the tab comes back into view, and when
// there's a newer build it reloads the data and redraws in place: same page, week, scroll position and filters.

const CHECK_EVERY_MS = 2 * 60e3;
let updatedAt = null; // build time of the data on screen
let lastCheck = 0;
let checking = false;
let headerNote = null; // replaces "Last updated …" while the button is working

/** data/status.json: { updatedAt }, or null if it can't be read. */
async function fetchStatus() {
  try {
    // a new query string every time, so neither the browser nor the CDN answers from a cached copy
    const res = await fetch(`data/status.json?t=${Date.now()}`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function agoText(t) {
  const min = Math.floor((Date.now() - t) / 60e3);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const d = Math.floor(hr / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function showUpdated() {
  const el = document.getElementById('updated');
  if (headerNote) el.replaceChildren(headerNote);
  else if (updatedAt) el.replaceChildren(h('span', { class: 'wide-only' }, 'Last updated'), h('span', { class: 'narrow-only' }, 'Updated'), ` ${agoText(updatedAt)}`);
  else el.replaceChildren();
  el.title = updatedAt ? fmtDateTime.format(updatedAt) : '';
}

/** Returns once the check is done (or right away if another check is already running). */
async function checkForUpdate({ force = false } = {}) {
  if (checking || (document.hidden && !force)) return;
  checking = true;
  lastCheck = Date.now();
  try {
    const status = await fetchStatus();
    const t = status?.updatedAt;
    if (!t || t <= (updatedAt ?? 0)) return;
    const version = `?v=${t}`;
    const res = await fetch(`data/site.json${version}`, { cache: 'no-cache' });
    if (!res.ok) return; // try again next time
    const next = await res.json();
    if (!next.players?.length || !next.weeks?.length) return;
    site = next;
    dataVersion = version;
    weekCache.clear();
    rankIconSet = agentIconSet = mapIconSet = undefined;
    // Load the week on screen before redrawing, so the games list doesn't flash "Loading…" and the page keeps its height.
    const [route, a, b] = location.hash.replace(/^#\/?/, '').split('/');
    await loadWeek(site.weeks[weekIndex(route === 'player' ? b : route === 'week' ? a : null)].key).catch(() => {});
    const y = window.scrollY;
    keepShown = shownCount; // keep any "Show more" pages that were open
    await render();
    keepShown = 0; // only for this redraw (unused if the page has no games list)
    window.scrollTo(0, y);
    updatedAt = t;
    showUpdated();
  } catch {
    // network hiccup: the next check retries
  } finally {
    checking = false;
  }
}

// ---------------------------------------------------------------- "Check for new games" button
// Asks the worker in site.updateUrl (worker/update-button.js) to start an update, then watches data/status.json
// until the new build is live (usually a minute or two) and redraws in place. Hidden when updateUrl isn't set.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setupCheckButton() {
  const btn = document.getElementById('check-btn');
  if (!site.updateUrl) return;
  btn.hidden = false;
  btn.addEventListener('click', () => requestUpdate(btn));
}

async function requestUpdate(btn) {
  const note = async (text, ms) => { headerNote = text; showUpdated(); if (ms) { await sleep(ms); headerNote = null; showUpdated(); } };
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    let reply = {};
    try {
      const res = await fetch(site.updateUrl, { method: 'POST' });
      reply = await res.json().catch(() => ({ error: res.status }));
    } catch {
      reply = { error: 'offline' };
    }
    if (reply.status === 'recent') {
      // a check started moments ago: show its result if it's out, and say when another can start
      await checkForUpdate({ force: true });
      btn.classList.remove('busy');
      await note(`Just checked · try again in ${reply.retryIn}s`, 5000);
      return;
    }
    if (reply.status !== 'started' && reply.status !== 'running') {
      btn.classList.remove('busy');
      await note('Couldn’t start an update', 5000);
      return;
    }
    await note('Checking for new games…');
    const before = updatedAt ?? 0;
    const deadline = Date.now() + 5 * 60e3; // updates normally finish in a minute or two
    let done = false;
    while (!done && Date.now() < deadline) {
      await sleep(2500);
      const t = (await fetchStatus())?.updatedAt;
      if (t && t > before) {
        while (checking) await sleep(250); // a background check may be redrawing already
        await checkForUpdate({ force: true });
        done = (updatedAt ?? 0) > before;
      }
    }
    btn.classList.remove('busy');
    headerNote = null;
    if (!done) await note('Still updating · check back in a minute', 6000);
    else showUpdated();
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
  }
}

async function boot() {
  setupThemeToggle();
  try {
    // status first: if a deploy lands in between, the page just refreshes once more at the next check
    const status = await fetchStatus();
    updatedAt = status?.updatedAt ?? null;
    dataVersion = updatedAt ? `?v=${updatedAt}` : '';
    const res = await fetch(`data/site.json${dataVersion}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    site = await res.json();
  } catch {
    app.replaceChildren(h('div', { class: 'notice' }, 'No data yet. Run ', h('code', {}, 'npm run update'), ' (see the README), then reload.'));
    return;
  }
  initFormats();
  document.title = `${site.teamName} · Valorant Tracker`;
  document.getElementById('brand').textContent = site.teamName;
  showUpdated();
  setInterval(showUpdated, 30e3);
  setupCheckButton();
  if (!site.players.length || !site.weeks?.length) {
    app.replaceChildren(h('div', { class: 'notice' }, 'No players found. Add Riot IDs to ', h('code', {}, 'config.json'), ' and run ', h('code', {}, 'npm run update'), '.'));
    return;
  }
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => redraws.forEach((f) => f()), 150); });
  render();
  setInterval(checkForUpdate, CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastCheck > 30e3) checkForUpdate();
  });
}

boot();
