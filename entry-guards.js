/**
 * Pure entry gates and close-reason classifiers.
 *
 * No I/O. Screening, deploy safety checks, and the offline replay script
 * all call these so a threshold means the same thing in each place.
 *
 * Defaults are permissive: minVolatility <= 0 and a disabled re-entry guard
 * reject nothing, which keeps existing deploy behaviour until the owner opts in.
 */

export function isLowYieldCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "low yield" || text.startsWith("low yield");
}

/**
 * True when a position is old enough for the low-yield close.
 * A missing age does not qualify — same as the previous `(age ?? 0) >= 60` check.
 * The minute floor comes from config (`minAgeBeforeYieldCheck`, default 60).
 */
export function lowYieldAgeReached(ageMinutes, minAgeBeforeYieldCheck = 60) {
  const minAge = Number(minAgeBeforeYieldCheck);
  const floor = Number.isFinite(minAge) ? minAge : 60;
  const age = Number(ageMinutes);
  if (!Number.isFinite(age)) return false;
  return age >= floor;
}

/**
 * Optional volatility floor. `minVolatility` <= 0 (the default) is off.
 * Returns a reject reason, or null when the pool is allowed.
 */
export function volatilityFloorRejectReason(volatility, minVolatility) {
  const min = Number(minVolatility);
  if (!Number.isFinite(min) || min <= 0) return null;
  if (volatility == null || volatility === "") {
    return `volatility unknown below minVolatility ${min}`;
  }
  const vol = Number(volatility);
  if (!Number.isFinite(vol) || vol < min) {
    return `volatility ${Number.isFinite(vol) ? vol : "unknown"} below minVolatility ${min}`;
  }
  return null;
}

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function deployStamp(deploy) {
  const t = Date.parse(deploy?.deployed_at || deploy?.closed_at || "");
  return Number.isFinite(t) ? t : null;
}

function closeStamp(deploy) {
  const t = Date.parse(deploy?.closed_at || deploy?.recorded_at || deploy?.deployed_at || "");
  return Number.isFinite(t) ? t : null;
}

function readEntryMcap(deploy) {
  return finitePositive(deploy?.entry_mcap ?? deploy?.mcap);
}

function readEntryVolatility(deploy) {
  return finitePositive(deploy?.volatility_at_deploy ?? deploy?.volatility);
}

/**
 * Decide whether a new deploy into a token should be blocked.
 *
 * `settings.enabled` must be true AND at least one threshold must be > 0.
 * Missing mcap or volatility does not block that dimension (the deploy-count
 * and low-yield streak rules still apply). History with no timestamp is kept
 * when lookback is off and ignored when lookback is on.
 *
 * @returns {string|null} block reason, or null to allow
 */
export function evaluateReentryGuard({
  baseMint = null,
  mcap = null,
  volatility = null,
  now = Date.now(),
  deploys = [],
  settings = {},
} = {}) {
  if (settings.enabled !== true) return null;
  if (!baseMint) return null;

  const maxDeploys = Number(settings.maxDeploysPerToken) || 0;
  const mcapDropPct = Number(settings.mcapDropPct) || 0;
  const volatilityDropPct = Number(settings.volatilityDropPct) || 0;
  const lookbackHours = Number(settings.lookbackHours) || 0;
  const lowYieldStreak = Number(settings.lowYieldStreak) || 0;
  if (maxDeploys <= 0 && mcapDropPct <= 0 && volatilityDropPct <= 0 && lowYieldStreak <= 0) {
    return null;
  }

  const nowMs = Number(now);
  const lookbackMs = lookbackHours > 0 ? lookbackHours * 3_600_000 : null;
  const prior = [];
  for (const deploy of deploys) {
    const stamp = deployStamp(deploy);
    if (lookbackMs != null) {
      if (stamp == null) continue;
      if (!Number.isFinite(nowMs) || nowMs - stamp > lookbackMs || stamp > nowMs) continue;
    }
    prior.push(deploy);
  }

  if (maxDeploys > 0 && prior.length >= maxDeploys) {
    return `re-entry blocked: ${prior.length} prior deploy(s) on this token (max ${maxDeploys})`;
  }

  const currentMcap = finitePositive(mcap);
  if (mcapDropPct > 0 && currentMcap != null) {
    let peak = null;
    for (const deploy of prior) {
      const entry = readEntryMcap(deploy);
      if (entry != null && (peak == null || entry > peak)) peak = entry;
    }
    if (peak != null) {
      const drop = ((peak - currentMcap) / peak) * 100;
      if (drop >= mcapDropPct) {
        return `re-entry blocked: mcap dropped ${drop.toFixed(1)}% from prior peak entry (limit ${mcapDropPct}%)`;
      }
    }
  }

  const currentVol = finitePositive(volatility);
  if (volatilityDropPct > 0 && currentVol != null) {
    let peak = null;
    for (const deploy of prior) {
      const entry = readEntryVolatility(deploy);
      if (entry != null && (peak == null || entry > peak)) peak = entry;
    }
    if (peak != null) {
      const drop = ((peak - currentVol) / peak) * 100;
      if (drop >= volatilityDropPct) {
        return `re-entry blocked: volatility dropped ${drop.toFixed(1)}% from prior peak entry (limit ${volatilityDropPct}%)`;
      }
    }
  }

  if (lowYieldStreak > 0) {
    const closed = prior
      .map((deploy) => ({ deploy, closedAt: closeStamp(deploy) }))
      .filter((item) => item.closedAt == null || !Number.isFinite(nowMs) || item.closedAt <= nowMs)
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
    if (closed.length >= lowYieldStreak) {
      const recent = closed.slice(-lowYieldStreak);
      if (recent.every((item) => isLowYieldCloseReason(item.deploy.close_reason))) {
        return `re-entry blocked: last ${lowYieldStreak} close(s) on this token were low yield`;
      }
    }
  }

  return null;
}
