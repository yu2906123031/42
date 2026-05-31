import fs from "node:fs";

function avg(values) {
  const filtered = values.filter((v) => Number.isFinite(v));
  return filtered.length ? filtered.reduce((a, b) => a + b, 0) / filtered.length : null;
}

function pct(n, d) {
  return d ? n / d : null;
}

function addMetric(bucket, row) {
  bucket.count += 1;
  const selected = Number(row.selected_index ?? row.prediction?.selected_index);
  const answer = Number(row.answer_index ?? row.actual_index ?? row.resolved_index);
  const predicted = Number(row.prediction?.conservative_predicted_volume ?? row.predicted_volume);
  const actual = Number(row.actual_volume ?? row.answer_volume ?? row.resolved_volume);
  if (Number.isFinite(selected) && Number.isFinite(answer)) {
    bucket.selected_minus_answer.push(selected - answer);
    if (selected === answer) bucket.hits += 1;
  }
  if (Number.isFinite(predicted) && Number.isFinite(actual) && actual > 0) {
    bucket.overestimate.push((predicted - actual) / actual);
  }
}

function finalize(bucket) {
  return {
    count: bucket.count,
    hit_rate: pct(bucket.hits, bucket.selected_minus_answer.length),
    overestimate_avg: avg(bucket.overestimate),
    selected_minus_answer_avg: avg(bucket.selected_minus_answer),
  };
}

function emptyBucket() {
  return { count: 0, hits: 0, overestimate: [], selected_minus_answer: [] };
}

function loadRows(path) {
  if (!fs.existsSync(path)) return [];
  const text = fs.readFileSync(path, "utf8").trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text);
  const obj = JSON.parse(text);
  if (Array.isArray(obj.rows)) return obj.rows;
  if (Array.isArray(obj.plans)) return obj.plans;
  return [];
}

export function summarizeBacktest(rows) {
  const byRegime = new Map();
  const byPairRegime = new Map();
  for (const row of rows) {
    const regime = row.regime || row.prediction?.regime || "UNKNOWN";
    const pair = row.pair || "UNKNOWN";
    if (!byRegime.has(regime)) byRegime.set(regime, emptyBucket());
    if (!byPairRegime.has(`${pair}:${regime}`)) byPairRegime.set(`${pair}:${regime}`, emptyBucket());
    addMetric(byRegime.get(regime), row);
    addMetric(byPairRegime.get(`${pair}:${regime}`), row);
  }
  const hit_rate_by_regime = {};
  const overestimate_by_regime = {};
  const selected_minus_answer_avg_by_regime = {};
  for (const [regime, bucket] of byRegime) {
    const final = finalize(bucket);
    hit_rate_by_regime[regime] = final.hit_rate;
    overestimate_by_regime[regime] = final.overestimate_avg;
    selected_minus_answer_avg_by_regime[regime] = final.selected_minus_answer_avg;
  }
  const by_pair_regime = {};
  for (const [key, bucket] of byPairRegime) by_pair_regime[key] = finalize(bucket);
  return {
    rows: rows.length,
    hit_rate_by_regime,
    overestimate_by_regime,
    selected_minus_answer_avg_by_regime,
    by_pair_regime,
  };
}

function main() {
  const input = process.env.BACKTEST_INPUT || "runtime-state/aoe_plan_backtest.json";
  const summary = summarizeBacktest(loadRows(input));
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
