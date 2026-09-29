import { loadOdds, pickProvider } from "../lib/providers.mjs";

// Per-instance cache so bursts of visitors don't each spend API credits.
let cached = null;

export default async () => {
  const env = process.env;
  const ttl = Math.max(5, Number(env.ODDS_CACHE_SECONDS) || 20) * 1000;
  const provider = pickProvider(env);

  try {
    if (!cached || cached.provider !== provider || Date.now() - cached.at > ttl) {
      cached = { provider, at: Date.now(), data: await loadOdds(env) };
    }
    const ttlSec = Math.round(ttl / 1000);
    return Response.json(cached.data, {
      headers: {
        "Cache-Control": "no-store",
        // Shared cache on Netlify's CDN: every visitor gets the same snapshot for
        // a few seconds, which keeps usage of the paid odds API predictable.
        "Netlify-CDN-Cache-Control": `public, s-maxage=${ttlSec}, stale-while-revalidate=${ttlSec}`,
      },
    });
  } catch (err) {
    console.error(err);
    // Serve the last good snapshot (flagged stale) rather than a blank page.
    if (cached && cached.provider === provider) {
      return Response.json({ ...cached.data, stale: true, error: err.message }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(
      { error: err.message, provider },
      { status: err.status === 401 || err.status === 403 ? 502 : 503, headers: { "Cache-Control": "no-store" } }
    );
  }
};

export const config = { path: "/api/odds" };
