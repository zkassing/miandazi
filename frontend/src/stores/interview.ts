import { defineStore } from 'pinia'
import {
  startInterview as apiStart,
  submitTurn as apiSubmitTurn,
  endInterview as apiEnd,
  fetchReport as apiFetchReport,
  fetchSession as apiFetchSession,
  dropSession as apiDrop,
} from '@/api'
import type {
  InterviewReport,
  SessionSnapshot,
  SessionTurn,
  StartInterviewRequest,
  TtsPayload,
  TurnResponse,
} from '@/types'

interface State {
  sessionId: string | null
  direction: string
  candidateName: string
  currentRound: number
  finished: boolean
  /** The question currently being asked by the AI. */
  lastQuestion: string
  lastQuestionAudio: TtsPayload | null
  /** The sample answer for the current (unanswered) question. */
  currentSampleAnswer: string
  /** Last turn's transcript (echoed back for the UI). */
  lastTranscript: string
  /** The structured report (populated after `fetchReport`). */
  report: InterviewReport | null
  /** The session's turn history (used by the report fallback path). */
  turns: SessionTurn[]
  loading: boolean
}

export const useInterviewStore = defineStore('interview', {
  state: (): State => ({
    sessionId: null,
    direction: '',
    candidateName: '',
    currentRound: 0,
    finished: false,
    lastQuestion: '',
    lastQuestionAudio: null,
    currentSampleAnswer: '',
    lastTranscript: '',
    report: null,
    turns: [],
    loading: false,
  }),

  getters: {
    isActive(state): boolean {
      return Boolean(state.sessionId) && !state.finished
    },
    canSubmitAnswer(state): boolean {
      return Boolean(state.sessionId) && !state.finished
    },
  },

  actions: {
    async start(req: StartInterviewRequest) {
      this.loading = true
      try {
        const r = await apiStart(req)
        this.sessionId = r.sessionId
        this.currentRound = r.round || 1
        this.direction = req.direction || ''
        this.candidateName = req.candidateName || ''
        this.finished = r.endInterview === true
        this.lastQuestion = r.question || ''
        this.currentSampleAnswer = r.sampleAnswer || ''
        this.lastQuestionAudio = r.tts?.audioBase64
          ? { audioBase64: r.tts.audioBase64, mime: r.tts.mime || 'audio/mpeg', format: r.tts.format, elapsedMs: r.tts.elapsedMs }
          : null
        this.lastTranscript = ''
        return r
      } finally {
        this.loading = false
      }
    },

    async submitTake(blob: Blob, opts: { language?: string; textOverride?: string } = {}) {
      if (!this.sessionId) throw new Error('没有有效的面试会话')
      this.loading = true
      try {
        const r: TurnResponse = await apiSubmitTurn({
          sessionId: this.sessionId,
          blob,
          language: opts.language,
          textOverride: opts.textOverride,
        })
        this.lastTranscript = r.transcript || ''
        this.currentSampleAnswer = r.sampleAnswer || ''
        this.lastQuestion = r.question || ''
        this.lastQuestionAudio = r.tts?.audioBase64
          ? { audioBase64: r.tts.audioBase64, mime: r.tts.mime || 'audio/mpeg', format: r.tts.format, elapsedMs: r.tts.elapsedMs }
          : null
        this.currentRound = r.round || this.currentRound
        this.finished = r.endInterview === true
        return r
      } finally {
        this.loading = false
      }
    },

    async endManually() {
      if (!this.sessionId) return
      try {
        await apiEnd(this.sessionId)
      } catch {
        // 404 etc. just means session was already gone — ignore.
      }
      this.finished = true
    },

    async loadReport(force = false) {
      if (!this.sessionId) throw new Error('没有有效的面试会话')
      const r = await apiFetchReport(this.sessionId, force)
      this.report = r.report
      // Also fetch session snapshot for turn history (used as a fallback
      // when the report doesn't include per_question).
      try {
        const snap: SessionSnapshot = await apiFetchSession(this.sessionId)
        this.turns = snap.turns || []
      } catch {
        this.turns = []
      }
      return r.report
    },

    async reset() {
      if (this.sessionId) {
        try {
          await apiDrop(this.sessionId)
        } catch {
          /* ignore */
        }
      }
      this.$reset()
    },
  },
})
