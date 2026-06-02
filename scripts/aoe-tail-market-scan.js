#!/usr/bin/env node

import { estimateDailyVolume, normalizeOutcomes as normalizeVolumeOutcomes } from "./aoe-opening-plan-generator.js";

const GRAPHQL_URL = process.env.GRAPHQL_URL || "https://ft.42.space/v1/graphql";
const WINDOW_HOURS = Number(process.env.TAIL_SCAN_HOURS || 5);
const MIN_PROBABILITY = Number(process.env.TAIL_SCAN_MIN_PROBABILITY || 0.8);
const PAGE_SIZE = Number(process.env.TAIL_SCAN_PAGE_SIZE || 100);
const MAX_PAGES = Number(process.env.TAIL_SCAN_MAX_PAGES || 20);

const MARKET_QUERY = `
query TailMarkets($now: Int!, $end: Int!, $limit: Int!, $offset: Int!) {
  home_market_list(
    where: {
      status: { _eq: "live" }
      current_end_timestamp: { _gte: $now, _lte: $end }
      is_blacklisted: { _eq: false }
    }
    order_by: { current_end_timestamp: asc }
    limit: $limit
    offset: $offset
  ) {
    title
    status
    market_address
    current_end_timestamp
    current_end_timestamp_tz
    market_cap_hmr
    total_volume_hmr
    traders
    outcomes
  }
}`;

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatHmr(value) {
  const n = asNumber(value);
  if (n >= 1000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  if (n >= 10) return n.toFixed(2);
  return n.toFixed(3);
}

function formatUsd(value) {
  const n = Number(value || 0);
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toFixed(0)}`;
}

function formatAddress(address) {
  if (!address) return "-";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function beijingTimeFromUnix(seconds) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(seconds * 1000));
}

function hoursLeft(endTs, nowTs) {
  return Math.max(0, (endTs - nowTs) / 3600);
}

function normalizeOutcomes(outcomes) {
  if (Array.isArray(outcomes)) return outcomes;
  if (typeof outcomes === "string") {
    try { return JSON.parse(outcomes); } catch { return []; }
  }
  return [];
}

function outcomeProbability(outcome, sumOutcomeCap) {
  if (sumOutcomeCap <= 0) return 0;
  return asNumber(outcome.market_cap_hmr) / sumOutcomeCap;
}

function topOutcome(market) {
  const outcomes = normalizeOutcomes(market.outcomes);
  const sumOutcomeCap = outcomes.reduce((sum, outcome) => sum + asNumber(outcome.market_cap_hmr), 0);
  const ranked = outcomes
    .map((outcome) => ({
      tokenId: outcome.token_id,
      name: outcome.name || outcome.symbol || String(outcome.token_id ?? "-"),
      marketCap: asNumber(outcome.market_cap_hmr),
      price: asNumber(outcome.price_hmr),
      payout: asNumber(outcome.payout_hmr),
      probability: outcomeProbability(outcome, sumOutcomeCap),
    }))
    .sort((a, b) => b.probability - a.probability);
  return ranked[0] || null;
}

function pairFromTitle(title) {
  const match = String(title || "").match(/\b(BNB|BTC|ETH|SOL)\/USDT\s+Futures\s+Daily\s+Volume/i);
  return match ? `${match[1].toUpperCase()}/USDT` : null;
}

function confidenceFromActualVolume(outcome, actualVolume, hoursRemaining) {
  if (!outcome || !Number.isFinite(actualVolume)) return 0;
  if (actualVolume < outcome.lower) return 0;
  if (!Number.isFinite(outcome.upper)) return Math.min(0.99, Math.max(0.90, 1 - hoursRemaining * 0.02));
  if (actualVolume >= outcome.upper) return 0;
  const width = Math.max(outcome.upper - outcome.lower, 1);
  const roomRatio = (outcome.upper - actualVolume) / width;
  return Math.min(0.95, Math.max(0.55, 0.95 - (1 - roomRatio) * 0.35 - hoursRemaining * 0.03));
}

async function attachBinanceComparison(row, now) {
  const pair = pairFromTitle(row.market.title);
  if (!pair) return { ...row, pair: null, comparison: null };
  const outcomes = normalizeVolumeOutcomes(row.market.outcomes);
  if (!outcomes.length) return { ...row, pair, comparison: null };
  const prediction = await estimateDailyVolume(pair, { now: new Date(now * 1000) });
  const actualVolume = Number(prediction.current_utc_day_volume || 0);
  const matched = outcomes.find((outcome) => actualVolume >= outcome.lower && actualVolume < outcome.upper) || null;
  const hLeft = hoursLeft(row.market.current_end_timestamp, now);
  return {
    ...row,
    pair,
    comparison: {
      actualVolume,
      rolling24hVolume: Number(prediction.current_24h_volume || 0),
      matched,
      probability: confidenceFromActualVolume(matched, actualVolume, hLeft),
      regime: prediction.regime,
      dataComplete: prediction.data_complete,
    },
  };
}

async function fetchPage(now, end, offset) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: MARKET_QUERY, variables: { now, end, limit: PAGE_SIZE, offset } }),
  });
  if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors.map((error) => error.message).join("; "));
  return json?.data?.home_market_list || [];
}

async function fetchAllMarkets(now, end) {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await fetchPage(now, end, page * PAGE_SIZE);
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

async function buildReport(markets, now, end) {
  const analyzed = await Promise.all(markets.map((market) => attachBinanceComparison({ market, top: topOutcome(market) }, now)));
  const candidates = analyzed
    .filter((row) => row.comparison?.matched && row.comparison.probability >= MIN_PROBABILITY)
    .sort((a, b) => a.market.current_end_timestamp - b.market.current_end_timestamp || b.comparison.probability - a.comparison.probability);

  const lines = [];
  lines.push(`42 扫尾盘报告`);
  lines.push(`窗口：未来 ${WINDOW_HOURS} 小时内结束`);
  lines.push(`扫描时间：${beijingTimeFromUnix(now)} 北京时间`);
  lines.push(`截止时间：${beijingTimeFromUnix(end)} 北京时间`);
  lines.push(`筛选：币安真实日成交量命中 outcome，尾盘胜率 >= ${formatPct(MIN_PROBABILITY)}`);
  lines.push(`市场数：${markets.length}；命中：${candidates.length}`);
  lines.push("");

  if (!candidates.length) {
    lines.push(`当前没有命中 >= ${formatPct(MIN_PROBABILITY)} 的币安日成交量尾盘市场。`);
    return lines.join("\n");
  }

  for (const { market, top, pair, comparison } of candidates) {
    const matched = comparison.matched;
    lines.push(`🧲 ${market.title}`);
    lines.push(`- 结束：${beijingTimeFromUnix(market.current_end_timestamp)} 北京时间（剩 ${hoursLeft(market.current_end_timestamp, now).toFixed(2)}h）`);
    lines.push(`- 币安对比：${pair} UTC日成交量 ${formatUsd(comparison.actualVolume)}；滚动24h ${formatUsd(comparison.rolling24hVolume)}`);
    lines.push(`- 命中区间：${matched.outcome_name}（token ${matched.token_id}）；尾盘胜率：${formatPct(comparison.probability)}`);
    lines.push(`- 42资金热度：${formatPct(top.probability)} → ${top.name}（token ${top.tokenId}）`);
    lines.push(`- 市场资金：${formatHmr(market.market_cap_hmr)} HMR；成交量：${formatHmr(market.total_volume_hmr)} HMR；交易者：${market.traders ?? 0}`);
    lines.push(`- 地址：${market.market_address} (${formatAddress(market.market_address)})`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export { buildReport, fetchAllMarkets, topOutcome, outcomeProbability, pairFromTitle, attachBinanceComparison };

if (import.meta.url === `file://${process.argv[1]}`) {
  const now = Math.floor(Date.now() / 1000);
  const end = now + Math.floor(WINDOW_HOURS * 3600);
  fetchAllMarkets(now, end)
    .then((markets) => buildReport(markets, now, end))
    .then((report) => console.log(report))
    .catch((error) => {
      console.error(`42 tail scan failed: ${error.message}`);
      process.exitCode = 1;
    });
}
