// mimoClient.js — call MiMo-V2.5-ASR (STT) and MiMo-V2.5-TTS via the
// OpenAI-compatible chat completions multimodal endpoint.
//
// STT protocol (confirmed against the live API):
//   POST {baseUrl}/v1/chat/completions
//   Body: { "model": "mimo-v2.5-asr",
//           "messages": [{ "role": "user", "content":
//             [{ "type": "input_audio",
//                "input_audio": { "data": "<base64>", "format": "wav"|"mp3" } }] }] }
//
// TTS protocol (assumed OpenAI-compatible; some MiMo deployments expose TTS
// as a multimodal chat-completions call with a system prompt asking for
// audio output, or as a dedicated /audio/speech endpoint. We try the chat
// completions multimodal form first because that's the same surface the
// docs document for the multimodal family; if your MiMo deployment exposes
// a dedicated TTS endpoint, override `ttsUrl` / `ttsRequest` in config.js.)
//
//   POST {baseUrl}/v1/chat/completions
//   Body: { "model": "mimo-v2.5-tts",
//           "modalities": ["audio", "text"],
//           "audio": { "voice": "alloy", "format": "wav" },
//           "messages": [{ "role": "user", "content": "你好" }] }
//   Response: { "choices": [{ "message": {
//     "audio": { "data": "<base64 wav/mp3>" },
//     "content": "" } }] }

import { Buffer } from 'node:buffer';

import { getEffectiveSettings } from './modelSettings.ts';

/**
 * 把用户填的 Base URL 归一化成 chat/completions 端点。
 * 兼容两种写法：直接给完整端点，或给到 /v1 这一级。
 */
function mimoChatUrl(base) {
  const b = String(base || '').replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(b) ? b : `${b}/chat/completions`;
}

/**
 * Best-effort format detection from filename + the first few bytes of the
 * buffer. Returns 'mp3', 'wav', or null. We only support mp3 for STT right
 * now; the detection helpers are kept so the API stays self-describing.
 */
export function detectAudioFormat(buffer, filename) {
  if (buffer.length >= 4) {
    // RIFF....WAVE  =>  "RIFF" + 4 bytes + "WAVE"
    if (
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45
    ) {
      return 'wav';
    }
    // MP3 sync: either 0xFF 0xFB / 0xFF 0xFA / 0xFF 0xF3 / 0xFF 0xF2
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
      return 'mp3';
    }
    // "ID3" tag (MP3 with ID3 header)
    if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
      return 'mp3';
    }
  }
  if (filename) {
    const ext = filename.toLowerCase().split('.').pop();
    if (ext === 'mp3') return 'mp3';
    if (ext === 'wav') return 'wav';
  }
  return null;
}

/**
 * Encode the buffer as a base64 string + a format tag the upstream STT
 * accepts. Both wav and mp3 are supported (mp3 for the original upload
 * path; wav for browser recordings that we transcode to PCM on the client).
 */
export function prepareAudioPayload(buffer, filename) {
  if (!buffer || buffer.length === 0) {
    const err = new Error('empty audio buffer');
    err.statusCode = 400;
    throw err;
  }
  const format = detectAudioFormat(buffer, filename);
  if (format !== 'mp3' && format !== 'wav') {
    const err = new Error(
      `Only mp3 and wav are supported (got: ${format || 'unknown'}; filename: ${filename || 'n/a'}). ` +
        `Re-encode your audio to mp3 or wav and retry.`,
    );
    err.statusCode = 415;
    throw err;
  }
  return {
    audioBase64: Buffer.from(buffer).toString('base64'),
    format,
  };
}

/**
 * Call the MiMo ASR chat completions endpoint with base64-encoded audio.
 * Returns the transcribed text (string).
 */
export async function transcribeWithBase64({ audioBase64, format = 'mp3', language = '', temperature, signal }) {
  const s = getEffectiveSettings();
  if (!s.mimoApiKey) {
    const err = new Error('MIMO_API_KEY is not configured. Set it in the ⚙️ 模型配置 or .env.');
    err.statusCode = 500;
    throw err;
  }
  if (!audioBase64) {
    const err = new Error('Empty audio data.');
    err.statusCode = 400;
    throw err;
  }

  const messages = [];
  if (language) {
    // Use a system prompt to bias toward a language. The model doesn't expose
    // a Whisper-style `language` field, but a short system prompt is effective.
    const map = {
      zh: '你是一个专业的语音转写助手。请把音频逐字转写成简体中文，不要翻译，不要添加标点之外的解释。',
      en: 'You are a professional speech-to-text engine. Transcribe the audio verbatim in English, no translation, no extra commentary.',
    };
    if (map[language]) {
      messages.push({ role: 'system', content: map[language] });
    }
  } else if (s.mimoSystemPrompt) {
    messages.push({ role: 'system', content: s.mimoSystemPrompt });
  }

  messages.push({
    role: 'user',
    content: [
      {
        type: 'input_audio',
        input_audio: { data: audioBase64, format },
      },
    ],
  });

  const body = {
    model: s.mimoAsrModel,
    messages,
    stream: false,
  };
  if (typeof temperature === 'number') body.temperature = temperature;

  let res;
  try {
    res = await fetch(mimoChatUrl(s.mimoBaseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${s.mimoApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const e = new Error(`Network error calling MiMo: ${err.message}`);
    e.statusCode = 502;
    throw e;
  }

  const rawText = await res.text();
  if (!res.ok) {
    let detail = rawText.slice(0, 800);
    try {
      const j = JSON.parse(rawText);
      detail = j.error?.message || j.message || j.detail || detail;
    } catch {
      /* keep text */
    }
    const err = new Error(`MiMo ASR ${res.status}: ${detail}`);
    err.statusCode = res.status;
    err.upstream = { status: res.status, body: rawText.slice(0, 2000) };
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw Object.assign(new Error(`Invalid JSON from MiMo: ${rawText.slice(0, 200)}`), {
      statusCode: 502,
    });
  }

  const text = parsed.choices?.[0]?.message?.content ?? '';
  if (typeof text !== 'string') {
    throw Object.assign(new Error('MiMo returned no text content.'), { statusCode: 502 });
  }

  return { text, raw: parsed, format: 'json' };
}

/**
 * One-shot helper: take a raw mp3 buffer and call the STT API. Returns the
 * same shape as transcribeWithBase64.
 */
export async function transcribe({ buffer, filename, language, temperature, signal }) {
  const { audioBase64, format } = prepareAudioPayload(buffer, filename);
  return transcribeWithBase64({
    audioBase64,
    format,
    language,
    temperature,
    signal,
  });
}

/* ============================================================ */
/*  TTS — text to speech via MiMo-V2.5-TTS                      */
/* ============================================================ */

/**
 * Call MiMo TTS and return the synthesized audio as a base64 string + the
 * detected mime format. The caller is responsible for decoding and serving
 * to the browser.
 *
 * Strategy: the simplest cross-version fallback chain.
 *   1. Try the multimodal chat completions endpoint with modalities=["audio","text"].
 *      MiMo's TTS family is expected to return { choices[0].message.audio.data }.
 *   2. If that fails, we propagate the error.
 *
 * The function is intentionally tolerant about which field the API puts the
 * audio under (`audio.data`, `audio_url`, `data` at top level) because TTS
 * endpoint shapes vary across vendors.
 */
export async function synthesize({ text, voice, format = 'wav', signal, settings } = {}) {
  const s = settings || getEffectiveSettings();
  if (!s.mimoApiKey) {
    const err = new Error('MIMO_API_KEY is not configured. Set it in the ⚙️ 模型配置 or .env.');
    err.statusCode = 500;
    throw err;
  }
  if (!text || !text.trim()) {
    const err = new Error('Empty text for TTS.');
    err.statusCode = 400;
    throw err;
  }

  const useVoice = voice || s.mimoTtsVoice;
  const useFormat = format || s.mimoTtsFormat;

  const body = {
    model: s.mimoTtsModel,
    modalities: ['text', 'audio'],
    audio: { voice: useVoice, format: useFormat },
    messages: [
      // MiMo TTS requires the message role to be 'assistant' (you provide the
      // text the voice should read out). We also intentionally omit the
      // `stream` field: MiMo's TTS endpoint returns "Invalid JSON in request
      // body" if `stream` is present.
      { role: 'assistant', content: text },
    ],
  };

  let res;
  try {
    res = await fetch(mimoChatUrl(s.mimoBaseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${s.mimoApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const e = new Error(`Network error calling MiMo TTS: ${err.message}`);
    e.statusCode = 502;
    throw e;
  }

  const rawText = await res.text();
  if (!res.ok) {
    let detail = rawText.slice(0, 800);
    try {
      const j = JSON.parse(rawText);
      detail = j.error?.message || j.message || j.detail || detail;
    } catch {
      /* keep text */
    }
    const err = new Error(`MiMo TTS ${res.status}: ${detail}`);
    err.statusCode = res.status;
    err.upstream = { status: res.status, body: rawText.slice(0, 2000) };
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw Object.assign(new Error(`Invalid JSON from MiMo TTS: ${rawText.slice(0, 200)}`), {
      statusCode: 502,
    });
  }

  // Look for audio data in common locations.
  const msg = parsed.choices?.[0]?.message || {};
  const audio =
    msg.audio?.data ??
    msg.audio?.audio_url ??
    parsed.audio?.data ??
    parsed.data ??
    null;

  if (!audio) {
    // Some TTS endpoints return plain text content instead of audio. Surface
    // that clearly so the caller can fall back to a browser-side TTS or just
    // display the text.
    const fallbackText = msg.content || parsed.choices?.[0]?.message?.content || '';
    const err = new Error(
      'MiMo TTS did not return audio data. ' +
        (fallbackText
          ? `Got text back instead: "${String(fallbackText).slice(0, 80)}…"`
          : 'Response had no audio field.'),
    );
    err.statusCode = 502;
    err.upstream = { status: 200, body: rawText.slice(0, 2000) };
    err.fallbackText = String(fallbackText || '').trim();
    throw err;
  }

  // If we got a URL instead of base64, fetch it.
  if (/^https?:\/\//i.test(audio)) {
    const audioRes = await fetch(audio, { signal });
    if (!audioRes.ok) {
      const e = new Error(`TTS audio URL returned HTTP ${audioRes.status}`);
      e.statusCode = 502;
      throw e;
    }
    const arr = new Uint8Array(await audioRes.arrayBuffer());
    return {
      audioBase64: Buffer.from(arr).toString('base64'),
      mime: audioRes.headers.get('content-type') || mimeForFormat(useFormat),
      format: useFormat,
    };
  }

  return {
    audioBase64: String(audio),
    mime: mimeForFormat(useFormat),
    format: useFormat,
  };
}

function mimeForFormat(format) {
  switch ((format || '').toLowerCase()) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
    case 'mpeg':
      return 'audio/mpeg';
    case 'opus':
      return 'audio/ogg';
    case 'pcm':
      return 'audio/pcm';
    default:
      return 'audio/wav';
  }
}

/**
 * 连接测试：用当前（或传入的候选）配置做一次极短的 TTS 合成，验证
 * key / Base URL / TTS 模型是否可用。返回结构化结果，不抛错。
 */
export async function testMimoConnection(settingsOverride) {
  const s = settingsOverride || getEffectiveSettings();
  if (!s.mimoApiKey) {
    return { ok: false, message: '未配置 MiMo API Key', detail: '请先填写 API Key（可在 ⚙️ 模型配置 或 .env 中设置）。' };
  }
  const t0 = Date.now();
  try {
    await synthesize({ text: '测试', voice: s.mimoTtsVoice, format: 'wav', settings: s });
    return { ok: true, message: 'MiMo 连接正常（ASR/TTS 端点可达，Key 有效）', latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      message: `MiMo 连接失败：${err.message}`,
      detail: (err.upstream && err.upstream.body) ? String(err.upstream.body).slice(0, 300) : '',
      latencyMs: Date.now() - t0,
    };
  }
}
