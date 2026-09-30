import { test } from "node:test";
import assert from "node:assert/strict";
import handler, { cacheSettings, snapshotTtl } from "../netlify/functions/odds.mjs";
import { safeLink } from "../netlify/lib/providers.mjs";

const KEY = "0123456789abcdef0123456789abcdef";
const HOUR = 3600 * 1000;

function fakeOddsApi({ status = 200, events = [], remaining = 400, used = 100 }) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const headers = new Headers({ "x-requests-remaining": String(remaining), "x-requests-used": String(used) });
    if (status !== 200) return new Response(JSON.stringify({ message: "Usage quota has been reached" }), { status, headers });
    const body = String(url).includes("/scores") ? [] : events;
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
  return calls;
}

const upcomingEvent = (inMs) => ({
  id: "g1",
  commence_time: new Date(Date.now() + inMs).toISOString(),
  home_team: "Miami Hurricanes",
  away_team: "Florida State Seminoles",
  bookmakers: [{ key: "fanduel", markets: [{ key: "h2h", outcomes: [{ name: "Miami Hurricanes", price: -150 }, { name: "Florida State Seminoles", price: 130 }] }] }],
});

test("cache lengths: 60s live, 1h idle by default, with sane minimums", () => {
  assert.deepEqual(cacheSettings({}), { live: 60, idle: 3600 });
  assert.deepEqual(cacheSettings({ ODDS_CACHE_SECONDS: "2", ODDS_IDLE_CACHE_SECONDS: "junk" }), { live: 15, idle: 3600 });
});

test("idle snapshots wait until the next kickoff, live ones use the live TTL", () => {
  const s = { live: 60, idle: 3600 };
  const now = Date.now();
  assert.equal(snapshotTtl({ anyLive: true }, s, now), 60);
  assert.equal(snapshotTtl({ anyLive: false, nextKickoff: new Date(now + 10 * 60000).toISOString() }, s, now), 600);
  assert.equal(snapshotTtl({ anyLive: false, nextKickoff: new Date(now + 5 * HOUR).toISOString() }, s, now), 3600);
  assert.equal(snapshotTtl({ anyLive: false, nextKickoff: null }, s, now), 3600);
});

test("refreshes slow down when monthly credits run low", () => {
  const s = { live: 60, idle: 3600 };
  assert.equal(snapshotTtl({ anyLive: true, quota: { remaining: 40, used: 460 } }, s), 300);
  assert.equal(snapshotTtl({ anyLive: true, quota: { remaining: 5, used: 495 } }, s), 1800);
});

test("templated or non-https links are dropped", () => {
  assert.equal(safeLink("https://sportsbook.fanduel.com/x"), "https://sportsbook.fanduel.com/x");
  assert.equal(safeLink("https://{state}.sportsbook.fanduel.com/x"), null);
  assert.equal(safeLink("javascript:alert(1)"), null);
});

test("function: real key disables demo, skips scores pre-game, caches, never leaks the key", async () => {
  process.env.ODDS_API_KEY = KEY;
  const calls = fakeOddsApi({ events: [upcomingEvent(2 * HOUR)] });
  const res = await handler();
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.demo, false);
  assert.equal(body.provider, "theoddsapi");
  assert.ok(!text.includes(KEY), "key must not appear in the response");
  assert.equal(calls.length, 1, "no scores call before kickoff (saves a credit)");
  assert.match(res.headers.get("netlify-cdn-cache-control"), /durable/);
  assert.equal(body.books.find((b) => b.key === "bet365").covered, false);
  assert.equal(body.books.find((b) => b.key === "caesars").covered, false, "Caesars absent from free-plan data");

  await handler();
  assert.equal(calls.length, 1, "second visitor is served from cache");
});

test("function: quota exhaustion serves stale odds and backs off", async () => {
  process.env.ODDS_API_KEY = KEY;
  process.env.ODDS_CACHE_SECONDS = "15";
  process.env.ODDS_IDLE_CACHE_SECONDS = "60";
  // Force the cache to expire by pretending time moved on.
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * HOUR;
  try {
    const calls = fakeOddsApi({ status: 401 });
    const res = await handler();
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.stale, true);
    assert.match(body.error, /credits are used up/);
    assert.equal(body.games.length, 1, "last good odds still shown");
    await handler();
    assert.equal(calls.length, 1, "no retry during backoff");
  } finally {
    Date.now = realNow;
    delete process.env.ODDS_CACHE_SECONDS;
    delete process.env.ODDS_IDLE_CACHE_SECONDS;
  }
});
