// Generate fake-but-realistic data so the site can be previewed without an API key. It simulates players
// queueing (often together), their RR going up and down, and the poller checking ranks every ~15 minutes,
// then runs the normal build.
//
//   node src/demo.js   ->  .demo/data (raw)  +  .demo/site-data (site JSON)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, DataStore, readJson, slugify, writeJson } from './store.js';
import { APEX_BASE, IMMORTAL, RANKED_QUEUE } from './stats.js';
import { listIcons } from './icons.js';

const DEMO = path.join(ROOT, '.demo');
const DATA = path.join(DEMO, 'data');
fs.rmSync(DEMO, { recursive: true, force: true });

let seed = 20261117;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + rand() * (b - a);
const int = (a, b) => Math.floor(between(a, b + 1));
const shuffle = (arr) => arr.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

const HOUR = 3600e3, DAY = 24 * HOUR;
const now = Date.now();
const matchStart = now - 6 * 7 * DAY;   // games go back 6 weeks
const trackStart = now - 24 * DAY;      // ...but rank checks began ~3.5 weeks ago

// Real agent and map ids when the icons have been downloaded (node src/icons.js), so the demo shows their art.
const iconState = readJson(path.join(ROOT, 'data', 'icons.json'), { names: {} });
const agentIds = listIcons(path.join(ROOT, 'site', 'img', 'agents')).filter((id) => iconState.names[id]);
const AGENTS = agentIds.length
  ? agentIds.map((id) => ({ id, name: iconState.names[id] }))
  : ['Jett', 'Sova', 'Omen', 'Killjoy', 'Sage', 'Raze', 'Viper', 'Skye', 'Cypher', 'Breach', 'Reyna', 'Clove'].map((name) => ({ id: `demo-${slugify(name)}`, name }));
const MAPS = (iconState.maps ?? []).length
  ? iconState.maps.map((id) => ({ id, name: iconState.names[id] }))
  : ['Ascent', 'Bind', 'Haven', 'Lotus', 'Sunset', 'Icebox', 'Split'].map((name) => ({ id: `demo-${slugify(name)}`, name }));

const NAMES = ['Ari', 'Benji', 'Cass', 'Dev', 'Elle', 'Finn', 'Gabe', 'Hana', 'Ivy', 'Jules'];
const STRANGERS = ['nightowl', 'tenz fan', 'clutch or kick', 'sheriff only', 'plat forever', 'lurk god', 'eco frag', 'one tap', 'smokes pls',
  'entry diff', 'op main', 'save ur gun', 'heaven peek', 'b site', 'mid ctrl', 'rotate', 'spike carrier', 'dink', 'jiggle', 'ff at 13'];

/** Ladder score -> { tier, rr }. Immortal 2/3 and Radiant cutoffs are made up for the demo. */
function fromScore(score) {
  score = Math.max(0, Math.round(score));
  if (score >= APEX_BASE) {
    const rr = score - APEX_BASE;
    return { tier: rr >= 450 ? 27 : rr >= 200 ? 26 : rr >= 90 ? 25 : IMMORTAL, rr };
  }
  return { tier: 3 + Math.floor(score / 100), rr: score % 100 };
}

const store = new DataStore(DATA);
const players = NAMES.map((name, i) => {
  const puuid = `demo-puuid-${i}`;
  store.players[`${name}#ucla`.toLowerCase()] = { riotId: `${name}#UCLA`, puuid, peak: null };
  const score = Math.round(between(1250, 2350));
  return {
    name, puuid, skill: between(-0.4, 0.8), score, peak: score, activity: between(0.3, 0.75),
    mains: shuffle(AGENTS).slice(0, 3), events: [],
  };
});

/** One scoreboard line. `skill` shifts kills and score; `won` gives the winners a little more. */
function line(team, agent, tier, skill, rounds, won) {
  const kpr = Math.max(0.35, 0.72 + skill * 0.25 + (won ? 0.06 : -0.06) + between(-0.18, 0.18));
  const k = Math.round(kpr * rounds), d = Math.round(rounds * between(0.6, 0.85) - skill * 2), a = int(1, Math.round(rounds * 0.35));
  const shots = k * int(5, 9);
  const hs = Math.round(shots * Math.min(0.4, Math.max(0.1, 0.2 + skill * 0.06 + between(-0.05, 0.05))));
  const ls = Math.round(shots * between(0.02, 0.08));
  return {
    team, agent: agent.name, agentId: agent.id, tier, k, d: Math.max(2, d), a,
    score: Math.round(k * 150 + a * 25 + rounds * between(40, 70)), hs, bs: shots - hs - ls, ls,
    dmg: Math.round(k * between(130, 170) + rounds * between(10, 30)), party: null,
  };
}

let matchNo = 1;
for (let day = matchStart; day < now; day += DAY) {
  // Each evening a few sessions: a stack of teammates who are on, playing a handful of games together.
  const online = players.filter((p) => rand() < p.activity);
  const stacks = [];
  for (const p of shuffle(online)) {
    const open = stacks.find((s) => s.length < pick([1, 2, 3, 5, 5]));
    if (open && rand() < 0.75) open.push(p); else stacks.push([p]);
  }
  for (const stack of stacks) {
    let t = day + between(17, 23) * HOUR;
    const sessionGames = int(2, 5);
    for (let g = 0; g < sessionGames && t < now - HOUR; g++) {
      const ranked = rand() < 0.85;
      const queue = ranked ? RANKED_QUEUE : pick(['unrated', 'swiftplay', 'unrated']);
      const skill = stack.reduce((s, p) => s + p.skill, 0) / stack.length;
      const won = rand() < 0.5 + skill * 0.12;
      const draw = queue !== 'swiftplay' && rand() < 0.03;
      const target = queue === 'swiftplay' ? 5 : 13;
      const overtime = !draw && queue !== 'swiftplay' && rand() < 0.12;
      const winRounds = draw ? 12 + int(0, 2) : overtime ? 14 + int(0, 2) : target;
      const loseRounds = draw ? winRounds : overtime ? winRounds - 2 : int(2, target - 1);
      const [ours, theirs] = draw ? [winRounds, winRounds] : won ? [winRounds, loseRounds] : [loseRounds, winRounds];
      const rounds = ours + theirs;
      const length = Math.round(rounds * between(95, 120));
      const start = Math.round(t);
      const id = `${String(matchNo++).padStart(8, '0')}-demo-4a1f-9c2e-d3m0g4m3d4t4`;
      const side = rand() < 0.5 ? 'Blue' : 'Red', other = side === 'Blue' ? 'Red' : 'Blue';
      const avgScore = stack.reduce((s, p) => s + p.score, 0) / stack.length;
      const used = new Set();
      const agentFor = (prefs) => { const a = [...prefs, ...shuffle(AGENTS)].find((x) => !used.has(x.id)); used.add(a.id); return a; };
      const lobbyTier = () => fromScore(avgScore + between(-150, 150)).tier;

      const m = {
        id, start, length, queue, queueName: { competitive: 'Competitive', unrated: 'Unrated', swiftplay: 'Swiftplay' }[queue],
        map: null, mapId: null, season: 'e11a3', patch: '11.10', rounds,
        teams: { [side]: { won: ours, lost: theirs, win: !draw && won }, [other]: { won: theirs, lost: ours, win: !draw && !won } },
        players: {}, others: [],
      };
      const map = pick(MAPS);
      m.map = map.name; m.mapId = map.id;
      const party = `party-${matchNo}`;
      for (const p of stack) {
        const cur = fromScore(p.score);
        m.players[p.puuid] = { ...line(side, agentFor(p.mains), cur.tier, p.skill, rounds, won), party: stack.length > 1 ? party : `solo-${p.puuid}` };
      }
      const names = shuffle(STRANGERS);
      for (let i = 0; i < 10 - stack.length; i++) {
        const team = i < 5 - stack.length ? side : other;
        const onWinners = team === side ? won : !won;
        m.others.push({ name: names[i], tag: String(int(1000, 9999)), ...line(team, agentFor([]), lobbyTier(), between(-0.4, 0.5), rounds, onWinners), party: `p-${i}` });
      }
      store.matches.set(id, m);

      if (ranked) {
        for (const p of stack) {
          const change = draw ? int(-3, 3) : won ? int(14, 26) : -int(12, 24);
          p.events.push({ t: start + length * 1000 + between(5e3, 40e3), id, change });
        }
      }
      t = start + length * 1000 + between(1, 4) * 60e3;
    }
  }
}

// Replay each player's games to get their rank after each one, ending on today's rank, then simulate the
// poller's rank checks every ~15 min (sometimes late, sometimes skipped).
for (const p of players) {
  p.events.sort((a, b) => a.t - b.t);
  let score = p.score - p.events.reduce((s, e) => s + e.change, 0);
  const rr = (store.rr[p.puuid] = {});
  for (const e of p.events) {
    const before = fromScore(score);
    score = Math.max(0, score + e.change);
    const after = fromScore(score);
    rr[e.id] = { t: Math.round(e.t), tier: after.tier, rr: after.rr, change: e.change, before: before.tier };
    if (rand() < 0.04 && e.change < 0) rr[e.id].protected = true;
    p.peak = Math.max(p.peak, score);
  }
  const peak = fromScore(p.peak + int(0, 120));
  store.players[`${p.name}#ucla`.toLowerCase()].peak = { tier: peak.tier, rr: peak.rr, season: 'e10a2' };
  const snaps = (store.snapshots[p.puuid] = []);
  const games = Object.values(rr).sort((a, b) => a.t - b.t);
  let gi = 0, cur = fromScore(p.score - p.events.reduce((s, e) => s + e.change, 0));
  for (let t = trackStart; t < now; t += 15 * 60e3) {
    if (rand() < 0.05) continue; // a skipped run
    const pollAt = Math.round(t + between(0, 6) * 60e3);
    while (gi < games.length && games[gi].t <= pollAt) cur = games[gi++];
    const last = snaps.at(-1);
    if (!last || last.tier !== cur.tier || last.rr !== cur.rr) snaps.push({ t: pollAt, tier: cur.tier, rr: cur.rr });
  }
}

store.save();
writeJson(path.join(DEMO, 'config.json'), {
  teamName: 'UCLA Valorant (demo data)', region: 'na', platform: 'pc', timezone: 'America/Los_Angeles', weekStartsOn: 1,
  players: players.map((p) => ({ riotId: `${p.name}#UCLA`, name: p.name })),
}, 3);
execFileSync(process.execPath, [
  path.join(ROOT, 'src', 'build.js'),
  '--config', path.join(DEMO, 'config.json'), '--data', DATA, '--out', path.join(DEMO, 'site-data'),
], { stdio: 'inherit' });
console.log(`demo players: ${players.map((p) => slugify(p.name)).join(', ')}`);
