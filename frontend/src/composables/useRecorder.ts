import { onUnmounted, ref, type Ref } from 'vue'
import { blobToWav, pickRecorderMime } from './useAudio'

export const SILENCE_RMS_THRESHOLD = 0.01 // ~ -40 dBFS, well above room noise
export const MIN_ACTIVE_SPEECH_SECONDS = 1.5
export const SILENCE_TIMEOUT_MS = 10_000
export const LOW_VOLUME_HINT_MS = 5_000

export type RecorderStatus = 'idle' | 'recording' | 'denied' | 'error'

interface UseRecorderOptions {
  /** Called when the take should be submitted (>= MIN_ACTIVE_SPEECH_SECONDS). */
  onSubmit: (blob: Blob) => void
  /** Called when silence was detected (no real speech) AND the question has a sample answer. */
  onShowSample: () => void
  /** Called when silence was detected but no sample answer is available. */
  onNoAnswer: () => void
  /** Called when the user clicks the on-screen "show answer" hint card. */
  onUserRequestedSample?: () => void
}

export function useRecorder(opts: UseRecorderOptions) {
  const recording = ref(false)
  const elapsed = ref(0)
  const hintCardVisible = ref(false)
  const hintPulsing = ref(false)
  const status: Ref<RecorderStatus> = ref('idle')
  const lastError = ref<string | null>(null)

  let mediaStream: MediaStream | null = null
  let mediaRecorder: MediaRecorder | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let recordedChunks: BlobPart[] = []
  let recordedMime = ''

  let silenceCheckTimer: number | null = null
  let silenceStartAt: number | null = null
  let lowVolumeStartAt: number | null = null
  let maxAmplitude = 0
  let activeSpeechSeconds = 0
  let lastSampleAt = 0

  let timerId: number | null = null
  let recordingStart = 0
  let waveRaf: number | null = null
  let canvas: HTMLCanvasElement | null = null

  /** Allow InterviewView to set the canvas ref after mount. */
  function bindCanvas(el: HTMLCanvasElement | null) {
    canvas = el
  }

  function teardownStream() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop())
      mediaStream = null
    }
    mediaRecorder = null
  }

  function teardownAudio() {
    if (silenceCheckTimer != null) {
      clearInterval(silenceCheckTimer)
      silenceCheckTimer = null
    }
    if (audioContext) {
      try {
        audioContext.close()
      } catch {
        /* noop */
      }
      audioContext = null
    }
    analyser = null
    silenceStartAt = null
    lowVolumeStartAt = null
    stopWaveform()
  }

  function teardownTimer() {
    if (timerId != null) {
      clearInterval(timerId)
      timerId = null
    }
  }

  function teardownAll() {
    teardownStream()
    teardownAudio()
    teardownTimer()
    recording.value = false
    hintCardVisible.value = false
    hintPulsing.value = false
  }

  function startWaveform() {
    if (!analyser) return
    if (waveRaf != null) cancelAnimationFrame(waveRaf)
    if (!canvas) {
      // The canvas ref must be bound *after* the view mounts, not in <script setup>.
      // If we got here without a canvas, the view forgot to call bindCanvas().
      console.warn('[useRecorder] startWaveform() called before bindCanvas() — waveform will not draw.')
      return
    }
    const loop = () => {
      if (!recording.value || !analyser) {
        waveRaf = null
        return
      }
      drawWaveFrame()
      waveRaf = requestAnimationFrame(loop)
    }
    loop()
  }

  function stopWaveform() {
    if (waveRaf != null) {
      cancelAnimationFrame(waveRaf)
      waveRaf = null
    }
  }

  function drawWaveFrame() {
    if (!canvas || !analyser) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth || 400
    const cssH = canvas.clientHeight || 96
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    ctx.fillStyle = 'rgba(24,24,28,0.55)'
    ctx.fillRect(0, 0, cssW, cssH)

    const mid = cssH / 2
    const h = (cssH - 14) / 2

    ctx.strokeStyle = 'rgba(107,125,255,0.22)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, mid)
    ctx.lineTo(cssW, mid)
    ctx.stroke()

    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)
    const n = data.length
    const step = n / cssW
    const peakAt = (x: number) => {
      const i0 = Math.floor(x * step)
      const i1 = Math.min(n - 1, Math.floor((x + 1) * step))
      let peak = 0
      for (let i = i0; i <= i1; i++) {
        const v = Math.abs(data[i])
        if (v > peak) peak = v
      }
      return peak
    }

    ctx.beginPath()
    ctx.moveTo(0, mid - peakAt(0) * h)
    for (let x = 1; x < cssW; x++) ctx.lineTo(x, mid - peakAt(x) * h)
    for (let x = cssW - 1; x >= 0; x--) ctx.lineTo(x, mid + peakAt(x) * h)
    ctx.closePath()

    const grad = ctx.createLinearGradient(0, 0, 0, cssH)
    grad.addColorStop(0, 'rgba(37,64,255,0.9)')
    grad.addColorStop(0.5, 'rgba(107,125,255,0.45)')
    grad.addColorStop(1, 'rgba(37,64,255,0.9)')
    ctx.fillStyle = grad
    ctx.fill()
  }

  function startSilenceDetection(stream: MediaStream) {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
      const ctx = new AudioCtx()
      const src = ctx.createMediaStreamSource(stream)
      const analyserNode = ctx.createAnalyser()
      analyserNode.fftSize = 1024
      src.connect(analyserNode)
      audioContext = ctx
      analyser = analyserNode

      const buf = new Float32Array(analyserNode.fftSize)
      silenceCheckTimer = window.setInterval(() => {
        if (!analyser) return
        analyser.getFloatTimeDomainData(buf)
        let sumSq = 0
        for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i]
        const rms = Math.sqrt(sumSq / buf.length)
        if (rms > maxAmplitude) maxAmplitude = rms
        const now = Date.now()
        if (lastSampleAt > 0) {
          const dt = (now - lastSampleAt) / 1000
          if (rms > SILENCE_RMS_THRESHOLD) {
            activeSpeechSeconds += dt
          }
        }
        lastSampleAt = now

        if (rms > SILENCE_RMS_THRESHOLD) {
          silenceStartAt = null
          if (lowVolumeStartAt !== null) {
            lowVolumeStartAt = null
            hintPulsing.value = false
          }
        } else {
          if (silenceStartAt === null) silenceStartAt = now
          if (now - silenceStartAt >= SILENCE_TIMEOUT_MS) {
            if (recording.value) stopRecording()
          }
          if (lowVolumeStartAt === null) {
            lowVolumeStartAt = now
          } else if (now - lowVolumeStartAt >= LOW_VOLUME_HINT_MS) {
            hintCardVisible.value = true
            hintPulsing.value = true
          }
        }
      }, 100)
    } catch (err) {
      console.warn('silence detection failed to start', err)
    }
  }

  async function startRecording() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('当前浏览器不支持麦克风，请用 Chrome / Edge / Firefox 最新版。')
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      mediaStream = stream
      const mime = pickRecorderMime()
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      recordedMime = rec.mimeType || mime || 'audio/webm'
      recordedChunks = []
      maxAmplitude = 0
      activeSpeechSeconds = 0
      lastSampleAt = 0
      silenceStartAt = null
      lowVolumeStartAt = null
      hintCardVisible.value = false
      hintPulsing.value = false

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) recordedChunks.push(e.data)
      }
      rec.onstop = () => {
        const blob = new Blob(recordedChunks, { type: recordedMime })
        const gaveRealSpeech = activeSpeechSeconds >= MIN_ACTIVE_SPEECH_SECONDS
        teardownStream()
        teardownAudio()
        if (gaveRealSpeech) {
          blobToWav(blob)
            .then((wav) => opts.onSubmit(wav))
            .catch((err) => {
              lastError.value = err.message
              status.value = 'error'
            })
        } else {
          // Hand the caller the original blob + a hint; they decide whether
          // to show the sample-answer modal or just complain.
          opts.onNoAnswer()
        }
      }

      rec.start(100)
      mediaRecorder = rec
      recording.value = true
      status.value = 'recording'
      recordingStart = Date.now()
      elapsed.value = 0
      teardownTimer()
      timerId = window.setInterval(() => {
        elapsed.value = (Date.now() - recordingStart) / 1000
      }, 200)

      startSilenceDetection(stream)
      startWaveform()
    } catch (err: any) {
      console.error(err)
      lastError.value = err.message || '无法启动录音'
      status.value = err.name === 'NotAllowedError' ? 'denied' : 'error'
      teardownAll()
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop()
    }
    recording.value = false
    teardownTimer()
  }

  function userClickedHint(hasSampleAnswer: boolean) {
    if (!recording.value) return
    if (opts.onUserRequestedSample) opts.onUserRequestedSample()
    if (hasSampleAnswer) {
      stopRecording()
    }
  }

  function teardown() {
    teardownAll()
  }

  onUnmounted(teardown)

  return {
    recording,
    elapsed,
    status,
    lastError,
    hintCardVisible,
    hintPulsing,
    startRecording,
    stopRecording,
    userClickedHint,
    bindCanvas,
    teardown,
  }
}
