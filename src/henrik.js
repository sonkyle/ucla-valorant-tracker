// Client for the HenrikDev Valorant API (https://docs.henrikdev.xyz), an unofficial API that relays Riot's
// Valorant data. Riot's own Valorant match and rank endpoints are only open to approved production apps,
// so a team site like this one can't use them directly.
//
// Rate limits: requests are spaced out (`perMinute`, default 30), and when the API says the window is
// nearly used up (X-RateLimit-Remaining) or answers 429, the client waits for the reset it reports.

const BASE = 'https://api.henrikdev.xyz/valorant';
export const REGIONS = ['na', 'eu', 'ap', 'kr', 'br', 'latam'];
export const PLATFORMS = ['pc', 'console'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seconds = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export class HenrikClient {
  constructor(apiKey, { region = 'na', platform = 'pc', perMinute = 30 } = {}) {
    if (!apiKey) throw new Error('Missing HENRIK_API_KEY (put it in .env or the environment).');
    if (!REGIONS.includes(region)) throw new Error(`Unknown region "${region}" (use one of ${REGIONS.join(', ')})`);
    if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform "${platform}" (use pc or console)`);
    this.apiKey = apiKey;
    this.region = region;
    this.platform = platform;
    this.gapMs = 60_000 / perMinute;
    this.next = 0; // earliest time the next request may go out
    this.requests = 0;
  }

  async #throttle() {
    const wait = this.next - Date.now();
    if (wait > 0) await sleep(wait);
    this.next = Date.now() + this.gapMs;
  }

  /** GET a path under /valorant. Returns the parsed body, or null for 404 (no such account, match or rank data). */
  async get(path, query = {}) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    ).toString();
    const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      await this.#throttle();
      this.requests++;
      let res;
      try {
        res = await fetch(url, { headers: { Authorization: this.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      } catch (err) {
        if (attempt >= 4) throw err;
        await sleep(3000 * (attempt + 1));
        continue;
      }
      const reset = seconds(res.headers.get('x-ratelimit-reset'));
      const remaining = seconds(res.headers.get('x-ratelimit-remaining'));
      if (remaining != null && remaining <= 1 && reset) {
        this.next = Math.max(this.next, Date.now() + reset * 1000 + 250);
      }
      if (res.ok) return res.json();
      if (res.status === 404) return null;
      if (res.status === 401 || res.status === 403) {
        throw new Error(`HenrikDev API rejected the key (${res.status}). Check HENRIK_API_KEY.`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const wait = seconds(res.headers.get('retry-after')) ?? reset ?? 5 * 2 ** attempt;
        await sleep(Math.min(wait, 120) * 1000 + 250);
        continue;
      }
      const body = await res.text();
      let message = body.slice(0, 300);
      try { message = JSON.parse(body).errors?.map((e) => e.message).join('; ') || message; } catch {}
      throw new Error(`HenrikDev API ${res.status} for ${path}: ${message}`);
    }
  }

  /** { puuid, region, name, tag, ... } or null if the Riot ID doesn't exist. */
  async account(name, tag) {
    return (await this.get(`/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`))?.data ?? null;
  }

  /** Current rank, peak and the latest RR update ({ current, peak, latest_update, ... }); null if they've never played ranked. */
  async mmr(puuid) {
    return (await this.get(`/v3/by-puuid/mmr/${this.region}/${this.platform}/${puuid}`))?.data ?? null;
  }

  /** Recent ranked games with the RR each one gained or lost, newest first. */
  async mmrHistory(puuid) {
    return (await this.get(`/v2/by-puuid/mmr-history/${this.region}/${this.platform}/${puuid}`))?.data?.history ?? [];
  }

  /** Older RR history that HenrikDev has saved, newest first, a page at a time. */
  async storedMmrHistory(puuid, { page = 1, size = 25 } = {}) {
    return (await this.get(`/v1/by-puuid/stored-mmr-history/${this.region}/${puuid}`, { page, size }))?.data ?? [];
  }

  /** Up to 10 full games (every player, every team), newest first, starting `start` games back. All modes. */
  async matches(puuid, { start = 0, size = 10 } = {}) {
    return (await this.get(`/v4/by-puuid/matches/${this.region}/${this.platform}/${puuid}`, { start, size }))?.data ?? [];
  }

  /** One full game by id, or null if it can't be found. */
  async match(id) {
    return (await this.get(`/v4/match/${this.region}/${id}`))?.data ?? null;
  }
}
