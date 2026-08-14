// scripts/smoke-interview.mjs
// End-to-end smoke test for the interview flow.
// Requires the server to be running on PORT (default 5174).
//   node scripts/smoke-interview.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:5174';

function log(...a) { console.log('[smoke]', ...a); }

function makeSilentWav(seconds = 2, sampleRate = 16000) {
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

async function call(method, urlPath, opts = {}) {
  const res = await fetch(`${BASE}${urlPath}`, { method, ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${urlPath}: ${data.message || data.error || text.slice(0, 200)}`);
  }
  return data;
}

async function turnWithText(sessionId, text) {
  const wav = makeSilentWav(2);
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'silent.wav');
  fd.append('sessionId', sessionId);
  fd.append('language', 'zh');
  fd.append('textOverride', text);
  return call('POST', '/api/interview/turn', { body: fd });
}

async function main() {
  log('1) health');
  const h = await call('GET', '/api/health');
  log('  ok=', h.ok, 'mimo=', h.mimo.asrModel, 'deepseek=', h.deepseek.model);

  log('2) start interview');
  const start = await call('POST', '/api/interview/start', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      direction: '前端工程师',
      candidateName: '冒烟测试',
      maxRounds: 3,
    }),
  });
  log('  sessionId=', start.sessionId, 'round=', start.round);
  log('  question=', start.question);
  log('  tts.audio len=', start.tts?.audioBase64?.length || 0, 'mime=', start.tts?.mime);

  log('3) turn 1 (intro)');
  const t1 = await turnWithText(start.sessionId, '你好，我叫张三，有 5 年前端经验，最近在做 React 低代码平台。');
  log('  round=', t1.round, 'end=', t1.endInterview, 'topic=', t1.topic);
  log('  next question=', t1.question);

  log('4) turn 2 (force end)');
  const t2 = await turnWithText(start.sessionId, '我没有其他问题了，可以结束面试。');
  log('  round=', t2.round, 'end=', t2.endInterview);
  log('  closing=', t2.question);

  if (!t2.endInterview) {
    throw new Error('expected endInterview=true after explicit end request');
  }

  log('5) generate report');
  const r = await call('POST', '/api/interview/report', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: start.sessionId }),
  });
  log('  scores=', JSON.stringify(r.report.scores));
  log('  verdict=', r.report.verdict);
  log('  improvements=', (r.report.improvements || []).length);
  log('  per_question=', (r.report.per_question || []).length);

  log('6) drop session');
  const drop = await call('DELETE', `/api/interview/session/${start.sessionId}`);
  log('  dropped=', drop.ok);

  log('✅ smoke OK');
}

main().catch((err) => {
  console.error('[smoke] ❌', err);
  process.exit(1);
});
