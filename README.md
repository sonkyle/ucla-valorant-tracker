# Valorant Team Tracker

A website showing each player's ranked Valorant games and **net RR week by week**.
It runs free on GitHub: a scheduled GitHub Action checks for new games every ~15 minutes and
publishes a static site on GitHub Pages. It's the same site as the TFT team tracker, built for Valorant.

- **Team page:** team totals for the week (net RR, ranked games, win rate, ACS) and a leaderboard
  (rank, net RR, games, W–L, win %, K/D, ACS, HS%).
- **Recent games page:** every player's most recent games, newest first. Teammates in the same game share one card.
- **Scoreboard:** hover the button on any game to see the full 10-player scoreboard (agent, rank going in, ACS, K/D/A,
  +/−, HS%, ADR). Click or tap to keep it open.
- **Player pages** (one tab per player in the header): that player's net RR and games for the selected week, plus their
  current and peak rank, a rank-over-time chart, net RR per week, and a week-by-week table.
  The week you're looking at carries over when you switch between the team page and player pages.

Want to see it before setting anything up? Run `npm run demo` and open the URL it prints (10 fake players).
It uses port 8080, or the next free port if 8080 is taken. Pick one with `node src/serve.js --demo --port 3000`.

## Where the data comes from (read this)

Riot's official Valorant API doesn't work for a site like this: match history and ranks are only available to
approved production apps, and Riot doesn't approve personal keys for Valorant. So the tracker uses the
**[HenrikDev API](https://docs.henrikdev.xyz)**, an unofficial API that most community Valorant sites use.
It needs a free key (step 1 below).

Unlike TFT, Valorant reports the **RR change for every ranked game**, so RR here is exact: each game shows the RR
Riot gave or took, with Riot's notes (placement game, derank protection, RR refunded for a cheater).
- Weekly net RR = the sum of that week's ranked games' RR changes.
- A `*` after a week's net RR means some ranked games that week have no RR recorded (shown as "RR n/a" on the game),
  so the total leaves them out.
- The tracker also checks each player's current rank every run and saves it when it changes, for the rank chart.

Only Competitive counts as ranked. Other modes (Unrated, Swiftplay, Premier, Deathmatch…) are tracked and listed,
and the "Ranked games only" switch on player pages hides them.

**Agent, map and rank art** comes from [valorant-api.com](https://valorant-api.com). Each poll downloads anything
missing into `site/img/agents`, `maps` and `ranks` (shrunk to small sizes), so the site serves it itself.
Run `node src/icons.js` to fetch them by hand.

Weeks run Monday 12am to Sunday 11:59pm Pacific time. You can change this in `config.json`.

## Setup

Requires Node 22+. There are no npm dependencies.

### 1. HenrikDev API key
1. Sign in at https://api.henrikdev.xyz/dashboard/ (it uses Discord).
2. **API Keys → Generate New Key.** The free tier is enough for a team.
3. `cp .env.example .env` and paste the key into `.env`.

The tracker spaces its requests to 30 a minute and slows down further when the API says it's near the limit.
If your key allows more, set `"requestsPerMinute"` in `config.json`.

### 2. Add the players
Edit `config.json`:

```json
{
  "teamName": "UCLA Valorant",
  "region": "na",
  "platform": "pc",
  "timezone": "America/Los_Angeles",
  "weekStartsOn": 1,
  "trackFrom": "2026-11-01",
  "players": [
    { "riotId": "SomeName#NA1", "name": "Display Name" }
  ]
}
```

- `riotId` is the in-game `Name#TAG`. `name` is what the site shows.
- `region`: `na`, `eu`, `ap`, `kr`, `br` or `latam`. `platform`: `pc` or `console`.
- `trackFrom` sets how far back games are backfilled. The start of the current act is a good choice.
- `weekOne` (optional) is the first day of "Week 1". The site then labels weeks by number (Week 1, Week 2, …), with the
  dates shown smaller. Leave it out to label weeks by date only.
- `weekStartsOn`: 0 = Sunday, 1 = Monday. `weekStartsAt` (optional, default `"00:00"`) is the time of day the week
  starts, e.g. `"22:00"` for after a Wednesday night meeting. A week that starts late in a day is named after its first
  full day. `weekStartsAtFrom` (optional) is the first start day that time applies to; earlier weeks keep starting at
  midnight.
- `queueNames` (optional) renames modes, e.g. `{ "hurm": "TDM" }`.

### 3. Run locally
```sh
cp .env.example .env          # then paste your key into .env
npm run update                # check for games + build the site data
npm run serve                 # prints the local URL (8080, or the next free port)
```
The first run backfills each player's RR history and games back to `trackFrom`. Each run makes at most 250 API calls,
so a large backfill finishes over a few runs. Use `node src/poll.js --max-calls 1000` to do more at once.

### 4. Put it online (GitHub Pages)
1. Create a GitHub repo for this folder (e.g. `ucla-valorant-tracker`) and push it.
2. Repo **Settings → Secrets and variables → Actions → New repository secret**: name `HENRIK_API_KEY`, value = your key.
3. Repo **Settings → Pages → Source: GitHub Actions**.
4. **Actions → "Update data & deploy site" → Run workflow** once. After that it's meant to run every 15 minutes on its own.

The site will be at `https://<user-or-org>.github.io/<repo>/`. The workflow commits only when the data changed, but
redeploys after every check so the site's "Last updated X minutes ago" stays current.

**If the scheduled runs never start.** GitHub's built-in schedule is best-effort, and for some repos it never fires. The fix
is a free outside timer that starts the workflow through GitHub's API every 15 minutes, e.g. [cron-job.org](https://cron-job.org):
- Make a fine-grained token (GitHub **Settings → Developer settings → Fine-grained tokens**) for this repo only, with
  **Actions: Read and write**.
- Create a cron job: `POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/update.yml/dispatches` every
  15 minutes, with headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
  `Content-Type: application/json` and body `{"ref":"main"}`. A test run should return 204.
- When the token expires (GitHub emails you first), regenerate it and paste the new one into the cron job.

### 5. "Check for new games" button (optional)
A refresh button in the site's header lets anyone start an update instead of waiting for the next 15-minute check.
Starting an update needs a GitHub token, which can't go in a public page, so a small free Cloudflare Worker
([worker/update-button.js](worker/update-button.js)) holds it and starts the workflow, at most once every 2 minutes and
never while an update is already running.
1. Make another fine-grained token like the one above (this repo only, **Actions: Read and write**).
2. In the [Cloudflare dashboard](https://dash.cloudflare.com) (free account): **Workers & Pages → Create → Create Worker**,
   name it (e.g. `valorant-update`), **Deploy**, then **Edit code**: replace everything with `worker/update-button.js` and **Deploy**.
   If your repo or site address isn't `sonkyle/ucla-valorant-tracker`, change `REPO` and `SITE_ORIGINS` at the top first.
3. The worker's **Settings → Variables and Secrets → Add**: type **Secret**, name `GITHUB_TOKEN`, value = the token.
4. Add the worker's address to `config.json` (`"updateUrl": "https://valorant-update.<you>.workers.dev"`) and push.
   The button appears once that deploy finishes.

Notes:
- If the key is wrong or revoked, the workflow fails and GitHub emails you. Update the secret and it recovers; games
  played meanwhile are picked up on the next run.
- GitHub turns off scheduled workflows after 60 days with no repo activity, e.g. a long break. Re-enable it from the Actions tab.

## Project layout
```
config.json          players + settings
worker/              Cloudflare Worker for the "Check for new games" button
src/poll.js          one polling pass: ranks, RR per game, new games -> data/
src/build.js         data/ -> site/data/ (weekly roll-ups, scoreboards)
src/stats.js         rank math, week math, weekly totals (unit-tested)
src/henrik.js        HenrikDev API client (rate limits, retries)
src/icons.js         agent/map/rank icons + names from valorant-api.com -> site/img/
data/                stored rank checks, RR history and trimmed games (committed)
site/                the static website (index.html, app.js, style.css, data/)
test/                npm test
```

Removing a player from `config.json` hides them from the site but keeps their data. Adding a player backfills their history on the next run.

---
This site isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in
producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered
trademarks of Riot Games, Inc.
