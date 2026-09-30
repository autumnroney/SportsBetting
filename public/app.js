import {
  bestQuote,
  compareQuotes,
  expectedValue,
  fairProbabilities,
  formatAmerican,
  formatPoint,
  impliedProbability,
  profit,
} from "./odds-math.js";

const SIDES = {
  moneyline: ["away", "home"],
  spread: ["away", "home"],
  total: ["over", "under"],
};
const STALE_MS = 3 * 60 * 1000; // live quote not refreshed by the book in 3 min
const MOVE_HIGHLIGHT_MS = 60 * 1000;

const state = {
  data: null,
  view: "live",
  market: "moneyline",
  search: "",
  stake: 100,
  intervalSec: 30,
  enabledBooks: new Set(),
  lastFetch: 0,
  fetching: false,
  error: null,
  // key -> { price, point, dir, changedAt }
  history: new Map(),
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- persistence (per-viewer conveniences only) ----------
function load(key, fallback) {
  try {
    const v = localStorage.getItem(`cfbodds.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(`cfbodds.${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

// ---------- data ----------
async function fetchOdds() {
  if (state.fetching) return;
  state.fetching = true;
  renderStatus();
  try {
    const res = await fetch("/api/odds", { cache: "no-store" });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !Array.isArray(body.games)) {
      throw new Error(body?.error || `Odds service returned ${res.status}`);
    }
    trackMovement(body.games);
    state.data = body;
    state.error = body.stale ? body.error || "Showing last saved odds" : null;
    if (!state.enabledBooks.size) {
      const saved = load("books", null);
      state.enabledBooks = new Set(saved || body.books.filter((b) => b.covered).map((b) => b.key));
    }
    renderBookToggles();
  } catch (err) {
    state.error = err.message || "Could not load odds";
  } finally {
    state.fetching = false;
    state.lastFetch = Date.now();
    render();
  }
}

function trackMovement(games) {
  const now = Date.now();
  for (const g of games) {
    for (const [market, sides] of Object.entries(g.markets)) {
      for (const [side, quotes] of Object.entries(sides)) {
        for (const [book, q] of Object.entries(quotes)) {
          const key = `${g.id}|${market}|${side}|${book}`;
          const prev = state.history.get(key);
          if (!prev) {
            state.history.set(key, { price: q.price, point: q.point, dir: 0, changedAt: 0 });
            continue;
          }
          if (prev.price !== q.price || prev.point !== q.point) {
            const better = compareQuotes(q, prev, market, side);
            state.history.set(key, { price: q.price, point: q.point, dir: better > 0 ? 1 : -1, changedAt: now });
          }
        }
      }
    }
  }
}

// ---------- rendering ----------
function bookMeta(key) {
  return state.data?.books.find((b) => b.key === key) || { key, name: key, url: "#" };
}

function sideLabel(game, market, side) {
  if (market === "total") return side === "over" ? "Over" : "Under";
  return side === "home" ? game.home : game.away;
}

function timeAgo(iso) {
  if (!iso) return "unknown";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function kickoff(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function money(n) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n < 100 ? 2 : 0 });
}

function filteredGames() {
  if (!state.data) return [];
  const q = state.search.trim().toLowerCase();
  return state.data.games.filter((g) => {
    if (state.view === "live" && !g.status.live) return false;
    if (state.view === "upcoming" && g.status.live) return false;
    if (q && !`${g.home} ${g.away}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function quoteText(q, market) {
  const pt = formatPoint(q.point, market);
  const px = `<span class="px">${esc(formatAmerican(q.price))}</span>`;
  return pt ? `<span class="pt">${esc(pt)}</span> ${px}` : px;
}

function renderGame(g) {
  const market = state.market;
  const sides = SIDES[market];
  const books = state.data.books;
  const enabled = state.enabledBooks;
  const m = g.markets[market];
  const bests = Object.fromEntries(sides.map((s) => [s, bestQuote(m[s], market, s, enabled)]));
  const fair = market === "moneyline" ? fairProbabilities(m[sides[0]], m[sides[1]], enabled) : null;

  const header = `
    <div class="game-head">
      <div class="teams">
        <div class="team"><span class="name">${esc(g.away)}</span>${g.score ? `<span class="score">${esc(g.score.away)}</span>` : ""}</div>
        <div class="team"><span class="name"><span class="at">@</span> ${esc(g.home)}</span>${g.score ? `<span class="score">${esc(g.score.home)}</span>` : ""}</div>
      </div>
      <div class="game-meta">
        ${g.status.live ? `<span class="live-badge"><span class="pulse"></span>LIVE</span><span class="clock">${esc(g.status.display && g.status.display !== "Live" ? g.status.display : "")}</span>` : `<span class="kick">${esc(kickoff(g.commence))}</span>`}
      </div>
    </div>`;

  const picks = sides
    .map((s) => {
      const b = bests[s];
      if (!b) return `<div class="pick none">${esc(sideLabel(g, market, s))}: no odds from your books</div>`;
      const names = b.tiedBooks.map((k) => bookMeta(k).name).join(" / ");
      const win = profit(state.stake, b.quote.price);
      let value = "";
      if (fair) {
        const p = s === sides[0] ? fair.a : fair.b;
        const ev = expectedValue(b.quote.price, p) * 100;
        value = `<span class="value ${ev >= 0 ? "pos" : "neg"}" title="Compared with the market's fair (no-vig) win chance of ${(p * 100).toFixed(1)}%">${ev >= 0 ? "+" : ""}${ev.toFixed(1)}% value</span>`;
      }
      const link = b.quote.link || bookMeta(b.book).url;
      return `
        <a class="pick" href="${esc(link)}" target="_blank" rel="noopener noreferrer">
          <span class="pick-side">${esc(sideLabel(g, market, s))} ${quoteText(b.quote, market)}</span>
          <span class="pick-book">Best at <strong>${esc(names)}</strong></span>
          <span class="pick-win">${money(state.stake)} wins ${money(win)}</span>
          ${value}
        </a>`;
    })
    .join("");

  const headRow = `<tr><th scope="col"></th>${books
    .map((b) => `<th scope="col" class="${enabled.has(b.key) ? "" : "off"}">${esc(b.name)}</th>`)
    .join("")}</tr>`;

  const rows = sides
    .map((s) => {
      const best = bests[s];
      const cells = books
        .map((b) => {
          const q = m[s]?.[b.key];
          if (!b.covered) return `<td class="na" title="${esc(b.name)} isn't available from the current odds feed">n/a</td>`;
          if (!q) return `<td class="na" title="${esc(b.name)} isn't offering this bet right now (it may be suspended during a play)">—</td>`;
          const isBest = best && enabled.has(b.key) && best.tiedBooks.includes(b.key);
          const h = state.history.get(`${g.id}|${market}|${s}|${b.key}`);
          const moved = h && h.changedAt && Date.now() - h.changedAt < MOVE_HIGHLIGHT_MS ? h.dir : 0;
          const stale = g.status.live && q.updated && Date.now() - Date.parse(q.updated) > STALE_MS;
          const cls = [isBest ? "best" : "", !enabled.has(b.key) ? "off" : "", stale ? "stale" : "", moved > 0 ? "up" : moved < 0 ? "down" : ""]
            .filter(Boolean)
            .join(" ");
          const prob = (impliedProbability(q.price) * 100).toFixed(1);
          const title = `${b.name}: ${sideLabel(g, market, s)} ${formatPoint(q.point, market)} ${formatAmerican(q.price)} · implied ${prob}% · ${money(state.stake)} wins ${money(profit(state.stake, q.price))} · updated ${timeAgo(q.updated)}`;
          const link = q.link || b.url;
          return `<td class="${cls}"><a href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${quoteText(q, market)}${moved > 0 ? '<span class="arrow" aria-label="improved">▲</span>' : moved < 0 ? '<span class="arrow" aria-label="worsened">▼</span>' : ""}</a></td>`;
        })
        .join("");
      return `<tr><th scope="row">${esc(sideLabel(g, market, s))}</th>${cells}</tr>`;
    })
    .join("");

  return `
    <article class="game ${g.status.live ? "is-live" : ""}">
      ${header}
      <div class="picks">${picks}</div>
      <div class="table-scroll"><table class="odds"><thead>${headRow}</thead><tbody>${rows}</tbody></table></div>
    </article>`;
}

function renderBanners() {
  const d = state.data;
  const out = [];
  if (d?.demo) {
    out.push(`<div class="banner warn"><strong>Demo mode: these odds are simulated, not real.</strong> Add your key as the ODDS_API_KEY environment variable in Netlify and redeploy to show real live odds (see README).</div>`);
  }
  if (d && !d.demo) {
    const missing = d.books.filter((b) => !b.covered).map((b) => b.name);
    if (missing.length) {
      const why = [];
      if (missing.includes("Caesars")) why.push("Caesars needs a paid The Odds API plan");
      if (missing.includes("bet365")) why.push("bet365 needs a SportsGameOdds key");
      out.push(`<div class="banner info">Not included with the current odds plan: ${esc(missing.join(" and "))}. ${esc(why.join("; "))} (see README).</div>`);
    }
  }
  if (d?.quota && Number.isFinite(d.quota.remaining) && d.quota.remaining < 100) {
    out.push(`<div class="banner warn">Only ${esc(d.quota.remaining)} odds API credits left this month. Odds will stop updating when they run out. Upgrade the plan or raise ODDS_CACHE_SECONDS in Netlify.</div>`);
  }
  if (state.error) out.push(`<div class="banner error">⚠ ${esc(state.error)}. Retrying automatically…</div>`);
  $("banners").innerHTML = out.join("");
}

function renderStatus() {
  const dot = $("statusDot");
  const text = $("statusText");
  if (state.fetching && !state.data) {
    text.textContent = "Loading odds…";
    dot.className = "dot";
    return;
  }
  if (!state.data) {
    text.textContent = "Couldn't load odds";
    dot.className = "dot bad";
    return;
  }
  const age = Math.round((Date.now() - Date.parse(state.data.fetchedAt)) / 1000);
  const next = Math.max(0, Math.ceil((state.lastFetch + state.intervalSec * 1000 - Date.now()) / 1000));
  text.textContent = state.fetching
    ? "Updating…"
    : `Odds from ${age < 5 ? "just now" : age < 120 ? `${age}s ago` : `${Math.round(age / 60)}m ago`} · checking again in ${document.hidden ? "—" : `${next}s`}`;
  const src = state.data.refreshSeconds;
  text.title = src ? `The odds source is refreshed every ${src >= 120 ? `${Math.round(src / 60)} min` : `${src}s`} (more often while games are live)` : "";
  dot.className = `dot ${state.error ? "bad" : state.data.demo ? "warn" : "ok"}`;
}

function renderBookToggles() {
  if (!state.data) return;
  $("bookToggles").innerHTML = state.data.books
    .map(
      (b) => `
      <label class="book-toggle ${b.covered ? "" : "disabled"}" title="${b.covered ? "" : "Not in the current odds feed"}">
        <input type="checkbox" value="${esc(b.key)}" ${state.enabledBooks.has(b.key) ? "checked" : ""} ${b.covered ? "" : "disabled"}>
        <span>${esc(b.name)}</span>
      </label>`
    )
    .join("");
}

function render() {
  renderBanners();
  renderStatus();
  if (!state.data) {
    $("games").innerHTML = "";
    return;
  }
  const all = state.data.games;
  $("countLive").textContent = all.filter((g) => g.status.live).length;
  $("countUpcoming").textContent = all.filter((g) => !g.status.live).length;

  const games = filteredGames();
  $("games").innerHTML = games.map(renderGame).join("");
  const empty = $("empty");
  if (games.length) {
    empty.hidden = true;
  } else {
    empty.hidden = false;
    empty.textContent = state.search
      ? `No games match “${state.search}”.`
      : state.view === "live"
        ? "No college football games are live right now. Check the Upcoming tab. Live odds show up here as soon as games kick off."
        : "No games with odds right now.";
  }
}

// ---------- controls ----------
function bindSegmented(attr, key, persistKey) {
  document.querySelectorAll(`[data-${attr}]`).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset[attr] === state[key]);
    btn.setAttribute("aria-selected", btn.dataset[attr] === state[key]);
    btn.addEventListener("click", () => {
      state[key] = btn.dataset[attr];
      save(persistKey, state[key]);
      document.querySelectorAll(`[data-${attr}]`).forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", b === btn);
      });
      render();
    });
  });
}

function init() {
  state.market = load("market", "moneyline");
  state.stake = Number(load("stake", 100)) || 100;
  state.intervalSec = [15, 30, 60].includes(Number(load("interval", 30))) ? Number(load("interval", 30)) : 30;
  $("stake").value = state.stake;
  $("interval").value = String(state.intervalSec);

  bindSegmented("view", "view", "view");
  bindSegmented("market", "market", "market");

  $("search").addEventListener("input", (e) => {
    state.search = e.target.value;
    render();
  });
  $("stake").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    if (v > 0) {
      state.stake = v;
      save("stake", v);
      render();
    }
  });
  $("interval").addEventListener("change", (e) => {
    state.intervalSec = Number(e.target.value);
    save("interval", state.intervalSec);
    renderStatus();
  });
  $("bookToggles").addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    if (e.target.checked) state.enabledBooks.add(e.target.value);
    else state.enabledBooks.delete(e.target.value);
    save("books", [...state.enabledBooks]);
    render();
  });
  $("refreshBtn").addEventListener("click", fetchOdds);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - state.lastFetch > state.intervalSec * 1000) fetchOdds();
    renderStatus();
  });

  // One ticker drives the countdown and polling; pauses while the tab is hidden.
  setInterval(() => {
    renderStatus();
    if (!document.hidden && !state.fetching && Date.now() - state.lastFetch >= state.intervalSec * 1000) fetchOdds();
  }, 1000);

  fetchOdds().then(() => {
    // If nothing is live yet, land on Upcoming so the page isn't empty.
    if (state.view === "live" && state.data && !state.data.games.some((g) => g.status.live) && state.data.games.length) {
      document.querySelector('[data-view="upcoming"]').click();
    }
  });
}

init();
