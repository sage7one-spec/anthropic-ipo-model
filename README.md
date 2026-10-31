# Anthropic (ANT) IPO — Day-1 to 1-Year Live Model

Browser-based Monte-Carlo model of the Anthropic IPO for a pre-IPO Fidelity allocation. Built on the
[SpaceX IPO model](https://github.com/sage7one-spec/spacex-ipo-model) engine (unchanged, 62 tests), extended
for Anthropic's S-1 (filed Oct 26 2026). It pulls fresh data on every page load — no server, no keys:

- **Hyperliquid `xyz:ANT`** pre-IPO perp — live per-share mark + realized vol.
- **Polymarket** Anthropic markets — Day-1 closing market cap (bucketed), **IPO valuation** (sets the
  default allocation price until the real one is known), listing date, and raise size.

If an API is down the page falls back to `snapshot.js` (captured 2026-10-31) and says so.

## What it shows

| Section | What |
|---|---|
| Day 1 | price × hour heatmap, touch odds, close and low/high distributions, Polymarket pricing-vs-close curves |
| Case A | scaled Day-1 sell plan (Protect / Balanced / Ride) with Fidelity OCO tickets and checkpoints |
| Case B | open-market bottom-feeder limit buy with OCO exit ($0 when it never fills) |
| Case C | **1-year** heatmap on the S-1 lock-up calendar, to the first long-term-gains session, with the SPCX post-IPO path overlaid |
| S-1 | quarterly revenue vs compute, key disclosures, compute commitments, value-chain check, risk-factor emphasis |

All three cases are scored on the same 10,000 paths, in net dollars on one capital base, before and after tax.

## The 1-year engine (`simulateYear`)

Per path, per trading day: `−½σ_d² + σ_d·Z` (σ decays from the IPO-day level to a long-run level, default
3%/day ≈ SPCX realized) + **lock-up overhang** (`supplyDriftCurve`: each tranche pulls the price down by
κ·f over the 10 sessions before it and gives back half over the 10 after — calibrated to SPCX falling 35%
into its first tranche) + **earnings jumps** + a soft **fundamental anchor** toward a bull/base/bear terminal
(run-rate × EV multiple + net cash, ÷ FD shares).

**Facts vs assumptions.** Unlock *dates* follow the S-1's rules exactly (`antUnlockEvents`). Tranche *sizes*,
pool sizes, the 365-day pool's 50% sell-through, earnings dates and the fundamental scenarios are
assumptions — the initial S-1 leaves the percentages blank. Replace them from the S-1/A in
`ANT_LOCKUP_DEFAULTS` / `ANT_SCENARIOS_DEFAULT`.

## Develop

- `npm test` — 76 unit tests (Node built-in runner); ANT tests run on verbatim captures in `test/fixtures/`.
- `python3 -m http.server 8765` → http://localhost:8765/ (ES modules need HTTP).
- `node scripts_gen_snapshot.mjs` — rebuild the offline snapshot from `test/fixtures/`.
- `node build_single_file.mjs` — bundle everything into `dist/anthropic-ipo-model.html`, which opens from
  disk (the copy kept in the vault).

**Not financial advice.** Built by Claude (an Anthropic model) from the public S-1 and public market data only.
