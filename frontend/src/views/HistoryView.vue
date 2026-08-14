<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { fetchHistory, deleteHistorySession } from '@/api'
import { useToast } from '@/composables/useToast'
import type { HistorySession } from '@/types'
import IconTrash from '@/components/IconTrash.vue'
import IconBook from '@/components/IconBook.vue'
import IconChevron from '@/components/IconChevron.vue'

const router = useRouter()
const toast = useToast()
const sessions = ref<HistorySession[]>([])
const loading = ref(true)
const filter = ref<'all' | 'finished' | 'active'>('all')

async function load() {
  loading.value = true
  try {
    const r = await fetchHistory()
    sessions.value = r.sessions
  } catch (err: any) {
    toast.show(`加载历史失败：${err.message}`, true)
  } finally {
    loading.value = false
  }
}

const filtered = computed(() => {
  if (filter.value === 'all') return sessions.value
  return sessions.value.filter((s) => s.status === filter.value)
})

const finishedCount = computed(() => sessions.value.filter((s) => s.status === 'finished').length)
const activeCount = computed(() => sessions.value.filter((s) => s.status === 'active').length)

const VERDICT_LABEL: Record<string, string> = {
  strong_hire: '强烈推荐',
  hire: '推荐',
  lean_hire: '倾向推荐',
  no_hire: '不推荐',
  strong_no_hire: '强烈不推荐',
}
const VERDICT_KIND: Record<string, string> = {
  strong_hire: 'hire',
  hire: 'hire',
  lean_hire: 'lean',
  no_hire: 'no',
  strong_no_hire: 'no',
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
function fmtDuration(start: number, end: number | null): string {
  if (!end) return '—'
  const sec = Math.round((end - start) / 1000)
  if (sec < 60) return `${sec} 秒`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m} 分 ${s} 秒`
}
function openSession(s: HistorySession) {
  router.push({ name: 'history-detail', params: { id: s.id } })
}

async function onDelete(s: HistorySession, e: Event) {
  e.stopPropagation()
  if (!confirm(`确定删除这场面试吗？\n\n方向：${s.direction}\n时间：${fmtDate(s.started_at)}\n\n此操作会删除所有录音文件，不可恢复。`)) return
  try {
    await deleteHistorySession(s.id)
    sessions.value = sessions.value.filter((x) => x.id !== s.id)
    toast.show('已删除', false, 2000)
  } catch (err: any) {
    toast.show(`删除失败：${err.message}`, true)
  }
}

onMounted(load)
</script>

<template>
  <main class="view-history">
    <section class="card history-hero">
      <div class="card-head">
        <div class="head-left">
          <div class="modal-icon">
            <IconBook :size="20" />
          </div>
          <div>
            <h2>历史面试 <span class="en">/ Archive</span></h2>
            <p class="settings-sub">
              所有面试永久保存 · 可重新查看报告、回放每轮录音、查看标记
            </p>
          </div>
        </div>
        <button class="btn-ghost" type="button" @click="router.push('/')">返回</button>
      </div>

      <div class="filter-bar">
        <button
          type="button"
          :class="['filter-pill', { active: filter === 'all' }]"
          @click="filter = 'all'"
        >
          全部 <span class="count">{{ sessions.length }}</span>
        </button>
        <button
          type="button"
          :class="['filter-pill', { active: filter === 'finished' }]"
          @click="filter = 'finished'"
        >
          已完成 <span class="count">{{ finishedCount }}</span>
        </button>
        <button
          type="button"
          :class="['filter-pill', { active: filter === 'active' }]"
          @click="filter = 'active'"
        >
          进行中 <span class="count">{{ activeCount }}</span>
        </button>
      </div>
    </section>

    <div v-if="loading" class="card"><div class="card-body loading">正在加载历史…</div></div>

    <div v-else-if="!filtered.length" class="card">
      <div class="card-body empty">
        <div class="empty-icon">📭</div>
        <h3>还没有面试记录</h3>
        <p>开始一场面试后，记录会自动出现在这里。</p>
        <button class="btn-primary" type="button" @click="router.push('/')">去开始面试</button>
      </div>
    </div>

    <section v-else class="history-list">
      <article
        v-for="s in filtered"
        :key="s.id"
        class="history-card"
        @click="openSession(s)"
      >
        <div class="hc-top">
          <div class="hc-direction">{{ s.direction }}</div>
          <span v-if="s.status === 'finished' && s.verdict" class="verdict-chip" :class="VERDICT_KIND[s.verdict] || ''">
            {{ VERDICT_LABEL[s.verdict] || s.verdict }}
          </span>
          <span v-else class="status-chip active">进行中</span>
        </div>
        <div class="hc-meta">
          <span class="meta-item">
            <span class="meta-label">开始</span>
            <span class="meta-value">{{ fmtDate(s.started_at) }}</span>
          </span>
          <span class="meta-item">
            <span class="meta-label">时长</span>
            <span class="meta-value">{{ fmtDuration(s.started_at, s.ended_at) }}</span>
          </span>
          <span class="meta-item">
            <span class="meta-label">轮数</span>
            <span class="meta-value">{{ s.total_rounds || 0 }}</span>
          </span>
          <span v-if="s.final_score != null" class="meta-item">
            <span class="meta-label">综合分</span>
            <span class="meta-value score">{{ s.final_score.toFixed(1) }} / 10</span>
          </span>
        </div>
        <div class="hc-id">id: {{ s.id }}</div>
        <div class="hc-actions">
          <button class="hc-open" type="button" @click.stop="openSession(s)">
            查看报告 <IconChevron :size="12" />
          </button>
          <button class="hc-delete" type="button" title="删除这场面试" @click="onDelete(s, $event)">
            <IconTrash :size="13" />
          </button>
        </div>
      </article>
    </section>
  </main>
</template>

<style scoped>
.view-history {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 28px 24px 60px;
  overflow-y: auto;
}
.history-hero {
  max-width: 960px;
  width: 100%;
  margin: 0 auto 20px;
}
.head-left {
  display: flex;
  align-items: center;
  gap: 14px;
}
h2 {
  font-size: 18px;
  font-weight: 700;
  margin: 0;
  color: var(--paper-100);
}
h2 .en {
  color: var(--paper-400);
  font-weight: 400;
  font-size: 12px;
  margin-left: 6px;
  font-family: var(--mono);
  letter-spacing: 0.1em;
}
.settings-sub {
  margin: 4px 0 0;
  color: var(--paper-400);
  font-size: 12px;
}
.modal-icon {
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--ink-3);
  color: var(--signal-soft);
  flex-shrink: 0;
}

.filter-bar {
  display: flex;
  gap: 8px;
  padding: 14px 24px 16px;
  border-top: 1px solid var(--line);
}
.filter-pill {
  font-size: 11px;
  letter-spacing: 0.08em;
  background: var(--ink-3);
  color: var(--paper-300);
  border: 1px solid var(--line-2);
  padding: 6px 14px;
  border-radius: var(--r-pill);
}
.filter-pill.active {
  background: var(--signal-wash);
  color: var(--signal-soft);
  border-color: var(--signal-soft);
}
.filter-pill .count {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: rgba(0, 0, 0, 0.25);
  font-family: var(--mono);
  font-size: 10px;
  color: var(--paper-200);
}

.history-list {
  max-width: 960px;
  width: 100%;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
@media (min-width: 720px) {
  .history-list {
    grid-template-columns: 1fr 1fr;
  }
}

.history-card {
  background: var(--ink-2);
  border: 1px solid var(--line);
  border-left: 3px solid var(--signal);
  border-radius: 12px;
  padding: 16px 18px;
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
  position: relative;
}
.history-card:hover {
  transform: translateY(-1px);
  border-color: var(--signal-soft);
  border-left-color: var(--signal-soft);
}
.hc-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.hc-direction {
  font-size: 16px;
  font-weight: 700;
  color: var(--paper-100);
}
.verdict-chip,
.status-chip {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 3px 10px;
  border-radius: var(--r-pill);
  border: 1px solid var(--line-2);
}
.verdict-chip.hire {
  color: var(--green);
  border-color: var(--green);
  background: rgba(74, 222, 128, 0.1);
}
.verdict-chip.lean {
  color: var(--signal-soft);
  border-color: var(--signal-soft);
  background: var(--signal-wash);
}
.verdict-chip.no {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--danger-wash);
}
.status-chip.active {
  color: var(--warning);
  border-color: var(--warning);
  background: rgba(250, 204, 21, 0.1);
}
.hc-meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 14px;
  margin-bottom: 10px;
}
.meta-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 12px;
}
.meta-label {
  color: var(--paper-500);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.meta-value {
  color: var(--paper-200);
  font-variant-numeric: tabular-nums;
}
.meta-value.score {
  color: var(--signal-soft);
  font-weight: 700;
  font-family: var(--mono);
}
.hc-id {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--paper-500);
  margin-bottom: 10px;
  word-break: break-all;
}
.hc-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.hc-open {
  font-size: 11px;
  color: var(--signal-soft);
  background: transparent;
  border: 1px solid var(--signal-soft);
  padding: 5px 12px;
  letter-spacing: 0.1em;
}
.hc-open:hover {
  background: var(--signal-wash);
  color: var(--paper-100);
}
.hc-delete {
  background: transparent;
  border: 1px solid var(--line-2);
  color: var(--paper-400);
  padding: 5px 8px;
  letter-spacing: 0;
}
.hc-delete:hover {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--danger-wash);
}

.loading,
.empty {
  text-align: center;
  color: var(--paper-400);
  padding: 40px;
}
.empty-icon {
  font-size: 36px;
  margin-bottom: 12px;
}
.empty h3 {
  margin: 0 0 6px;
  color: var(--paper-200);
  font-size: 16px;
}
.empty p {
  margin: 0 0 18px;
  color: var(--paper-400);
  font-size: 13px;
}
.loading {
  font-family: var(--mono);
  letter-spacing: 0.1em;
}
</style>
