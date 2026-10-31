// Tests for the Anthropic (ANT) extensions. Fixtures are verbatim captures of the live
// Polymarket / Hyperliquid payloads the page consumes (2026-10-31), not invented shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseBucketEvent, parseBucketCurve, parseDateEvent, curveArrays, medianCapT,
  parseHyperliquid, realizedVolFromCandles, mulberry32,
  NASDAQ_HOLIDAYS, addTradingDays, buildTradingCalendar, calIndex, isTradingDay,
  fidelityFirstSellable, ltcgFirstDay, antUnlockEvents, ANT_LOCKUP_DEFAULTS, earningsSessions,
  supplyDriftCurve, simulateYear, scenarioPerShare, ANT_SCENARIOS_DEFAULT, afterTax,
} from '../model.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const closeCap = fx('ant-poly-close-cap.json');
const valuation = fx('ant-poly-valuation.json');
const raise = fx('ant-poly-raise.json');
const dateEv = fx('ant-poly-date.json');
const hlMeta = fx('ant-hl-meta.json');
const hlCandles = fx('ant-hl-candles-1h.json');

test('parseBucketEvent: Day-1 close-cap buckets → conditional survival curve', () => {
  const { curve, pNoIpo } = parseBucketEvent(closeCap);
  assert.deepEqual(curve.map(r => r.capT), [1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0]);
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i].pAbove <= curve[i - 1].pAbove);
  assert.ok(curve[0].pAbove > 90 && curve[0].pAbove < 100);  // "<$1.25T" leg is the only mass below
  assert.ok(pNoIpo > 0 && pNoIpo < 0.05);                     // the "No IPO" leg was split off, not parsed as a bucket
  const { thresh, above } = curveArrays(curve);
  const med = medianCapT(thresh, above);
  assert.ok(med > 1.75 && med < 2.0, `median close cap ${med}`);
});

test('parseBucketEvent: IPO-valuation buckets with "$1.25–$1.50T" labels (unit only on the 2nd number)', () => {
  const { thresh, above } = curveArrays(parseBucketCurve(valuation));
  assert.equal(thresh[0], 1.25);
  const med = medianCapT(thresh, above);
  assert.ok(med > 1.5 && med < 1.75, `median IPO valuation ${med}`);
});

test('parseBucketEvent: $B raise buckets are scaled to $T', () => {
  const { thresh, above } = curveArrays(parseBucketCurve(raise));
  assert.ok(Math.abs(thresh[0] - 0.065) < 1e-9);
  const med = medianCapT(thresh, above);
  assert.ok(med > 0.095 && med < 0.105, `median raise ${med}`);
});

test('parseDateEvent: mode is the most likely listing day; "No IPO" kept separate', () => {
  const d = parseDateEvent(dateEv);
  assert.equal(d.modeIso, '2026-11-20');
  assert.ok(d.dates.length >= 10);
  assert.ok(d.dates.every(x => /^2026-11-\d\d$/.test(x.iso)));
  assert.ok(d.pNone > 0.05 && d.pNone < 0.5);
});

test('Hyperliquid xyz:ANT parses from the xyz dex payload; candles give a realized vol', () => {
  const hl = parseHyperliquid(hlMeta, 'xyz:ANT');
  assert.ok(hl && hl.mark > 50 && hl.mark < 300);
  const v = realizedVolFromCandles(hlCandles, 2);
  assert.ok(v && v.hourlySigma > 0 && v.sliderVal >= 0 && v.sliderVal <= 100);
});

test('calendar: Thanksgiving / Christmas / New Year 2027 are skipped', () => {
  const cal = buildTradingCalendar('2026-11-20', 30);
  const isos = cal.map(d => d.iso);
  for (const h of ['2026-11-26', '2026-12-25', '2027-01-01']) assert.ok(!isos.includes(h));
  assert.equal(cal[0].iso, '2026-11-20');
  assert.ok(isos.includes('2026-11-27'));        // half-day, still a session
  assert.equal(addTradingDays('2027-02-25', 2), '2027-03-01');
  assert.ok(!isTradingDay('2027-06-18') && !isTradingDay('2027-07-05'));
});

test('Fidelity flip window and LTCG date', () => {
  assert.equal(fidelityFirstSellable('2026-06-12'), '2026-06-29');   // SpaceX precedent
  assert.equal(fidelityFirstSellable('2026-11-20'), '2026-12-07');
  assert.equal(ltcgFirstDay('2026-11-20'), '2027-11-22');            // Nov 21 2027 is a Sunday
});

test('antUnlockEvents: S-1 date rules land on the right sessions; weights sum to 1 per pool', () => {
  const ev = antUnlockEvents('2026-11-20');
  const by = Object.fromEntries(ev.map(e => [`${e.pool}:${e.key}`, e.iso]));
  assert.equal(by['180:d27'], '2026-12-16');      // prospectus Thu Nov 19 + 27 days
  assert.equal(by['180:fy'], '2027-03-01');       // 2nd full trading day after Thu Feb 25 release
  assert.equal(by['180:q1'], '2027-05-17');       // Q1 release +2 sessions beats day 180 (May 19)
  assert.equal(by['365:q3'], '2027-11-15');       // Q3 release +2 sessions beats day 365
  for (const pool of [180, 365]) {
    const s = ev.filter(e => e.pool === pool).reduce((a, e) => a + e.w, 0);
    assert.ok(Math.abs(s - 1) < 1e-9, `pool ${pool} weights sum ${s}`);
  }
  const fd = ev.reduce((a, e) => a + e.fracFD, 0);
  assert.ok(Math.abs(fd - (ANT_LOCKUP_DEFAULTS.pool180 + ANT_LOCKUP_DEFAULTS.pool365)) < 1e-9);
  assert.ok(ev.every(e => isTradingDay(e.iso)));
  const q3 = ev.find(e => e.key === 'q3');
  assert.ok(Math.abs(q3.supplyFD - q3.fracFD * ANT_LOCKUP_DEFAULTS.sellThrough[365]) < 1e-12);
  assert.ok(ev.filter(e => e.pool === 180).every(e => e.supplyFD === e.fracFD));
});

test('earningsSessions: reaction lands the session after an after-close release', () => {
  const e = earningsSessions();
  assert.equal(e.find(x => x.key === 'fy26').iso, '2027-02-26');
});

test('supplyDriftCurve: net drift = −kappa·f·(1−rho) for an interior event; lead window sits before it', () => {
  const ev = [{ idx: 30, fracFD: 0.1 }];
  const c = supplyDriftCurve(ev, 60, { kappa: 1, rho: 0.5, lead: 10, lag: 10 });
  const sum = c.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - (-0.05)) < 1e-12);
  assert.ok(c[29] < 0 && c[20] < 0 && c[19] === 0);    // days 21..30 carry the anticipation
  assert.ok(c[30] > 0 && c[39] > 0 && c[40] === 0);    // days 31..40 carry the give-back
  assert.ok(supplyDriftCurve([{ idx: 0, fracFD: 0.1 }], 20).every(x => x === 0)); // day-1 float: no drift
});

test('simulateYear: zero vol + supply only → deterministic exp(Σ curve)', () => {
  const curve = supplyDriftCurve([{ idx: 15, fracFD: 0.2 }], 40);
  const r = simulateYear({ closes: [100, 120], rng: mulberry32(1), days: 40, sigma0: 0, sigmaLong: 0,
    supplyCurve: curve, supplyWeight: 1 });
  const expect = Math.exp(curve.reduce((a, b) => a + b, 0));
  assert.ok(Math.abs(r.grid[40][0] / 100 - expect) < 1e-9);
  assert.ok(Math.abs(r.grid[40][1] / 120 - expect) < 1e-9);
  assert.ok(r.grid[15][0] < r.grid[40][0]);           // trough at the unlock, partial recovery after
});

test('simulateYear: the fundamental anchor pulls zero-vol paths toward their scenario terminal', () => {
  const scenarios = [{ p: 1, perShare: 150 }];
  const r = simulateYear({ closes: Array(50).fill(100), rng: mulberry32(3), days: 250, sigma0: 0, sigmaLong: 0,
    scenarios, dispersion: 0, anchorStrength: 0.5, anchorTau: 20 });
  const end = r.grid[250][0];
  assert.ok(end > 140 && end <= 150, `end ${end}`);
  const none = simulateYear({ closes: [100], rng: mulberry32(3), days: 250, sigma0: 0, sigmaLong: 0 });
  assert.ok(Math.abs(none.grid[250][0] - 100) < 1e-9); // martingale with no noise stays put
});

test('simulateYear: earnings jumps fire only on earnings sessions', () => {
  const r = simulateYear({ closes: Array(200).fill(100), rng: mulberry32(9), days: 10, sigma0: 0, sigmaLong: 0,
    earningsIdx: [5], earningsSigma: 0.1 });
  const moved = (d) => r.grid[d].some((x, i) => Math.abs(x - r.grid[d - 1][i]) > 1e-12);
  assert.ok(!moved(4) && moved(5) && !moved(6));
});

test('scenario per-share and after-tax helpers', () => {
  assert.ok(Math.abs(scenarioPerShare({ runRateB: 200, multiple: 10 }, 0, 20e9) - 100) < 1e-9);
  const base = ANT_SCENARIOS_DEFAULT.find(s => s.name === 'Base');
  assert.ok(scenarioPerShare(base, 180, 17.4e9) > 100);
  assert.equal(afterTax(1000, 0.3), 700);
  assert.equal(afterTax(-1000, 0.3), -700);
});

test('simulateYear: AI-credit shock hits ~shockProb of paths once, by exactly shockSize', () => {
  const N = 4000;
  const r = simulateYear({ closes: Array(N).fill(100), rng: mulberry32(11), days: 60, sigma0: 0, sigmaLong: 0,
    shockProb: 0.25, shockSize: 0.3 });
  let hit = 0;
  for (let p = 0; p < N; p++) {
    const end = r.grid[60][p];
    if (r.shockDay[p] > 0) { hit++; assert.ok(Math.abs(end - 70) < 1e-9); assert.ok(Math.abs(r.grid[r.shockDay[p] - 1][p] - 100) < 1e-9); }
    else assert.ok(Math.abs(end - 100) < 1e-9);
  }
  assert.ok(Math.abs(hit / N - 0.25) < 0.03, `shocked share ${hit / N}`);
  const off = simulateYear({ closes: [100], rng: mulberry32(11), days: 60, sigma0: 0, sigmaLong: 0 });
  assert.equal(off.shockDay[0], -1);
});

test('simulateYear: half of a shock persists through the fundamental anchor (multiple compression)', () => {
  const base = { closes: Array(400).fill(100), rng: mulberry32(5), days: 250, sigma0: 0, sigmaLong: 0,
    scenarios: [{ p: 1, perShare: 100 }], dispersion: 0, anchorStrength: 1, anchorTau: 5 };
  const r = simulateYear({ ...base, shockProb: 1, shockSize: 0.36, shockPersist: 0.5 });
  for (let p = 0; p < 400; p++) if (r.shockDay[p] > 0 && r.shockDay[p] < 120)
    assert.ok(Math.abs(r.grid[250][p] - 80) < 2, `end ${r.grid[250][p]} vs 100·0.64^0.5 = 80`);
  const full = simulateYear({ ...base, shockProb: 1, shockSize: 0.36, shockPersist: 0 });
  for (let p = 0; p < 400; p++) if (full.shockDay[p] > 0 && full.shockDay[p] < 120) assert.ok(full.grid[250][p] > 97);
});

