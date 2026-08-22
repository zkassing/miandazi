<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useInterviewStore } from '@/stores/interview'
import { useRecorder } from '@/composables/useRecorder'
import { useToast } from '@/composables/useToast'
import { base64ToBlobUrl, fmtTime } from '@/composables/useAudio'
import { addMarker } from '@/api'
import Orb from '@/components/Orb.vue'
import TopicChip from '@/components/TopicChip.vue'
import SampleAnswerModal from '@/components/SampleAnswerModal.vue'
import IconMic from '@/components/IconMic.vue'
import IconVolume from '@/components/IconVolume.vue'
import IconStop from '@/components/IconStop.vue'
import IconBack from '@/components/IconBack.vue'
import IconBulb from '@/components/IconBulb.vue'
import IconFlag from '@/components/IconFlag.vue'

const interview = useInterviewStore()
const router = useRouter()
const toast = useToast()

const orbState = ref<'speaking' | 'listening' | 'thinking' | 'idle'>('listening')
const hintText = ref('点击下方按钮开始回答')
const audioNeedsReplay = ref(false)
const topic = ref<string | null>(null)
const transcript = ref('')
const sampleModalOpen = ref(false)
const cooldownRemain = ref(0)
/** 正在把音频提交给后端（转写 + 出下一题）—— 期间麦克风按钮必须禁用。 */
const submitting = ref(false)
/** 正在结束面试 / 生成报告：幂等守卫，避免自动结束与手动点击两路并发。 */
const finishing = ref(false)
/** 报告生成已用秒数，用于 loading 进度提示（推理模型往往要 15-40s）。 */
const finishElapsed = ref(0)
let finishTimer: number | null = null
let cooldownTimer: number | null = null
let autoStartTimer: number | null = null
let audioEl: HTMLAudioElement | null = null
let autoRecordOnTtsEnd = true
/** 组件已卸载：所有异步回调都不再碰 UI / 录音。 */
let viewDisposed = false

const waveCanvas = ref<HTMLCanvasElement | null>(null)

/**
 * 所有「自动开始录音」都走这里。之前 TTS onended、冷却结束、以及用户点击
 * 三条路都各自调 startRecording()，判空只看 `recorder.recording`，
 * 而 MediaRecorder 启动是异步的 —— 于是会出现两路录音同时跑，
 * 后停止的那路把前一路的 stream/波形拆掉：波形消失、录音还在录、
 * 按钮状态错乱。现在统一在这里做串行化 + 前置条件检查。
 */
function requestStartRecording(delayMs = 0) {
  if (autoStartTimer != null) {
    clearTimeout(autoStartTimer)
    autoStartTimer = null
  }
  const go = () => {
    autoStartTimer = null
    if (viewDisposed) return
    if (interview.finished || submitting.value) return
    if (sampleModalOpen.value) return
    if (cooldownRemain.value > 0) return
    if (recorder.phase.value !== 'idle') return
    if (orbState.value === 'speaking') return
    void recorder.startRecording()
  }
  if (delayMs > 0) autoStartTimer = window.setTimeout(go, delayMs)
  else go()
}

const recorder = useRecorder({
  onSubmit: async (wav: Blob) => {
    if (!interview.sessionId || viewDisposed) return
    submitting.value = true
    orbState.value = 'thinking'
    hintText.value = '正在编码音频并转写…'
    try {
      const r = await interview.submitTake(wav, { language: 'zh' })
      if (viewDisposed) return
      if (r.emptyReason === 'no_speech_detected' || !r.transcript) {
        toast.show('没能听清你的回答，请再试一次。', true, 3500)
        orbState.value = 'listening'
        hintText.value = '点击麦克风重新作答'
        autoRecordOnTtsEnd = false
        return
      }
      const stripped = (r.transcript || '').replace(/[，。！？.,!?\s]/g, '')
      if (stripped.length < 2) {
        toast.show(`没能识别到有效回答（识别为「${r.transcript}」），请再试一次。`, true, 4000)
        orbState.value = 'listening'
        hintText.value = '点击麦克风重新作答'
        autoRecordOnTtsEnd = false
        return
      }
      transcript.value = `你说：${r.transcript}`
      topic.value = r.topic || null
      autoRecordOnTtsEnd = !r.endInterview
      if (r.endInterview) {
        interview.finished = true
        setTimeout(finishInterview, 1800)
      } else {
        // 必须先解锁 submitting，否则 playQuestionAudio 播完触发的
        // 自动开录会被 submitting 挡掉，用户看到「聆听中」却没有波形。
        submitting.value = false
        await playQuestionAudio()
      }
    } catch (err: any) {
      console.error(err)
      if (viewDisposed) return
      toast.show(`提交失败：${err.message}`, true)
      orbState.value = 'listening'
      hintText.value = '点击麦克风重试'
    } finally {
      submitting.value = false
    }
  },
  onShowSample: () => {
    if (interview.currentSampleAnswer) openSampleModal()
  },
  onNoAnswer: () => {
    // 没有有效语音就结束录音（如手动停止）时，只轻提示，不弹答案弹窗；
    // 答案提示改为录音中显示按钮、由用户主动点击查看。
    if (viewDisposed) return
    toast.show('没有听清内容，请再试一次。', true, 3500)
    orbState.value = 'listening'
    hintText.value = '点击麦克风重新作答'
  },
  onUserRequestedSample: () => {
    // 用户点击「答案提示」按钮：停止录音并打开参考答案弹窗。
    openSampleModal()
  },
  onDeviceLost: () => {
    if (viewDisposed) return
    orbState.value = 'listening'
    hintText.value = '麦克风连接中断，请检查设备后点击麦克风重试'
  },
})

const showWave = computed(() => recorder.recording.value)
const waveHealthy = computed(() => recorder.analysisHealthy.value)
const showHintCard = computed(() => recorder.hintCardVisible.value)
const hintPulsing = computed(() => recorder.hintPulsing.value)
const timerText = computed(() => fmtTime(recorder.elapsed.value))
/** 启动/收尾中或正在提交 —— 禁用麦克风按钮，避免并发开录、状态错乱。 */
const micDisabled = computed(
  () => cooldownRemain.value > 0 || recorder.busy.value || submitting.value,
)
const micLabel = computed(() => {
  if (submitting.value) return '处理中'
  if (recorder.phase.value === 'starting') return '启动中'
  if (recorder.phase.value === 'stopping') return '收尾中'
  return recorder.recording.value ? '停止录音' : '开始录音'
})

// 麦克风不可用 / 被拒绝时，在页面上给出明确提示（此前只在控制台报错）。
watch(recorder.status, (s) => {
  if (viewDisposed) return
  if (s === 'denied' || s === 'error') {
    toast.show(recorder.lastError.value || '麦克风不可用，请检查设备后重试', true, 4500)
    orbState.value = 'listening'
    hintText.value = '麦克风不可用，请检查设备后点击重试'
    // 麦克风出错后不要再自动开录，否则会反复弹错误提示。
    autoRecordOnTtsEnd = false
    if (autoStartTimer != null) {
      clearTimeout(autoStartTimer)
      autoStartTimer = null
    }
  }
})

function openSampleModal() {
  sampleModalOpen.value = true
  if (autoStartTimer != null) {
    clearTimeout(autoStartTimer)
    autoStartTimer = null
  }
  recorder.stopRecording()
}

function closeSampleModal() {
  sampleModalOpen.value = false
  orbState.value = 'listening'
  startCooldown(3000) // 关闭答案弹窗后等 3s 自动重新录音（原 5s）
}

function startCooldown(ms: number) {
  cooldownRemain.value = Math.ceil(ms / 1000)
  if (cooldownTimer != null) clearInterval(cooldownTimer)
  hintText.value = `请等待 ${cooldownRemain.value} 秒后重新作答…`
  cooldownTimer = window.setInterval(() => {
    cooldownRemain.value -= 1
    if (cooldownRemain.value <= 0) {
      if (cooldownTimer != null) clearInterval(cooldownTimer)
      cooldownTimer = null
      orbState.value = 'listening'
      // 关闭答案弹窗后的等待结束后，自动重新开始录音。
      hintText.value = '正在聆听，请开始回答…'
      requestStartRecording()
    } else {
      hintText.value = `请等待 ${cooldownRemain.value} 秒后重新作答…`
    }
  }, 1000)
}

async function playQuestionAudio() {
  if (!interview.lastQuestionAudio?.audioBase64) {
    orbState.value = 'listening'
    hintText.value = '点击麦克风开始回答'
    return
  }
  orbState.value = 'speaking'
  hintText.value = '面搭子正在说…'
  audioNeedsReplay.value = false

  // Tear down the previous audio element cleanly so its handlers can't
  // fire after we've moved on (which would cause the misleading "播放失败"
  // toast when the user is on the next turn).
  if (audioEl) {
    audioEl.onended = null
    audioEl.onerror = null
    audioEl.oncanplay = null
    try { audioEl.pause() } catch { /* noop */ }
    try { audioEl.removeAttribute('src') } catch { /* noop */ }
    audioEl.load()
  }

  // Make sure we have an <audio> element attached to the DOM. Detached
  // `new Audio()` works in some browsers but is unreliable in Edge/Chrome
  // when the source is a blob: URL with PCM WAV — the element sometimes
  // fires `error` before `loadedmetadata`. An attached element behaves
  // the same as a regular <audio src> in the HTML and never errors out
  // this way.
  let a = audioEl
  if (!a || !a.isConnected) {
    a = document.createElement('audio')
    a.preload = 'auto'
    a.setAttribute('aria-hidden', 'true')
    a.style.display = 'none'
    document.body.appendChild(a)
  }
  audioEl = a

  const url = base64ToBlobUrl(
    interview.lastQuestionAudio.audioBase64,
    interview.lastQuestionAudio.mime,
  )
  // Cache the latest URL so onReplayClick can reuse it without rebuilding
  // (saves a 200KB allocation per replay).
  lastQuestionUrl.value = url
  a.src = url
  a.load()

  a.onended = () => {
    URL.revokeObjectURL(url)
    if (lastQuestionUrl.value === url) lastQuestionUrl.value = null
    orbState.value = 'listening'
    hintText.value = '点击麦克风开始回答'
    audioNeedsReplay.value = false
    if (autoRecordOnTtsEnd && !interview.finished) {
      if (sampleModalOpen.value) return
      autoRecordOnTtsEnd = false
      // 稍等一下让 orbState 更新落地，再走统一的串行入口。
      requestStartRecording(250)
    }
  }
  a.onerror = () => {
    // Distinguish the common autoplay-blocked case from a real codec error.
    // Autoplay shows up as MEDIA_ERR_SRC_NOT_SUPPORTED on some browsers when
    // they refuse to start a media element without a user gesture, even
    // though the data is perfectly fine.
    const code = a.error?.code
    const message = a.error?.message
    console.warn('[interview] audio element error', { code, message })
    orbState.value = 'listening'
    if (code === 1 /* MEDIA_ERR_ABORTED — we caused it by tearing down */) {
      // user navigated away / next turn started — don't toast
      return
    }
    audioNeedsReplay.value = true
    hintText.value = '点击右下角"重听题目"重试'
    if (interview.finished || !autoRecordOnTtsEnd) {
      // user has already seen the question text — keep it quiet
    } else {
      toast.show('自动播放被浏览器拦截，请点击"重听题目"', false, 4500)
    }
  }
  try {
    await a.play()
    // play() resolved — the audio is now actually playing. Clear the
    // "needs replay" flag so the button styling goes back to normal.
    audioNeedsReplay.value = false
  } catch (err: any) {
    // play() rejects with NotAllowedError when the browser blocks autoplay
    console.warn('[interview] audio play() rejected:', err?.name, err?.message)
    orbState.value = 'listening'
    audioNeedsReplay.value = true
    hintText.value = '点击右下角"重听题目"重试'
    if (!interview.finished && autoRecordOnTtsEnd) {
      toast.show('点击右下角"重听题目"按钮收听题目', false, 4500)
    }
  }
}

// Cache the blob URL for the current question so re-clicking "重听题目"
// doesn't need to decode base64 again.
const lastQuestionUrl = ref<string | null>(null)

function onReplayClick() {
  // If we have a cached URL + a still-attached audio element, just hit
  // play() on it. If the autoplay block was the cause of the previous
  // failure, this click is a user gesture and the browser will allow it.
  if (audioEl && audioEl.isConnected && lastQuestionUrl.value) {
    audioEl.currentTime = 0
    const p = audioEl.play()
    if (p && typeof p.then === 'function') {
      p.catch((err) => {
        console.warn('[interview] replay play() rejected:', err?.message)
        // As a last resort, rebuild the URL and try again
        playQuestionAudio()
      })
    }
    return
  }
  // No cached state — fall back to a full rebuild
  playQuestionAudio()
}

function onMicClick() {
  // 启动中 / 收尾中 / 提交中一律忽略：这正是「点一下变回开始录制、
  // 再点又开一路」的来源。
  if (recorder.busy.value || submitting.value) return
  if (recorder.recording.value) {
    recorder.stopRecording()
    return
  }
  if (cooldownRemain.value > 0) {
    toast.show(`请等待 ${cooldownRemain.value} 秒后再试`, true, 1500)
    return
  }
  // 用户手动点击时不受 orbState === 'speaking' 限制：先把题目语音停掉。
  if (orbState.value === 'speaking') stopQuestionAudio()
  autoRecordOnTtsEnd = false
  requestStartRecording()
}

function onHintClick() {
  if (!recorder.recording.value) return
  if (!interview.currentSampleAnswer) {
    toast.show('这道题还没有参考答案～继续试试吧！', false, 2500)
    return
  }
  recorder.userClickedHint(true)
}

function stopQuestionAudio() {
  if (audioEl) {
    try { audioEl.pause() } catch { /* noop */ }
  }
  orbState.value = 'listening'
  hintText.value = '点击麦克风开始回答'
}

function onExitClick() {
  if (!confirm('确定退出当前面试？已进行的对话不会被保存。')) return
  cleanup()
  router.push('/')
}

async function onEndClick() {
  if (finishing.value) return
  if (!confirm('确定结束本场面试并查看报告吗？')) return
  await finishInterview()
}

async function onMarkerClick() {
  if (!interview.sessionId) {
    toast.show('当前没有可标记的面试', true)
    return
  }
  // Mark the *current* round — the one whose question is on screen and
  // which the candidate is currently answering (or about to answer).
  const round = interview.currentRound
  try {
    await addMarker(interview.sessionId, round)
    toast.show(`已标记第 ${round} 轮（会在报告里显示）`, false, 2000)
  } catch (err: any) {
    toast.show(`标记失败：${err.message}`, true)
  }
}

/**
 * 结束面试 → 生成报告 → 跳报告页。
 *
 * 之前这里一旦 loadReport 抛错（DeepSeek 推理把 token 吃完 → 后端 502），
 * 只弹一个 toast：不跳页、不复位、录音已 teardown，页面就永远停在
 * 「正在生成面试报告…」—— 这就是「结束面试后一直不结束」。
 * 现在：幂等守卫 + 计时提示 + 无论成败都跳到报告页（报告页自带
 * turns 兜底渲染与重试按钮）。
 */
async function finishInterview() {
  if (!interview.sessionId) return
  // 幂等：`endInterview` 自动触发的 setTimeout 和用户手动点「结束面试」
  // 可能重叠，两路并发发报告请求会让状态更乱。
  if (finishing.value) return
  finishing.value = true
  cleanup()
  orbState.value = 'thinking'
  finishElapsed.value = 0
  hintText.value = '正在生成面试报告（预计 15-40 秒）…'
  finishTimer = window.setInterval(() => {
    finishElapsed.value += 1
    const s = finishElapsed.value
    hintText.value =
      s < 45
        ? `正在生成面试报告… ${s}s（预计 15-40 秒，请不要关闭页面）`
        : `报告生成较慢，正在重试… ${s}s`
  }, 1000)
  try {
    await interview.endManually()
    await interview.loadReport()
    if (interview.report?.degraded) {
      toast.show(
        `AI 评分未生成（${interview.report.degraded_reason || '未知原因'}），` +
          `已先展示完整对话记录，可在报告页点「重新生成报告」重试。`,
        true,
        6000,
      )
    }
  } catch (err: any) {
    console.error(err)
    toast.show(`生成报告失败：${err.message}（已保留对话记录，可在报告页重试）`, true, 6000)
  } finally {
    if (finishTimer != null) {
      clearInterval(finishTimer)
      finishTimer = null
    }
    finishing.value = false
    // 关键：无论报告是否生成成功都要离开本页。否则录音已 teardown、
    // 提示文案停在 loading，用户除了刷新没有任何出路。
    router.push('/report')
  }
}

function cleanup() {
  if (autoStartTimer != null) {
    clearTimeout(autoStartTimer)
    autoStartTimer = null
  }
  if (audioEl) {
    try { audioEl.onended = null } catch { /* noop */ }
    try { audioEl.onerror = null } catch { /* noop */ }
    try { audioEl.oncanplay = null } catch { /* noop */ }
    try { audioEl.pause() } catch { /* noop */ }
    try { audioEl.removeAttribute('src') } catch { /* noop */ }
    try { audioEl.load() } catch { /* noop */ }
    if (audioEl.parentNode) audioEl.parentNode.removeChild(audioEl)
    audioEl = null
  }
  if (lastQuestionUrl.value) {
    try { URL.revokeObjectURL(lastQuestionUrl.value) } catch { /* noop */ }
    lastQuestionUrl.value = null
  }
  if (cooldownTimer != null) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
  recorder.teardown()
}

onMounted(async () => {
  // Bind the canvas AFTER mount — template refs are null during <script setup>.
  recorder.bindCanvas(waveCanvas.value)
  // Auto-play the first question.
  topic.value = null
  await playQuestionAudio()
})

onBeforeUnmount(() => {
  viewDisposed = true
  if (finishTimer != null) {
    clearInterval(finishTimer)
    finishTimer = null
  }
  cleanup()
})

const questionText = computed(() => interview.lastQuestion || '…')
const roundText = computed(() => `第 ${interview.currentRound || 1} 轮 · 自由时长`)
</script>

<template>
  <main class="iv-root">
    <div class="iv-top">
      <button class="btn-ghost" type="button" @click="onExitClick">
        <IconBack :size="14" />
        退出
      </button>
      <div class="iv-progress">
        <div class="iv-progress-text">{{ roundText }}</div>
        <div class="iv-progress-bar">
          <div class="iv-progress-fill" style="width: 100%"></div>
        </div>
      </div>
      <TopicChip :topic="topic" />
    </div>

    <div class="iv-stage">
      <Orb :state="orbState" />
      <div v-show="showWave" class="iv-wave-wrap" aria-hidden="true">
        <canvas ref="waveCanvas" height="96" class="iv-wave-canvas"></canvas>
        <span class="iv-wave-live">LIVE</span>
        <span v-if="!waveHealthy" class="iv-wave-warn">正在连接麦克风…</span>
      </div>
      <div class="iv-state">{{ hintText }}</div>
      <div class="iv-question">{{ questionText }}</div>
      <button
        v-if="orbState === 'speaking'"
        type="button"
        class="iv-skip-audio"
        @click="stopQuestionAudio"
      >
        跳过语音 →
      </button>

      <button
        v-show="showHintCard"
        class="iv-hint-card"
        :class="{ pulsing: hintPulsing }"
        type="button"
        aria-label="显示参考答案"
        @click="onHintClick"
      >
        <span class="iv-hint-pulse" aria-hidden="true"></span>
        <span class="iv-hint-finger" aria-hidden="true">👆</span>
        <span class="iv-hint-icon" aria-hidden="true">
          <IconBulb :size="14" />
        </span>
        <span class="iv-hint-text">
          卡住了？点我查看<strong>参考答案</strong>
        </span>
      </button>

      <div v-if="transcript" class="iv-transcript">{{ transcript }}</div>
    </div>

    <div class="iv-controls">
      <button
        class="iv-mic"
        :class="{ recording: recorder.recording.value, busy: recorder.busy.value || submitting }"
        type="button"
        :disabled="micDisabled"
        :title="micLabel"
        :aria-label="micLabel"
        @click="onMicClick"
      >
        <span class="iv-mic-icon">
          <IconMic :size="30" />
        </span>
      </button>
      <div class="iv-mic-meta">
        <div class="iv-timer">{{ timerText }}</div>
        <div class="iv-mic-label">{{ micLabel }}</div>
      </div>
      <div class="iv-actions">
        <button
          class="btn-ghost marker-btn"
          type="button"
          title="标记当前轮（用于报告）"
          @click="onMarkerClick"
        >
          <IconFlag :size="14" />
          标记
        </button>
        <button
          class="btn-ghost"
          :class="{ 'btn-accent': audioNeedsReplay }"
          type="button"
          @click="onReplayClick"
        >
          <IconVolume :size="14" />
          重听题目
        </button>
        <button
          class="btn-ghost"
          type="button"
          :disabled="finishing"
          @click="onEndClick"
        >
          <IconStop :size="14" />
          {{ finishing ? '生成报告中…' : '结束面试' }}
        </button>
      </div>
    </div>

    <SampleAnswerModal
      :open="sampleModalOpen"
      :answer="interview.currentSampleAnswer"
      @close="closeSampleModal"
    />
  </main>
</template>

<style scoped>
.iv-root {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--ink);
  overflow: hidden;
}

/* ---------- Top bar ---------- */
.iv-top {
  flex-shrink: 0;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  align-items: center;
  gap: 16px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--line);
  background: rgba(17, 17, 20, 0.6);
  backdrop-filter: blur(8px);
}
.iv-progress {
  text-align: center;
}
.iv-progress-text {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--paper-300);
  margin-bottom: 6px;
}
.iv-progress-bar {
  height: 3px;
  background: var(--ink-3);
  border-radius: 999px;
  overflow: hidden;
}
.iv-progress-fill {
  height: 100%;
  background: var(--signal-soft);
  transition: width 0.3s ease;
}
.iv-top > :last-child {
  justify-self: end;
}

/* ---------- Stage ---------- */
.iv-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 24px;
  padding: 36px 24px;
  overflow-y: auto;
}

.iv-wave-wrap {
  position: relative;
  width: 100%;
  max-width: 600px;
  background: rgba(24, 24, 28, 0.55);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.iv-wave-canvas {
  width: 100%;
  height: 96px;
  display: block;
}
.iv-wave-live {
  position: absolute;
  top: 8px;
  right: 12px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.2em;
  color: var(--danger);
  text-transform: uppercase;
  animation: live-blink 1.2s ease-in-out infinite;
}
.iv-wave-warn {
  position: absolute;
  top: 8px;
  left: 12px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--paper-400);
  text-transform: uppercase;
}
@keyframes live-blink {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

.iv-state {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--paper-400);
}
.iv-skip-audio {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--paper-500);
  background: transparent;
  border: 1px solid var(--line-300);
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.15s ease;
  margin-top: 8px;
}
.iv-skip-audio:hover {
  color: var(--paper-200);
  border-color: var(--accent-500);
  background: rgba(255, 255, 255, 0.04);
}
.iv-question {
  max-width: 720px;
  font-size: 22px;
  line-height: 1.7;
  font-weight: 400;
  color: var(--paper-100);
  text-align: center;
}
.iv-transcript {
  max-width: 720px;
  font-size: 14px;
  color: var(--paper-300);
  background: var(--ink-3);
  padding: 10px 18px;
  border-radius: 10px;
  border: 1px solid var(--line);
  font-style: italic;
  line-height: 1.7;
  text-align: center;
}

/* ---------- Hint card ---------- */
.iv-hint-card {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  padding: 12px 22px;
  background: linear-gradient(135deg, var(--ember-wash), rgba(255, 122, 77, 0.06));
  border: 1px solid rgba(255, 122, 77, 0.35);
  border-radius: var(--r-pill);
  color: var(--paper-100);
  font-family: var(--sans);
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  cursor: pointer;
  overflow: visible;
  transition: transform var(--dur-fast) var(--ease-out);
}
.iv-hint-card:hover {
  background: linear-gradient(135deg, rgba(255, 122, 77, 0.22), rgba(255, 122, 77, 0.1));
  border-color: var(--ember);
  color: var(--paper-100);
  transform: translateY(-1px);
}
.iv-hint-card .iv-hint-icon {
  display: inline-flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(255, 122, 77, 0.22);
  color: var(--ember);
  flex-shrink: 0;
}
.iv-hint-card .iv-hint-text strong {
  color: var(--ember);
  font-weight: 700;
  margin: 0 1px;
}
.iv-hint-card .iv-hint-finger {
  font-size: 18px;
  line-height: 1;
}
.iv-hint-card .iv-hint-pulse {
  position: absolute;
  inset: -2px;
  border-radius: var(--r-pill);
  pointer-events: none;
  opacity: 0;
}
.iv-hint-card .iv-hint-pulse::before,
.iv-hint-card .iv-hint-pulse::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  border: 2px solid var(--ember);
  opacity: 0;
}
.iv-hint-card.pulsing .iv-hint-pulse::before {
  animation: hint-pulse 1.6s ease-out infinite;
}
.iv-hint-card.pulsing .iv-hint-pulse::after {
  animation: hint-pulse 1.6s ease-out infinite 0.8s;
}
.iv-hint-card.pulsing .iv-hint-finger {
  animation: hint-finger 1.2s ease-in-out infinite;
}
.iv-hint-card.pulsing {
  animation: hint-card-jiggle 2.4s ease-in-out infinite;
}
@keyframes hint-pulse {
  0% {
    opacity: 0.75;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(1.35);
  }
}
@keyframes hint-finger {
  0%, 100% {
    transform: translateY(0) rotate(0);
  }
  50% {
    transform: translateY(-5px) rotate(-8deg);
  }
}
@keyframes hint-card-jiggle {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(255, 122, 77, 0.35);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(255, 122, 77, 0);
  }
}

/* ---------- Bottom controls ---------- */
.iv-controls {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 22px 24px;
  border-top: 1px solid var(--line);
  background: rgba(17, 17, 20, 0.72);
  backdrop-filter: blur(8px);
}
.iv-mic {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--signal), var(--signal-deep));
  color: #fff;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 0 rgba(37, 64, 255, 0.5);
  transition: all 0.2s;
  flex-shrink: 0;
  padding: 0;
  font-size: 26px;
  letter-spacing: 0;
  text-transform: none;
}
.iv-mic:hover {
  transform: scale(1.05);
  background: linear-gradient(135deg, var(--signal-soft), var(--signal-deep));
}
.iv-mic.recording {
  background: linear-gradient(135deg, var(--danger), #dc2626);
  box-shadow: 0 0 0 12px rgba(248, 113, 113, 0.18), 0 0 30px rgba(248, 113, 113, 0.5);
  animation: mic-pulse 1.4s ease-in-out infinite;
}
@keyframes mic-pulse {
  0%, 100% {
    box-shadow: 0 0 0 8px rgba(248, 113, 113, 0.18), 0 0 30px rgba(248, 113, 113, 0.5);
  }
  50% {
    box-shadow: 0 0 0 18px rgba(248, 113, 113, 0.05), 0 0 40px rgba(248, 113, 113, 0.6);
  }
}
.iv-mic:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.iv-mic.busy {
  animation: none;
  background: linear-gradient(135deg, var(--ink-3), var(--ink-2));
  box-shadow: none;
}
.iv-mic.busy .iv-mic-icon {
  animation: mic-busy-fade 1s ease-in-out infinite;
}
@keyframes mic-busy-fade {
  0%, 100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
.iv-mic-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 72px;
}
.iv-mic-label {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--paper-400);
}
.iv-timer {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 15px;
  color: var(--paper-300);
  min-width: 60px;
}
.iv-actions {
  margin-left: auto;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.btn-accent {
  color: var(--accent-300) !important;
  border-color: var(--accent-500) !important;
  background: rgba(91, 156, 255, 0.08) !important;
  animation: iv-pulse-accent 1.4s ease-in-out infinite;
}
@keyframes iv-pulse-accent {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(91, 156, 255, 0.45);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(91, 156, 255, 0);
  }
}
.marker-btn {
  color: var(--ember);
  border-color: rgba(255, 122, 77, 0.35);
}
.marker-btn:hover {
  background: var(--ember-wash);
  border-color: var(--ember);
  color: var(--ember);
}

@media (max-width: 640px) {
  .iv-question {
    font-size: 18px;
  }
  .iv-mic {
    width: 60px;
    height: 60px;
  }
  .iv-controls {
    padding: 16px;
    gap: 12px;
  }
  .iv-hint-card {
    font-size: 13px;
    padding: 10px 18px;
  }
}
</style>
