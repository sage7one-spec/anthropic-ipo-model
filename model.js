// model.js — pure functions only (no DOM, no fetch). Imported by index.html and tests.

export function parseThresholdToCap(question) {
  const m = String(question).match(/\$([0-9]*\.?[0-9]+)\s*([TB])/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n * (m[2].toUpperCase() === 'T' ? 1e12 : 1e9);
}

export function parsePolymarketCurve(eventJson) {
  const ev = Array.isArray(eventJson) ? eventJson[0] : eventJson;
  const rows = [];
  for (const mk of (ev?.markets || [])) {
    const cap = parseThresholdToCap(mk.question || '');
    if (cap == null) continue;
    let pr = mk.outcomePrices;
    if (typeof pr === 'string') { try { pr = JSON.parse(pr); } catch { continue; } }
    if (!pr || pr.length < 1) continue;
    const pAbove = parseFloat(pr[0]); // Yes price = P(cap > threshold)
    if (!isFinite(pAbove)) continue;
    rows.push({ capT: cap / 1e12, pAbove: pAbove * 100 });
  }
  rows.sort((a, b) => a.capT - b.capT);
  // Thin-market noise can violate monotonicity; project onto the nearest non-increasing
  // sequence with pool-adjacent-violators (isotonic regression) — averages the violating
  // run instead of one-sidedly truncating later values down.
  const fitted = pavaNonIncreasing(rows.map(r => r.pAbove));
  for (let i = 0; i < rows.length; i++) rows[i].pAbove = fitted[i];
  return rows; // [{capT in $T, pAbove in %}]
}

function pavaNonIncreasing(v) {
  const blocks = [];
  for (const x of v) {
    blocks.push({ sum: x, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sum / a.n >= b.sum / b.n - 1e-12) break;
      a.sum += b.sum; a.n += b.n; blocks.pop();
    }
  }
  const out = [];
  for (const b of blocks) for (let i = 0; i < b.n; i++) out.push(b.sum / b.n);
  return out;
}

export function curveArrays(curve) {
  return { thresh: curve.map(r => r.capT), above: curve.map(r => r.pAbove) };
}

// Seeded RNG (ported from v1) — keeps results reproducible.
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export function gaussFrom(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Polymarket "above $X" prices are timing-contaminated: they resolve "No" if no IPO
// happens by the deadline, so each pAbove is really P(IPO)·P(cap > X | IPO). Dividing by
// the low-threshold plateau (≈ the crowd's P(IPO)) recovers the conditional curve.
export function normalizeTimingCurve(rows, pIpo = null) {
  if (!rows || !rows.length) return [];
  const p = pIpo ?? Math.max(...rows.map(r => r.pAbove)) / 100;
  if (!(p > 0)) return rows.map(r => ({ ...r }));
  return rows.map(r => ({ ...r, pAbove: Math.min(100, r.pAbove / p) }));
}

// Inverse-CDF of closing market cap ($T) at survival level u ∈ [0,100).
// Tails extend the quoted buckets instead of using fixed magic offsets:
//   lower — continue the first bucket's inverse-CDF slope (uniform density), floored at thresh[0]/2;
//   upper — exponential survival fitted to the last two buckets, clamped at 2·thresh[last].
export function sampleCapU(thresh, above, u) {
  const last = above.length - 1;
  if (u >= above[0]) {
    if (last < 1 || above[0] <= above[1]) return thresh[0];
    const slope = (thresh[1] - thresh[0]) / (above[0] - above[1]);
    return Math.max(thresh[0] * 0.5, thresh[0] - (u - above[0]) * slope);
  }
  if (u <= above[last]) {
    if (last < 1 || above[last] <= 0 || above[last - 1] <= above[last]) return thresh[last];
    const lambda = Math.log(above[last - 1] / above[last]) / (thresh[last] - thresh[last - 1]);
    return Math.min(thresh[last] * 2, thresh[last] + Math.log(above[last] / Math.max(u, 1e-12)) / lambda);
  }
  for (let i = 0; i < last; i++) {
    if (above[i] >= u && u >= above[i + 1]) {
      const f = (above[i] - u) / ((above[i] - above[i + 1]) || 1);
      return thresh[i] + f * (thresh[i + 1] - thresh[i]);
    }
  }
  return thresh[Math.floor(last / 2)];
}

// Inverse-CDF sample of closing market cap ($T) from the survival curve.
export function sampleCap(thresh, above, rng) {
  return sampleCapU(thresh, above, rng() * 100);
}

// Closed-form sample of a Brownian bridge's extreme over one interval pinned at
// log-levels a → b with interval variance s2, from a uniform u ∈ (0,1):
//   min = (a + b − √((a−b)² − 2·s2·ln u)) / 2     (reflection principle)
// u → 1 collapses onto the nearer endpoint; small u reaches further. Sampling min and
// max from independent uniforms slightly overstates the joint range — acceptable here.
export function sampleBridgeMin(a, b, s2, u) {
  return (a + b - Math.sqrt((a - b) * (a - b) - 2 * s2 * Math.log(u))) / 2;
}
export function sampleBridgeMax(a, b, s2, u) {
  return (a + b + Math.sqrt((a - b) * (a - b) - 2 * s2 * Math.log(u))) / 2;
}

// Polymarket-implied median closing cap ($T) via interpolation at the 50% crossing.
export function medianCapT(thresh, above) {
  const last = above.length - 1;
  for (let i = 0; i < last; i++) {
    if (above[i] >= 50 && 50 >= above[i + 1]) {
      const f = (above[i] - 50) / ((above[i] - above[i + 1]) || 1);
      return thresh[i] + f * (thresh[i + 1] - thresh[i]);
    }
  }
  return thresh[Math.floor(last / 2)];
}

export function parseHyperliquid(metaAndCtxs, coin = 'xyz:SPCX') {
  if (!Array.isArray(metaAndCtxs) || metaAndCtxs.length < 2) return null;
  const [meta, ctxs] = metaAndCtxs;
  const i = (meta?.universe || []).findIndex(a => a.name === coin);
  if (i < 0) return null;
  const c = ctxs[i] || {};
  return {
    mark: +c.markPx, oracle: +c.oraclePx,
    prevDay: +c.prevDayPx, funding: +c.funding
  };
}

export function disagreement(hlMark, polyMedianPerShare) {
  const avg = (hlMark + polyMedianPerShare) / 2;
  const absPct = avg > 0 ? Math.abs(hlMark - polyMedianPerShare) / avg : 0;
  const tier = absPct < 0.05 ? 'high' : absPct < 0.15 ? 'moderate' : 'low';
  return { absPct, tier, deltaUsd: hlMark - polyMedianPerShare };
}

export function blendCenter(hlMark, polyMedianPerShare, w) {
  return w * hlMark + (1 - w) * polyMedianPerShare;
}

// Hourly candles → realized vol. Maps daily sigma into v1's slider band: sigMid = 0.02 + 0.18*(slider/100).
// ipoDayMult scales the session vol up from the perp's calm regime toward Day-1 price
// discovery (the synthetic perp tracks a slow oracle; real first-day IPO vol runs far hotter).
export function realizedVolFromCandles(candles, ipoDayMult = 1) {
  const closes = (candles || []).map(k => +k.c).filter(x => isFinite(x) && x > 0);
  if (closes.length < 3) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rets.length - 1);
  const hourlySigma = Math.sqrt(varr);
  const sessionSigma = hourlySigma * Math.sqrt(6.5) * ipoDayMult; // 24/7 hourly vol → ~6.5h Day-1 session, × IPO-day multiplier
  const sliderVal = Math.max(0, Math.min(100, Math.round((sessionSigma - 0.02) / 0.18 * 100)));
  return { hourlySigma, sessionSigma, sliderVal };
}

// Day-1 open→close returns from public mega-IPO first-day histories (ported from v1 model).
const OPEN_TO_CLOSE = [0.073, 0.134, -0.056, -0.138, -0.009, 0.036, 0.042, -0.109, -0.084, -0.091, -0.103, -0.010, 0.041];

export function simulateDayOne(cfg) {
  const { thresh, above, shares, hlMark, w, offer, vol, N = 10000, steps = 8, rng } = cfg;
  const gauss = () => gaussFrom(rng);
  const polyMedCap = medianCapT(thresh, above);          // $T
  const polyMedPerShare = polyMedCap * 1e12 / shares;    // $/share
  const center = blendCenter(hlMark, polyMedPerShare, w);// $/share
  const factor = polyMedPerShare > 0 ? center / polyMedPerShare : 1; // multiplicative re-center (keeps shape)
  // s = σ/√n: the conditional-consistent bridge scale (midpoint SD = σ/2 given open & close).
  // The old 2σ/√n doubled the intraday wiggle the vol estimate justifies.
  const n = steps, sigMid = 0.02 + 0.18 * (vol / 100), s = sigMid / Math.sqrt(n), s2 = s * s;
  const closes = [], lows = [], highs = [], capU = [];
  const grid = Array.from({ length: n + 1 }, () => []);
  // per-interval bridge extremes — continuous-monitoring correction for touch/stop/fill events
  const gridMin = Array.from({ length: n }, () => []);
  const gridMax = Array.from({ length: n }, () => []);
  const lp = new Array(n + 1);
  for (let p = 0; p < N; p++) {
    const u = rng() * 100;                               // kept per path for rank-coupling Case C terminals
    const cap = sampleCapU(thresh, above, u);            // $T
    capU.push(u);
    const C = (cap * 1e12 / shares) * factor;            // $/share, blended close
    const oc = OPEN_TO_CLOSE[Math.floor(rng() * OPEN_TO_CLOSE.length)] + gauss() * 0.02;
    const O = C / (1 + oc);                              // opening print
    const lO = Math.log(O), lC = Math.log(C);
    let W = 0; const Wk = [0];
    for (let k = 1; k <= n; k++) { W += gauss() * s; Wk.push(W); }
    const Wn = Wk[n];
    for (let k = 0; k <= n; k++) {
      const bb = Wk[k] - (k / n) * Wn;
      lp[k] = lO + (lC - lO) * (k / n) + bb;
      grid[k].push(Math.exp(lp[k]));
    }
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < n; k++) {
      const mn = Math.exp(sampleBridgeMin(lp[k], lp[k + 1], s2, rng()));
      const mx = Math.exp(sampleBridgeMax(lp[k], lp[k + 1], s2, rng()));
      gridMin[k].push(mn); gridMax[k].push(mx);
      if (mn < lo) lo = mn;
      if (mx > hi) hi = mx;
    }
    closes.push(C); lows.push(lo); highs.push(hi);
  }
  return { closes, lows, highs, grid, gridMin, gridMax, capU, entry: offer, center, polyMedPerShare };
}

// ---- Execution layer (pure, tested) -------------------------------------

// Score one execution policy against a simulated open→close price grid.
//   paths : { grid: number[steps+1][N] }            (grid-length-agnostic; entry/shares come from policy)
//   policy: { shares, entry, coreAtOpenFrac?, tranches:[{frac,limitPx}], stopSchedule:[{from,stopPx}] }
// Tie-break: within a step, upside limits fill BEFORE the protective stop.
// The stop covers the whole remaining position. Residual sells at the close price.
export function evaluatePolicy(paths, policy) {
  const { grid, gridMin, gridMax } = paths;   // gridMin/gridMax: optional per-interval bridge extremes
  const steps = grid.length - 1;
  const N = grid[0].length;
  const { shares, entry, coreAtOpenFrac = 0, tranches, stopSchedule } = policy;
  const basis = shares * entry;
  const proceeds = new Array(N);
  const hasIv = !!(gridMin && gridMax);
  let subCount = 0, subSharesSum = 0, netLoss = 0, openSum = 0, upSum = 0, stopSum = 0, closeSum = 0;

  const activeStop = (frac) => {
    let s = null;
    for (const e of stopSchedule) if (e.from <= frac + 1e-9) s = e.stopPx;
    return s;
  };

  for (let p = 0; p < N; p++) {
    let left = shares, value = 0, subShares = 0;
    const open = grid[0][p];
    if (coreAtOpenFrac > 0) {                                  // 0) market-sell the core at the open
      const q = shares * coreAtOpenFrac;
      value += q * open; if (open < entry) subShares += q; openSum += q; left -= q;
    }
    const filled = new Array(tranches.length).fill(false);
    // touchHi/touchLo: highest/lowest price seen in this time element (node, or the
    // bridge extremes of the following interval) — same tie-break either way.
    const sweep = (touchHi, touchLo, frac) => {
      for (let t = 0; t < tranches.length; t++) {            // A) upside limits first
        if (filled[t] || touchHi < tranches[t].limitPx) continue;
        const qty = Math.min(left, shares * tranches[t].frac);
        value += qty * tranches[t].limitPx; left -= qty; upSum += qty; filled[t] = true;
      }
      const stop = activeStop(frac);                          // B) protective stop on remainder
      if (stop != null && left > 1e-9 && touchLo <= stop) {
        value += left * stop; if (stop < entry) subShares += left; stopSum += left; left = 0;
      }
    };
    for (let k = 0; k <= steps && left > 1e-9; k++) {
      const price = grid[k][p], frac = k / steps;
      sweep(price, price, frac);                              // the node itself
      if (hasIv && k < steps && left > 1e-9)                  // then the interval to the next node
        sweep(gridMax[k][p], gridMin[k][p], frac);
    }
    if (left > 1e-9) {                                        // C) forced close-out at close
      const close = grid[steps][p];
      value += left * close; if (close < entry) subShares += left; closeSum += left; left = 0;
    }
    proceeds[p] = value;
    if (subShares > 1e-9) { subCount++; subSharesSum += subShares; }
    if (value < basis - 1e-6) netLoss++;
  }

  const sorted = [...proceeds].sort((a, b) => a - b);
  const pct = (q) => { const i = (N - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
  const meanP = proceeds.reduce((a, b) => a + b, 0) / N;
  const varP = proceeds.reduce((a, b) => a + (b - meanP) * (b - meanP), 0) / Math.max(1, N - 1);
  const tot = N * shares;
  return {
    Eproceeds: meanP, medianProceeds: pct(0.5), p5: pct(0.05), p95: pct(0.95),
    seProceeds: Math.sqrt(varP / N),
    pNetLoss: netLoss / N, pSubBasisSale: subCount / N, eSharesSubBasis: subSharesSum / N,
    avgSalePx: meanP / shares,
    mix: { openPct: openSum / tot, upsidePct: upSum / tot, stopPct: stopSum / tot, closePct: closeSum / tot },
  };
}

// Baseline: sell the entire position at one grid column (e.g. open or close).
// Returns only { Eproceeds, avgSalePx } — a partial shape vs evaluatePolicy, sufficient
// for baseline comparison (do not spread it into an evaluatePolicy-shaped consumer).
export function sellAllAt(paths, stepIndex, shares) {
  const col = paths.grid[stepIndex];
  const m = col.reduce((a, b) => a + b, 0) / col.length;
  return { Eproceeds: m * shares, avgSalePx: m };
}

// ---- Scenario presets (time-phased, risk-modulated) ---------------------

const SCENARIO_DEFS = {
  protect:  { core: 0.40, rungs: [0.02, 0.05, 0.09], splits: [0.22, 0.18, 0.12],
              stops: [{ from: 0.10, pct: -0.08 }, { from: 0.55, pct: -0.04 }, { from: 0.85, pct: -0.02 }] },
  balanced: { core: 0.30, rungs: [0.03, 0.07, 0.12], splits: [0.25, 0.20, 0.15],
              stops: [{ from: 0.35, pct: -0.07 }, { from: 0.70, pct: -0.04 }, { from: 0.90, pct: -0.02 }] },
  ride:     { core: 0.15, rungs: [0.06, 0.15, 0.28], splits: [0.25, 0.25, 0.20],
              stops: [{ from: 0.20, pct: -0.12 }, { from: 0.80, pct: -0.04 }] },
};

// Upside rungs anchor ABOVE the reference opening price (refPx). The protective stop is
// refPx-anchored but clamped to [entry, refPx] — never below the entry basis, never above
// the reference (which would imply an above-market stop). riskLevel 0..100: higher → higher
// rungs + smaller core (ride the upside); lower → larger core sold at the open (protect).
export function buildScenario(name, riskLevel, ctx) {
  const def = SCENARIO_DEFS[name];
  if (!def) throw new Error(`unknown scenario: ${name}`);
  const { entry, shares, refPx } = ctx;
  const ref = refPx ?? entry;
  const f = 1 + (riskLevel - 50) / 100 * 0.5;
  const core = Math.max(0, Math.min(1, def.core * (2 - f)));
  const stopAt = (pct) => +Math.min(Math.max(ref * (1 + pct * f), entry), ref).toFixed(2);
  return {
    name, entry, shares, refPx: ref, coreAtOpenFrac: core,
    tranches: def.rungs.map((r, i) => ({ frac: def.splits[i], limitPx: +(ref * (1 + r * f)).toFixed(2) })),
    stopSchedule: def.stops.map(s => ({ from: s.from, stopPx: stopAt(s.pct) })),
  };
}
export const SCENARIO_NAMES = Object.keys(SCENARIO_DEFS);

// Render a policy as Fidelity-executable tickets. Each upside tranche is an OCO
// (sell-limit-up / sell-stop-down) on its shares; equal stop levels across tranches
// behave as one whole-position stop (matches evaluatePolicy). Residual = MOC/LOC.
export function ticketsFromPolicy(policy, opts = {}) {
  const { shares, coreAtOpenFrac = 0, tranches, stopSchedule } = policy;
  const openMin = opts.openMin ?? 600;   // 10:00 ET (IPOs often open late; adjust to the real open)
  const closeMin = opts.closeMin ?? 960; // 16:00 ET
  const clock = (frac) => {
    const m = Math.round(openMin + frac * (closeMin - openMin));
    const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
    const ap = h < 12 ? 'am' : 'pm', hh = ((h + 11) % 12) + 1;
    return `${hh}:${mm}${ap} ET`;
  };
  const tk = opts.ticker ?? 'ANT';
  const r = (n) => Math.round(n);
  const firstStop = stopSchedule[0] || null;
  const coreShares = r(shares * coreAtOpenFrac);
  const ladder = tranches.map((t, i) => ({
    tranche: i + 1, shares: r(shares * t.frac),
    limitPx: t.limitPx, stopPx: firstStop ? firstStop.stopPx : null,
    type: 'OCO', tif: 'Day',
  }));
  // reconcile the residual against the rounded rows so the ticket table totals exactly `shares`
  const residualShares = Math.max(0, Math.round(shares) - coreShares - ladder.reduce((a, L) => a + L.shares, 0));
  const checkpoints = stopSchedule.map((s, i) => ({
    atFrac: s.from, clock: clock(s.from), stopPx: s.stopPx,
    action: i === 0
      ? `Place a protective Sell Stop at $${s.stopPx} on the residual shares only — each ladder tranche already carries its own stop leg inside its OCO bracket, so stopping them again would oversell. Place it once ${tk} has a printed price (new IPOs reject stops until a quote exists).`
      : `Raise protection to $${s.stopPx}: cancel/replace the residual stop, and cancel/replace the stop leg of each unfilled OCO bracket.`,
  }));
  return {
    coreAtOpen: {
      shares: coreShares, type: 'MKT',
      note: `Sell at Market (or a marketable limit) on the opening print to lock the in-the-money gain. This is the core of the plan when ${tk} opens well above your $${policy.entry} basis.`,
    },
    ladder,
    residual: {
      shares: residualShares, type: 'MOC',
      note: `Sell-on-Close (MOC/LOC) for any unsold shares; enter before the ~3:45pm ET cutoff. If your account/security can't place on-close orders, sell at Market by ~3:50pm. The active stop also covers this residual until then.`,
    },
    checkpoints,
    flatBy: clock(1),
  };
}

// Fidelity ATP order set for Case B: a buy-limit at/below the limit, an OCO bracket
// attached on fill, and an MOC/LOC residual. Mirrors the bottom-feeder execution.
export function bottomFeedTicket(cfg) {
  const px = (n) => n.toFixed(2);
  const { limitPx = 135, capital = 100000, targetPct = 0.06, stopPct = 0.05, ticker = 'ANT' } = cfg;
  const shares = Math.round(capital / limitPx);
  const target = +(limitPx * (1 + targetPct)).toFixed(2);
  const stop = +(limitPx * (1 - stopPct)).toFixed(2);
  const lim = +limitPx.toFixed(2);
  // all three tickets reference the same lot; the OCO bracket and the MOC residual are mutually exclusive exit paths, not additive lots.
  return {
    entry: {
      type: 'BUY LIMIT', shares, limitPx: lim, tif: 'Day',
      note: `Buy ${shares} sh limit $${px(lim)} — deploys ~$${(shares * lim).toLocaleString()} only if ${ticker} trades down to your limit. If it never prints ≤ $${px(lim)}, nothing fills and you keep $${capital.toLocaleString()} in cash.`,
    },
    bracket: {
      type: 'OCO (attach on fill)', shares, sellLimitPx: target, sellStopPx: stop, tif: 'Day',
      note: `On fill, attach a one-cancels-other bracket: sell-limit $${target} (target +${(targetPct * 100).toFixed(0)}%) / sell-stop $${stop} (stop −${(stopPct * 100).toFixed(0)}%). In Active Trader Pro, stage this as a conditional/contingent order tied to the buy fill.`,
    },
    residual: {
      type: 'MOC', shares,
      note: `Any shares unsold by ~3:45pm ET → Sell-on-Close (MOC/LOC); if unavailable, sell at Market by ~3:50pm.`,
    },
  };
}

// ---- 20-day post-IPO engine (Phase 2) ----------------------------------------
// Illustrative normalized post-IPO median path for large tech/space listings:
// a mild first-week fade then a gradual drift back up. Day index 0..20, level[0]=1.
// Used only as an OPTIONAL drift shape (driftWeight default 0 = martingale).
export const MEGA_IPO_POSTIPO_CURVE = [
  1.000, 0.985, 0.972, 0.965, 0.962, 0.968, 0.975, 0.982, 0.988, 0.992, 0.996,
  1.000, 1.004, 1.008, 1.011, 1.014, 1.016, 1.018, 1.020, 1.021, 1.022,
];

// ---- Index-inclusion / lock-up event overlay (opt-in) ------------------------
// Per-day excess log-drift injected at full weight (eventWeight = 1). Entry i is the
// drift applied going INTO trading day (i+1), where Day 0 is the IPO/Day-1 close
// (Fri Jun 12 2026) and weekends + NYSE holidays (Juneteenth Jun 19, Independence Day
// observed Jul 3) are skipped, so the calendar lands these on real catalyst sessions:
//   Day 4  (Thu Jun 18) +1.2%  — FTSE Russell reconstitution wave begins
//   Day 5  (Mon Jun 22) +1.8%  — Vanguard CRSP / first passive-buy cluster (~$15B est.)
//   Day 15 (Tue Jul 7)  +2.5%  — Nasdaq-100 inclusion goes live (the big mechanical bid)
//   Day 16 (Wed Jul 8)  +0.8%  — index follow-through
// Note: Fidelity's flip window is 15 CALENDAR days (not trading sessions) — it ends over the
// Jun 27–28 weekend, so flip-eligible retail supply arrives from Day 10 (Mon Jun 29), well
// before the Jul 7 inclusion. That supply is not separately modeled; treat the Day 15
// impulse as gross of it.
// These are demand-side impulses from the Mertz/Grok supply/demand thesis, NOT a forecast:
// they are forced, calendar-dated flows you can dial up or down (or zero out) to stress-test
// how much the "float deficit" story could bend the path. Lock-up supply beyond the flip
// window (the classic 180-day cliff) falls outside this 20-day horizon.
export const SPCX_EVENT_DRIFT = [
  0, 0, 0, 0.012, 0.018, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0.025, 0.008, 0, 0, 0, 0,
];

// Probability a path reaches `level` by `throughDay` (running max of daily closes, d=0..throughDay)
// and the probability it is still at/above `level` AT that day's close. Daily-close granularity —
// it understates true intraday touches, so `everPct` is a floor on "hit the zone at some point."
export function peakReachProb(grid, level, throughDay) {
  const N = grid[0].length, last = Math.max(0, Math.min(throughDay, grid.length - 1));
  let ever = 0, at = 0;
  for (let p = 0; p < N; p++) {
    let mx = -Infinity;
    for (let d = 0; d <= last; d++) { const v = grid[d][p]; if (v > mx) mx = v; }
    if (mx >= level) ever++;
    if (grid[last][p] >= level) at++;
  }
  return { everPct: ever / N, atPct: at / N, throughDay: last };
}

// Walk each Day-1 close forward `days` trading days. Per-day log change blends:
//   diffusion:  -0.5σ² + σ·Z                              (martingale GBM)
//   drift:      driftWeight · log(curve[d]/curve[d-1])     (optional historical shape)
//   anchor:     anchorStrength · (d/days) · (logT − logS)  (Polymarket terminal soft-pull)
// where logT is a per-path log terminal sampled once from the Polymarket close-cap curve.
export function simulatePostIPO(cfg) {
  const {
    closes, dailySigma, rng, days = 20,
    driftCurve = MEGA_IPO_POSTIPO_CURVE, driftWeight = 0,
    polyTerminal = null, anchorStrength = 0.3,
    eventCurve = null, eventWeight = 0,
  } = cfg;
  const N = closes.length, g = () => gaussFrom(rng);
  const hist = (driftCurve && driftWeight > 0)
    ? Array.from({ length: days }, (_, i) => Math.log((driftCurve[i + 1] ?? 1) / (driftCurve[i] ?? 1)))
    : null;
  const grid = Array.from({ length: days + 1 }, () => new Array(N));
  for (let p = 0; p < N; p++) {
    let logS = Math.log(closes[p]);
    grid[0][p] = closes[p];
    let logT = null;
    if (polyTerminal && anchorStrength > 0) {
      // Rank coupling: when the caller passes the per-path uniforms that generated each
      // Day-1 close (polyTerminal.us), reuse them so a path that closed at its 95th
      // percentile anchors to the 95th-percentile terminal — an independent draw here
      // would manufacture cross-sectional mean reversion and shrink the 20-day fan.
      const u = polyTerminal.us ? polyTerminal.us[p] : rng() * 100;
      const cap = sampleCapU(polyTerminal.thresh, polyTerminal.above, u); // $T
      logT = Math.log(cap * 1e12 / polyTerminal.shares);
    }
    for (let d = 1; d <= days; d++) {
      let dLog = -0.5 * dailySigma * dailySigma + g() * dailySigma;
      if (hist) dLog += driftWeight * hist[d - 1];
      if (eventCurve && eventWeight) dLog += eventWeight * (eventCurve[d - 1] || 0);
      if (logT != null) dLog += anchorStrength * (d / days) * (logT - logS);
      logS += dLog;
      grid[d][p] = Math.exp(logS);
    }
  }
  return { grid, days };
}

// For each early step k, P(close > entry | price at step k < entry).
export function conditionalRecovery(grid, entry, ks = [1, 2, 3]) {
  const steps = grid.length - 1, N = grid[0].length, close = grid[steps];
  return ks.filter(k => k >= 0 && k <= steps).map(k => {
    let dips = 0, recover = 0;
    for (let p = 0; p < N; p++) if (grid[k][p] < entry) { dips++; if (close[p] > entry) recover++; }
    return { k, frac: k / steps, dips, p: dips ? recover / dips : null };
  });
}

// ---- Reporting helpers (Phase 3): everything is net absolute dollars on a fixed basis ----

export function netDollars(proceeds, capital = 100000) {
  return proceeds - capital;
}

// Signed absolute-dollar string. Rounds to whole dollars; exact zero prints unsigned "$0".
export function fmtNet(dollars) {
  const r = Math.round(dollars);
  if (r === 0) return '$0';
  return `${r > 0 ? '+' : '-'}$${Math.abs(r).toLocaleString('en-US')}`;
}

// Per-day percentile envelope + P(price < belowLevel) for the fan chart.
export function postIpoBands(grid, belowLevel = 135) {
  const days = grid.length - 1, N = grid[0].length;
  const pctAt = (col, q) => { const s = [...col].sort((a, b) => a - b); const i = (N - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
  const out = [];
  for (let d = 0; d <= days; d++) {
    const col = grid[d];
    let below = 0; for (let p = 0; p < N; p++) if (col[p] < belowLevel) below++;
    out.push({
      day: d,
      p5: pctAt(col, 0.05), p25: pctAt(col, 0.25), median: pctAt(col, 0.5),
      p75: pctAt(col, 0.75), p95: pctAt(col, 0.95), pBelow: below / N,
    });
  }
  return out;
}

// ---- Case B: open-market bottom-feeder (Phase 1) -----------------------------
// Buys the full capital at a limit (default $135) the first step price <= limitPx,
// then exits via an OCO bracket: sell-limit at +targetPct, sell-stop at -stopPct,
// target checked BEFORE stop within a step. Residual sells at the close. If no step
// ever reaches the limit, the path records exactly $0 net (capital preserved).
export function simulateBottomFeed(paths, cfg) {
  const { grid, gridMin, gridMax } = paths;   // gridMin/gridMax: optional per-interval bridge extremes
  const steps = grid.length - 1, N = grid[0].length;
  const { limitPx = 135, capital = 100000, targetPct = 0.06, stopPct = 0.05 } = cfg;
  const target = limitPx * (1 + targetPct);
  const stop = limitPx * (1 - stopPct);
  const shares = capital / limitPx;
  const nets = new Array(N);
  const hasIv = !!(gridMin && gridMax);
  let fills = 0, targetHits = 0, stopHits = 0, closeHits = 0, noFill = 0;

  // Unified time sequence: element e ∈ [0, 2·steps] — even e is node e/2, odd e is the
  // interval (e−1)/2 between nodes (checked only when bridge extremes are provided).
  // A fill inside an element defers exit checks to the NEXT element (ordering within
  // one element is ambiguous); within an exit element, target is checked before stop.
  for (let p = 0; p < N; p++) {
    let eFill = -1;
    for (let e = 0; e <= 2 * steps; e++) {
      if (e % 2 === 0) { if (grid[e / 2][p] <= limitPx) { eFill = e; break; } }
      else if (hasIv) { if (gridMin[(e - 1) / 2][p] <= limitPx) { eFill = e; break; } }
    }
    if (eFill < 0) { nets[p] = 0; noFill++; continue; }   // No-Execution safety state
    fills++;
    // A resting limit fills at the limit when price trades down through it — except at the
    // open, where the opening print is the first price: open < limit fills at the open.
    const fillPx = (eFill === 0) ? Math.min(limitPx, grid[0][p]) : limitPx;
    // If the fill lands at/below the bracket stop, the stop leg is instantly marketable —
    // it exits ≈ the fill price, never above it (no fake stop−fill gain on a gap-down open).
    const stopExit = Math.min(stop, fillPx);
    let exitPx = null;
    for (let e = eFill + 1; e <= 2 * steps && exitPx == null; e++) {
      if (e % 2 === 0) {
        const price = grid[e / 2][p];
        if (price >= target)      { exitPx = target;   targetHits++; }
        else if (price <= stop)   { exitPx = stopExit; stopHits++; }
      } else if (hasIv) {
        const k = (e - 1) / 2;
        if (gridMax[k][p] >= target)    { exitPx = target;   targetHits++; }
        else if (gridMin[k][p] <= stop) { exitPx = stopExit; stopHits++; }
      }
    }
    if (exitPx == null) { exitPx = grid[steps][p]; closeHits++; }      // residual to close
    nets[p] = shares * (exitPx - fillPx);
  }

  const sorted = [...nets].sort((a, b) => a - b);
  const pct = (q) => { const i = (N - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
  const mean = nets.reduce((a, b) => a + b, 0) / N;
  const varN = nets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, N - 1);
  return {
    pFill: fills / N, pNoFill: noFill / N,
    net: { mean, median: pct(0.5), p5: pct(0.05), p95: pct(0.95), se: Math.sqrt(varN / N) },
    mix: { targetPct: targetHits / N, stopPct: stopHits / N, closePct: closeHits / N, noFillPct: noFill / N },
    nets, shares,
  };
}

// ============================================================================
// ---- Anthropic (ANT) extensions — 2026-10-31 -------------------------------
// Everything above is the SpaceX engine, unchanged. Below: bucket-market parsing,
// the Nasdaq calendar, the S-1 lock-up schedule, and the 1-year path engine.
// ============================================================================

// Polymarket range-bucket events ("<$1.25T", "$1.25–$1.5T", "$3.0T+", "No IPO by …").
// Returns the same survival-curve shape as parsePolymarketCurve, but already conditional
// on an IPO: buckets are renormalized after dropping the "No IPO" leg, so this curve must
// NOT also go through normalizeTimingCurve. Values are in $T ($B labels are scaled).
export function parseBucketEvent(eventJson) {
  const ev = Array.isArray(eventJson) ? eventJson[0] : eventJson;
  const buckets = [];
  let pNoIpo = 0;
  for (const mk of (ev?.markets || [])) {
    let pr = mk.outcomePrices;
    if (typeof pr === 'string') { try { pr = JSON.parse(pr); } catch { continue; } }
    const p = parseFloat(pr?.[0]);
    if (!isFinite(p)) continue;
    const label = String(mk.groupItemTitle || mk.question || '').trim();
    if (/no ipo/i.test(label)) { pNoIpo = p; continue; }
    const units = [...label.matchAll(/([0-9.]+)\s*([TB])/gi)];
    if (!units.length) continue;
    const scale = units[units.length - 1][2].toUpperCase() === 'T' ? 1 : 1e-3;
    const nums = [...label.matchAll(/([0-9]+(?:\.[0-9]+)?)/g)].map(m => parseFloat(m[1]) * scale);
    buckets.push({ lo: label.startsWith('<') ? -Infinity : nums[0], p });
  }
  const total = buckets.reduce((a, b) => a + b.p, 0);
  if (!(total > 0)) return { curve: [], pNoIpo, total: 0 };
  const bounds = [...new Set(buckets.filter(b => isFinite(b.lo)).map(b => b.lo))].sort((a, b) => a - b);
  const curve = bounds.map(t => ({
    capT: t, pAbove: 100 * buckets.filter(b => b.lo >= t).reduce((a, b) => a + b.p, 0) / total,
  }));
  return { curve, pNoIpo, total };
}
export function parseBucketCurve(eventJson) { return parseBucketEvent(eventJson).curve; }

// Polymarket IPO-date event ("November 18", "November 13 or earlier", "No IPO by …").
const MONTH_IDX = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11 };
export function parseDateEvent(eventJson) {
  const ev = Array.isArray(eventJson) ? eventJson[0] : eventJson;
  const year = parseInt(String(ev?.endDate || '').slice(0, 4), 10) || new Date().getUTCFullYear();
  const dates = [];
  let pNone = 0;
  for (const mk of (ev?.markets || [])) {
    let pr = mk.outcomePrices;
    if (typeof pr === 'string') { try { pr = JSON.parse(pr); } catch { continue; } }
    const p = parseFloat(pr?.[0]);
    if (!isFinite(p)) continue;
    const label = String(mk.groupItemTitle || '').trim();
    if (/no ipo/i.test(label)) { pNone = p; continue; }
    const m = label.match(/^([A-Za-z]+)\s+([0-9]{1,2})/);
    if (!m || MONTH_IDX[m[1].toLowerCase()] == null) continue;
    const iso = `${year}-${String(MONTH_IDX[m[1].toLowerCase()] + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    dates.push({ iso, p, orEarlier: /earlier/i.test(label) });
  }
  dates.sort((a, b) => a.iso.localeCompare(b.iso));
  const modeIso = dates.length ? dates.reduce((a, b) => (b.p > a.p ? b : a)).iso : null;
  return { dates, pNone, modeIso };
}

// ---- Nasdaq calendar (Nov 2026 → Dec 2027) ---------------------------------
// Observed holidays: Thanksgiving, Christmas, New Year, MLK, Presidents, Good Friday,
// Memorial, Juneteenth (Sat Jun 19 2027 → Fri Jun 18), Independence (Sun Jul 4 2027 →
// Mon Jul 5), Labor, Thanksgiving 2027, Christmas 2027 (Sat → Fri Dec 24).
export const NASDAQ_HOLIDAYS = new Set([
  '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26',
  '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const utc = (iso) => new Date(iso + 'T12:00:00Z');
export function addDaysIso(iso, n) { const d = utc(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function isTradingDay(iso, holidays = NASDAQ_HOLIDAYS) {
  const dow = utc(iso).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(iso);
}
export function nextTradingDay(iso, holidays = NASDAQ_HOLIDAYS) {
  let x = iso; while (!isTradingDay(x, holidays)) x = addDaysIso(x, 1); return x;
}
// n trading days strictly after iso ("the second full trading day following the release").
export function addTradingDays(iso, n, holidays = NASDAQ_HOLIDAYS) {
  let x = iso, k = 0;
  while (k < n) { x = addDaysIso(x, 1); if (isTradingDay(x, holidays)) k++; }
  return x;
}
export function prevTradingDay(iso, holidays = NASDAQ_HOLIDAYS) {
  let x = addDaysIso(iso, -1); while (!isTradingDay(x, holidays)) x = addDaysIso(x, -1); return x;
}
// Index 0 = the first trading day on/after startIso (the IPO session).
export function buildTradingCalendar(startIso, n, holidays = NASDAQ_HOLIDAYS) {
  const out = [];
  let x = nextTradingDay(startIso, holidays);
  while (out.length <= n) {
    const d = utc(x);
    out.push({ i: out.length, iso: x, label: `${DOW3[d.getUTCDay()]} ${MON3[d.getUTCMonth()]} ${d.getUTCDate()}`,
      short: `${MON3[d.getUTCMonth()]} ${d.getUTCDate()}`, mon: `${MON3[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}` });
    x = addTradingDays(x, 1, holidays);
  }
  return out;
}
export function calIndex(cal, iso) { return cal.findIndex(d => d.iso >= iso); }

// Fidelity counts its flip window in CALENDAR days: the first penalty-free sale is the first
// trading day after IPO date + 15 (SpaceX: Fri Jun 12 → Mon Jun 29).
export function fidelityFirstSellable(ipoIso, holidays = NASDAQ_HOLIDAYS) {
  return nextTradingDay(addDaysIso(ipoIso, 16), holidays);
}
// Long-term capital gains need a holding period of MORE than one year.
export function ltcgFirstDay(ipoIso, holidays = NASDAQ_HOLIDAYS) {
  const y = parseInt(ipoIso.slice(0, 4), 10) + 1;
  return nextTradingDay(addDaysIso(`${y}${ipoIso.slice(4)}`, 1), holidays);
}

// ---- S-1 lock-up schedule ----------------------------------------------------
// The release DATES are rules quoted from the S-1 ("Shares Eligible for Future Sale").
// The tranche SIZES are blank ("%") in the initial S-1, so the weights and pool sizes below
// are ASSUMPTIONS patterned on SPCX's reported structure — replace them from the S-1/A.
// Earnings release dates are also assumed (typical late-Feb / mid-May / mid-Aug / mid-Nov).
export const ANT_LOCKUP_DEFAULTS = {
  pool180: 0.40,   // share of FD stock under the 180-day lock-up (S-1: "approximately %")
  pool365: 0.45,   // co-founders + holders >0.5% under the extended 365-day lock-up
  earnings: { fy26: '2027-02-25', q1: '2027-05-13', q2: '2027-08-12', q3: '2027-11-11' },
  w180: { day1: 0.05, d27: 0.07, d48: 0.07, d62: 0.07, d76: 0.07,
          fy: 0.20, fy13: 0.05, fy27: 0.05, fy41: 0.05, fy55: 0.05, fy69: 0.05, q1: 0.22 },
  w365: { q1_34: 0.10, q1_48: 0.10, q1_62: 0.10, q1_76: 0.10,
          q2: 0.15, q2_27: 0.05, q2_41: 0.05, q2_55: 0.05, q2_69: 0.05, q2_83: 0.05, q3: 0.20 },
};

export function antUnlockEvents(ipoIso, cfg = ANT_LOCKUP_DEFAULTS, holidays = NASDAQ_HOLIDAYS) {
  const prosp = prevTradingDay(ipoIso, holidays);              // priced the evening before the first trade
  const nt = (iso) => nextTradingDay(iso, holidays);
  const after = (iso, n) => nt(addDaysIso(iso, n));             // "Nth day after …"
  const rel2 = (iso) => addTradingDays(iso, 2, holidays);       // "second full trading day following …"
  const { fy26, q1, q2, q3 } = cfg.earnings;
  // "immediately after the close of trading on the 180th/365th day" → sellable the next session
  const d180 = addTradingDays(prevTradingDay(addDaysIso(prosp, 181), holidays), 1, holidays);
  const d365 = addTradingDays(prevTradingDay(addDaysIso(prosp, 366), holidays), 1, holidays);
  const first = (a, b) => (a < b ? a : b);
  const ev = [];
  const add = (pool, key, iso, label) => {
    const w = (pool === 180 ? cfg.w180 : cfg.w365)[key] ?? 0;
    ev.push({ pool, key, iso, label, w, fracFD: w * (pool === 180 ? cfg.pool180 : cfg.pool365) });
  };
  add(180, 'day1', ipoIso, 'Employee/officer early release (day 1)');
  for (const n of [27, 48, 62, 76]) add(180, `d${n}`, after(prosp, n), `Day ${n} tranche`);
  add(180, 'fy', rel2(fy26), 'FY26 earnings release');
  for (const n of [13, 27, 41, 55, 69]) add(180, `fy${n}`, after(fy26, n), `FY26 +${n}d tranche`);
  add(180, 'q1', first(rel2(q1), d180), '180-day pool: all remaining (Q1 earnings / day 180)');
  for (const n of [34, 48, 62, 76]) add(365, `q1_${n}`, after(q1, n), `365-day pool: Q1 +${n}d`);
  add(365, 'q2', rel2(q2), '365-day pool: Q2 earnings');
  for (const n of [27, 41, 55, 69, 83]) add(365, `q2_${n}`, after(q2, n), `365-day pool: Q2 +${n}d`);
  add(365, 'q3', first(rel2(q3), d365), 'Founders + >0.5% holders: all remaining (Q3 / day 365)');
  return ev.sort((a, b) => a.iso.localeCompare(b.iso));
}

// Earnings reaction sessions: results come out after the close, so the move lands next session.
export function earningsSessions(cfg = ANT_LOCKUP_DEFAULTS, holidays = NASDAQ_HOLIDAYS) {
  return Object.entries(cfg.earnings).map(([k, iso]) => ({ key: k, release: iso, iso: addTradingDays(iso, 1, holidays) }));
}

// Deterministic per-day log-drift from the unlock calendar. Each tranche (fraction f of FD
// shares) pulls the price down by kappa·f spread over the `lead` sessions BEFORE it unlocks
// (supply anticipation — SPCX fell 35% into its first big tranche), then gives back rho of
// that over the `lag` sessions after (SPCX bounced ~+24% within a week of its Aug 6 release).
// c[d-1] is the drift going INTO day d, matching simulatePostIPO's eventCurve convention.
export function supplyDriftCurve(events, days, { kappa = 1.0, rho = 0.5, lead = 10, lag = 10 } = {}) {
  const c = new Array(days).fill(0);
  for (const e of events) {
    if (!(e.idx > 0)) continue;                                  // day-1 float is priced into the open
    const hit = kappa * e.fracFD;
    for (let k = 0; k < lead; k++) { const d = e.idx - k; if (d >= 1 && d <= days) c[d - 1] -= hit / lead; }
    for (let k = 1; k <= lag; k++) { const d = e.idx + k; if (d >= 1 && d <= days) c[d - 1] += rho * hit / lag; }
  }
  return c;
}

// ---- Fundamental terminal (12-month) ------------------------------------------
// Equity value = run-rate revenue × EV/run-rate multiple + net cash; ÷ FD shares.
// Defaults are ASSUMPTIONS chosen so the base case sits roughly at a cost-of-equity drift
// above the crowd's Day-1 price — the anchor should add shape, not smuggle in alpha.
export const ANT_SCENARIOS_DEFAULT = [
  { name: 'Bear', p: 0.25, runRateB: 110, multiple: 7 },
  { name: 'Base', p: 0.50, runRateB: 200, multiple: 9.5 },
  { name: 'Bull', p: 0.25, runRateB: 300, multiple: 11 },
];
export function scenarioPerShare(sc, netCashB, sharesFD) {
  return (sc.runRateB * sc.multiple + netCashB) * 1e9 / sharesFD;
}

// Walk each Day-1 close forward `days` sessions:
//   diffusion: −½σ_d² + σ_d·Z, with σ_d decaying from sigma0 (IPO-hot) to sigmaLong
//              (default 3%/day ≈ SPCX's realized 30-day vol, Oct 2026) at volHalfLife;
//   supply:    supplyWeight · supplyCurve[d−1]  (lock-up overhang, deterministic);
//   earnings:  a zero-mean jump of earningsSigma on each earnings reaction session;
//   anchor:    anchorStrength · (d/days) · (logT − logS) / anchorTau, where logT is a per-path
//              terminal drawn from the fundamental scenario mixture with lognormal dispersion.
export function simulateYear(cfg) {
  const {
    closes, rng, days, sigma0, sigmaLong = 0.03, volHalfLife = 15,
    supplyCurve = null, supplyWeight = 0,
    earningsIdx = [], earningsSigma = 0.08,
    scenarios = null, dispersion = 0.15, anchorStrength = 0, anchorTau = 20,
  } = cfg;
  const N = closes.length, g = () => gaussFrom(rng);
  const grid = Array.from({ length: days + 1 }, () => new Float64Array(N));
  const scen = new Int8Array(N).fill(-1);
  const earn = new Set(earningsIdx);
  const sig = Array.from({ length: days + 1 }, (_, d) => sigmaLong + (sigma0 - sigmaLong) * Math.pow(0.5, Math.max(0, d - 1) / volHalfLife));
  const useAnchor = scenarios && scenarios.length && anchorStrength > 0;
  const pTot = useAnchor ? scenarios.reduce((a, s) => a + s.p, 0) : 0;
  for (let p = 0; p < N; p++) {
    let logS = Math.log(closes[p]);
    grid[0][p] = closes[p];
    let logT = null;
    if (useAnchor) {
      let u = rng() * pTot, k = 0;
      while (k < scenarios.length - 1 && u > scenarios[k].p) { u -= scenarios[k].p; k++; }
      scen[p] = k;
      logT = Math.log(scenarios[k].perShare) + g() * dispersion;
    }
    for (let d = 1; d <= days; d++) {
      const s = sig[d];
      let dLog = -0.5 * s * s + g() * s;
      if (supplyCurve && supplyWeight) dLog += supplyWeight * (supplyCurve[d - 1] || 0);
      if (earn.has(d)) dLog += -0.5 * earningsSigma * earningsSigma + g() * earningsSigma;
      if (logT != null) dLog += anchorStrength * (d / days) * (logT - logS) / anchorTau;
      logS += dLog;
      grid[d][p] = Math.exp(logS);
    }
  }
  return { grid, days, scen };
}

// After-tax net of a gain/loss. A loss is credited at the same rate (assumes it offsets
// other gains of the same character) — a simplification, flagged in the UI.
export function afterTax(netGain, rate) { return netGain - netGain * rate; }
