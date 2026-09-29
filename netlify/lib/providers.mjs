// Fetches college football odds from a licensed odds feed and normalizes them
// into one shape the front end understands, regardless of which feed is used.
//
// Normalized game:
// {
//   id, home, away, commence (ISO), status: { live, completed, display },
//   score: { home, away } | null,
//   markets: {
//     moneyline: { home: { [book]: Quote }, away: { [book]: Quote } },
//     spread:    { home: { [book]: Quote }, away: { [book]: Quote } },
//     total:     { over: { [book]: Quote }, under: { [book]: Quote } },
//   }
// }
// Quote = { price: <american int>, point: <number|null>, updated: ISO|null, link: url|null }

export const BOOKS = [
  { key: "fanduel", name: "FanDuel", url: "https://sportsbook.fanduel.com/navigation/ncaaf" },
  { key: "draftkings", name: "DraftKings", url: "https://sportsbook.draftkings.com/leagues/football/ncaaf" },
  { key: "caesars", name: "Caesars", url: "https://sportsbook.caesars.com/us/bet/football" },
  { key: "bet365", name: "bet365", url: "https://www.bet365.com/#/AS/B12/" },
];

const emptyMarkets = () => ({
  moneyline: { home: {}, away: {} },
  spread: { home: {}, away: {} },
  total: { over: {}, under: {} },
});

export function parseAmerican(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim().toLowerCase();
  if (s === "even" || s === "ev") return 100;
  const n = Number(s.replace(/^\+/, ""));
  if (!Number.isFinite(n) || n === 0 || (n > -100 && n < 100)) return null;
  return Math.round(n);
}

export function decimalToAmerican(dec) {
  const d = Number(dec);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

function parsePoint(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/^\+/, ""));
  return Number.isFinite(n) ? n : null;
}

function toNumber(value) {
  const n = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(n) ? null : n;
}

// ---------------------------------------------------------------------------
// SportsGameOdds (https://sportsgameodds.com) — covers FanDuel, DraftKings,
// Caesars AND bet365. In-game (live) odds require their AllStar plan.
// ---------------------------------------------------------------------------

const SGO_ODD_IDS = {
  "points-home-game-ml-home": ["moneyline", "home"],
  "points-away-game-ml-away": ["moneyline", "away"],
  "points-home-game-sp-home": ["spread", "home"],
  "points-away-game-sp-away": ["spread", "away"],
  "points-all-game-ou-over": ["total", "over"],
  "points-all-game-ou-under": ["total", "under"],
};

export function normalizeSportsGameOdds(events, now = Date.now()) {
  const books = new Set(BOOKS.map((b) => b.key));
  const games = [];
  for (const ev of events || []) {
    const status = ev.status || {};
    if (status.cancelled || status.completed || status.finalized) continue;
    const markets = emptyMarkets();
    for (const [oddID, [market, side]] of Object.entries(SGO_ODD_IDS)) {
      const odd = ev.odds?.[oddID];
      if (!odd?.byBookmaker) continue;
      for (const [bookID, q] of Object.entries(odd.byBookmaker)) {
        if (!books.has(bookID) || q?.available === false) continue;
        const price = parseAmerican(q.odds);
        if (price === null) continue;
        const point = market === "spread" ? parsePoint(q.spread) : market === "total" ? parsePoint(q.overUnder) : null;
        if (market !== "moneyline" && point === null) continue;
        markets[market][side][bookID] = {
          price,
          point,
          updated: q.lastUpdatedAt || null,
          link: typeof q.deeplink === "string" && q.deeplink.startsWith("https://") ? q.deeplink : null,
        };
      }
    }
    const startsAt = status.startsAt || ev.startsAt || null;
    const started = status.started ?? (startsAt ? Date.parse(startsAt) <= now : false);
    const live = Boolean(status.live ?? (started && !status.ended));
    const homeScore = toNumber(ev.results?.game?.home?.points ?? ev.teams?.home?.score);
    const awayScore = toNumber(ev.results?.game?.away?.points ?? ev.teams?.away?.score);
    const names = (t) => t?.names?.long || t?.names?.medium || t?.names?.short || t?.teamID || "TBD";
    games.push({
      id: ev.eventID,
      home: names(ev.teams?.home),
      away: names(ev.teams?.away),
      commence: startsAt,
      status: {
        live,
        completed: Boolean(status.ended),
        display: live ? status.displayLong || status.displayShort || "Live" : null,
      },
      score: homeScore !== null || awayScore !== null ? { home: homeScore ?? 0, away: awayScore ?? 0 } : null,
      markets,
    });
  }
  return games;
}

async function fetchSportsGameOdds(apiKey) {
  const params = new URLSearchParams({
    leagueID: "NCAAF",
    oddsAvailable: "true",
    finalized: "false",
    bookmakerID: BOOKS.map((b) => b.key).join(","),
    oddID: Object.keys(SGO_ODD_IDS).join(","),
    limit: "100",
  });
  const events = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`https://api.sportsgameodds.com/v2/events?${params}`, {
      headers: { "x-api-key": apiKey },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      throw new ProviderError(`SportsGameOdds error ${res.status}: ${body.error || res.statusText}`, res.status);
    }
    events.push(...(body.data || []));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return { games: normalizeSportsGameOdds(events), quota: null };
}

// ---------------------------------------------------------------------------
// The Odds API (https://the-odds-api.com) — covers FanDuel, DraftKings and
// Caesars ("williamhill_us", paid plans only). bet365 is NOT offered for US
// markets by this feed.
// ---------------------------------------------------------------------------

const ODDS_API_BOOKS = { fanduel: "fanduel", draftkings: "draftkings", williamhill_us: "caesars" };
const ODDS_API_MARKETS = { h2h: "moneyline", spreads: "spread", totals: "total" };

export function normalizeOddsApi(events, scores, now = Date.now()) {
  const scoreById = new Map((scores || []).map((s) => [s.id, s]));
  const games = [];
  for (const ev of events || []) {
    const markets = emptyMarkets();
    for (const bm of ev.bookmakers || []) {
      const book = ODDS_API_BOOKS[bm.key];
      if (!book) continue;
      for (const m of bm.markets || []) {
        const market = ODDS_API_MARKETS[m.key];
        if (!market) continue;
        for (const o of m.outcomes || []) {
          let side;
          if (market === "total") side = o.name === "Over" ? "over" : o.name === "Under" ? "under" : null;
          else side = o.name === ev.home_team ? "home" : o.name === ev.away_team ? "away" : null;
          if (!side) continue;
          const price = parseAmerican(o.price);
          if (price === null) continue;
          const point = market === "moneyline" ? null : parsePoint(o.point);
          if (market !== "moneyline" && point === null) continue;
          markets[market][side][book] = {
            price,
            point,
            updated: m.last_update || bm.last_update || null,
            link: typeof (m.link || bm.link) === "string" && (m.link || bm.link).startsWith("https://") ? m.link || bm.link : null,
          };
        }
      }
    }
    const sc = scoreById.get(ev.id);
    if (sc?.completed) continue;
    const started = Date.parse(ev.commence_time) <= now;
    let score = null;
    if (Array.isArray(sc?.scores)) {
      const find = (team) => toNumber(sc.scores.find((s) => s.name === team)?.score);
      const h = find(ev.home_team);
      const a = find(ev.away_team);
      if (h !== null || a !== null) score = { home: h ?? 0, away: a ?? 0 };
    }
    games.push({
      id: ev.id,
      home: ev.home_team,
      away: ev.away_team,
      commence: ev.commence_time,
      status: { live: started, completed: false, display: started ? "Live" : null },
      score,
      markets,
    });
  }
  return games;
}

async function fetchOddsApi(apiKey) {
  const base = "https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf";
  const oddsParams = new URLSearchParams({
    apiKey,
    bookmakers: Object.keys(ODDS_API_BOOKS).join(","),
    markets: Object.keys(ODDS_API_MARKETS).join(","),
    oddsFormat: "american",
    includeLinks: "true",
  });
  const [oddsRes, scoresRes] = await Promise.all([
    fetch(`${base}/odds?${oddsParams}`),
    fetch(`${base}/scores?${new URLSearchParams({ apiKey })}`),
  ]);
  if (!oddsRes.ok) {
    const body = await oddsRes.json().catch(() => ({}));
    throw new ProviderError(`The Odds API error ${oddsRes.status}: ${body.message || oddsRes.statusText}`, oddsRes.status);
  }
  const events = await oddsRes.json();
  // Scores are a nice-to-have; odds still render if this call fails.
  const scores = scoresRes.ok ? await scoresRes.json().catch(() => []) : [];
  const remaining = scoresRes.headers.get("x-requests-remaining") ?? oddsRes.headers.get("x-requests-remaining");
  return {
    games: normalizeOddsApi(events, scores),
    quota: remaining !== null ? { remaining: Number(remaining) } : null,
  };
}

// ---------------------------------------------------------------------------
// Demo feed — used only when no API key is configured so the site still
// renders after the first deploy. Clearly flagged as simulated in the UI.
// ---------------------------------------------------------------------------

const DEMO_MATCHUPS = [
  ["Ohio State Buckeyes", "Michigan Wolverines", -6.5, 47.5],
  ["Georgia Bulldogs", "Alabama Crimson Tide", -2.5, 51.5],
  ["Texas Longhorns", "Oklahoma Sooners", -4.5, 55.5],
  ["Oregon Ducks", "USC Trojans", -9.5, 60.5],
  ["Florida State Seminoles", "Miami Hurricanes", 3.5, 49.5],
  ["LSU Tigers", "Ole Miss Rebels", 1.5, 62.5],
  ["Penn State Nittany Lions", "Notre Dame Fighting Irish", -3, 44.5],
  ["Clemson Tigers", "Florida Atlantic Owls", -24.5, 52.5],
];

function spreadToMoneyline(spread) {
  // Rough spread → win probability → American odds, good enough for a demo.
  const p = 1 / (1 + Math.exp(spread / 6.2));
  const clamp = Math.min(Math.max(p, 0.02), 0.98);
  return clamp >= 0.5 ? Math.round((-100 * clamp) / (1 - clamp)) : Math.round((100 * (1 - clamp)) / clamp);
}

export function demoGames(now = Date.now()) {
  const tick = Math.floor(now / 15000); // odds "move" every 15 seconds
  const rand = (seed) => {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const iso = (ms) => new Date(ms).toISOString();
  return DEMO_MATCHUPS.map(([home, away, baseSpread, baseTotal], i) => {
    const live = i < 5;
    const drift = live ? (rand(tick * 7 + i) - 0.5) * 6 : 0;
    const spread = Math.round((baseSpread + drift) * 2) / 2;
    const quarter = 1 + ((tick + i) % 4);
    const clockSec = 900 - ((tick * 37 + i * 101) % 900);
    const homeScore = live ? Math.round(quarter * 6 + rand(i + 1) * 10 - Math.min(spread, 0)) : null;
    const awayScore = live ? Math.round(quarter * 5 + rand(i + 2) * 10 + Math.max(spread, 0)) : null;
    const markets = emptyMarkets();
    BOOKS.forEach((b, j) => {
      const r = (k) => rand(tick * 31 + i * 17 + j * 5 + k);
      const bookSpread = spread + (r(1) < 0.3 ? 0.5 : r(1) > 0.8 ? -0.5 : 0);
      const ml = spreadToMoneyline(bookSpread);
      let k = 10;
      const jig = () => Math.round((r(k++) - 0.5) * 20);
      const vig = (p) => (p > 0 ? Math.max(100, p - 12) : p - 12);
      const updated = iso(now - Math.round(r(9) * 40000));
      const link = null;
      markets.moneyline.home[b.key] = { price: vig(ml) + jig(), point: null, updated, link };
      markets.moneyline.away[b.key] = { price: vig(spreadToMoneyline(-bookSpread)) + jig(), point: null, updated, link };
      markets.spread.home[b.key] = { price: -110 + jig(), point: bookSpread, updated, link };
      markets.spread.away[b.key] = { price: -110 + jig(), point: -bookSpread, updated, link };
      const tot = baseTotal + (live ? Math.round((rand(tick + i) - 0.5) * 8) / 2 : 0) + (r(3) < 0.25 ? 0.5 : 0);
      markets.total.over[b.key] = { price: -110 + jig(), point: tot, updated, link };
      markets.total.under[b.key] = { price: -110 + jig(), point: tot, updated, link };
    });
    for (const market of Object.values(markets)) {
      for (const side of Object.values(market)) {
        for (const q of Object.values(side)) {
          if (q.price > -100 && q.price < 100) q.price = q.price >= 0 ? 100 : -100;
        }
      }
    }
    return {
      id: `demo-${i}`,
      home,
      away,
      commence: live ? iso(now - (quarter * 45 + i * 3) * 60000) : iso(now + (i - 4) * 3 * 3600000),
      status: {
        live,
        completed: false,
        display: live ? `Q${quarter} ${Math.floor(clockSec / 60)}:${String(clockSec % 60).padStart(2, "0")}` : null,
      },
      score: live ? { home: Math.max(homeScore, 0), away: Math.max(awayScore, 0) } : null,
      markets,
    };
  });
}

// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function pickProvider(env) {
  const forced = (env.ODDS_PROVIDER || "").toLowerCase();
  if (forced === "demo") return "demo";
  if (forced === "sportsgameodds" && env.SPORTSGAMEODDS_API_KEY) return "sportsgameodds";
  if (forced === "theoddsapi" && env.THE_ODDS_API_KEY) return "theoddsapi";
  if (env.SPORTSGAMEODDS_API_KEY) return "sportsgameodds";
  if (env.THE_ODDS_API_KEY) return "theoddsapi";
  return "demo";
}

export async function loadOdds(env) {
  const provider = pickProvider(env);
  let result;
  if (provider === "sportsgameodds") result = await fetchSportsGameOdds(env.SPORTSGAMEODDS_API_KEY);
  else if (provider === "theoddsapi") result = await fetchOddsApi(env.THE_ODDS_API_KEY);
  else result = { games: demoGames(), quota: null };

  const covered =
    provider === "theoddsapi" ? ["fanduel", "draftkings", "caesars"] : BOOKS.map((b) => b.key);
  result.games.sort((a, b) => {
    if (a.status.live !== b.status.live) return a.status.live ? -1 : 1;
    return Date.parse(a.commence || 0) - Date.parse(b.commence || 0);
  });
  return {
    provider,
    demo: provider === "demo",
    fetchedAt: new Date().toISOString(),
    books: BOOKS.map((b) => ({ ...b, covered: covered.includes(b.key) })),
    quota: result.quota,
    games: result.games,
  };
}
