import { computed, onUnmounted, ref, type Ref } from 'vue'
import { blobToWav, pickRecorderMime } from './useAudio'

export const SILENCE_RMS_THRESHOLD = 0.01 // ~ -40 dBFS, well above room noise
export const MIN_ACTIVE_SPEECH_SECONDS = 1.5
export const SILENCE_TIMEOUT_MS = 10_000
export const LOW_VOLUME_HINT_MS = 5_000
/**
 * 当音量分析不可用（AudioContext 被浏览器挂起 / 创建失败）时，用「录了多久」
 * 兜底判断这段录音是否值得提交，避免把用户真实说的话直接丢掉。
 */
export const MIN_FALLBACK_DURATION_SECONDS = 1.5
/** 分析可用、但有效说话时长不够时的宽松兜底（说明确实有声音进来）。 */
export const LENIENT_DURATION_SECONDS = 2

export type RecorderStatus = 'idle' | 'recording' | 'denied' | 'error'
/**
 * 录音机的真实生命周期。`recording` 只是它的一个投影：
 * MediaRecorder.stop() 是异步的，onstop 之前录音其实还在跑，
 * 之前直接把 recording 置 false 会让按钮立刻变回「开始录制」，
 * 用户再点一次就会开出第二路录音 —— 旧的 onstop 随后又把新的
 * stream / AudioContext 拆掉，于是「波形消失但录音还在录」。
 */
export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'stopping'

/** 把 getUserMedia 的错误映射成给用户看的中文提示。 */
function micFriendlyMessage(err: any): string {
  const name = err?.name || ''
  switch (name) {
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '未检测到麦克风设备。请确认麦克风已连接并启用，然后重试。'
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '麦克风权限被拒绝。请在浏览器地址栏允许使用麦克风后重试。'
    case 'NotReadableError':
    case 'TrackStartError':
      return '麦克风正被其他程序占用或不可用。请关闭占用麦克风的程序后重试。'
    case 'OverconstrainedError':
      return '没有找到符合要求的麦克风设备，请检查系统录音设置。'
    case 'SecurityError':
      return '浏览器安全策略阻止了麦克风访问（请通过 http://localhost 或 HTTPS 访问）。'
    default:
      return err?.message || '无法启动麦克风'
  }
}

interface UseRecorderOptions {
  /** Called when the take should be submitted (>= MIN_ACTIVE_SPEECH_SECONDS). */
  onSubmit: (blob: Blob) => void
  /** Called when silence was detected (no real speech) AND the question has a sample answer. */
  onShowSample: () => void
  /** Called when silence was detected but no sample answer is available. */
  onNoAnswer: () => void
  /** Called when the user clicks the on-screen "show answer" hint card. */
  onUserRequestedSample?: () => void
  /** Called when the mic dies mid-take (device unplugged / grabbed by another app). */
  onDeviceLost?: () => void
}

export function useRecorder(opts: UseRecorderOptions) {
  const phase: Ref<RecorderPhase> = ref('idle')
  /** 兼容旧用法：只有真正在录的时候才是 true。 */
  const recording = computed(() => phase.value === 'recording')
  /** 启动中 / 收尾中 —— UI 应该禁用麦克风按钮，避免并发开录。 */
  const busy = computed(() => phase.value === 'starting' || phase.value === 'stopping')
  const elapsed = ref(0)
  const hintCardVisible = ref(false)
  const hintPulsing = ref(false)
  const status: Ref<RecorderStatus> = ref('idle')
  const lastError = ref<string | null>(null)
  /** 音量分析是否真的在工作（波形有没有数据）。UI 可以据此提示。 */
  const analysisHealthy = ref(false)

  let mediaStream: MediaStream | null = null
  let mediaRecorder: MediaRecorder | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let recordedChunks: BlobPart[] = []
  let recordedMime = ''
  // 用户主动点击「答案提示」按钮停止录音时为 true：onstop 不再触发 onNoAnswer
  //（弹窗由 onUserRequestedSample 打开，避免重复）。
  let hintStopRequested = false
  /** 组件已卸载 / teardown 过：任何回调都不该再触发业务逻辑。 */
  let disposed = false

  /**
   * 每次 startRecording 递增。所有异步回调（onstop / rAF / setInterval /
   * track.onended）都要先比对自己的 take 是否仍是当前 take，
   * 否则上一次录音的收尾会把这一次的资源拆掉。
   */
  let takeId = 0

  let silenceCheckTimer: number | null = null
  let silenceStartAt: number | null = null
  let lowVolumeStartAt: number | null = null
  let maxAmplitude = 0
  let activeSpeechSeconds = 0
  let lastSampleAt = 0
  let sawNonZeroSample = false

  let timerId: number | null = null
  let recordingStart = 0
  let waveRaf: number | null = null
  let waveWaitUntil = 0
  let canvas: HTMLCanvasElement | null = null

  /** Allow InterviewView to set the canvas ref after mount. */
  function bindCanvas(el: HTMLCanvasElement | null) {
    canvas = el
  }

  function teardownStream() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => {
        t.onended = null
        try {
          t.stop()
        } catch {
          /* noop */
        }
      })
      mediaStream = null
    }
    if (mediaRecorder) {
      mediaRecorder.ondataavailable = null
      mediaRecorder.onstop = null
      mediaRecorder.onerror = null
      mediaRecorder = null
    }
  }

  function teardownAudio() {
    if (silenceCheckTimer != null) {
      clearInterval(silenceCheckTimer)
      silenceCheckTimer = null
    }
    stopWaveform()
    if (sourceNode) {
      try {
        sourceNode.disconnect()
      } catch {
        /* noop */
      }
      sourceNode = null
    }
    if (audioContext) {
      const ctx = audioContext
      audioContext = null
      ctx.onstatechange = null
      try {
        void ctx.close()
      } catch {
        /* noop */
      }
    }
    analyser = null
    silenceStartAt = null
    lowVolumeStartAt = null
  }

  function teardownTimer() {
    if (timerId != null) {
      clearInterval(timerId)
      timerId = null
    }
  }

  function teardownAll() {
    // 让所有在飞的回调失效
    takeId++
    teardownStream()
    teardownAudio()
    teardownTimer()
    phase.value = 'idle'
    hintCardVisible.value = false
    hintPulsing.value = false
    analysisHealthy.value = false
  }

  function startWaveform(myTake: number) {
    if (waveRaf != null) {
      cancelAnimationFrame(waveRaf)
      waveRaf = null
    }
    // canvas / analyser 有可能还没就绪（v-show 刚打开、AudioContext 还在 resume），
    // 以前这里直接 return，于是「录音在跑但波形永远不出现」。
    // 现在改成在 rAF 里等，最多等 3 秒。
    waveWaitUntil = Date.now() + 3000
    const loop = () => {
      if (disposed || myTake !== takeId || phase.value !== 'recording') {
        waveRaf = null
        return
      }
      if (!analyser || !canvas || !canvas.isConnected) {
        if (Date.now() > waveWaitUntil) {
          console.warn('[useRecorder] waveform gave up waiting for canvas/analyser')
          waveRaf = null
          return
        }
        waveRaf = requestAnimationFrame(loop)
        return
      }
      drawWaveFrame()
      waveRaf = requestAnimationFrame(loop)
    }
    waveRaf = requestAnimationFrame(loop)
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
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    // v-show 刚切换的那一帧宽高还是 0；此时不要把画布尺寸锁成兜底值
    // （会导致后面一直是被拉伸的模糊波形），直接跳过这一帧。
    if (!cssW || !cssH) return
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

  /**
   * 建 AudioContext + AnalyserNode。**必须 await**：Chrome 在没有用户手势的
   * 上下文里（比如题目 TTS 播放结束后自动开录）创建的 AudioContext 会是
   * suspended，getFloatTimeDomainData() 永远返回全 0 —— 波形是一条直线（看起来
   * 就是「没出现」），静音检测也会误判成「你什么都没说」。
   */
  async function setupAnalyser(stream: MediaStream, myTake: number): Promise<void> {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
      if (!AudioCtx) throw new Error('AudioContext unsupported')
      const ctx: AudioContext = new AudioCtx()
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume()
        } catch (err) {
          console.warn('[useRecorder] AudioContext.resume() failed', err)
        }
      }
      if (disposed || myTake !== takeId) {
        try {
          void ctx.close()
        } catch {
          /* noop */
        }
        return
      }
      const src = ctx.createMediaStreamSource(stream)
      const analyserNode = ctx.createAnalyser()
      analyserNode.fftSize = 1024
      analyserNode.smoothingTimeConstant = 0.6
      src.connect(analyserNode)
      // 有些浏览器（Safari）里 analyser 不接到 destination 就不推进数据。
      // 接一个静音 gain 到 destination，既能保证数据流动又不会有回声。
      try {
        const mute = ctx.createGain()
        mute.gain.value = 0
        analyserNode.connect(mute)
        mute.connect(ctx.destination)
      } catch {
        /* noop */
      }
      audioContext = ctx
      analyser = analyserNode
      sourceNode = src
      // 浏览器（切后台、系统打断）可能随时挂起 context —— 尝试自动恢复。
      ctx.onstatechange = () => {
        if (disposed || myTake !== takeId) return
        if (ctx.state === 'suspended' && phase.value === 'recording') {
          void ctx.resume().catch(() => {})
        }
      }
      startSilenceLoop(myTake)
    } catch (err) {
      console.warn('[useRecorder] analyser failed to start', err)
      analyser = null
      analysisHealthy.value = false
    }
  }

  function startSilenceLoop(myTake: number) {
    if (!analyser) return
    const buf = new Float32Array(analyser.fftSize)
    if (silenceCheckTimer != null) clearInterval(silenceCheckTimer)
    silenceCheckTimer = window.setInterval(() => {
      if (disposed || myTake !== takeId || phase.value !== 'recording') return
      if (!analyser) return
      analyser.getFloatTimeDomainData(buf)
      let sumSq = 0
      for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i]
      const rms = Math.sqrt(sumSq / buf.length)
      if (rms > 0) {
        sawNonZeroSample = true
        if (!analysisHealthy.value) analysisHealthy.value = true
      }
      if (rms > maxAmplitude) maxAmplitude = rms
      const now = Date.now()
      if (lastSampleAt > 0) {
        // 切到后台时 setInterval 会被节流到 1s+，不夹一下会把有效说话时长
        // 算爆（明明没说话也判定为「说了很久」）。
        const dt = Math.min((now - lastSampleAt) / 1000, 0.3)
        if (rms > SILENCE_RMS_THRESHOLD) activeSpeechSeconds += dt
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
        // 不再静音自动停止/弹答案：只负责把「答案提示」按钮亮出来，
        // 是否取消录音由用户点击按钮决定。
        if (lowVolumeStartAt === null) {
          lowVolumeStartAt = now
        } else if (now - lowVolumeStartAt >= LOW_VOLUME_HINT_MS) {
          hintCardVisible.value = true
          hintPulsing.value = true
        }
      }
    }, 100)
  }

  /** 这段录音到底算不算「说了话」。 */
  function judgeTake(durationSec: number): boolean {
    const analysisUsable = sawNonZeroSample
    if (!analysisUsable) {
      // 音量分析没工作（context 被挂起等）：不能靠它判空，按时长兜底放行，
      // 真正的空录音交给后端 ASR 判定。
      return durationSec >= MIN_FALLBACK_DURATION_SECONDS
    }
    if (activeSpeechSeconds >= MIN_ACTIVE_SPEECH_SECONDS) return true
    // 分析可用但有效时长不够：只要确实有超过噪声底的声音且录够 2 秒，也放行，
    // 避免语速慢 / 麦克风增益低的人被反复判「没听清」。
    return durationSec >= LENIENT_DURATION_SECONDS && maxAmplitude > SILENCE_RMS_THRESHOLD
  }

  async function startRecording() {
    if (disposed) return
    // 并发保护：启动中 / 录音中 / 收尾中都不能再开一路。
    if (phase.value !== 'idle') {
      console.warn(`[useRecorder] startRecording ignored (phase=${phase.value})`)
      return
    }
    const myTake = ++takeId
    phase.value = 'starting'
    lastError.value = null
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('当前浏览器不支持麦克风，请用 Chrome / Edge / Firefox 最新版。')
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      // 拿到权限期间可能已经被 teardown / 换了一次 take。
      if (disposed || myTake !== takeId) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      mediaStream = stream
      const mime = pickRecorderMime()
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      recordedMime = rec.mimeType || mime || 'audio/webm'
      recordedChunks = []
      maxAmplitude = 0
      activeSpeechSeconds = 0
      lastSampleAt = 0
      sawNonZeroSample = false
      analysisHealthy.value = false
      silenceStartAt = null
      lowVolumeStartAt = null
      hintCardVisible.value = false
      hintPulsing.value = false

      rec.ondataavailable = (e) => {
        if (myTake !== takeId) return
        if (e.data && e.data.size) recordedChunks.push(e.data)
      }
      rec.onerror = (e: any) => {
        console.error('[useRecorder] MediaRecorder error', e?.error || e)
        if (myTake !== takeId) return
        lastError.value = '录音过程中出错，请重新录制。'
        status.value = 'error'
        teardownAll()
      }
      rec.onstop = () => {
        // 只有仍是当前 take 才允许收尾 —— 否则会拆掉新一轮的 stream/context。
        if (disposed || myTake !== takeId) return
        const chunks = recordedChunks
        recordedChunks = []
        const durationSec = recordingStart ? (Date.now() - recordingStart) / 1000 : 0
        const blob = new Blob(chunks, { type: recordedMime })
        const wasHintStop = hintStopRequested
        hintStopRequested = false
        const gaveRealSpeech = blob.size > 0 && judgeTake(durationSec)

        // 先把状态收干净，再回调业务逻辑：这样 onNoAnswer / onSubmit 里
        // 立刻重新 startRecording() 也不会撞上还没释放的旧资源。
        teardownAll()
        status.value = 'idle'

        if (wasHintStop) {
          // 用户点击「答案提示」主动取消录音：弹窗已由
          // onUserRequestedSample 打开，这里不再触发任何提示。
          return
        }
        if (gaveRealSpeech) {
          blobToWav(blob)
            .then((wav) => {
              if (disposed) return
              opts.onSubmit(wav)
            })
            .catch((err) => {
              console.error('[useRecorder] blobToWav failed', err)
              if (disposed) return
              lastError.value = err?.message || '音频编码失败'
              status.value = 'error'
            })
        } else {
          // Hand the caller the original blob + a hint; they decide whether
          // to show the sample-answer modal or just complain.
          opts.onNoAnswer()
        }
      }

      // 设备被拔掉 / 被其他程序抢走：track 会 ended，但 MediaRecorder 不会报错，
      // 表现就是「一直在录，却永远录不到东西」。主动收掉并提示。
      stream.getTracks().forEach((t) => {
        t.onended = () => {
          if (disposed || myTake !== takeId) return
          console.warn('[useRecorder] mic track ended unexpectedly')
          lastError.value = '麦克风连接中断（设备被拔出或被其他程序占用），请检查后重试。'
          status.value = 'error'
          teardownAll()
          opts.onDeviceLost?.()
        }
      })

      rec.start(100)
      mediaRecorder = rec
      recordingStart = Date.now()
      elapsed.value = 0
      phase.value = 'recording'
      status.value = 'recording'
      teardownTimer()
      timerId = window.setInterval(() => {
        if (myTake !== takeId) return
        elapsed.value = (Date.now() - recordingStart) / 1000
      }, 200)

      // 波形先起，analyser 就绪后自动开始画（loop 里会等）。
      startWaveform(myTake)
      await setupAnalyser(stream, myTake)
    } catch (err: any) {
      console.error(err)
      if (myTake !== takeId) return
      lastError.value = micFriendlyMessage(err)
      status.value = err?.name === 'NotAllowedError' ? 'denied' : 'error'
      teardownAll()
    }
  }

  function stopRecording() {
    if (phase.value === 'idle' || phase.value === 'stopping') return
    if (phase.value === 'starting') {
      // 还没真正开录就被叫停（用户快速连点）：直接放弃这一次。
      teardownAll()
      return
    }
    // 注意：不要在这里把 phase 直接置 idle。stop() 是异步的，
    // 数据要等 onstop 才完整；置 idle 会让按钮立刻变回「开始录制」，
    // 用户再点一下就开出第二路录音。
    phase.value = 'stopping'
    hintCardVisible.value = false
    hintPulsing.value = false
    teardownTimer()
    stopWaveform()
    const rec = mediaRecorder
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop()
      } catch (err) {
        console.warn('[useRecorder] stop() threw', err)
        teardownAll()
      }
    } else {
      // 没有可停的 recorder（异常状态）：自己收尾，别把 UI 卡在 stopping。
      teardownAll()
    }
  }

  function userClickedHint(hasSampleAnswer: boolean) {
    if (phase.value !== 'recording') return
    // 必须先置位：onUserRequestedSample（打开弹窗）内部也会调用 stopRecording()，
    // 晚置位的话 onstop 会误判成「没听清」再弹一次提示。
    if (hasSampleAnswer) hintStopRequested = true
    if (opts.onUserRequestedSample) opts.onUserRequestedSample()
    if (hasSampleAnswer) stopRecording()
  }

  function teardown() {
    disposed = true
    teardownAll()
    status.value = 'idle'
  }

  onUnmounted(teardown)

  return {
    phase,
    recording,
    busy,
    elapsed,
    status,
    lastError,
    analysisHealthy,
    hintCardVisible,
    hintPulsing,
    startRecording,
    stopRecording,
    userClickedHint,
    bindCanvas,
    teardown,
  }
}
