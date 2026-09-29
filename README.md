# CFB Live Line Shop

A live college football odds comparison site. It shows **FanDuel, DraftKings, Caesars and bet365** side by side, updates while games are in progress, and highlights the sportsbook paying the most for each side. That's where you should place the bet.

- **Live / Upcoming tabs.** In-game odds refresh automatically (every 10–60s, your choice). Refreshing pauses while the tab is hidden.
- **Moneyline, spread and total.** Best line logic understands each market:
  - Moneyline: the highest payout wins.
  - Spread: more points wins; if the points are equal, the better price wins.
  - Total: the lowest Over line or the highest Under line wins; ties go to the better price.
- **Best-bet cards.** Each card shows the best book and the payout on your stake. For moneylines it also shows a **value %**: how the best price compares with the market's no-vig fair odds.
- **Line movement.** ▲ ▼ arrows and a flash mark a price that just moved. Faded cells are quotes the book hasn't refreshed in 3+ minutes.
- **"My sportsbooks" filter.** Untick the books you don't have an account with, and the best pick will only use your books. The page remembers your choices.
- Works on phones, and supports light and dark mode.

## Where the odds come from

Sportsbooks don't allow scraping. They block bots, change their pages all the time, and scraping breaks their terms. So the site reads odds from a **licensed odds data feed** through a small Netlify Function (`/api/odds`). The function keeps your API key secret on the server.

Two feeds are supported. Set **one** of these keys:

| Feed | Env variable | FanDuel | DraftKings | Caesars | bet365 | Live in-game odds |
|---|---|---|---|---|---|---|
| **[SportsGameOdds](https://sportsgameodds.com/pricing)** (recommended) | `SPORTSGAMEODDS_API_KEY` | ✅ | ✅ | ✅ | ✅ | AllStar plan |
| [The Odds API](https://the-odds-api.com/#get-access) | `THE_ODDS_API_KEY` | ✅ | ✅ | paid plans | ❌ (not offered for US) | ✅ all plans |

With **no key set**, the site runs in **demo mode** with simulated odds. A yellow banner makes it obvious that the odds aren't real.

If both keys are set, SportsGameOdds is used. You can force one feed with `ODDS_PROVIDER=sportsgameodds`, `theoddsapi` or `demo`.

## Deploy to Netlify

1. In Netlify: **Add new site → Import an existing project →** pick this GitHub repo, branch `main`.
   Build settings come from `netlify.toml` (publish directory `public`, functions in `netlify/functions`). Leave the build command empty.
2. **Site configuration → Environment variables → Add a variable:**
   - `SPORTSGAMEODDS_API_KEY` = your key (or `THE_ODDS_API_KEY` = your key)
   - optional: `ODDS_CACHE_SECONDS` = how long one API response is reused (default `20`)
3. **Deploys → Trigger deploy.** The demo banner disappears once a real key is working.

### Keeping API costs under control

Every visitor's browser calls `/api/odds`, but the function reuses one response for `ODDS_CACHE_SECONDS` (via Netlify's CDN cache and an in-memory cache). API usage therefore depends on that setting, not on how many people are on the site. Rough numbers for a 3.5-hour game window:

- The Odds API costs 4 credits per refresh (3 markets + scores). At 20s that is about **2,500 credits per window**.
- On SportsGameOdds, usage is counted per event returned.

Raise `ODDS_CACHE_SECONDS` if you're burning through your plan.

## Run locally

```bash
npm install -g netlify-cli
SPORTSGAMEODDS_API_KEY=xxx netlify dev   # or leave the key off for demo mode
npm test                                 # unit tests for the odds math and feed parsing
```

## Project layout

```
public/                 static site (index.html, app.js, odds-math.js, styles.css)
netlify/functions/odds.mjs   /api/odds endpoint with caching
netlify/lib/providers.mjs    feed adapters (SportsGameOdds, The Odds API, demo) → one common format
test/                    node --test unit tests
```

## Important

Odds from any data feed can lag the sportsbook by a few seconds, and live lines get suspended during plays. **Always confirm the price in the sportsbook app before betting.** You must be 21+ and in a state where sports betting is legal. Gambling problem? Call 1-800-GAMBLER.
