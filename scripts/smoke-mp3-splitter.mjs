// scripts/smoke-mp3-splitter.mjs — verify the browser-side MP3 splitter logic
// against synthetic CBR / VBR / ID3v2 / corrupted streams.
//
// Run: node scripts/smoke-mp3-splitter.mjs
//
// The splitter lives in public/mp3Splitter.js (browser-targeted) but is
// pure ESM with no DOM/Web APIs, so we can exercise it from Node directly.

import {
  sliceMp3ByDuration,
  sliceMp3ByMaxBytes,
  estimateMp3Duration,
} from '../public/mp3Splitter.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else      { fail++; console.error('  ✗ ' + msg); }
}

// MPEG1 Layer III, 128 kbps, 44100 Hz, mono:
//   frameSize = 144 * 128000 / 44100 = 417 bytes (+padding=0)
//   samplesPerFrame = 1152
//   secondsPerFrame = 1152 / 44100 = 0.02612
// We construct N frames worth of 0xFF sync data; each frame is 417 bytes.
function makeCbrMp3(numFrames, { bitrateKbps = 128, sampleRate = 44100, padding = 0, withId3 = false } = {}) {
  const frameSize = Math.floor((144 * bitrateKbps * 1000) / sampleRate) + padding;
  // Look up bitrate index for the requested bitrate in the MPEG1 L3 table.
  const MP3_BITRATES_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const bitrateIdx = MP3_BITRATES_KBPS.indexOf(bitrateKbps);
  const MP3_SR_HZ = [44100, 48000, 32000, 0];
  const sampleIdx = MP3_SR_HZ.indexOf(sampleRate);
  if (bitrateIdx < 0 || sampleIdx < 0) {
    throw new Error(`makeCbrMp3: unsupported bitrate=${bitrateKbps} or sampleRate=${sampleRate}`);
  }
  const header = new Uint8Array([
    0xff,
    0xfb,                  // MPEG1, Layer III, no CRC
    ((bitrateIdx << 4) | (sampleIdx << 2) | (padding & 1)),
    0xc0,                  // channel mode = mono, no copyright, original, no emphasis
  ]);
  const total = (withId3 ? 1024 : 0) + numFrames * frameSize;
  const buf = new Uint8Array(total);
  let off = 0;
  if (withId3) {
    // ID3v2.3 header: "ID3" + version(2) + flags(1) + synchsafe size(4) = 0
    const id3Size = 1024 - 10;
    const b = (n, s) => (n >> s) & 0x7f;
    buf.set([0x49, 0x44, 0x33, 3, 0, 0], 0);
    buf.set([b(id3Size, 21), b(id3Size, 14), b(id3Size, 7), b(id3Size, 0)], 6);
    off = 1024;
  }
  for (let i = 0; i < numFrames; i++) {
    buf.set(header, off);
    // fill the rest with non-sync bytes to discourage false-positive sync detection
    for (let j = 4; j < frameSize; j++) buf[off + j] = (i * 17 + j) & 0xff;
    off += frameSize;
  }
  return { buf, frameSize, sampleRate, bitrateKbps };
}

// ----- Test 1: CBR, no slicing needed (short file) -----
{
  console.log('1) CBR short file: no slicing, single chunk');
  const { buf } = makeCbrMp3(100);
  const slices = sliceMp3ByDuration(buf, 300); // target 5 min
  assert(slices.length === 1, `1 slice (got ${slices.length})`);
  assert(slices[0].buffer.length === buf.length, 'slice covers whole file');
  const dur = estimateMp3Duration(buf);
  assert(dur > 2.0 && dur < 3.0, `~2.6s duration (got ${dur.toFixed(2)})`);
}

// ----- Test 2: CBR, sliced into multiple parts -----
{
  console.log('2) CBR long file: split into multiple slices');
  // 20000 frames * 1152/44100 = ~522.4s total. Target 5s/slice => ~105 slices.
  const { buf } = makeCbrMp3(20000, { bitrateKbps: 128, sampleRate: 44100 });
  const slices = sliceMp3ByDuration(buf, 5);
  const expectedCount = Math.ceil((20000 * 1152 / 44100) / 5);
  assert(slices.length === expectedCount,
    `slice count = ${expectedCount} (got ${slices.length})`);
  // Each slice except the last should be ~5s.
  for (let i = 0; i < slices.length - 1; i++) {
    const s = slices[i];
    const bytes = s.endOff - s.startOff;
    // 128kbps mono CBR: 5s = 80000 bytes = ~80KB
    assert(bytes > 60000 && bytes < 100000,
      `slice ${i} ~80KB (got ${bytes})`);
  }
  // First slice should include the ID3v2 prefix if it existed; we didn't add
  // one, so first slice startOff should be 0.
  assert(slices[0].startOff === 0, 'first slice startOff=0');
}

// ----- Test 3: ID3v2 prefix is preserved on the first slice only -----
{
  console.log('3) ID3v2 tag preserved only on first slice');
  const { buf } = makeCbrMp3(2000, { withId3: true });
  const slices = sliceMp3ByDuration(buf, 5);
  assert(slices.length >= 2, `>=2 slices (got ${slices.length})`);
  // First slice buffer must start with "ID3"
  const first3 = String.fromCharCode(...slices[0].buffer.subarray(0, 3));
  assert(first3 === 'ID3', `first slice starts with ID3 (got "${first3}")`);
  // Subsequent slices must NOT start with ID3
  const second3 = String.fromCharCode(...slices[1].buffer.subarray(0, 3));
  assert(second3 !== 'ID3', `slice 1 doesn't start with ID3 (got "${second3}")`);
  // First slice startOff should be 0; subsequent should be > 0
  assert(slices[0].startOff === 0, 'first startOff=0');
  assert(slices[1].startOff > 0, `slice 1 startOff>0 (got ${slices[1].startOff})`);
  // All slices' data after the ID3 region should look like valid frame data
  for (let i = 0; i < slices.length; i++) {
    const startOfFrames = i === 0 ? 1024 : 0;
    const b0 = slices[i].buffer[startOfFrames];
    const b1 = slices[i].buffer[startOfFrames + 1];
    assert(b0 === 0xff && (b1 & 0xe0) === 0xe0,
      `slice ${i} starts with valid MP3 sync at frame region`);
  }
}

// ----- Test 4: VBR Xing header is detected and total duration correct -----
{
  console.log('4) VBR Xing header: total frame count drives duration');
  // Build a 100-frame CBR file, then patch a Xing header in the first frame.
  const { buf, frameSize, sampleRate } = makeCbrMp3(100);
  // First frame: protection=0 (no CRC), channel_mode=3 (mono) => side info = 17
  // Xing tag is at off + 4 + 2 + 17 = off + 23
  const xingOff = 23;
  buf.set([0x58, 0x69, 0x6e, 0x67], xingOff); // "Xing"
  // flags = 0x01 (frames present)
  buf[xingOff + 4] = 0; buf[xingOff + 5] = 0; buf[xingOff + 6] = 0; buf[xingOff + 7] = 0x01;
  // total frames = 100 (big endian u32)
  buf[xingOff + 8]  = 0; buf[xingOff + 9]  = 0; buf[xingOff + 10] = 0; buf[xingOff + 11] = 100;
  const dur = estimateMp3Duration(buf);
  const expected = (100 * 1152) / sampleRate;
  assert(Math.abs(dur - expected) < 0.01,
    `VBR duration ${dur.toFixed(2)}s ≈ expected ${expected.toFixed(2)}s`);
}

// ----- Test 5: Corrupted / non-MP3 input throws -----
{
  console.log('5) Non-MP3 input throws cleanly');
  const junk = new Uint8Array(4096);
  for (let i = 0; i < junk.length; i++) junk[i] = i & 0x77; // no 0xFF sync
  let err = null;
  try { sliceMp3ByDuration(junk, 300); } catch (e) { err = e; }
  assert(err !== null, 'non-MP3 input throws');
  assert(err && /no mp3 frame/i.test(err.message), `error message: ${err?.message}`);
}

// ----- Test 6: Bitrate table sanity (no functional assertion, just smoke) -----
{
  console.log('6) Sanity: sliceMp3ByDuration returns Uint8Array buffers');
  const { buf } = makeCbrMp3(50);
  const slices = sliceMp3ByDuration(buf, 300);
  assert(slices[0].buffer instanceof Uint8Array, 'buffer is Uint8Array');
}

// ----- Test 7: sliceMp3ByMaxBytes respects byte budget -----
{
  console.log('7) sliceMp3ByMaxBytes: each slice <= maxBytes');
  // 320kbps mono CBR 44.1k, frameSize = 144*320000/44100 = 1044 bytes
  // 50000 frames * 1044 bytes = ~52 MB
  const { buf } = makeCbrMp3(50000, { bitrateKbps: 320, sampleRate: 44100 });
  const maxBytes = 9 * 1024 * 1024; // 9 MB
  const slices = sliceMp3ByMaxBytes(buf, maxBytes);
  assert(slices.length >= 5, `at least 5 slices (got ${slices.length})`);
  let maxSeen = 0;
  for (const s of slices) {
    assert(s.bytes <= maxBytes, `slice ${s.buffer.length}b <= ${maxBytes}`);
    if (s.bytes > maxSeen) maxSeen = s.bytes;
  }
  console.log(`    (max slice size: ${(maxSeen / 1024 / 1024).toFixed(2)} MB across ${slices.length} slices)`);
}

// ----- Test 8: sliceMp3ByMaxBytes preserves ID3 only on first slice -----
{
  console.log('8) sliceMp3ByMaxBytes: ID3v2 only on first slice');
  const { buf } = makeCbrMp3(20000, { bitrateKbps: 192, sampleRate: 44100, withId3: true });
  const slices = sliceMp3ByMaxBytes(buf, 5 * 1024 * 1024);
  assert(slices.length >= 2, `>=2 slices (got ${slices.length})`);
  // First slice buffer should start with "ID3" (we wrote one in)
  const first3 = String.fromCharCode(...slices[0].buffer.subarray(0, 3));
  assert(first3 === 'ID3', `first slice starts with ID3 (got "${first3}")`);
  // Subsequent slices must not start with ID3
  const second3 = String.fromCharCode(...slices[1].buffer.subarray(0, 3));
  assert(second3 !== 'ID3', `slice 1 doesn't start with ID3 (got "${second3}")`);
}

// ----- Test 9: small file: no slicing -----
{
  console.log('9) sliceMp3ByMaxBytes: small file returns single slice');
  const { buf } = makeCbrMp3(50); // ~20KB
  const slices = sliceMp3ByMaxBytes(buf, 9 * 1024 * 1024);
  assert(slices.length === 1, `1 slice (got ${slices.length})`);
  assert(slices[0].bytes === buf.length, 'slice covers whole file');
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
