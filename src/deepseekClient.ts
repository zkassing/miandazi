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
 * @param {number} [opts.timeoutMs] 可选：单次请求的硬超时。超时抛 statusCode=504
 *   的错误，避免调用方（以及浏览器）无限等待 —— 报告生成走的就是这条路。
 */
export async function deepseekChat({ messages, temperature = 0.7, maxTokens, jsonMode = false, signal, settings, timeoutMs } = {}) {
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

  // 硬超时：把调用方传入的 signal 和我们自己的定时器合并。DeepSeek 的推理
  // 模型偶尔会长时间不返回，没有超时的话前端会一直停在 loading 上。
  let timer = null;
  let timedOut = false;
  let effectiveSignal = signal;
  if (timeoutMs && timeoutMs > 0) {
    const ac = new AbortController();
    timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    effectiveSignal = ac.signal;
  }

  let res;
  let rawText;
  try {
    try {
      res = await fetch(deepseekChatUrl(s.deepseekBaseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.deepseekApiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: effectiveSignal,
      });
    } catch (err) {
      if (timedOut) {
        const e = new Error(`DeepSeek request timed out after ${timeoutMs}ms.`);
        e.statusCode = 504;
        e.timeout = true;
        throw e;
      }
      const e = new Error(`Network error calling DeepSeek: ${err.message}`);
      e.statusCode = 502;
      throw e;
    }

    try {
      rawText = await res.text();
    } catch (err) {
      if (timedOut) {
        const e = new Error(`DeepSeek response timed out after ${timeoutMs}ms.`);
        e.statusCode = 504;
        e.timeout = true;
        throw e;
      }
      throw err;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

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

  const finishReason = parsed.choices?.[0]?.finish_reason || '';
  // 推理模型（deepseek-v4-flash 等）在 max_tokens 被 reasoning_tokens 吃完时，
  // 会返回 finish_reason='length' + content=''。这时必须报错而不是当正常
  // 结果往下传 —— 否则调用方会拿到空字串并在 JSON 解析处神秘失败。
  if (!content.trim() && finishReason === 'length') {
    const used = parsed.usage?.completion_tokens_details?.reasoning_tokens;
    const err = new Error(
      `DeepSeek truncated the response: all ${used ?? maxTokens} output tokens were consumed by reasoning, leaving no content. Raise maxTokens.`,
    );
    err.statusCode = 502;
    err.truncated = true;
    err.upstream = { status: res.status, finishReason, usage: parsed.usage };
    throw err;
  }

  return { content: content.trim(), finishReason, usage: parsed.usage, raw: parsed };
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
