// scripts/smoke-sample-answer.mjs
// Quick test that the start and turn endpoints now return sampleAnswer.

const BASE = process.env.BASE || 'http://127.0.0.1:5174';

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
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${urlPath}: ${data.message || data.error || text.slice(0,200)}`);
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

const start = await call('POST', '/api/interview/start', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ direction: '前端工程师', candidateName: 'SA测试' }),
});
console.log('start.question =', start.question);
console.log('start.sampleAnswer =', start.sampleAnswer);
console.log('---');
const t1 = await turnWithText(start.sessionId, '我叫测试，有 5 年前端经验。');
console.log('turn1.question =', t1.question);
console.log('turn1.sampleAnswer =', t1.sampleAnswer);
console.log('---');
const t2 = await turnWithText(start.sessionId, '我没问题了，结束面试。');
console.log('turn2.endInterview =', t2.endInterview);

// cleanup
await call('DELETE', `/api/interview/session/${start.sessionId}`);
console.log('OK');
