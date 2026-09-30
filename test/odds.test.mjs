import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSportsGameOdds,
  normalizeOddsApi,
  demoGames,
  parseAmerican,
  pickProvider,
  resolveProvider,
} from "../netlify/lib/providers.mjs";
import { bestQuote, fairProbabilities, profit, expectedValue } from "../public/odds-math.js";

test("parseAmerican handles strings, signs and junk", () => {
  assert.equal(parseAmerican("+150"), 150);
  assert.equal(parseAmerican("-110"), -110);
  assert.equal(parseAmerican("EVEN"), 100);
  assert.equal(parseAmerican("50"), null);
  assert.equal(parseAmerican(""), null);
});

test("moneyline best price picks the highest payout", () => {
  const side = { fanduel: { price: 140 }, draftkings: { price: 155 }, caesars: { price: -105 } };
  assert.equal(bestQuote(side, "moneyline", "away").book, "draftkings");
  const fav = { fanduel: { price: -150 }, draftkings: { price: -135 }, bet365: { price: -160 } };
  assert.equal(bestQuote(fav, "moneyline", "home").book, "draftkings");
});

test("best price respects the user's enabled books", () => {
  const side = { fanduel: { price: 140 }, draftkings: { price: 155 } };
  assert.equal(bestQuote(side, "moneyline", "away", new Set(["fanduel"])).book, "fanduel");
});

test("spread best line prefers more points, then price", () => {
  const side = {
    fanduel: { point: 6.5, price: -105 },
    draftkings: { point: 7, price: -120 },
    caesars: { point: 7, price: -110 },
  };
  assert.equal(bestQuote(side, "spread", "home").book, "caesars");
  const fav = { fanduel: { point: -3, price: -110 }, draftkings: { point: -3.5, price: +100 } };
  assert.equal(bestQuote(fav, "spread", "home").book, "fanduel");
});

test("total best line: lowest over, highest under", () => {
  const over = { fanduel: { point: 48.5, price: -110 }, draftkings: { point: 47.5, price: -115 } };
  const under = { fanduel: { point: 48.5, price: -110 }, draftkings: { point: 47.5, price: -105 } };
  assert.equal(bestQuote(over, "total", "over").book, "draftkings");
  assert.equal(bestQuote(under, "total", "under").book, "fanduel");
});

test("ties list every book with the best price", () => {
  const side = { fanduel: { price: -110 }, draftkings: { price: -110 } };
  assert.deepEqual(bestQuote(side, "moneyline", "home").tiedBooks, ["fanduel", "draftkings"]);
});

test("payout and value math", () => {
  assert.equal(profit(100, 150), 150);
  assert.ok(Math.abs(profit(110, -110) - 100) < 1e-9);
  const fair = fairProbabilities({ a: { price: -110 } }, { a: { price: -110 } });
  assert.ok(Math.abs(fair.a - 0.5) < 1e-9);
  assert.ok(expectedValue(110, 0.5) > 0);
  assert.ok(expectedValue(-110, 0.5) < 0);
});

test("SportsGameOdds events normalize to the four books", () => {
  const ev = {
    eventID: "E1",
    status: { started: true, live: true, displayShort: "Q3 4:12", startsAt: "2026-09-26T19:30:00Z" },
    teams: {
      home: { names: { long: "Florida Atlantic Owls" }, score: 21 },
      away: { names: { long: "Rice Owls" }, score: 17 },
    },
    odds: {
      "points-home-game-ml-home": {
        byBookmaker: {
          fanduel: { odds: "-180", available: true, lastUpdatedAt: "2026-09-26T21:00:00Z" },
          bet365: { odds: "-170", available: true },
          betmgm: { odds: "-150", available: true },
        },
      },
      "points-away-game-ml-away": {
        byBookmaker: { fanduel: { odds: "+150" }, caesars: { odds: "+160", available: false } },
      },
      "points-home-game-sp-home": { byBookmaker: { draftkings: { odds: "-110", spread: "-3.5" } } },
      "points-all-game-ou-over": { byBookmaker: { caesars: { odds: "-115", overUnder: "52.5" } } },
    },
  };
  const [g] = normalizeSportsGameOdds([ev]);
  assert.equal(g.home, "Florida Atlantic Owls");
  assert.equal(g.status.live, true);
  assert.deepEqual(g.score, { home: 21, away: 17 });
  assert.deepEqual(Object.keys(g.markets.moneyline.home).sort(), ["bet365", "fanduel"]);
  assert.equal(g.markets.moneyline.away.caesars, undefined, "unavailable quotes are dropped");
  assert.equal(g.markets.spread.home.draftkings.point, -3.5);
  assert.equal(g.markets.total.over.caesars.point, 52.5);
});

test("SportsGameOdds drops finished games", () => {
  const games = normalizeSportsGameOdds([{ eventID: "x", status: { completed: true }, teams: {}, odds: {} }]);
  assert.equal(games.length, 0);
});

test("The Odds API events normalize and map williamhill_us to Caesars", () => {
  const now = Date.parse("2026-09-26T20:00:00Z");
  const events = [
    {
      id: "g1",
      commence_time: "2026-09-26T19:00:00Z",
      home_team: "Miami Hurricanes",
      away_team: "Florida State Seminoles",
      bookmakers: [
        {
          key: "williamhill_us",
          markets: [
            { key: "h2h", last_update: "2026-09-26T19:59:30Z", outcomes: [{ name: "Miami Hurricanes", price: -200 }, { name: "Florida State Seminoles", price: 170 }] },
            { key: "totals", outcomes: [{ name: "Over", price: -110, point: 49.5 }, { name: "Under", price: -110, point: 49.5 }] },
          ],
        },
        { key: "betmgm", markets: [{ key: "h2h", outcomes: [{ name: "Miami Hurricanes", price: -190 }] }] },
      ],
    },
  ];
  const scores = [{ id: "g1", completed: false, scores: [{ name: "Miami Hurricanes", score: "14" }, { name: "Florida State Seminoles", score: "10" }] }];
  const [g] = normalizeOddsApi(events, scores, now);
  assert.equal(g.status.live, true);
  assert.deepEqual(g.score, { home: 14, away: 10 });
  assert.equal(g.markets.moneyline.home.caesars.price, -200);
  assert.equal(g.markets.moneyline.home.betmgm, undefined);
  assert.equal(g.markets.total.under.caesars.point, 49.5);
});

test("demo games are well formed and prices are valid American odds", () => {
  const games = demoGames(Date.parse("2026-09-26T20:00:00Z"));
  assert.ok(games.length > 0);
  for (const g of games) {
    for (const sides of Object.values(g.markets)) {
      for (const quotes of Object.values(sides)) {
        for (const q of Object.values(quotes)) {
          assert.ok(q.price >= 100 || q.price <= -100, `bad price ${q.price}`);
        }
      }
    }
  }
});

test("provider selection prefers SportsGameOdds (has bet365), falls back to demo", () => {
  assert.equal(pickProvider({}), "demo");
  assert.equal(pickProvider({ THE_ODDS_API_KEY: "a" }), "theoddsapi");
  assert.equal(pickProvider({ THE_ODDS_API_KEY: "a", SPORTSGAMEODDS_API_KEY: "b" }), "sportsgameodds");
  assert.equal(pickProvider({ ODDS_PROVIDER: "theoddsapi", THE_ODDS_API_KEY: "a", SPORTSGAMEODDS_API_KEY: "b" }), "theoddsapi");
});

test("a generic ODDS_API_KEY is routed to the right feed by its format", () => {
  const oddsApiKey = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(resolveProvider({ ODDS_API_KEY: oddsApiKey }), { provider: "theoddsapi", key: oddsApiKey });
  assert.equal(resolveProvider({ ODDS_API_KEY: "sgo_live_abc123" }).provider, "sportsgameodds");
  assert.equal(resolveProvider({ ODDS_API_KEY: ` ${oddsApiKey}\n` }).key, oddsApiKey, "whitespace from pasting is trimmed");
});
