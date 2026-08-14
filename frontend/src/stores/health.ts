import { defineStore } from 'pinia'
import { fetchHealth } from '@/api'
import type { HealthInfo } from '@/types'

interface State {
  health: HealthInfo | null
  loading: boolean
  lastCheckedAt: number
}

export const useHealthStore = defineStore('health', {
  state: (): State => ({
    health: null,
    loading: false,
    lastCheckedAt: 0,
  }),

  getters: {
    statusLabel(state): string {
      const h = state.health
      if (!h) return '检测中…'
      if (!h.hasApiKey && !h.hasDeepseekKey) return '未配置 API Key'
      if (h.hasApiKey && h.hasDeepseekKey)
        return `就绪 · ${h.deepseek.model} + ${h.mimo.asrModel}/${h.mimo.ttsModel}`
      return '部分 key 缺失'
    },
    statusKind(state): 'ok' | 'warn' | 'err' {
      const h = state.health
      if (!h) return 'warn'
      if (h.hasApiKey && h.hasDeepseekKey) return 'ok'
      return 'warn'
    },
  },

  actions: {
    async refresh() {
      this.loading = true
      try {
        this.health = await fetchHealth()
        this.lastCheckedAt = Date.now()
      } catch {
        this.health = null
      } finally {
        this.loading = false
      }
    },
  },
})
