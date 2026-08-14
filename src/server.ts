// server.ts — Fastify API server
//   - exposes POST /api/transcribe (MiMo STT, kept for the original tool)
//   - exposes the interview API: /api/interview/{start, turn, report, session}
//   - the SPA is served separately by Vite (dev) or a static host (prod)

import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'

import { config } from './config.ts'
import {
  getEffectiveSettings,
  getPublicSettings,
  updateSettings,
  resetSettings,
  effectiveWithOverrides,
} from './modelSettings.ts'
import { transcribe, testMimoConnection } from './mimoClient.ts'
import { testDeepseekConnection } from './deepseekClient.ts'
import {
  startInterview,
  submitTurn,
  generateReport,
  getSessionSnapshot,
  forceFinishSession,
  dropSession,
} from './interviewOrchestrator.ts'

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
  bodyLimit: config.maxUploadBytes + 1024 * 1024,
})

await app.register(cors, {
  origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s: string) => s.trim()),
  methods: ['GET', 'POST', 'OPTIONS'],
})

await app.register(multipart, {
  limits: {
    fileSize: config.maxUploadBytes,
    files: 1,
  },
})

/* ------------------------- health ------------------------- */

app.get('/api/health', async () => {
  const s = getEffectiveSettings();
  return {
    ok: true,
    hasApiKey: Boolean(s.mimoApiKey),
    hasDeepseekKey: Boolean(s.deepseekApiKey),
    mimo: {
      asrModel: s.mimoAsrModel,
      ttsModel: s.mimoTtsModel,
      ttsVoice: s.mimoTtsVoice,
      ttsFormat: s.mimoTtsFormat,
      baseUrl: s.mimoBaseUrl,
    },
    deepseek: {
      model: s.deepseekModel,
      maxRounds: s.deepseekMaxRounds,
    },
    maxUploadBytes: config.maxUploadBytes,
  };
});

/* ------------------------- /api/settings (模型配置) ------------------------- */

/**
 * GET /api/settings — 返回当前模型配置（key 已掩码）+ Key 申请网址。
 * 浏览器打开「模型配置」弹窗时调用。
 */
app.get('/api/settings', async () => getPublicSettings());

/**
 * POST /api/settings — 更新模型配置并持久化，立即生效（无需重启）。
 * Body: { mimo?: { apiKey?, baseUrl?, asrModel?, ttsModel?, ttsVoice?, ttsFormat?, systemPrompt? },
 *         deepseek?: { apiKey?, baseUrl?, model? } }
 * 省略的字段（或空的 key）＝ 保持现状。
 */
app.post('/api/settings', async (request, reply) => {
  const payload = request.body || {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return reply.code(400).send({ error: 'bad_request', message: 'Body must be a JSON object.' });
  }
  try {
    const pub = updateSettings(payload);
    request.log.info('[settings] model settings updated via UI');
    return pub;
  } catch (err) {
    request.log.error({ err }, 'settings update failed');
    return reply.code(500).send({ error: 'settings_update_failed', message: err.message });
  }
});

/**
 * POST /api/settings/reset — 清空运行时覆盖，回到 .env 默认值。
 */
app.post('/api/settings/reset', async (request, reply) => {
  try {
    const pub = resetSettings();
    request.log.info('[settings] model settings reset to .env defaults');
    return pub;
  } catch (err) {
    return reply.code(500).send({ error: 'settings_reset_failed', message: err.message });
  }
});

/**
 * POST /api/settings/test — 用指定配置做一次最小请求，验证连通性。
 * Body: { provider?: 'mimo' | 'deepseek' | 'all', settings?: { mimo?, deepseek? } }
 *   - provider 默认 'all'
 *   - settings 可选：表单里「未保存」的候选配置；不传则用当前已保存的配置
 * 返回: { results: { mimo?: {...}, deepseek?: {...} } }
 */
app.post('/api/settings/test', async (request, reply) => {
  const { provider, settings } = request.body || {};
  const p = String(provider || 'all');
  const candidate = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? effectiveWithOverrides(settings)
    : undefined;
  const results = {};
  try {
    if (p === 'all' || p === 'mimo') {
      results.mimo = await testMimoConnection(candidate);
    }
    if (p === 'all' || p === 'deepseek') {
      results.deepseek = await testDeepseekConnection(candidate);
    }
    return { results };
  } catch (err) {
    return reply.code(500).send({ error: 'settings_test_failed', message: err.message });
  }
});

/* ------------------------- /api/transcribe (legacy) ------------------------- */

app.post('/api/transcribe', async (request, reply) => {
  if (!getEffectiveSettings().mimoApiKey) {
    return reply.code(500).send({
      error: 'server_misconfigured',
      message: 'MIMO_API_KEY 未配置。请在右上角 ⚙️ 模型配置 里填写，或设置 .env 后重启。',
    });
  }
  let part;
  try {
    part = await request.file();
  } catch (err) {
    request.log.warn({ err }, 'multipart error');
    return reply.code(400).send({ error: 'bad_request', message: err.message });
  }
  if (!part) {
    return reply
      .code(400)
      .send({ error: 'no_file', message: 'No file uploaded under field "file".' });
  }
  if (part.fileTruncated) {
    return reply
      .code(413)
      .send({ error: 'file_too_large', message: `File exceeds ${config.maxUploadBytes} bytes.` });
  }
  const buffer = await part.toBuffer();
  const filename = part.filename || 'audio.webm';
  const contentType = part.mimetype || 'application/octet-stream';

  let language = '';
  let temperature;
  if (part.fields && typeof part.fields === 'object') {
    if (part.fields.language) language = String(part.fields.language.value || '').trim();
    if (part.fields.temperature) {
      const t = Number(part.fields.temperature.value);
      if (!Number.isNaN(t)) temperature = t;
    }
  }

  try {
    const t0 = Date.now();
    const result = await transcribe({ buffer, filename, language, temperature });
    const elapsedMs = Date.now() - t0;
    return {
      text: result.text,
      format: 'json',
      elapsedMs,
      meta: { filename, contentType, bytes: buffer.length, language: language || 'auto', model: getEffectiveSettings().mimoAsrModel },
      usage: result.raw?.usage,
    };
  } catch (err) {
    request.log.error({ err }, 'upstream error');
    const status = err.statusCode || 502;
    return reply.code(status).send({
      error: 'upstream_error',
      message: err.message,
      upstream: err.upstream,
    });
  }
});

/* ------------------------- /api/interview/* ------------------------- */

function requireKeys(reply) {
  const s = getEffectiveSettings();
  if (!s.mimoApiKey) {
    reply.code(500).send({
      error: 'server_misconfigured',
      message: 'MIMO_API_KEY 未配置。请在右上角 ⚙️ 模型配置 里填写，或设置 .env 后重启。',
    });
    return false;
  }
  if (!s.deepseekApiKey) {
    reply.code(500).send({
      error: 'server_misconfigured',
      message: 'DEEPSEEK_API_KEY 未配置。请在右上角 ⚙️ 模型配置 里填写，或设置 .env 后重启。',
    });
    return false;
  }
  return true;
}

/**
 * POST /api/interview/start
 * Body: { direction?, jdText?, candidateName?, maxRounds?, voice?, ttsFormat? }
 * Returns: { sessionId, round, question, topic, endInterview, tts: { audioBase64, mime, ... } }
 */
app.post('/api/interview/start', async (request, reply) => {
  if (!requireKeys(reply)) return;
  const body = request.body || {};
  try {
    const r = await startInterview({
      direction: body.direction,
      jdText: body.jdText,
      candidateName: body.candidateName,
      maxRounds: body.maxRounds,
      voice: body.voice,
      ttsFormat: body.ttsFormat,
    });
    request.log.info({ sessionId: r.sessionId }, 'interview started');
    return r;
  } catch (err) {
    request.log.error({ err }, 'interview start failed');
    return reply.code(err.statusCode || 502).send({
      error: 'interview_start_failed',
      message: err.message,
      upstream: err.upstream,
    });
  }
});

/**
 * POST /api/interview/turn
 * multipart: file (mp3 / webm / etc.) + sessionId, language, textOverride?
 * Returns: { sessionId, round, question, topic, endInterview, transcript, tts }
 */
app.post('/api/interview/turn', async (request, reply) => {
  if (!requireKeys(reply)) return;

  // Read multipart
  let part;
  try {
    part = await request.file();
  } catch (err) {
    return reply.code(400).send({ error: 'bad_request', message: err.message });
  }
  if (!part) {
    return reply
      .code(400)
      .send({ error: 'no_file', message: 'No file uploaded under field "file".' });
  }
  if (part.fileTruncated) {
    return reply
      .code(413)
      .send({ error: 'file_too_large', message: `File exceeds ${config.maxUploadBytes} bytes.` });
  }

  const buffer = await part.toBuffer();
  const filename = part.filename || 'turn.webm';

  let sessionId = '';
  let language = 'zh';
  let textOverride = '';
  if (part.fields && typeof part.fields === 'object') {
    if (part.fields.sessionId) sessionId = String(part.fields.sessionId.value || '').trim();
    if (part.fields.language) language = String(part.fields.language.value || 'zh').trim();
    if (part.fields.textOverride) textOverride = String(part.fields.textOverride.value || '').trim();
  }
  if (!sessionId) {
    return reply
      .code(400)
      .send({ error: 'no_session', message: 'Missing sessionId form field.' });
  }
  if (!buffer || buffer.length === 0) {
    return reply
      .code(400)
      .send({ error: 'empty_audio', message: 'Empty audio buffer.' });
  }

  try {
    const t0 = Date.now();
    const r = await submitTurn(sessionId, {
      audioBuffer: buffer,
      audioFilename: filename,
      language,
      textOverride,
    });
    request.log.info(
      { sessionId, round: r.round, end: r.endInterview, elapsedMs: Date.now() - t0 },
      'interview turn ok',
    );
    return r;
  } catch (err) {
    request.log.error({ err, sessionId }, 'interview turn failed');
    return reply.code(err.statusCode || 502).send({
      error: 'interview_turn_failed',
      message: err.message,
      upstream: err.upstream,
    });
  }
});

/**
 * POST /api/interview/end
 * Body: { sessionId }
 * Force-marks the session as finished so a subsequent /report call succeeds.
 * Use this when the candidate clicks ⏹ without explicitly saying "end" — we
 * don't need to round-trip through DeepSeek just to mark finished.
 */
app.post('/api/interview/end', async (request, reply) => {
  const { sessionId } = request.body || {};
  if (!sessionId) {
    return reply.code(400).send({ error: 'no_session', message: 'Missing sessionId.' });
  }
  const s = forceFinishSession(sessionId, 'candidate_manual_end');
  if (!s) {
    return reply.code(404).send({ error: 'not_found' });
  }
  return { sessionId, finished: true, endedAt: s.endedAt, endReason: s.endReason };
});

/**
 * POST /api/interview/report
 * Body: { sessionId }
 * Returns the structured report (cached after first call).
 */
app.post('/api/interview/report', async (request, reply) => {
  if (!requireKeys(reply)) return;
  const { sessionId } = request.body || {};
  if (!sessionId) {
    return reply.code(400).send({ error: 'no_session', message: 'Missing sessionId.' });
  }
  try {
    const report = await generateReport(sessionId);
    return { sessionId, report };
  } catch (err) {
    request.log.error({ err, sessionId }, 'report failed');
    return reply.code(err.statusCode || 502).send({
      error: 'report_failed',
      message: err.message,
      upstream: err.upstream,
    });
  }
});

/**
 * GET /api/interview/session/:id — snapshot for the report page.
 */
app.get('/api/interview/session/:id', async (request, reply) => {
  const snap = getSessionSnapshot(request.params.id);
  if (!snap) return reply.code(404).send({ error: 'not_found' });
  return snap;
});

/**
 * DELETE /api/interview/session/:id — drop a session.
 */
app.delete('/api/interview/session/:id', async (request, reply) => {
  const ok = dropSession(request.params.id);
  return { ok };
});

/* ------------------------- /api/history (SQLite-backed) ------------------------- */

import {
  listSessions,
  getSessionRow,
  deleteSessionRow,
  listTurns,
  listMarkers,
  insertMarker,
  getTurnAudioPath,
  loadFullReport,
} from './db.ts'

/**
 * GET /api/history — list all interviews (newest first).
 */
app.get('/api/history', async () => {
  const rows = listSessions()
  return { sessions: rows }
})

/**
 * GET /api/history/:id — full session detail: meta + turns + markers.
 * The LLM-driven report is loaded on demand via /api/interview/report.
 */
app.get('/api/history/:id', async (request, reply) => {
  const id = request.params.id
  const session = getSessionRow(id)
  if (!session) return reply.code(404).send({ error: 'not_found' })
  const turns = listTurns(id)
  const markers = listMarkers(id)
  const report = loadFullReport(id)
  return { session, turns, markers, report }
})

/**
 * DELETE /api/history/:id — delete a session + its audio files (irreversible).
 */
app.delete('/api/history/:id', async (request, reply) => {
  const id = request.params.id
  const row = getSessionRow(id)
  if (!row) return reply.code(404).send({ error: 'not_found' })
  try {
    deleteSessionRow(id)
  } catch (err) {
    return reply.code(500).send({ error: 'delete_failed', message: err.message })
  }
  return { ok: true }
})

/**
 * POST /api/history/:id/marker — drop a marker on the current round.
 * Body: { round: number }
 * Returns: { id, round, created_at, label }
 */
app.post('/api/history/:id/marker', async (request, reply) => {
  const id = request.params.id
  const row = getSessionRow(id)
  if (!row) return reply.code(404).send({ error: 'not_found' })
  const { round } = (request.body || {}) as { round?: number }
  if (typeof round !== 'number' || round < 1) {
    return reply.code(400).send({ error: 'bad_request', message: 'round (number) required' })
  }
  const ts = Date.now()
  const time = new Date(ts).toTimeString().slice(0, 8) // HH:MM:SS
  const label = `已标记 @ 轮 ${round} ${time}`
  const marker = insertMarker(id, round, label, ts)
  return marker
})

/**
 * GET /api/audio/:turnId — stream the audio file for a single turn.
 * Used by the history / report page to play back recordings.
 */
app.get('/api/audio/:turnId', async (request, reply) => {
  const turnId = Number(request.params.turnId)
  if (!Number.isFinite(turnId)) {
    return reply.code(400).send({ error: 'bad_request', message: 'turnId must be a number' })
  }
  const filePath = getTurnAudioPath(turnId)
  if (!filePath) return reply.code(404).send({ error: 'not_found' })
  try {
    const buf = await import('node:fs/promises').then((m) => m.readFile(filePath))
    return reply
      .header('Content-Type', 'audio/wav')
      .header('Content-Length', String(buf.length))
      .header('Cache-Control', 'private, max-age=86400')
      .send(buf)
  } catch (err) {
    return reply.code(500).send({ error: 'read_failed', message: err.message })
  }
})

/* ------------------------- 404 ------------------------- */
// The frontend is served by Vite (dev) or a static host (prod), so any
// non-/api/ path that lands here is a 404 — return JSON, not HTML.
app.setNotFoundHandler((request, reply) => {
  return reply.code(404).send({ error: 'not_found' })
});

try {
  await app.listen({ port: config.port, host: config.host });
  const s = getEffectiveSettings();
  app.log.info(
    {
      port: config.port,
      mimoAsr: s.mimoAsrModel,
      mimoTts: s.mimoTtsModel,
      deepseek: s.deepseekModel,
    },
    'MiMo ASR + Interview app ready',
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
