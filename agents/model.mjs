// A small model client for the OpenAI Responses API (POST {base}/responses) with a cost ledger. The
// base URL, model and key come from the environment, so it can point at any provider that implements
// that endpoint. The key is read from the environment and never logged or stored.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = process.env.PM_MODEL_BASE_URL || 'https://api.openai.com/v1';
const KEY = process.env.PM_MODEL_API_KEY || process.env.OPENAI_API_KEY || '';
const LEDGER = process.env.PM_LEDGER || null;

// Approximate USD per 1M tokens, for the local ledger only (informational, not billing).
const PRICE = {
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-5-mini': { in: 0.25, out: 2.0 },
  'gpt-5.2': { in: 1.25, out: 10.0 },
};

export const usage = { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0, byModel: {} };

function record(model, u) {
  usage.calls += 1;
  usage.input_tokens += u.input_tokens || 0;
  usage.output_tokens += u.output_tokens || 0;
  const p = PRICE[model] || { in: 0, out: 0 };
  const cost = ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out) / 1e6;
  usage.usd += cost;
  const m = (usage.byModel[model] ||= { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 });
  m.calls += 1; m.input_tokens += u.input_tokens || 0; m.output_tokens += u.output_tokens || 0; m.usd += cost;
  if (LEDGER) {
    try {
      mkdirSync(dirname(LEDGER), { recursive: true });
      appendFileSync(LEDGER, JSON.stringify({ t: new Date().toISOString(), model, ...u, usd: cost }) + '\n');
    } catch { /* ledger is best-effort */ }
  }
  return cost;
}

// Ask the model for a JSON object. Returns the parsed object plus the raw usage. Uses the Responses
// API with a plain text instruction that asks for strict JSON, then extracts the first JSON object.
export async function askJson({ model = process.env.PM_MODEL || 'gpt-5-nano', system, user, maxOutputTokens = 4000, effort = 'low' }) {
  if (!KEY) throw new Error('no model API key: set PM_MODEL_API_KEY or OPENAI_API_KEY');
  const body = {
    model,
    input: [
      { role: 'developer', content: system },
      { role: 'user', content: user },
    ],
    max_output_tokens: maxOutputTokens,
    reasoning: { effort },
    text: { format: { type: 'json_object' } },
  };
  let res, json;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${BASE}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
      });
      json = await res.json();
      if (res.ok && json.status === 'completed') break;
      if (attempt >= 4) throw new Error(`model error: ${json?.error?.message || json?.status || res.status}`);
    } catch (e) {
      if (attempt >= 4) throw e;
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  const text = (json.output || []).flatMap((o) => o.content || []).map((c) => c.text || '').join('');
  const cost = record(model, json.usage || {});
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`model did not return JSON: ${text.slice(0, 200)}`);
    parsed = JSON.parse(m[0]);
  }
  return { data: parsed, usage: json.usage || {}, usd: cost, model };
}

export function usageSummary() {
  return {
    calls: usage.calls,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    usd: Number(usage.usd.toFixed(5)),
    byModel: Object.fromEntries(Object.entries(usage.byModel).map(([k, v]) => [k, { ...v, usd: Number(v.usd.toFixed(5)) }])),
  };
}
