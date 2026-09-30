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

Two feeds are supported. Put your key in a Netlify environment variable named **`ODDS_API_KEY`**. The site works out which feed the key belongs to from its format: a 32-character key is The Odds API, anything else is SportsGameOdds.

| Feed | FanDuel | DraftKings | Caesars | bet365 | Live in-game odds |
|---|---|---|---|---|---|
| [The Odds API](https://the-odds-api.com/#get-access) | ✅ | ✅ | paid plans only | ❌ (not offered for US) | ✅ all plans |
| [SportsGameOdds](https://sportsgameodds.com/pricing) | ✅ | ✅ | ✅ | ✅ | AllStar plan |

If a book isn't included in your plan, its column shows "n/a" and a note at the top explains why. The "best odds" picks only compare books that actually have prices.

With **no key set**, the site runs in **demo mode** with simulated odds. A yellow banner makes it obvious that the odds aren't real.

Advanced: `THE_ODDS_API_KEY` and `SPORTSGAMEODDS_API_KEY` still work if you want both feeds configured. SportsGameOdds wins when both are set. `ODDS_PROVIDER=theoddsapi|sportsgameodds|demo` forces one.

> **Never commit your API key to this repository.** The repo is public, and bots scan GitHub for keys and will use up your credits. Keep the key only in Netlify's environment variables.

## Deploy to Netlify

1. In Netlify: **Add new site → Import an existing project →** pick this GitHub repo, branch `main`.
   Build settings come from `netlify.toml` (publish directory `public`, functions in `netlify/functions`). Leave the build command empty.
2. **Site configuration → Environment variables → Add a variable → Add a single variable:**
   - Key: `ODDS_API_KEY`
   - Value: your API key
   - Scopes: leave as "All scopes"; Deploy contexts: "Same value for all deploy contexts"
   - Optional: `ODDS_CACHE_SECONDS`, how many seconds one odds snapshot is reused (default `20`, see costs below)
3. **Deploys → Trigger deploy.** The demo banner disappears once a real key is working.

### Keeping API costs under control

Every visitor's browser calls `/api/odds`, but the function reuses one response for `ODDS_CACHE_SECONDS` (via Netlify's CDN cache and an in-memory cache). API usage therefore depends on that setting, not on how many people are on the site. Rough numbers for a 3.5-hour game window:

- **The Odds API:** each refresh costs 4 credits (3 markets + live scores). Credits are only used while someone has the page open.
  - Free plan (500 credits/month): about 125 refreshes. At the default 20s that's roughly **40 minutes** of live viewing a month; at `ODDS_CACHE_SECONDS=60` it's about 2 hours.
  - 20K plan: about 5,000 refreshes, or roughly 28 hours at 20s.
  - The page warns when fewer than 100 credits are left.
- **SportsGameOdds:** usage is counted per event returned.

Raise `ODDS_CACHE_SECONDS` if you're burning through your plan.

## Run locally

```bash
npm install -g netlify-cli
ODDS_API_KEY=your_key netlify dev   # or leave the key off for demo mode
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
