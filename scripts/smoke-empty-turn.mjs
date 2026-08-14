// scripts/smoke-empty-turn.mjs
// Verify that submitting a (near-)silent recording doesn't 400 — it returns
// 200 with emptyReason='no_speech_detected' and round unchanged.

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
  return { status: res.status, data };
}

const start = await call('POST', '/api/interview/start', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ direction: '前端工程师', candidateName: '空答测试' }),
});
console.log('start.status =', start.status, 'round =', start.data.round);

const wav = makeSilentWav(2);
const fd = new FormData();
fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'silent.wav');
fd.append('sessionId', start.data.sessionId);
fd.append('language', 'zh');
// no textOverride — should hit the STT path and return emptyReason

const turn = await call('POST', '/api/interview/turn', { body: fd });
console.log('turn.status =', turn.status);
console.log('turn.data.round =', turn.data.round, '(should still be 1)');
console.log('turn.data.transcript =', JSON.stringify(turn.data.transcript));
console.log('turn.data.emptyReason =', turn.data.emptyReason);
console.log('turn.data.question =', turn.data.question);

await call('DELETE', `/api/interview/session/${start.data.sessionId}`);

if (turn.status !== 200) { console.error('FAIL: expected 200'); process.exit(1); }
if (turn.data.round !== 1) { console.error('FAIL: round should remain 1'); process.exit(1); }
if (turn.data.emptyReason !== 'no_speech_detected') { console.error('FAIL: emptyReason'); process.exit(1); }
console.log('OK');
