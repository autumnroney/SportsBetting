// Pure odds helpers shared by the UI and the tests.

export function americanToDecimal(american) {
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

// Implied win probability from a price (includes the book's vig).
export function impliedProbability(american) {
  return 1 / americanToDecimal(american);
}

// Profit (not including stake) on a winning bet.
export function profit(stake, american) {
  return stake * (americanToDecimal(american) - 1);
}

export function formatAmerican(american) {
  return american > 0 ? `+${american}` : String(american);
}

export function formatPoint(point, market) {
  if (point === null || point === undefined) return "";
  if (market === "total") return String(point);
  if (point === 0) return "PK";
  return point > 0 ? `+${point}` : String(point);
}

// Returns >0 if quote a is better for the bettor than quote b.
// Spreads: getting more points (or giving fewer) wins, then price.
// Totals: a lower Over line / higher Under line wins, then price.
// Moneyline: higher payout wins.
export function compareQuotes(a, b, market, side) {
  if (market === "spread" && a.point !== b.point) return a.point - b.point;
  if (market === "total" && a.point !== b.point) return side === "over" ? b.point - a.point : a.point - b.point;
  return americanToDecimal(a.price) - americanToDecimal(b.price);
}

// Best quote among the enabled books. Returns { book, quote, tiedBooks } or null.
export function bestQuote(sideQuotes, market, side, enabledBooks) {
  let best = null;
  for (const [book, quote] of Object.entries(sideQuotes || {})) {
    if (enabledBooks && !enabledBooks.has(book)) continue;
    if (!best) {
      best = { book, quote, tiedBooks: [book] };
      continue;
    }
    const cmp = compareQuotes(quote, best.quote, market, side);
    if (cmp > 1e-9) best = { book, quote, tiedBooks: [book] };
    else if (Math.abs(cmp) <= 1e-9) best.tiedBooks.push(book);
  }
  return best;
}

// Market consensus win probability for each side of a two-way moneyline,
// with the vig removed, averaged over books that price both sides.
export function fairProbabilities(sideA, sideB, enabledBooks) {
  let sumA = 0;
  let n = 0;
  for (const book of Object.keys(sideA || {})) {
    if (enabledBooks && !enabledBooks.has(book)) continue;
    const b = sideB?.[book];
    if (!b) continue;
    const pa = impliedProbability(sideA[book].price);
    const pb = impliedProbability(b.price);
    sumA += pa / (pa + pb);
    n++;
  }
  if (!n) return null;
  return { a: sumA / n, b: 1 - sumA / n };
}

// Expected return per $1 when betting `american` on an outcome whose true
// probability is `prob`. Positive = the price beats the market's fair odds.
export function expectedValue(american, prob) {
  return prob * americanToDecimal(american) - 1;
}
