/**
 * Offline replay of closed-position performance records.
 *
 * This does not simulate prices. It answers: of the deploys that already
 * happened, which ones would a stricter entry rule have skipped, and what
 * PnL did the kept set actually realize? Removed trades are not replaced.
 * Exit rules (TP / trailing / stop) cannot be re-simulated until records
 * include `pnl_path`.
 *
 * Usage:
 *   node scripts/backtest-thresholds.js path/to/lessons.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { evaluateReentryGuard, volatilityFloorRejectReason } from "../entry-guards.js";

export function deployTimeMs(row) {
  if (row?.deployed_at) {
    const direct = Date.parse(row.deployed_at);
    if (Number.isFinite(direct)) return direct;
  }
  const closed = Date.parse(row?.recorded_at || row?.closed_at || "");
  const held = Number(row?.minutes_held);
  if (Number.isFinite(closed) && Number.isFinite(held)) return closed - held * 60_000;
  return Number.isFinite(closed) ? closed : 0;
}

export function closeTimeMs(row) {
  const closed = Date.parse(row?.recorded_at || row?.closed_at || "");
  return Number.isFinite(closed) ? closed : deployTimeMs(row);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Positive top-level volatility, otherwise the screening snapshot. A stored 0 is missing, not a real print. */
export function entryVolatility(row) {
  const top = num(row?.volatility);
  if (top != null && top > 0) return top;
  const snap = num(row?.signal_snapshot?.volatility);
  if (snap != null && snap > 0) return snap;
  return top ?? snap;
}

export function reasonGroup(reason) {
  const text = String(reason || "").toLowerCase();
  if (text.includes("stop loss")) return "stop loss";
  if (text.includes("take profit")) return "take profit";
  if (text.includes("trailing")) return "trailing";
  if (text.includes("low yield")) return "low yield";
  if (text.includes("pumped far")) return "pumped far above range";
  if (text.includes("out of range") || text === "oor" || /\boor\b/.test(text)) return "OOR";
  return "other";
}

export function summarize(rows) {
  const list = rows || [];
  let totalPnl = 0;
  let totalPct = 0;
  let wins = 0;
  let nonnegative = 0;
  let tp = 0;
  let sl = 0;
  const byReason = {};
  for (const row of list) {
    const pnl = num(row.pnl_usd) ?? 0;
    const pct = num(row.pnl_pct) ?? 0;
    totalPnl += pnl;
    totalPct += pct;
    if (pnl > 0 || (pnl === 0 && pct > 0)) wins += 1;
    if (pct >= 0) nonnegative += 1;
    const group = reasonGroup(row.close_reason);
    byReason[group] = (byReason[group] || 0) + 1;
    if (group === "take profit" || group === "trailing") tp += 1;
    if (group === "stop loss") sl += 1;
  }
  const n = list.length;
  return {
    n,
    wins,
    winRate: n ? wins / n : 0,
    nonnegative,
    totalPnl,
    meanPnl: n ? totalPnl / n : 0,
    meanPct: n ? totalPct / n : 0,
    tp,
    sl,
    byReason,
  };
}

function mintKey(row) {
  return row?.base_mint || row?.pool || "unknown";
}

/**
 * Walk the book in deploy-time order.
 * `countMode: "all"` counts every historical deploy as prior context
 * (matches a retrospective "the 4th entry").
 * `countMode: "taken"` counts only deploys that passed the same rules
 * (what the agent would have remembered if the filter had been on).
 */
export function replayBook(rows, rules = {}, { countMode = "taken" } = {}) {
  const ordered = [...(rows || [])].map((row, index) => ({ row, index }));
  ordered.sort((a, b) => deployTimeMs(a.row) - deployTimeMs(b.row) || a.index - b.index);

  const historyByMint = new Map();
  const takenByMint = new Map();
  const taken = [];
  const skipped = [];

  for (const item of ordered) {
    const row = item.row;
    const mint = mintKey(row);
    const prior = countMode === "all"
      ? (historyByMint.get(mint) || [])
      : (takenByMint.get(mint) || []);
    const reason = entryRejectReason(row, rules, prior);
    if (countMode === "all") {
      const hist = historyByMint.get(mint) || [];
      hist.push(toGuardDeploy(row));
      historyByMint.set(mint, hist);
    }
    if (reason) {
      skipped.push({ ...row, _skip_reason: reason });
    } else {
      taken.push(row);
      const list = takenByMint.get(mint) || [];
      list.push(toGuardDeploy(row));
      takenByMint.set(mint, list);
    }
  }

  return { taken, skipped };
}

function toGuardDeploy(row) {
  return {
    deployed_at: new Date(deployTimeMs(row)).toISOString(),
    closed_at: new Date(closeTimeMs(row)).toISOString(),
    entry_mcap: row.entry_mcap,
    volatility: entryVolatility(row),
    close_reason: row.close_reason,
  };
}

export function entryRejectReason(row, rules = {}, priorDeploys = []) {
  if (Number(rules.minVolatility) > 0) {
    const reason = volatilityFloorRejectReason(entryVolatility(row), rules.minVolatility);
    if (reason) return reason;
  }
  if (Number(rules.minFeeTvl) > 0) {
    const fee = num(row?.fee_tvl_ratio);
    if (fee == null || fee < Number(rules.minFeeTvl)) {
      return `fee/TVL ${fee ?? "unknown"} below ${rules.minFeeTvl}`;
    }
  }
  if (Number(rules.maxMcap) > 0) {
    const mcap = num(row?.entry_mcap);
    if (mcap == null || mcap > Number(rules.maxMcap)) {
      return `mcap ${mcap ?? "unknown"} above ${rules.maxMcap}`;
    }
  }
  if (rules.reentry?.enabled === true) {
    const block = evaluateReentryGuard({
      baseMint: mintKey(row),
      mcap: row?.entry_mcap,
      volatility: entryVolatility(row),
      now: deployTimeMs(row),
      deploys: priorDeploys,
      settings: rules.reentry,
    });
    if (block) return block;
  }
  return null;
}

function money(n) {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}`;
}

export function formatSummary(label, rows) {
  const s = summarize(rows);
  const win = s.n ? (100 * s.winRate).toFixed(1) : "0.0";
  return [
    label.padEnd(46),
    `n=${String(s.n).padStart(4)}`,
    `win=${win.padStart(5)}%`,
    `total=$${money(s.totalPnl).padStart(8)}`,
    `mean=$${money(s.meanPnl).padStart(7)}`,
    `mean%=${money(s.meanPct).padStart(6)}`,
    `tp/trail=${String(s.tp).padStart(2)}`,
    `sl=${s.sl}`,
  ].join("  ");
}

function loadRows(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = Array.isArray(data) ? data : data.performance;
  if (!Array.isArray(rows)) throw new Error(`${file} has no performance[]`);
  return rows;
}

function deployOrdinals(rows) {
  const ordered = [...rows].map((row, index) => ({ row, index }));
  ordered.sort((a, b) => deployTimeMs(a.row) - deployTimeMs(b.row) || a.index - b.index);
  const counts = new Map();
  return ordered.map(({ row }) => {
    const mint = mintKey(row);
    const next = (counts.get(mint) || 0) + 1;
    counts.set(mint, next);
    return { row, ordinal: next };
  });
}

function printVerification(rows) {
  console.log("## Check against the attached analysis");
  const volKnown = rows.filter((row) => entryVolatility(row) != null && entryVolatility(row) > 0);
  const hi = volKnown.filter((row) => entryVolatility(row) >= 5);
  const lo = volKnown.filter((row) => entryVolatility(row) < 5);
  console.log("Volatility uses the positive top-level value, else signal_snapshot.volatility. A stored 0 is treated as missing.");
  console.log(formatSummary("volatility >= 5", hi));
  console.log(formatSummary("volatility < 5", lo));
  const missingVol = rows.length - volKnown.length;
  if (missingVol) console.log(`volatility missing on ${missingVol} record(s); excluded from the split above`);

  const ordinals = deployOrdinals(rows);
  const early = ordinals.filter((item) => item.ordinal <= 3).map((item) => item.row);
  const late = ordinals.filter((item) => item.ordinal >= 4).map((item) => item.row);
  console.log(formatSummary("1st-3rd deploy into token", early));
  console.log(formatSummary("4th+ deploy into token", late));
  const lateSl = late.filter((row) => reasonGroup(row.close_reason) === "stop loss");
  console.log(`stop losses inside 4th+ deploys: ${lateSl.length} (book stop losses: ${summarize(rows).sl})`);

  for (const fee of [1, 2, 5]) {
    const known = rows.filter((row) => num(row.fee_tvl_ratio) != null);
    console.log(formatSummary(`fee_tvl_ratio >= ${fee}`, known.filter((row) => row.fee_tvl_ratio >= fee)));
    console.log(formatSummary(`fee_tvl_ratio < ${fee}`, known.filter((row) => row.fee_tvl_ratio < fee)));
  }
  console.log(formatSummary("entry mcap > 10M", rows.filter((row) => num(row.entry_mcap) != null && row.entry_mcap > 10_000_000)));
  console.log(formatSummary("entry mcap <= 10M", rows.filter((row) => num(row.entry_mcap) != null && row.entry_mcap <= 10_000_000)));
  const withPath = rows.filter((row) => row.pnl_path?.samples?.length).length;
  console.log(`records with pnl_path samples: ${withPath} of ${rows.length}`);
  console.log("");
}

function printSweep(title, rows, cases, countMode) {
  console.log(`## ${title}`);
  for (const [label, rules] of cases) {
    const { taken } = replayBook(rows, rules, { countMode });
    console.log(formatSummary(label, taken));
  }
  console.log("");
}

function reentry(partial) {
  return {
    enabled: true,
    maxDeploysPerToken: 0,
    mcapDropPct: 0,
    volatilityDropPct: 0,
    lookbackHours: 0,
    lowYieldStreak: 0,
    ...partial,
  };
}

export function buildReport(rows) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    renderReport(rows);
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

function renderReport(rows) {
  const stamps = rows.map((row) => Date.parse(row.recorded_at || "")).filter(Number.isFinite).sort((a, b) => a - b);
  const first = stamps.length ? new Date(stamps[0]).toISOString() : "unknown";
  const last = stamps.length ? new Date(stamps[stamps.length - 1]).toISOString() : "unknown";
  console.log(`# Threshold replay`);
  console.log(`n=${rows.length}  close ${first} → ${last}`);
  console.log("Replay keeps historical closes that pass the rule and drops the rest. It does not invent replacement trades, and it does not re-simulate exits.");
  console.log("Win = pnl_usd > 0 (or pnl_usd == 0 and pnl_pct > 0). tp/trail counts take-profit and trailing closes. Dollars are the recorded dry-run pnl_usd (no gas, slippage, or Jupiter referral).");
  console.log("");
  console.log("## Baseline");
  console.log(formatSummary("all recorded closes", rows));
  const base = summarize(rows);
  const reasonParts = Object.entries(base.byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`);
  console.log(`close groups: ${reasonParts.join(", ")}`);
  console.log("");

  printVerification(rows);

  printSweep("Volatility floor (other rules off)", rows, [
    ["minVolatility off", {}],
    ["minVolatility >= 3", { minVolatility: 3 }],
    ["minVolatility >= 4", { minVolatility: 4 }],
    ["minVolatility >= 5", { minVolatility: 5 }],
    ["minVolatility >= 6", { minVolatility: 6 }],
    ["minVolatility >= 8", { minVolatility: 8 }],
  ], "taken");

  printSweep("fee/TVL floor (existing minFeeActiveTvlRatio; not a new default)", rows, [
    ["fee_tvl >= 0.26", { minFeeTvl: 0.26 }],
    ["fee_tvl >= 1", { minFeeTvl: 1 }],
    ["fee_tvl >= 2", { minFeeTvl: 2 }],
    ["fee_tvl >= 5", { minFeeTvl: 5 }],
  ], "taken");

  printSweep("Max entry mcap (existing maxMcap; not a new default)", rows, [
    ["maxMcap 5M", { maxMcap: 5_000_000 }],
    ["maxMcap 10M", { maxMcap: 10_000_000 }],
  ], "taken");

  printSweep("Re-entry rules, priors = every historical deploy", rows, [
    ["max 2 deploys / token", { reentry: reentry({ maxDeploysPerToken: 2 }) }],
    ["max 3 deploys / token", { reentry: reentry({ maxDeploysPerToken: 3 }) }],
    ["max 4 deploys / token", { reentry: reentry({ maxDeploysPerToken: 4 }) }],
    ["mcap drop >= 30%", { reentry: reentry({ mcapDropPct: 30 }) }],
    ["mcap drop >= 40%", { reentry: reentry({ mcapDropPct: 40 }) }],
    ["mcap drop >= 50%", { reentry: reentry({ mcapDropPct: 50 }) }],
    ["vol drop >= 30%", { reentry: reentry({ volatilityDropPct: 30 }) }],
    ["vol drop >= 40%", { reentry: reentry({ volatilityDropPct: 40 }) }],
    ["vol drop >= 50%", { reentry: reentry({ volatilityDropPct: 50 }) }],
    ["low-yield streak 2", { reentry: reentry({ lowYieldStreak: 2 }) }],
    ["low-yield streak 3", { reentry: reentry({ lowYieldStreak: 3 }) }],
    ["max 3 within 24h", { reentry: reentry({ maxDeploysPerToken: 3, lookbackHours: 24 }) }],
    ["max 3 within 168h", { reentry: reentry({ maxDeploysPerToken: 3, lookbackHours: 168 }) }],
    ["max 3 + mcap40 + volDrop40 / 168h", { reentry: reentry({ maxDeploysPerToken: 3, mcapDropPct: 40, volatilityDropPct: 40, lookbackHours: 168 }) }],
    ["that plus low-yield streak 2", { reentry: reentry({ maxDeploysPerToken: 3, mcapDropPct: 40, volatilityDropPct: 40, lowYieldStreak: 2, lookbackHours: 168 }) }],
  ], "all");

  const guard = reentry({
    maxDeploysPerToken: 3,
    mcapDropPct: 40,
    volatilityDropPct: 40,
    lowYieldStreak: 2,
    lookbackHours: 168,
  });
  const suggested = { minVolatility: 4, reentry: guard };
  const volOnly = { minVolatility: 4 };
  const tighterVol = { minVolatility: 5, reentry: guard };
  const capOnly = { reentry: reentry({ maxDeploysPerToken: 3, lookbackHours: 168 }) };
  const stackNoLookback = { ...suggested, reentry: { ...guard, lookbackHours: 0 } };

  printSweep("Stacks (priors = deploys that stack would have taken). On this book, stacking the vol floor with the re-entry cap made less total PnL than either rule alone.", rows, [
    ["vol>=4 only", volOnly],
    ["vol>=5 only", { minVolatility: 5 }],
    ["max 3 deploys / 168h only", capOnly],
    ["vol>=4 plus full re-entry guard", suggested],
    ["vol>=5 plus full re-entry guard", tighterVol],
    ["vol>=4 plus guard, lookback all history", stackNoLookback],
    ["vol>=4 and fee>=1", { minVolatility: 4, minFeeTvl: 1 }],
    ["vol>=5 and maxMcap 10M", { minVolatility: 5, maxMcap: 10_000_000 }],
  ], "taken");

  console.log("## What this cannot say");
  console.log("- No price path is stored on these records, so take-profit, trailing, and stop-loss levels cannot be replayed. New closes store pnl_path (peak, min, max, samples) for a later exit replay.");
  console.log("- Skipped deploys free a slot, but this book does not show which other pool would have been taken instead.");
  console.log("- Figures are dry-run pnl_usd. Live gas, failed transactions, and the Jupiter referral are not in the file.");
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/backtest-thresholds.js <lessons.json>");
    process.exit(1);
  }
  const rows = loadRows(path.resolve(file));
  renderReport(rows);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
