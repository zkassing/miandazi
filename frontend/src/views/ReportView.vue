<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useInterviewStore } from '@/stores/interview'
import { useToast } from '@/composables/useToast'
import { audioUrl, fetchHistoryDetail, addMarker } from '@/api'
import IconDownload from '@/components/IconDownload.vue'
import IconRestart from '@/components/IconRestart.vue'
import IconBulb from '@/components/IconBulb.vue'
import IconTarget from '@/components/IconTarget.vue'
import IconFlag from '@/components/IconFlag.vue'
import IconArrowLeft from '@/components/IconArrowLeft.vue'
import type {
  HistoryMarker,
  HistorySession,
  HistoryTurn,
  InterviewReport,
  PerQuestionItem,
} from '@/types'

const interview = useInterviewStore()
const route = useRoute()
const router = useRouter()
const toast = useToast()
const report = ref<InterviewReport | null>(null)
const loading = ref(true)

const historyMode = computed(() => Boolean(route.params.id))
const historySession = ref<HistorySession | null>(null)
const historyTurns = ref<HistoryTurn[]>([])
const historyMarkers = ref<HistoryMarker[]>([])
const isReadOnly = computed(() => historyMode.value)

const scoreCircleEl = ref<HTMLDivElement | null>(null)
const radarCanvas = ref<HTMLCanvasElement | null>(null)

const VERDICT_LABEL: Record<string, string> = {
  strong_hire: '强烈推荐',
  hire: '推荐',
  lean_hire: '倾向推荐',
  no_hire: '不推荐',
  strong_no_hire: '强烈不推荐',
}

const sub = computed(() => {
  const r = report.value
  const date = new Date(
    (historySession.value?.started_at || interview.sessionId ? Date.now() : Date.now()),
  ).toLocaleString()
  const direction = historySession.value?.direction || interview.direction
  const rounds =
    (historyTurns.value.length || interview.turns.length || 0)
  return `${direction} · 共 ${rounds} 轮 · ${date}`
})

const overall = computed(() => {
  const fromReport = Number(report.value?.scores?.overall || 0)
  if (fromReport > 0) return fromReport
  // Fall back to the SQLite-cached final_score for finished history sessions
  if (historySession.value?.final_score != null) {
    return Number(historySession.value.final_score)
  }
  return 0
})
const verdict = computed(() => report.value?.verdict || '—')
const verdictLabel = computed(() => VERDICT_LABEL[verdict.value] || verdict.value)
const verdictClass = computed(() => `verdict ${String(verdict.value).replace('_', '-')}`)
const overallText = computed(() => overall.value.toFixed(1))

const items = computed<PerQuestionItem[]>(() => {
  const r = report.value
  if (r?.per_question?.length) return r.per_question
  // In history mode, fall back to the persisted turns
  if (historyMode.value && historyTurns.value.length) {
    return historyTurns.value.map((t) => ({
      round: t.round,
      question: t.question,
      answer: t.answer,
      score: 0,
      comment: '（无点评）',
      better_answer: '',
    }))
  }
  return interview.turns.map((t, i) => ({
    round: i + 1,
    question: t.question,
    answer: t.answer,
    score: 0,
    comment: '（无点评）',
    better_answer: '',
  }))
})

/** Map turn round → turn row (for audio + per-turn markers). */
const turnByRound = computed(() => {
  const m = new Map<number, HistoryTurn>()
  for (const t of historyTurns.value) m.set(t.round, t)
  return m
})

const markersByRound = computed(() => {
  const m = new Map<number, HistoryMarker[]>()
  for (const mk of historyMarkers.value) {
    if (!m.has(mk.round)) m.set(mk.round, [])
    m.get(mk.round)!.push(mk)
  }
  return m
})

const improvements = computed(() => {
  const list = (report.value?.improvements || []).filter((s) => s && s.trim())
  if (list.length) return list
  return [
    '保持麦克风环境安静，讲话时贴近设备，避免背景噪音干扰转写。',
    '建议采用总-分-总结构：先给出结论，再用 1–2 个例子论证，最后总结。',
    '控制每个回答在 1–2 分钟内，避免超时被自动暂停。',
  ]
})

const summary = computed(
  () => report.value?.summary || '本次面试未收集到足够信息，请重新参加一次面试。',
)

// 后端在空 answer 上放的是 `（候选人未作答或本轮无回答）` 这样的 prompt 占位符，
// 在 UI 上统一替换为短的 `（未作答）`。
const NO_ANSWER_TOKENS = ['（候选人未作答或本轮无回答）', '（未作答）', '（无回答）']
function cleanAnswer(text?: string): string {
  if (!text) return ''
  const t = String(text).trim()
  if (!t) return ''
  if (NO_ANSWER_TOKENS.includes(t)) return ''
  return t
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
  }
  return String(s).replace(/[<>&"]/g, (c) => map[c] ?? c)
}

function drawScoreCircle(pct: number) {
  if (!scoreCircleEl.value) return
  const deg = Math.max(0, Math.min(360, (pct / 100) * 360))
  const color =
    pct >= 80
      ? 'var(--green)'
      : pct >= 60
        ? 'var(--primary, var(--signal))'
        : pct >= 40
          ? 'var(--yellow)'
          : 'var(--red)'
  scoreCircleEl.value.style.background = `conic-gradient(${color} ${deg}deg, var(--bg-3) ${deg}deg)`
}

function drawRadar(scores: Record<string, number>) {
  const canvas = radarCanvas.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const cssW = canvas.clientWidth || 360
  const cssH = canvas.clientHeight || 360
  canvas.width = cssW * dpr
  canvas.height = cssH * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  const labels = ['逻辑', '表达', '深度', '匹配', '应变']
  const keys = ['logic', 'expression', 'depth', 'relevance', 'adaptability']
  const values = keys.map((k) => Number(scores[k] || 0))
  const n = labels.length
  const cx = cssW / 2
  const cy = cssH / 2
  const radius = Math.min(cx, cy) - 40

  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 1
  for (let r = 1; r <= 5; r++) {
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI * 2 * i) / n - Math.PI / 2
      const rr = (radius * r) / 5
      const x = cx + Math.cos(ang) * rr
      const y = cy + Math.sin(ang) * rr
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  for (let i = 0; i < n; i++) {
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(ang) * radius, cy + Math.sin(ang) * radius)
    ctx.stroke()
  }
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(10, values[i])) / 10
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2
    const x = cx + Math.cos(ang) * radius * v
    const y = cy + Math.sin(ang) * radius * v
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
  grad.addColorStop(0, 'rgba(124, 140, 255, 0.4)')
  grad.addColorStop(1, 'rgba(124, 140, 255, 0.05)')
  ctx.fillStyle = grad
  ctx.fill()
  ctx.strokeStyle = 'rgba(124, 140, 255, 0.9)'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fillStyle = '#7c8cff'
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(10, values[i])) / 10
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2
    const x = cx + Math.cos(ang) * radius * v
    const y = cy + Math.sin(ang) * radius * v
    ctx.beginPath()
    ctx.arc(x, y, 4, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#e7eaf2'
  ctx.font = '13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < n; i++) {
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2
    const x = cx + Math.cos(ang) * (radius + 22)
    const y = cy + Math.sin(ang) * (radius + 22)
    ctx.fillText(`${labels[i]} ${values[i].toFixed(1)}`, x, y)
  }
}

function buildMarkdown(): string {
  const r = report.value
  if (!r) return ''
  const lines: string[] = []
  lines.push(`# 面试报告 — ${interview.direction}`)
  lines.push('')
  lines.push(`> 时间：${new Date().toLocaleString()}`)
  lines.push(`> 轮数：${interview.turns.length} 轮`)
  lines.push(`> 综合分：**${(r.scores?.overall || 0).toFixed(1)} / 10**`)
  lines.push(`> 结论：${r.verdict || '—'}`)
  lines.push('')
  lines.push('## 评分维度')
  lines.push('| 维度 | 分数 |')
  lines.push('| --- | --- |')
  const LABELS: Record<string, string> = {
    logic: '逻辑',
    expression: '表达',
    depth: '深度',
    relevance: '匹配',
    adaptability: '应变',
  }
  for (const k of ['logic', 'expression', 'depth', 'relevance', 'adaptability']) {
    lines.push(`| ${LABELS[k]} | ${(r.scores?.[k as keyof typeof r.scores] || 0).toFixed(1)} |`)
  }
  lines.push('')
  lines.push('## 总评')
  lines.push(summary.value)
  lines.push('')
  lines.push('## 改进建议')
  for (const s of improvements.value) lines.push(`- ${s}`)
  lines.push('')
  lines.push('## 逐轮点评')
  for (const it of items.value) {
    lines.push(`### 第 ${it.round} 轮 · 评分 ${(it.score || 0).toFixed(1)}`)
    lines.push(`- **提问**：${it.question || ''}`)
    lines.push(`- **回答**：${cleanAnswer(it.answer) || '（未作答）'}`)
    lines.push(`- **点评**：${it.comment || ''}`)
    if (it.better_answer) lines.push(`- **建议回答**：${it.better_answer}`)
    lines.push('')
  }
  return lines.join('\n')
}

function buildPlainText(): string {
  return buildMarkdown()
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/^\|.*\|$/gm, '')
}

function downloadFile(name: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function downloadMd() {
  try {
    downloadFile(`interview-report-${Date.now()}.md`, buildMarkdown(), 'text/markdown;charset=utf-8')
  } catch (err: any) {
    toast.show(`下载失败：${err.message}`, true)
  }
}
function downloadTxt() {
  try {
    downloadFile(`interview-report-${Date.now()}.txt`, buildPlainText())
  } catch (err: any) {
    toast.show(`下载失败：${err.message}`, true)
  }
}

async function restart() {
  await interview.reset()
  router.push('/')
}

async function onAddMarker(round: number) {
  const id = historySession.value?.id || interview.sessionId
  if (!id) {
    toast.show('当前没有可标记的面试', true)
    return
  }
  try {
    const m = await addMarker(id, round)
    if (historyMode.value) {
      historyMarkers.value = [...historyMarkers.value, m]
    } else {
      historyMarkers.value = [...historyMarkers.value, m]
    }
    toast.show(`已标记第 ${round} 轮`, false, 1800)
  } catch (err: any) {
    toast.show(`标记失败：${err.message}`, true)
  }
}

async function drawReportCharts() {
  await new Promise((r) => requestAnimationFrame(r))
  drawScoreCircle(overall.value * 10)
  drawRadar({
    logic: Number(report.value?.scores?.logic || 0),
    expression: Number(report.value?.scores?.expression || 0),
    depth: Number(report.value?.scores?.depth || 0),
    relevance: Number(report.value?.scores?.relevance || 0),
    adaptability: Number(report.value?.scores?.adaptability || 0),
  })
}

onMounted(async () => {
  try {
    const id = route.params.id as string | undefined
    if (id) {
      // History mode: load full snapshot from SQLite
      const detail = await fetchHistoryDetail(id)
      historySession.value = detail.session
      historyTurns.value = detail.turns
      historyMarkers.value = detail.markers
      // Use the cached report from SQLite (no LLM re-run needed)
      if (detail.report) {
        report.value = detail.report
      } else {
        // Fall back to LLM generation if we don't have a cached report
        try {
          const r = await fetch(`/api/interview/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: id }),
          })
          if (r.ok) {
            const d = await r.json()
            report.value = d.report
          }
        } catch {
          // No cached report — that's fine, we'll use the fallback rendering
        }
      }
    } else {
      if (!interview.report) {
        await interview.loadReport()
      }
      report.value = interview.report
    }
    await drawReportCharts()
  } catch (err: any) {
    console.error(err)
    toast.show(`加载报告失败：${err.message}`, true)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <main class="view-report">
    <section v-if="loading" class="card">
      <div class="card-body loading">正在加载报告…</div>
    </section>

    <template v-else>
      <section class="card report-hero">
        <div class="card-head">
          <span class="label">/ 评估报告</span>
          <span class="meta">REPORT</span>
        </div>
        <div class="report-hero-body">
          <div>
            <h2>面试报告 <span class="en">/ Review</span></h2>
            <p class="sub">{{ sub }}</p>
          </div>
          <div class="report-actions">
            <button v-if="historyMode" class="btn-ghost" type="button" @click="router.push('/history')">
              <IconArrowLeft :size="14" />
              返回历史
            </button>
            <button type="button" @click="downloadMd">
              <IconDownload :size="14" />
              下载 Markdown
            </button>
            <button type="button" @click="downloadTxt">
              <IconDownload :size="14" />
              下载 .txt
            </button>
            <button v-if="!historyMode" class="btn-ghost" type="button" @click="restart">
              <IconRestart :size="14" />
              再来一场
            </button>
          </div>
        </div>
      </section>

      <section class="card report-summary">
        <div class="score-big">
          <div ref="scoreCircleEl" class="score-circle">
            <span class="score-value">{{ overallText }}</span>
            <span class="score-label">综合分</span>
          </div>
          <div :class="verdictClass">{{ verdictLabel }}</div>
        </div>
        <div class="radar-wrap">
          <canvas ref="radarCanvas" width="360" height="360"></canvas>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <span class="label">/ 总评</span>
          <span class="meta">VERDICT</span>
        </div>
        <div class="card-body">
          <p class="report-summary-text">{{ summary }}</p>
          <h3 class="improve-title">改进建议 <span class="en">/ Improvements</span></h3>
          <ol class="report-improvements">
            <li v-for="(s, i) in improvements" :key="i">{{ s }}</li>
          </ol>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <span class="label">/ 逐轮点评</span>
          <span class="meta">TURNS</span>
        </div>
        <div class="card-body">
          <ol class="report-turns">
            <li v-for="it in items" :key="it.round">
              <div class="rt-head">
                <strong>第 {{ it.round }} 轮</strong>
                <span class="rt-score">{{ (Number(it.score) || 0).toFixed(1) }} / 10</span>
              </div>
              <div class="rt-q">
                <strong>问：</strong><span v-html="escapeHtml(it.question || '')"></span>
              </div>
              <div class="rt-a">
                {{ cleanAnswer(it.answer) || '（未作答）' }}
              </div>

              <!-- Per-turn audio player (only when SQLite has the file) -->
              <div
                v-if="turnByRound.get(it.round)?.audio_path"
                class="rt-audio"
              >
                <div class="rt-audio-label">
                  <span class="rt-audio-dot" />
                  本轮录音
                </div>
                <audio
                  :src="audioUrl(turnByRound.get(it.round)!.id)"
                  controls
                  preload="metadata"
                />
                <span v-if="turnByRound.get(it.round)?.audio_bytes" class="rt-audio-meta">
                  {{ Math.round((turnByRound.get(it.round)!.audio_bytes || 0) / 1024) }} KB
                </span>
              </div>

              <!-- Per-turn markers -->
              <div
                v-if="markersByRound.get(it.round)?.length"
                class="rt-markers"
              >
                <div
                  v-for="mk in markersByRound.get(it.round)"
                  :key="mk.id"
                  class="rt-marker"
                >
                  <IconFlag :size="13" />
                  <span>{{ mk.label }}</span>
                </div>
              </div>

              <div class="rt-comment">
                <IconBulb :size="13" /> {{ it.comment || '本轮候选人未作答，无法给出点评。' }}
              </div>
              <div v-if="it.better_answer" class="rt-better">
                <IconTarget :size="13" /> 建议回答：{{ it.better_answer }}
              </div>
            </li>
          </ol>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.view-report {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 28px 24px 120px;
  max-width: 980px;
  margin: 0 auto;
  width: 100%;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
}

.report-hero-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 22px 30px;
}
.report-hero-body h2 {
  font-size: 24px;
  font-weight: 900;
  margin: 0;
  letter-spacing: -0.01em;
  color: var(--paper-100);
}
.report-hero-body h2 .en {
  font-size: 16px;
  margin-left: 8px;
  color: var(--paper-400);
  font-weight: 400;
}
.report-hero-body .sub {
  color: var(--paper-400);
  margin: 5px 0 0;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.06em;
}
.report-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.report-summary {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 36px;
  align-items: center;
  padding: 30px 34px;
  margin: 0 0 16px;
}
@media (max-width: 640px) {
  .report-summary {
    grid-template-columns: 1fr;
  }
}
.score-big {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.score-circle {
  width: 140px;
  height: 140px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  background: var(--ink-3);
}
.score-value {
  font-family: var(--display);
  font-size: 44px;
  color: var(--paper-100);
  letter-spacing: -0.02em;
  line-height: 1;
}
.score-label {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--paper-400);
  margin-top: 6px;
}
.verdict {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 6px 14px;
  border-radius: var(--r-pill);
  border: 1px solid var(--line-2);
  color: var(--paper-300);
}
.verdict.strong-hire,
.verdict.hire {
  color: var(--green);
  border-color: var(--green);
  background: rgba(74, 222, 128, 0.1);
}
.verdict.lean-hire {
  color: var(--signal-soft);
  border-color: var(--signal-soft);
  background: var(--signal-wash);
}
.verdict.no-hire,
.verdict.strong-no-hire {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--danger-wash);
}
.radar-wrap {
  display: flex;
  justify-content: center;
}
.radar-wrap canvas {
  width: 100%;
  max-width: 360px;
  height: auto;
  aspect-ratio: 1;
}

.improve-title {
  margin: 22px 0 12px;
  font-size: 16px;
  color: var(--paper-100);
  font-weight: 700;
}
.improve-title .en {
  color: var(--paper-400);
  font-weight: 400;
  font-size: 12px;
  margin-left: 6px;
  font-family: var(--mono);
  letter-spacing: 0.1em;
}

.report-summary-text {
  color: var(--paper-100);
  line-height: 1.8;
  font-size: 15px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: visible;
}
.report-improvements {
  padding-left: 20px;
  line-height: 1.9;
  color: var(--paper-100);
}
.report-improvements li {
  margin-bottom: 8px;
}

.report-turns {
  padding-left: 0;
  list-style: none;
}
.report-turns li {
  background: var(--ink-3);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 14px;
  border-left: 3px solid var(--signal);
}
.rt-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.rt-head strong {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.1em;
  color: var(--paper-100);
}
.rt-score {
  font-family: var(--mono);
  font-weight: 700;
  color: var(--signal-soft);
  font-variant-numeric: tabular-nums;
}
.rt-q {
  font-size: 14px;
  color: var(--paper-300);
  margin-bottom: 10px;
  line-height: 1.7;
  overflow: visible;
}
.rt-q strong {
  color: var(--paper-100);
}
.rt-a {
  font-size: 14px;
  background: var(--ink-2);
  padding: 12px 14px;
  border-radius: 8px;
  margin-bottom: 10px;
  line-height: 1.7;
  border: 1px solid var(--line);
  color: var(--paper-200);
  white-space: pre-wrap;
  word-break: break-word;
  overflow: visible;
}
.rt-comment {
  font-size: 13px;
  color: var(--paper-100);
  margin-bottom: 8px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: visible;
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.rt-audio {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--ink-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
}
.rt-audio audio {
  flex: 1;
  min-width: 0;
  height: 32px;
  filter: invert(0.85) hue-rotate(180deg);
}
.rt-audio-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--paper-300);
  white-space: nowrap;
}
.rt-audio-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ember);
  box-shadow: 0 0 6px var(--ember);
  animation: live-blink 1.2s ease-in-out infinite;
}
.rt-audio-meta {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--paper-500);
  white-space: nowrap;
}
@keyframes live-blink {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
.rt-markers {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.rt-marker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: rgba(255, 122, 77, 0.12);
  border: 1px solid rgba(255, 122, 77, 0.4);
  border-radius: 6px;
  font-size: 12px;
  color: var(--ember);
  font-family: var(--mono);
  letter-spacing: 0.04em;
  align-self: flex-start;
}
.rt-marker :deep(svg) {
  flex-shrink: 0;
}
.rt-better {
  font-size: 13px;
  color: var(--paper-300);
  padding: 10px 14px;
  background: var(--ink-2);
  border-radius: 8px;
  border: 1px dashed var(--line-2);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: visible;
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.rt-comment :deep(svg),
.rt-better :deep(svg) {
  flex-shrink: 0;
  margin-top: 2px;
}
.loading {
  text-align: center;
  color: var(--paper-400);
  padding: 40px;
  font-family: var(--mono);
  letter-spacing: 0.1em;
}
</style>
