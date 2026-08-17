// deepseekClient.js — minimal DeepSeek chat client.
//
// We use the OpenAI-compatible chat completions endpoint at
//   POST {baseUrl}/chat/completions
//   Authorization: Bearer <DEEPSEEK_API_KEY>
//
// The deepseek-v4-flash model is good at structured JSON output when
// instructed. We rely on that for the per-turn question and the final
// interview report.

import { getEffectiveSettings } from './modelSettings.ts';

/**
 * 把用户填的 DeepSeek Base URL 归一化成 chat/completions 端点。
 * 兼容「https://api.deepseek.com/v1」和直接粘完整端点两种写法。
 */
function deepseekChatUrl(base) {
  const b = String(base || '').replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return `${b}/chat/completions`;
}

/**
 * Low-level chat call. Returns { content, raw }.
 * Throws on network / HTTP errors.
 * @param {object} [opts.settings] 可选：用传入的候选配置而非当前配置（用于保存前测试）。
 */
export async function deepseekChat({ messages, temperature = 0.7, maxTokens, jsonMode = false, signal, settings } = {}) {
  const s = settings || getEffectiveSettings();
  if (!s.deepseekApiKey) {
    const e = new Error('DEEPSEEK_API_KEY is not configured. Set it in the ⚙️ 模型配置 or .env.');
    e.statusCode = 500;
    throw e;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    const e = new Error('deepseekChat: messages must be a non-empty array');
    e.statusCode = 400;
    throw e;
  }

  const body = {
    model: s.deepseekModel,
    messages,
    temperature,
    stream: false,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (jsonMode) body.response_format = { type: 'json_object' };

  let res;
  try {
    res = await fetch(deepseekChatUrl(s.deepseekBaseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${s.deepseekApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const e = new Error(`Network error calling DeepSeek: ${err.message}`);
    e.statusCode = 502;
    throw e;
  }

  const rawText = await res.text();
  if (!res.ok) {
    let detail = rawText.slice(0, 800);
    try {
      const j = JSON.parse(rawText);
      detail = j.error?.message || j.message || j.detail || detail;
    } catch { /* keep text */ }
    const err = new Error(`DeepSeek ${res.status}: ${detail}`);
    err.statusCode = res.status;
    err.upstream = { status: res.status, body: rawText.slice(0, 2000) };
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const err = new Error(`Invalid JSON from DeepSeek: ${rawText.slice(0, 200)}`);
    err.statusCode = 502;
    throw err;
  }

  const content = parsed.choices?.[0]?.message?.content ?? '';
  if (typeof content !== 'string') {
    const err = new Error('DeepSeek returned no content.');
    err.statusCode = 502;
    throw err;
  }

  return { content: content.trim(), raw: parsed };
}

/**
 * Strip a ```json ... ``` fence if present, and parse.
 * Falls back to extracting the first {...} block.
 */
export function parseJsonLoose(text) {
  if (!text) return null;
  let s = String(text).trim();

  // ```json ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // First { ... last }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }

  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * 连接测试：用当前（或传入的候选）配置发一次极小的 chat 请求，验证
 * key / Base URL / 模型是否可用。返回结构化结果，不抛错。
 */
export async function testDeepseekConnection(settingsOverride) {
  const s = settingsOverride || getEffectiveSettings();
  if (!s.deepseekApiKey) {
    return { ok: false, message: '未配置 DeepSeek API Key', detail: '请先填写 API Key（可在 ⚙️ 模型配置 或 .env 中设置）。' };
  }
  const t0 = Date.now();
  try {
    await deepseekChat({
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
      maxTokens: 1,
      settings: s,
    });
    return { ok: true, message: 'DeepSeek 连接正常（Key 有效）', latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      message: `DeepSeek 连接失败：${err.message}`,
      detail: (err.upstream && err.upstream.body) ? String(err.upstream.body).slice(0, 300) : '',
      latencyMs: Date.now() - t0,
    };
  }
}
