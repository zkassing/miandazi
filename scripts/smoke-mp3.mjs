// scripts/smoke-mp3.mjs — 验证 mimoClient 在没有 ffmpeg 的情况下:
//   1) 正确识别 mp3 frame header 走通 prepareAudioPayload
//   2) 正确拒绝非 mp3 (wav)
//   3) 正确拒绝空 buffer
// 不真正调用 mimo API,只验证本地准备逻辑。
import { detectAudioFormat, prepareAudioPayload } from '../src/mimoClient.js';

function assert(cond, msg) {
  if (!cond) {
    console.error('  ✗ ' + msg);
    process.exitCode = 1;
  } else {
    console.log('  ✓ ' + msg);
  }
}

console.log('1) detect mp3 by sync byte (0xFF 0xFB)');
{
  const buf = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert(detectAudioFormat(buf, 'a.mp3') === 'mp3', 'sync-byte mp3 detected');
}

console.log('2) detect mp3 by ID3 header');
{
  const buf = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert(detectAudioFormat(buf, 'a.mp3') === 'mp3', 'ID3 mp3 detected');
}

console.log('3) detect wav by RIFF/WAVE');
{
  const buf = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  ]);
  assert(detectAudioFormat(buf, 'a.wav') === 'wav', 'wav detected');
}

console.log('4) reject non-mp3 with proper statusCode 415');
{
  const wavBuf = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  ]);
  let err;
  try { prepareAudioPayload(wavBuf, 'a.wav'); } catch (e) { err = e; }
  assert(err && err.statusCode === 415, `wav rejected with 415 (got ${err?.statusCode})`);
  assert(/only mp3/i.test(err?.message || ''), 'wav error message mentions mp3');
}

console.log('5) reject empty buffer with 400');
{
  let err;
  try { prepareAudioPayload(Buffer.alloc(0), 'a.mp3'); } catch (e) { err = e; }
  assert(err && err.statusCode === 400, `empty buffer rejected with 400 (got ${err?.statusCode})`);
}

console.log('6) accept mp3, return base64 + format=mp3');
{
  const buf = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const { audioBase64, format } = prepareAudioPayload(buf, 'song.mp3');
  assert(format === 'mp3', 'format is mp3');
  assert(typeof audioBase64 === 'string' && audioBase64.length > 0, 'base64 non-empty');
  assert(audioBase64 === buf.toString('base64'), 'base64 round-trips');
}

console.log('\nDone. Exit code:', process.exitCode || 0);
