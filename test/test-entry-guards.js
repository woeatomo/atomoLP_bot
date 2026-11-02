/**
 * Unit tests for entry filters, PnL-path sampling, and the threshold replay.
 * No network and no wallet. Run: node test/test-entry-guards.js
 */

import assert from "node:assert/strict";
import {
  evaluateReentryGuard,
  isLowYieldCloseReason,
  lowYieldAgeReached,
  volatilityFloorRejectReason,
} from "../entry-guards.js";
import { applyPnlSample, buildPnlPath, capPnlSamples, totalMinutesOutOfRange } from "../state.js";
import { entryRejectReason, replayBook, summarize } from "../scripts/backtest-thresholds.js";

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${name}`);
}

test("minVolatility default is off and a positive floor rejects below it", () => {
  assert.equal(volatilityFloorRejectReason(1, 0), null);
  assert.equal(volatilityFloorRejectReason(1, null), null);
  assert.equal(volatilityFloorRejectReason(4.9, 5), "volatility 4.9 below minVolatility 5");
  assert.equal(volatilityFloorRejectReason(5, 5), null);
  assert.match(volatilityFloorRejectReason(null, 5), /unknown/);
});

test("low-yield age uses the configured floor and ignores a missing age", () => {
  assert.equal(lowYieldAgeReached(59, 60), false);
  assert.equal(lowYieldAgeReached(60, 60), true);
  assert.equal(lowYieldAgeReached(60, 90), false);
  assert.equal(lowYieldAgeReached(90, 90), true);
  assert.equal(lowYieldAgeReached(null, 60), false);
  assert.equal(lowYieldAgeReached(undefined), false);
});

test("low-yield reasons match the live exit text, not only the exact token", () => {
  assert.equal(isLowYieldCloseReason("low yield"), true);
  assert.equal(isLowYieldCloseReason("Low yield: fee/TVL 0.13% < min 25% (age: 60m)"), true);
  assert.equal(isLowYieldCloseReason("take profit"), false);
  assert.equal(isLowYieldCloseReason("not a low yield close"), false);
});

test("re-entry guard stays off until enabled with a threshold", () => {
  const deploys = [
    { deployed_at: "2026-10-31T00:00:00Z", closed_at: "2026-10-31T01:00:00Z", entry_mcap: 1_000_000, volatility_at_deploy: 8, close_reason: "low yield" },
    { deployed_at: "2026-10-31T02:00:00Z", closed_at: "2026-10-31T03:00:00Z", entry_mcap: 900_000, volatility_at_deploy: 7, close_reason: "low yield" },
    { deployed_at: "2026-10-31T04:00:00Z", closed_at: "2026-10-31T05:00:00Z", entry_mcap: 800_000, volatility_at_deploy: 6, close_reason: "low yield" },
  ];
  const now = Date.parse("2026-10-31T06:00:00Z");
  assert.equal(evaluateReentryGuard({
    baseMint: "mint",
    mcap: 400_000,
    volatility: 3,
    now,
    deploys,
    settings: { enabled: false, maxDeploysPerToken: 3, mcapDropPct: 40 },
  }), null);
  assert.equal(evaluateReentryGuard({
    baseMint: "mint",
    mcap: 400_000,
    volatility: 3,
    now,
    deploys,
    settings: { enabled: true },
  }), null);
});

test("max deploys blocks the 4th entry and not the 3rd", () => {
  const settings = { enabled: true, maxDeploysPerToken: 3 };
  const one = [{ deployed_at: "2026-10-31T00:00:00Z", closed_at: "2026-10-31T01:00:00Z" }];
  const three = [0, 1, 2].map((i) => ({
    deployed_at: new Date(Date.parse("2026-10-31T00:00:00Z") + i * 3_600_000).toISOString(),
    closed_at: new Date(Date.parse("2026-10-31T01:00:00Z") + i * 3_600_000).toISOString(),
  }));
  assert.equal(evaluateReentryGuard({ baseMint: "mint", now: Date.parse("2026-10-31T12:00:00Z"), deploys: one, settings }), null);
  assert.match(
    evaluateReentryGuard({ baseMint: "mint", now: Date.parse("2026-10-31T12:00:00Z"), deploys: three, settings }),
    /max 3/,
  );
});

test("mcap and volatility drops block against the prior peak, and missing data does not", () => {
  const deploys = [{
    deployed_at: "2026-10-31T00:00:00Z",
    closed_at: "2026-10-31T02:00:00Z",
    entry_mcap: 1_027_000,
    volatility: 6.2,
    close_reason: "take profit",
  }];
  const now = Date.parse("2026-10-31T20:00:00Z");
  const settings = { enabled: true, mcapDropPct: 40, volatilityDropPct: 40 };
  assert.match(evaluateReentryGuard({
    baseMint: "mint", mcap: 424_000, volatility: 6.2, now, deploys, settings,
  }), /mcap dropped/);
  assert.match(evaluateReentryGuard({
    baseMint: "mint", mcap: 1_000_000, volatility: 3.2, now, deploys, settings,
  }), /volatility dropped/);
  assert.equal(evaluateReentryGuard({
    baseMint: "mint", mcap: 900_000, volatility: 5, now, deploys, settings,
  }), null);
  assert.equal(evaluateReentryGuard({
    baseMint: "mint", mcap: null, volatility: null, now, deploys, settings,
  }), null);
});

test("lookback ignores old deploys and a low-yield streak resets after another close", () => {
  const old = {
    deployed_at: "2026-10-01T00:00:00Z",
    closed_at: "2026-10-01T02:00:00Z",
    entry_mcap: 2_000_000,
    close_reason: "Low yield: fee/TVL 0.1% < min 25% (age: 60m)",
  };
  const recent = {
    deployed_at: "2026-10-31T00:00:00Z",
    closed_at: "2026-10-31T02:00:00Z",
    entry_mcap: 500_000,
    close_reason: "take profit",
  };
  const now = Date.parse("2026-10-31T08:00:00Z");
  assert.equal(evaluateReentryGuard({
    baseMint: "mint",
    mcap: 400_000,
    now,
    deploys: [old],
    settings: { enabled: true, maxDeploysPerToken: 1, lookbackHours: 48 },
  }), null);
  const recentLow = {
    deployed_at: "2026-10-31T01:00:00Z",
    closed_at: "2026-10-31T03:00:00Z",
    close_reason: "Low yield: fee/TVL 0.2% < min 25% (age: 60m)",
  };
  const earlierRecent = {
    deployed_at: "2026-10-30T20:00:00Z",
    closed_at: "2026-10-30T22:00:00Z",
    close_reason: old.close_reason,
  };
  assert.match(evaluateReentryGuard({
    baseMint: "mint",
    now,
    deploys: [old, earlierRecent, recentLow],
    settings: { enabled: true, lowYieldStreak: 2, lookbackHours: 48 },
  }), /low yield/);
  assert.equal(evaluateReentryGuard({
    baseMint: "mint",
    now,
    deploys: [old, recent],
    settings: { enabled: true, lowYieldStreak: 2 },
  }), null);
});

test("PnL samples keep min and max and honour the interval", () => {
  const position = { deployed_at: "2026-10-31T00:00:00.000Z", pnl_samples: [] };
  const t0 = Date.parse(position.deployed_at);
  applyPnlSample(position, { pnl_pct: 1, in_range: true, now: t0 + 1000, sampleSec: 60 });
  applyPnlSample(position, { pnl_pct: 1.2, in_range: true, now: t0 + 10_000, sampleSec: 60 });
  assert.equal(position.pnl_samples.length, 1);
  applyPnlSample(position, { pnl_pct: 4.6, in_range: true, now: t0 + 20_000, sampleSec: 60 });
  assert.equal(position.pnl_samples.length, 2);
  applyPnlSample(position, { pnl_pct: -3.5, in_range: false, now: t0 + 90_000, sampleSec: 60 });
  assert.equal(position.min_pnl_pct, -3.5);
  assert.equal(position.max_pnl_pct, 4.6);
  const path = buildPnlPath({ ...position, peak_pnl_pct: 4.6 });
  assert.equal(path.sample_count, position.pnl_samples.length);
  assert.equal(path.samples[0].ts, undefined);
  assert.ok(path.samples.some((sample) => sample.pnl_pct === -3.5));
  assert.equal(path.peak_pnl_pct, 4.6);

  const many = [];
  for (let i = 0; i < 200; i++) {
    const pnl = i === 40 ? -12 : i === 150 ? 9 : i / 100;
    many.push({ ts: i, t: i, pnl_pct: pnl, in_range: true });
  }
  const capped = capPnlSamples(many, 20);
  assert.ok(capped.length <= 20);
  assert.equal(capped[0].t, 0);
  assert.equal(capped[capped.length - 1].t, 199);
  assert.ok(capped.some((sample) => sample.pnl_pct === -12));
  assert.ok(capped.some((sample) => sample.pnl_pct === 9));
});

test("total out-of-range minutes adds the open stretch to earlier ones", () => {
  const now = Date.parse("2026-10-31T02:00:00Z");
  const minutes = totalMinutesOutOfRange({
    minutes_out_of_range_total: 15,
    out_of_range_since: "2026-10-31T01:30:00Z",
  }, now);
  assert.equal(minutes, 45);
  assert.equal(totalMinutesOutOfRange({ minutes_out_of_range_total: 0, out_of_range_since: null }, now), 0);
});

test("replay drops the 4th deploy and a low-volatility book without touching the rest", () => {
  const rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push({
      base_mint: "mintA",
      volatility: 6,
      fee_tvl_ratio: 3,
      entry_mcap: 1_000_000 - i * 100_000,
      pnl_usd: i === 3 ? -20 : 5,
      pnl_pct: i === 3 ? -15 : 2,
      close_reason: i === 3 ? "Stop loss: PnL -15% <= -15%" : "take profit",
      recorded_at: new Date(Date.parse("2026-10-31T00:00:00Z") + (i + 1) * 3_600_000).toISOString(),
      minutes_held: 30,
    });
  }
  rows.push({
    base_mint: "mintB",
    volatility: 2,
    fee_tvl_ratio: 0.4,
    entry_mcap: 400_000,
    pnl_usd: -2,
    pnl_pct: -1,
    close_reason: "Low yield: fee/TVL 1% < min 25% (age: 60m)",
    recorded_at: "2026-10-31T06:00:00Z",
    minutes_held: 60,
  });

  const vol = replayBook(rows, { minVolatility: 5 });
  assert.equal(vol.taken.length, 4);
  assert.equal(vol.skipped.length, 1);
  assert.ok(vol.skipped[0]._skip_reason.includes("minVolatility"));

  const capped = replayBook(rows, {
    reentry: { enabled: true, maxDeploysPerToken: 3 },
  }, { countMode: "all" });
  assert.equal(capped.taken.length, 4);
  assert.equal(capped.skipped.length, 1);
  assert.equal(capped.skipped[0].pnl_usd, -20);

  const summary = summarize(capped.taken);
  assert.equal(summary.n, 4);
  assert.equal(summary.totalPnl, 13);
  assert.equal(summary.sl, 0);
  assert.equal(summary.tp, 3);

  assert.equal(entryRejectReason(rows[0], {}), null);
});

console.log(`\n${passed} tests passed`);
