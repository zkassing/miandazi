/**
 * Audio helpers used by the recorder and the report page.
 */

export function pickRecorderMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/mpeg',
  ]
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

export function base64ToBlobUrl(base64: string, mime: string): string {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const blob = new Blob([bytes], { type: mime || 'audio/mpeg' })
  return URL.createObjectURL(blob)
}

/**
 * Decode any audio blob (e.g. webm/opus from MediaRecorder) into a 16kHz
 * mono PCM WAV Blob. We do this client-side to avoid adding ffmpeg / a
 * server-side transcoder — the upstream ASR only accepts wav or mp3.
 *
 * Returns a Promise<Blob> with type 'audio/wav'.
 */
export async function blobToWav(blob: Blob, targetSampleRate = 16000): Promise<Blob> {
  const arrayBuf = await blob.arrayBuffer()
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
  const decodeCtx = new AudioCtx()
  let decoded: AudioBuffer
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0))
  } finally {
    decodeCtx.close?.()
  }

  const targetChannels = 1
  const offlineCtx = new OfflineAudioContext(
    targetChannels,
    Math.ceil(decoded.duration * targetSampleRate),
    targetSampleRate,
  )
  const src = offlineCtx.createBufferSource()
  src.buffer = decoded
  src.connect(offlineCtx.destination)
  src.start(0)
  const rendered = await offlineCtx.startRendering()

  const channelData = rendered.getChannelData(0)
  const numSamples = channelData.length
  const dataSize = numSamples * 2
  const headerSize = 44
  const wavBuf = new ArrayBuffer(headerSize + dataSize)
  const view = new DataView(wavBuf)

  function writeStr(off: number, s: string) {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, targetChannels, true)
  view.setUint32(24, targetSampleRate, true)
  view.setUint32(28, targetSampleRate * targetChannels * 2, true)
  view.setUint16(32, targetChannels * 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  let off = headerSize
  for (let i = 0; i < numSamples; i++) {
    let s = Math.max(-1, Math.min(1, channelData[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }

  return new Blob([wavBuf], { type: 'audio/wav' })
}

export function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
