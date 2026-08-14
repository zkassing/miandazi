import { defineStore } from 'pinia'
import { fetchSettings, resetSettings, updateSettings } from '@/api'
import type { PublicSettings, SettingsUpdatePayload } from '@/types'

interface State {
  data: PublicSettings | null
  loading: boolean
  saveState: string
}

export const useSettingsStore = defineStore('settings', {
  state: (): State => ({
    data: null,
    loading: false,
    saveState: '',
  }),

  actions: {
    async load() {
      this.loading = true
      try {
        this.data = await fetchSettings()
      } finally {
        this.loading = false
      }
    },
    async save(payload: SettingsUpdatePayload) {
      this.loading = true
      this.saveState = ''
      try {
        this.data = await updateSettings(payload)
        this.saveState = '已保存并生效'
      } catch (err) {
        this.saveState = ''
        throw err
      } finally {
        this.loading = false
      }
    },
    async reset() {
      this.loading = true
      try {
        this.data = await resetSettings()
        this.saveState = '已恢复默认'
      } finally {
        this.loading = false
      }
    },
  },
})
