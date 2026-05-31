import { pathToFileURL } from "node:url";

export function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function utcEventDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function symbolForPair(pair) {
  return pair.replace("/", "").toUpperCase();
}

export const pairProfiles = {
  "BNB/USDT": { allowSpikeMode: true, spikeBuyAmountFactor: 0.50 },
  "BTC/USDT": { allowSpikeMode: false, conservativeFactor: 0.80 },
  "SOL/USDT": { allowSpikeMode: false, conservativeFactor: 0.80 },
  "ETH/USDT": { allowSpikeMode: false, conservativeFactor: 0.80 },
};

function profileFor(pair) {
  return pairProfiles[pair] || { allowSpikeMode: false, conservativeFactor: 0.80 };
}

function envNumber(env, key, fallback) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function amountForPair(pair, env = process.env) {
  if (pair === "BNB/USDT") return env.PRIMARY_BUY_USDT || env.BNB_BUY_USDT || env.AUTO_BUY_AMOUNT_USDT || "2";
  if (pair === "BTC/USDT") return env.PRIMARY_BUY_USDT || env.BTC_BUY_USDT || env.AUTO_BUY_AMOUNT_USDT || "2";
  if (pair === "SOL/USDT") return env.PRIMARY_BUY_USDT || env.SOL_BUY_USDT || env.AUTO_BUY_AMOUNT_USDT || "2";
  if (pair === "ETH/USDT") return env.PRIMARY_BUY_USDT || env.ETH_BUY_USDT || env.AUTO_BUY_AMOUNT_USDT || "2";
  return env.AUTO_BUY_AMOUNT_USDT || "2";
}

function formatUsdt(value) {
  const fixed = Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return fixed || "0";
}

function parseMagnitude(raw) {
  const text = String(raw).trim().replace(/^\$/, "").replace(/,/g, "");
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)([KMBT])?$/i);
  if (!match) return null;
  const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return Number(match[1]) * (multipliers[(match[2] || "").toUpperCase()] || 1);
}

export function parseOutcomeRange(outcome) {
  const name = String(outcome?.name ?? outcome?.outcome_name ?? outcome?.title ?? "").trim();
  const token_id = String(outcome?.token_id ?? outcome?.tokenId ?? outcome?.id ?? "");
  const price_hmr = Number(outcome?.price_hmr ?? outcome?.price ?? outcome?.last_price ?? outcome?.probability ?? 0);
  const normalized = name.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  let lower = null;
  let upper = null;
  let m = normalized.match(/^(?:Below|Under|<)\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?\s*[KMBT]?)/i);
  if (m) {
    lower = 0;
    upper = parseMagnitude(m[1].replace(/\s+/g, ""));
  } else if ((m = normalized.match(/^(?:Above|Over|>)\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?\s*[KMBT]?)/i))) {
    lower = parseMagnitude(m[1].replace(/\s+/g, ""));
    upper = Infinity;
  } else if ((m = normalized.match(/^\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?\s*[KMBT]?)\s*-\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?\s*[KMBT]?)/i))) {
    lower = parseMagnitude(m[1].replace(/\s+/g, ""));
    upper = parseMagnitude(m[2].replace(/\s+/g, ""));
  }
  if (lower == null || upper == null || !token_id) return null;
  return { token_id, outcome_name: name, lower, upper, price_hmr };
}

export function normalizeOutcomes(outcomes) {
  const list = typeof outcomes === "string" ? JSON.parse(outcomes) : outcomes;
  if (!Array.isArray(list)) return [];
  return list.map(parseOutcomeRange).filter(Boolean).sort((a, b) => a.lower - b.lower);
}

async function fetchJson(url, fetchFn = fetch) {
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

function average(values) {
  const filtered = values.filter((v) => Number.isFinite(v));
  return filtered.reduce((a, b) => a + b, 0) / Math.max(filtered.length, 1);
}

function volatilityRatios(hourly) {
  const closes = hourly.map((k) => Number(k?.[4] || 0)).filter((v) => Number.isFinite(v) && v > 0);
  if (closes.length < 4) return { realizedVol1hRatio: 1, realizedVol3hRatio: 1 };
  const moves = [];
  for (let i = 1; i < closes.length; i += 1) moves.push(Math.abs(closes[i] / closes[i - 1] - 1));
  const baseline = Math.max(average(moves.slice(0, -3)), 0.000001);
  return {
    realizedVol1hRatio: (moves[moves.length - 1] || baseline) / baseline,
    realizedVol3hRatio: average(moves.slice(-3)) / baseline,
  };
}

export function detectVolumeRegime(data, env = process.env) {
  const recent7dAvg = Math.max(Number(data.recent7dAvg || 0), 1);
  const volume_spike_ratio = Number(data.current24hVolume || 0) / recent7dAvg;
  const today_projection_ratio = Number(data.projectedFromToday || 0) / recent7dAvg;
  const previous_day_spike_ratio = Number(data.previousDayVolume || 0) / recent7dAvg;
  const intraday_momentum_ratio = Number(data.last3hVolume || 0) / Math.max(Number(data.recent3hAvg || 0), 1);
  const realized_vol_1h_ratio = Number(data.realizedVol1hRatio ?? data.realized_vol_1h_ratio ?? 1);
  const realized_vol_3h_ratio = Number(data.realizedVol3hRatio ?? data.realized_vol_3h_ratio ?? 1);
  const normalSpikeRatio = envNumber(env, "REGIME_NORMAL_SPIKE_RATIO", 1.8);
  const spikeRatio = envNumber(env, "REGIME_SPIKE_RATIO", 2.5);
  const intradaySpikeRatio = envNumber(env, "REGIME_INTRADAY_SPIKE_RATIO", 2.0);
  const decayRatio = envNumber(env, "REGIME_POST_SPIKE_DECAY_RATIO", 0.65);
  const momentumRatio = envNumber(env, "REGIME_POST_SPIKE_MOMENTUM_RATIO", 0.75);
  const volConfirmed = realized_vol_1h_ratio >= 1.5 || realized_vol_3h_ratio >= 1.5;
  const reasons = [];
  let regime = "NORMAL";

  const postSpike = previous_day_spike_ratio >= spikeRatio
    && volume_spike_ratio >= normalSpikeRatio
    && (today_projection_ratio < previous_day_spike_ratio * decayRatio || intraday_momentum_ratio < momentumRatio);
  if (postSpike) {
    regime = "POST_SPIKE_COOLDOWN";
    reasons.push("rolling_24h_residue_ignored");
  } else {
    const volumeSpike = volume_spike_ratio >= spikeRatio || today_projection_ratio >= spikeRatio || (intraday_momentum_ratio >= intradaySpikeRatio && today_projection_ratio >= normalSpikeRatio);
    if (volumeSpike && volConfirmed) {
      regime = "SPIKE";
      reasons.push("volatility_confirmed");
    } else if (volumeSpike) {
      regime = "TRANSITION";
      reasons.push("spike_without_volatility_confirmation");
    } else if (volume_spike_ratio >= normalSpikeRatio || today_projection_ratio >= normalSpikeRatio) {
      regime = "TRANSITION";
      reasons.push("volume_transition");
    } else {
      reasons.push("normal_volume");
    }
  }

  if (regime === "SPIKE" && !profileFor(data.pair).allowSpikeMode) {
    regime = "TRANSITION";
    reasons.push("pair_spike_disabled");
  }

  return {
    regime,
    volume_spike_ratio,
    today_projection_ratio,
    previous_day_spike_ratio,
    intraday_momentum_ratio,
    realized_vol_1h_ratio,
    realized_vol_3h_ratio,
    reasons,
  };
}

export function estimateDailyVolumeByRegime(data, env = process.env) {
  const regimeInfo = typeof data.regime === "string" ? { regime: data.regime, reasons: [] } : data.regime;
  const regime = regimeInfo.regime;
  const recent7dAvg = Number(data.recent7dAvg || 0);
  const current24hVolume = Number(data.current24hVolume || 0);
  const projectedFromToday = Number(data.projectedFromToday || 0);
  const elapsedDayRatio = Number(data.elapsedDayRatio || 0);
  const lastHoursMomentumProjected = Number(data.lastHoursMomentumProjected || projectedFromToday || 0);
  const projectedCaps = {
    NORMAL: [0.50, 1.25],
    TRANSITION: [0.60, 1.80],
    POST_SPIKE_COOLDOWN: [0.50, 1.20],
    SPIKE: [0.80, envNumber(env, "SPIKE_PROJECTED_CAP_MULTIPLIER", 6.0)],
  };
  const [projectedFloor, projectedCap] = projectedCaps[regime] || projectedCaps.NORMAL;
  const projectedFromTodayCapped = clamp(projectedFromToday, recent7dAvg * projectedFloor, recent7dAvg * projectedCap);
  const profile = profileFor(data.pair);
  let rawPredicted;
  let factor;
  if (regime === "SPIKE") {
    rawPredicted = recent7dAvg * 0.10 + current24hVolume * 0.20 + projectedFromTodayCapped * 0.45 + lastHoursMomentumProjected * 0.25;
    factor = envNumber(env, "SPIKE_CONSERVATIVE_FACTOR", 0.95);
  } else if (regime === "POST_SPIKE_COOLDOWN") {
    rawPredicted = recent7dAvg * 0.30 + current24hVolume * 0.05 + projectedFromTodayCapped * 0.45 + lastHoursMomentumProjected * 0.20;
    factor = envNumber(env, "POST_SPIKE_CONSERVATIVE_FACTOR", 0.85);
  } else if (regime === "TRANSITION") {
    rawPredicted = recent7dAvg * 0.30 + current24hVolume * 0.15 + projectedFromTodayCapped * 0.35 + lastHoursMomentumProjected * 0.20;
    factor = envNumber(env, "TRANSITION_CONSERVATIVE_FACTOR", 0.90);
  } else {
    rawPredicted = recent7dAvg * 0.40 + current24hVolume * 0.10 + projectedFromTodayCapped * 0.35 + lastHoursMomentumProjected * 0.15;
    factor = Number(profile.conservativeFactor || envNumber(env, "NORMAL_CONSERVATIVE_FACTOR", 0.80));
    if (elapsedDayRatio < 0.35) factor *= 0.90;
  }
  const conservativePredicted = rawPredicted * factor;
  return {
    predicted_volume: conservativePredicted,
    raw_predicted_volume: rawPredicted,
    conservative_predicted_volume: conservativePredicted,
    recent7d_avg: recent7dAvg,
    previous_day_volume: data.previousDayVolume,
    current_24h_volume: current24hVolume,
    current_utc_day_volume: data.currentUtcDayVolume,
    projected_from_today: projectedFromToday,
    projected_from_today_capped: projectedFromTodayCapped,
    last_hours_momentum_projected: lastHoursMomentumProjected,
    regime,
    volume_spike_ratio: regimeInfo.volume_spike_ratio,
    today_projection_ratio: regimeInfo.today_projection_ratio,
    previous_day_spike_ratio: regimeInfo.previous_day_spike_ratio,
    intraday_momentum_ratio: regimeInfo.intraday_momentum_ratio,
    realized_vol_1h_ratio: regimeInfo.realized_vol_1h_ratio,
    realized_vol_3h_ratio: regimeInfo.realized_vol_3h_ratio,
    regime_reasons: regimeInfo.reasons || [],
    amount_factor: regime === "SPIKE" ? Number(profile.spikeBuyAmountFactor || envNumber(env, "SPIKE_BUY_AMOUNT_FACTOR", 0.50)) : 1,
  };
}

export async function estimateDailyVolume(pair, { binanceFapiUrl = "https://fapi.binance.com", fetchFn = fetch, now = new Date(), env = process.env } = {}) {
  const symbol = symbolForPair(pair);
  const [ticker, daily, hourly] = await Promise.all([
    fetchJson(`${binanceFapiUrl}/fapi/v1/ticker/24hr?symbol=${symbol}`, fetchFn),
    fetchJson(`${binanceFapiUrl}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=8`, fetchFn),
    fetchJson(`${binanceFapiUrl}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=24`, fetchFn),
  ]);
  const quoteAt = (k) => Number(k?.[7] || 0);
  const dailyVolumes = daily.map(quoteAt).filter((v) => Number.isFinite(v) && v > 0);
  const recent7 = dailyVolumes.slice(Math.max(0, dailyVolumes.length - 8), -1);
  const recent7dAvg = recent7.reduce((a, b) => a + b, 0) / Math.max(recent7.length, 1);
  const current24hVolume = Number(ticker.quoteVolume || 0);
  const currentUtcDayVolume = dailyVolumes[dailyVolumes.length - 1] || 0;
  const previousDayVolume = dailyVolumes[dailyVolumes.length - 2] || 0;
  const elapsedDayRatio = ((now.getUTCHours() * 3600) + (now.getUTCMinutes() * 60) + now.getUTCSeconds()) / 86400;
  const projectedFromToday = currentUtcDayVolume / Math.max(elapsedDayRatio, 0.05);
  const hourlyVolumes = hourly.map(quoteAt).filter((v) => Number.isFinite(v) && v > 0);
  const recent1hAvg = average(hourlyVolumes);
  const last1hVolume = hourlyVolumes[hourlyVolumes.length - 1] || recent1hAvg || 0;
  const last3hVolume = hourlyVolumes.slice(-3).reduce((a, b) => a + b, 0);
  const recent3hAvg = Math.max(average(hourlyVolumes.slice(0, -3)) * 3, 1);
  const lastHoursMomentumProjected = last3hVolume / Math.max(3 / 24, 0.05);
  const vols = volatilityRatios(hourly);
  const regime = detectVolumeRegime({ pair, recent7dAvg, previousDayVolume, current24hVolume, currentUtcDayVolume, projectedFromToday, last1hVolume, recent1hAvg, last3hVolume, recent3hAvg, elapsedDayRatio, ...vols }, env);
  return {
    ...estimateDailyVolumeByRegime({ pair, recent7dAvg, previousDayVolume, current24hVolume, currentUtcDayVolume, projectedFromToday, lastHoursMomentumProjected, elapsedDayRatio, regime }, env),
    last_1h_volume: last1hVolume,
    recent_1h_avg: recent1hAvg,
    last_3h_volume: last3hVolume,
    recent_3h_avg: recent3hAvg,
    data_complete: recent7.length >= 7 && hourlyVolumes.length >= 24 && current24hVolume > 0,
  };
}

function distanceToRange(predicted, outcome) {
  if (predicted >= outcome.lower && predicted < outcome.upper) return 0;
  if (predicted < outcome.lower) return outcome.lower - predicted;
  return predicted - outcome.upper;
}

function centerScore(predicted, outcome) {
  if (!Number.isFinite(outcome.upper)) return predicted >= outcome.lower ? 15 : 0;
  const width = Math.max(outcome.upper - outcome.lower, 1);
  const center = outcome.lower + width / 2;
  return clamp(1 - Math.abs(predicted - center) / (width / 2), 0, 1) * 25;
}

function confidenceFor(outcome, prediction, maxPrice) {
  const predicted = prediction.conservative_predicted_volume ?? prediction.predicted_volume;
  const inside = predicted >= outcome.lower && predicted < outcome.upper;
  let confidence = inside ? 50 : 25;
  confidence += centerScore(predicted, outcome);
  confidence += clamp((maxPrice - outcome.price_hmr) / Math.max(maxPrice, 0.01), 0, 1) * 15;
  if (prediction.data_complete) confidence += 10;
  if (inside && Number.isFinite(outcome.upper)) {
    const width = Math.max(outcome.upper - outcome.lower, 1);
    const edgeDistance = Math.min(predicted - outcome.lower, outcome.upper - predicted) / width;
    if (edgeDistance < 0.05) confidence -= 25;
    else if (edgeDistance < 0.15) confidence -= 10;
  }
  return Math.round(clamp(confidence, 0, 100));
}

function outcomeIntervals(outcomes) {
  return outcomes.map((o, index) => ({ index, token_id: o.token_id, outcome_name: o.outcome_name, lower: o.lower, upper: o.upper, price_hmr: o.price_hmr }));
}

function attachSelection(outcome, meta) {
  return { ...outcome, ...meta };
}

export function selectOutcome(outcomes, prediction, { pair = "", maxPrice = 0.45, minConfidence = 65, allowLowConfidence = false, maxOpeningBucketIndex = null, env = process.env } = {}) {
  const orderedAll = [...outcomes].sort((a, b) => a.lower - b.lower);
  const allIntervals = outcomeIntervals(orderedAll);
  const priced = orderedAll.filter((outcome) => Number(outcome.price_hmr) <= Number(maxPrice));
  if (!priced.length) return null;
  const regime = prediction.regime || "NORMAL";
  const predicted = prediction.conservative_predicted_volume ?? prediction.predicted_volume;
  const downgrade_reasons = [...(prediction.regime_reasons || [])];
  const highest = orderedAll[orderedAll.length - 1];
  const originalIndex = Math.max(0, orderedAll.findIndex((outcome) => predicted >= outcome.lower && predicted < outcome.upper));
  let selected = null;

  if (regime === "SPIKE") {
    if (highest && predicted >= highest.lower * 1.05) selected = highest;
    if (!selected) {
      const containing = orderedAll.find((outcome) => predicted >= outcome.lower && predicted < outcome.upper);
      selected = containing || orderedAll.find((outcome) => predicted < outcome.lower) || highest;
      const idx = orderedAll.indexOf(selected);
      if (idx >= 0 && idx < orderedAll.length - 1 && predicted >= selected.upper) selected = orderedAll[idx + 1];
    }
    if (Number(selected.price_hmr) > Number(maxPrice)) {
      downgrade_reasons.push("spike_price_too_high");
      selected = priced.slice().reverse().find((candidate) => candidate.lower <= selected.lower) || priced[0];
    }
  } else {
    const eligible = priced.filter((outcome) => {
      if (maxOpeningBucketIndex == null || regime === "SPIKE") return true;
      const limit = regime === "TRANSITION" ? Number(maxOpeningBucketIndex) + 1 : Number(maxOpeningBucketIndex);
      return orderedAll.indexOf(outcome) <= limit;
    });
    const containingIndex = orderedAll.findIndex((outcome) => predicted >= outcome.lower && predicted < outcome.upper);
    selected = orderedAll[containingIndex] || orderedAll.find((outcome) => predicted < outcome.lower) || highest;
    if (regime === "NORMAL" || regime === "POST_SPIKE_COOLDOWN" || regime === "TRANSITION") {
      const idx = orderedAll.indexOf(selected);
      const previous = orderedAll[idx - 1];
      if (previous) {
        const width = Number.isFinite(selected.upper) ? Math.max(selected.upper - selected.lower, 1) : Math.max(previous.upper - previous.lower, 1);
        const inLowerHalf = predicted < selected.lower + width * (regime === "TRANSITION" ? 0.35 : 0.50);
        if (inLowerHalf) {
          downgrade_reasons.push(regime === "TRANSITION" ? "transition_lower_zone_downgrade" : "normal_lower_half_downgrade");
          selected = previous;
        }
        const nearUpper = Number.isFinite(selected.upper) && selected.upper - predicted < width * 0.05;
        if (nearUpper) downgrade_reasons.push("upper_edge_guard");
      }
    }
    if (!eligible.includes(selected)) {
      selected = eligible.slice().reverse().find((candidate) => candidate.lower <= selected.lower) || eligible[0];
      downgrade_reasons.push("max_opening_bucket_index_cap");
    }
  }

  if (!selected) return null;
  if (!truthy(env.ALLOW_UPPER_BOUNDARY_BUY) && regime !== "SPIKE" && Number.isFinite(selected.upper)) {
    const width = Math.max(selected.upper - selected.lower, 1);
    const positionInRange = (predicted - selected.lower) / width;
    const upperBoundaryLimit = regime === "TRANSITION" ? 0.85 : 0.75;
    if (positionInRange > upperBoundaryLimit) {
      prediction.skipReason = "near_upper_boundary_skip";
      prediction.skip_reason = "near_upper_boundary_skip";
      return null;
    }
  }
  const confidence = confidenceFor(selected, prediction, Number(maxPrice));
  if (confidence < Number(minConfidence) && !allowLowConfidence) {
    prediction.skipReason = "low_confidence";
    prediction.skip_reason = "low_confidence";
    return null;
  }
  const selectedIndex = orderedAll.indexOf(selected);
  return attachSelection(selected, {
    confidence,
    selected_index: selectedIndex,
    original_selected_index: originalIndex,
    selected_range: { lower: selected.lower, upper: selected.upper, outcome_name: selected.outcome_name },
    all_outcome_intervals: allIntervals,
    downgrade_reasons,
    amount_factor: regime === "SPIKE" ? envNumber(env, "SPIKE_BUY_AMOUNT_FACTOR", prediction.amount_factor ?? 0.50) : 1,
  });
}

const MARKET_QUERY = `
query OpeningPlans($pattern: String!) {
  home_market_list(where: { title: { _ilike: $pattern } }, limit: 20) {
    title
    status
    market_address
    outcomes
  }
}`;

function ordinal(day) {
  if (day > 3 && day < 21) return `${day}th`;
  const last = day % 10;
  if (last === 1) return `${day}st`;
  if (last === 2) return `${day}nd`;
  if (last === 3) return `${day}rd`;
  return `${day}th`;
}

function monthName(date) {
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date);
}

async function queryMarket(pair, eventDay, graphqlUrl, fetchFn) {
  const d = new Date(`${eventDay}T00:00:00Z`);
  const pattern = `%${pair} Futures Daily Volume, ${monthName(d)} ${ordinal(d.getUTCDate())}%`;
  const response = await fetchFn(graphqlUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: MARKET_QUERY, variables: { pattern } }) });
  if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  const markets = json?.data?.home_market_list || [];
  return markets.filter((m) => m.market_address).sort((a, b) => (b.status === "live") - (a.status === "live"))[0] || null;
}

function buildReason(pair, prediction, selected) {
  if (prediction.regime === "SPIKE") return `SPIKE regime: ${pair} current/projected volume is elevated with volatility confirmation; selecting high bucket with reduced size ${selected.outcome_name}`;
  if (prediction.regime === "POST_SPIKE_COOLDOWN") return `POST_SPIKE_COOLDOWN regime: rolling_24h_residue_ignored; selected ${selected.outcome_name} from conservative intraday volume`;
  if (prediction.regime === "TRANSITION") return `TRANSITION regime: light conservative selection ${selected.outcome_name}`;
  return `NORMAL regime: conservative quote volume ${Math.round(prediction.conservative_predicted_volume)} selected ${selected.outcome_name} at price ${selected.price_hmr}`;
}

export async function generateOpeningSnipePlans({ env = process.env, fetchFn = fetch, writeFileFn, logFn = console.log, now = new Date() } = {}) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const pairs = (env.AUTO_BUY_PAIRS || "BNB/USDT,BTC/USDT,SOL/USDT,ETH/USDT").split(",").map((v) => v.trim()).filter(Boolean);
  const eventDay = env.EVENT_DAY || utcEventDay(now);
  const graphqlUrl = env.GRAPHQL_URL || "https://ft.42.space/v1/graphql";
  const binanceFapiUrl = env.BINANCE_FAPI_URL || "https://fapi.binance.com";
  const outputPath = env.OPENING_SNIPE_PLAN_PATH || "runtime-state/opening_snipe_plans.json";
  const minConfidence = Number(env.PLAN_MIN_CONFIDENCE || 65);
  const maxPrice = Number(env.PLAN_MAX_PRICE || env.AUTO_MAX_OUTCOME_PRICE || 0.45);
  const maxOpeningBucketIndex = env.MAX_OPENING_BUCKET_INDEX == null ? null : Number(env.MAX_OPENING_BUCKET_INDEX);
  const minBuyUsdt = envNumber(env, "MIN_BUY_USDT", 1);
  const plans = [];
  for (const pair of pairs) {
    try {
      const market = await queryMarket(pair, eventDay, graphqlUrl, fetchFn);
      if (!market) { logFn(`plan skip pair=${pair} reason=market_not_found`); continue; }
      const outcomes = normalizeOutcomes(market.outcomes);
      const prediction = await estimateDailyVolume(pair, { binanceFapiUrl, fetchFn, now, env });
      const baseAmount = Number(amountForPair(pair, env));
      const selected = selectOutcome(outcomes, prediction, { pair, maxPrice, minConfidence, allowLowConfidence: truthy(env.PLAN_ALLOW_LOW_CONFIDENCE), maxOpeningBucketIndex, env });
      if (!selected) { logFn(`plan skip pair=${pair} reason=${prediction.skipReason || prediction.skip_reason || "no_confident_price_eligible_outcome"}`); continue; }
      const amountFactor = selected.amount_factor ?? prediction.amount_factor ?? 1;
      const buyAmount = Math.max(minBuyUsdt, baseAmount * amountFactor);
      plans.push({
        pair,
        event_day: eventDay,
        market_address: market.market_address,
        selected_token_id: selected.token_id,
        outcome_name: selected.outcome_name,
        buy_amount_usdt: formatUsdt(buyAmount),
        max_price: maxPrice,
        confidence: selected.confidence,
        reason: buildReason(pair, prediction, selected),
        prediction: {
          ...prediction,
          selected_index: selected.selected_index,
          original_selected_index: selected.original_selected_index,
          selected_range: selected.selected_range,
          all_outcome_intervals: selected.all_outcome_intervals,
          downgrade_reasons: selected.downgrade_reasons,
          amount_factor: amountFactor,
        },
      });
    } catch (error) {
      logFn(`plan skip pair=${pair} error=${error.message}`);
    }
  }
  const payload = { generated_at: now.toISOString(), event_day: eventDay, plans };
  if (truthy(env.PLAN_DRY_RUN)) {
    logFn(JSON.stringify(payload, null, 2));
  } else {
    if (writeFileFn) writeFileFn(outputPath, JSON.stringify(payload, null, 2));
    else {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
    }
    logFn(`wrote opening plans path=${outputPath} count=${plans.length}`);
  }
  return payload;
}

async function main() {
  await generateOpeningSnipePlans();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
