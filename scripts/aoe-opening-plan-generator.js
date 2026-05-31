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

export function amountForPair(pair, env = process.env) {
  if (pair === "BNB/USDT") return env.PRIMARY_BUY_USDT || env.BNB_BUY_USDT || env.AUTO_BUY_AMOUNT_USDT || "2";
  if (pair === "BTC/USDT") return env.BTC_BUY_USDT || "2";
  if (pair === "SOL/USDT") return env.SOL_BUY_USDT || "2";
  if (pair === "ETH/USDT") return env.ETH_BUY_USDT || "2";
  return env.AUTO_BUY_AMOUNT_USDT || "2";
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

export async function estimateDailyVolume(pair, { binanceFapiUrl = "https://fapi.binance.com", fetchFn = fetch, now = new Date() } = {}) {
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
  const previousUtcDayVolume = dailyVolumes[dailyVolumes.length - 2] || 0;
  const elapsedDayRatio = ((now.getUTCHours() * 3600) + (now.getUTCMinutes() * 60) + now.getUTCSeconds()) / 86400;
  const projectedFromToday = currentUtcDayVolume / Math.max(elapsedDayRatio, 0.05);
  const hourlyVolumes = hourly.map(quoteAt).filter((v) => Number.isFinite(v) && v > 0);
  const recent1hAvg = hourlyVolumes.reduce((a, b) => a + b, 0) / Math.max(hourlyVolumes.length, 1);
  const last1hVolume = hourlyVolumes[hourlyVolumes.length - 1] || recent1hAvg || 0;
  const activityBoost = clamp(last1hVolume / Math.max(recent1hAvg, 1), 0.7, 1.3);
  const volumeSpikeRatio = current24hVolume / Math.max(recent7dAvg, 1);
  const todayProjectionRatio = projectedFromToday / Math.max(recent7dAvg, 1);
  const previousDaySpikeRatio = previousUtcDayVolume / Math.max(recent7dAvg, 1);
  const regime = previousDaySpikeRatio >= 2.5 && todayProjectionRatio < 1.8
    ? "post_spike_cooldown"
    : (volumeSpikeRatio >= 2.5 || todayProjectionRatio >= 2.5 ? "spike" : (volumeSpikeRatio >= 1.8 || todayProjectionRatio >= 1.8 ? "transition" : "normal"));
  let predicted;
  if (regime === "spike") {
    predicted = (projectedFromToday * 0.60 + current24hVolume * 0.30 + recent7dAvg * 0.10) * activityBoost;
  } else if (regime === "post_spike_cooldown") {
    predicted = (projectedFromToday * 0.70 + recent7dAvg * 0.25 + current24hVolume * 0.05) * activityBoost;
  } else if (regime === "transition") {
    predicted = (projectedFromToday * 0.45 + current24hVolume * 0.25 + recent7dAvg * 0.30) * activityBoost;
  } else {
    predicted = (recent7dAvg * 0.55 + current24hVolume * 0.20 + projectedFromToday * 0.25) * activityBoost;
  }
  return {
    predicted_volume: predicted,
    recent7d_avg: recent7dAvg,
    current_24h_volume: current24hVolume,
    current_utc_day_volume: currentUtcDayVolume,
    projected_from_today: projectedFromToday,
    activity_boost: activityBoost,
    volume_spike_ratio: volumeSpikeRatio,
    today_projection_ratio: todayProjectionRatio,
    previous_day_spike_ratio: previousDaySpikeRatio,
    regime,
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
  const predicted = prediction.predicted_volume;
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

export function selectOutcome(outcomes, prediction, { maxPrice = 0.45, minConfidence = 60, allowLowConfidence = false } = {}) {
  const eligible = outcomes.filter((outcome) => Number(outcome.price_hmr) <= Number(maxPrice));
  if (!eligible.length) return null;
  const predicted = prediction.predicted_volume;
  const ordered = [...eligible].sort((a, b) => a.lower - b.lower);
  if (prediction.regime === "normal") {
    const containingIndex = ordered.findIndex((outcome) => predicted >= outcome.lower && predicted < outcome.upper);
    const containing = ordered[containingIndex];
    const previous = ordered[containingIndex - 1];
    if (containing && previous) {
      const previousWidth = Math.max(previous.upper - previous.lower, 1);
      const nearLowerEdge = predicted - containing.lower < Math.max(previousWidth * 0.10, containing.lower * 0.03);
      if (nearLowerEdge) {
        const confidence = Math.max(
          Number(minConfidence),
          confidenceFor(previous, { ...prediction, predicted_volume: previous.lower + Math.max(previous.upper - previous.lower, 1) * 0.85 }, Number(maxPrice)),
        );
        return { ...previous, confidence };
      }
    }
  }
  const ranked = eligible.map((outcome) => ({
    outcome,
    distance: distanceToRange(predicted, outcome),
    confidence: confidenceFor(outcome, prediction, Number(maxPrice)),
  })).sort((a, b) => a.distance - b.distance || b.confidence - a.confidence || a.outcome.price_hmr - b.outcome.price_hmr);
  const best = ranked[0];
  if (best.confidence < Number(minConfidence) && !allowLowConfidence) return null;
  return { ...best.outcome, confidence: best.confidence };
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

export async function generateOpeningSnipePlans({ env = process.env, fetchFn = fetch, writeFileFn, logFn = console.log, now = new Date() } = {}) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const pairs = (env.AUTO_BUY_PAIRS || "BNB/USDT,BTC/USDT,SOL/USDT,ETH/USDT").split(",").map((v) => v.trim()).filter(Boolean);
  const eventDay = env.EVENT_DAY || utcEventDay(now);
  const graphqlUrl = env.GRAPHQL_URL || "https://ft.42.space/v1/graphql";
  const binanceFapiUrl = env.BINANCE_FAPI_URL || "https://fapi.binance.com";
  const outputPath = env.OPENING_SNIPE_PLAN_PATH || "runtime-state/opening_snipe_plans.json";
  const minConfidence = Number(env.PLAN_MIN_CONFIDENCE || 60);
  const maxPrice = Number(env.PLAN_MAX_PRICE || env.AUTO_MAX_OUTCOME_PRICE || 0.45);
  const plans = [];
  for (const pair of pairs) {
    try {
      const market = await queryMarket(pair, eventDay, graphqlUrl, fetchFn);
      if (!market) { logFn(`plan skip pair=${pair} reason=market_not_found`); continue; }
      const outcomes = normalizeOutcomes(market.outcomes);
      const prediction = await estimateDailyVolume(pair, { binanceFapiUrl, fetchFn, now });
      const selected = selectOutcome(outcomes, prediction, { maxPrice, minConfidence, allowLowConfidence: truthy(env.PLAN_ALLOW_LOW_CONFIDENCE) });
      if (!selected) { logFn(`plan skip pair=${pair} reason=no_confident_price_eligible_outcome`); continue; }
      plans.push({
        pair,
        event_day: eventDay,
        market_address: market.market_address,
        selected_token_id: selected.token_id,
        outcome_name: selected.outcome_name,
        buy_amount_usdt: amountForPair(pair, env),
        max_price: maxPrice,
        confidence: selected.confidence,
        reason: `predicted quote volume ${Math.round(prediction.predicted_volume)} selected ${selected.outcome_name} at price ${selected.price_hmr}`,
        prediction,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  generateOpeningSnipePlans().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
