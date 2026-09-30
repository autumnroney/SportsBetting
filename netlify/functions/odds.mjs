import { loadOdds, pickProvider } from "../lib/providers.mjs";

// How long one odds snapshot is reused. Every visitor shares the same snapshot,
// so API usage depends on these numbers, not on how many people are watching.
export function cacheSettings(env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    live: Math.max(15, num(env.ODDS_CACHE_SECONDS, 60)), // while a game is in progress
    idle: Math.max(60, num(env.ODDS_IDLE_CACHE_SECONDS, 3600)), // when nothing is live
  };
}

// Seconds until the next API call is allowed, given the latest snapshot.
export function snapshotTtl(data, settings, now = Date.now()) {
  if (data.demo) return 15;
  let ttl = settings.live;
  if (!data.anyLive) {
    // Pre-game lines move slowly; wake up again in time for the next kickoff.
    const untilKick = data.nextKickoff ? (Date.parse(data.nextKickoff) - now) / 1000 : Infinity;
    ttl = Math.max(settings.live, Math.min(settings.idle, untilKick));
  }
  const q = data.quota;
  if (q && Number.isFinite(q.remaining)) {
    const total = Number.isFinite(q.used) ? q.remaining + q.used : null;
    // Stretch out refreshes when the monthly credits are nearly gone.
    if (q.remaining < 10) ttl = Math.max(ttl, 1800);
    else if (total && q.remaining / total < 0.1) ttl = Math.max(ttl, 300);
  }
  return Math.round(ttl);
}

function cdnHeaders(seconds) {
  return {
    "Cache-Control": "no-store",
    // Netlify's CDN serves this response to every visitor for `seconds`;
    // `durable` shares it across edge nodes so each region doesn't call the API.
    "Netlify-CDN-Cache-Control": `public, durable, s-maxage=${seconds}, stale-while-revalidate=${Math.min(seconds, 60)}`,
  };
}

// Per-instance memory: last good snapshot plus error backoff.
let cached = null;
let failure = null;

export default async () => {
  const env = process.env;
  const provider = pickProvider(env);
  const settings = cacheSettings(env);
  const now = Date.now();

  if (cached && cached.provider === provider && now - cached.at < cached.ttl * 1000) {
    return Response.json(cached.data, { headers: cdnHeaders(Math.ceil(cached.ttl - (now - cached.at) / 1000)) });
  }

  // After a failure, wait before calling the API again so errors (bad key,
  // quota used up, rate limit) don't turn every page load into another call.
  const backingOff = failure && failure.provider === provider && now < failure.until;
  try {
    if (backingOff) throw failure.err;
    const data = await loadOdds(env);
    const ttl = snapshotTtl(data, settings, now);
    cached = { provider, at: now, ttl, data: { ...data, refreshSeconds: ttl } };
    failure = null;
    return Response.json(cached.data, { headers: cdnHeaders(ttl) });
  } catch (err) {
    if (!backingOff) {
      console.error(err.message);
      const wait = err.status === 401 || err.status === 403 ? 300 : err.status === 429 ? 120 : 30;
      failure = { provider, err, until: now + wait * 1000 };
    }
    const retryIn = Math.max(5, Math.ceil((failure.until - now) / 1000));
    const hint =
      err.status === 401 || err.status === 403
        ? " (the key was rejected or this month's credits are used up; check the key in Netlify and your plan's usage)"
        : err.status === 429
          ? " (rate limited; raise ODDS_CACHE_SECONDS in Netlify)"
          : "";
    // Serve the last good snapshot (flagged stale) rather than a blank page.
    if (cached && cached.provider === provider) {
      return Response.json({ ...cached.data, stale: true, error: err.message + hint }, { headers: cdnHeaders(retryIn) });
    }
    return Response.json(
      { error: err.message + hint, provider },
      { status: err.status === 401 || err.status === 403 ? 502 : 503, headers: cdnHeaders(retryIn) }
    );
  }
};

export const config = { path: "/api/odds" };
