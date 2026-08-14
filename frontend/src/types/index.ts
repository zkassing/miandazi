// Shared types between the Fastify backend and the Vue frontend.

export type InterviewTopic =
  | 'behavioral'
  | 'technical'
  | 'scenario'
  | 'wrap_up'
  | 'candidate_questions'
  | string

export interface TtsPayload {
  audioBase64?: string
  mime: string
  format: string
  elapsedMs: number
}

export interface StartInterviewRequest {
  direction?: string
  jdText?: string
  candidateName?: string
  maxRounds?: number
  voice?: string
  ttsFormat?: string
}

export interface StartInterviewResponse {
  sessionId: string
  round: number
  question: string
  topic: InterviewTopic
  endInterview: boolean
  sampleAnswer?: string
  tts?: TtsPayload
  meta?: { direction: string; maxRounds: number }
}

export interface TurnResponse {
  sessionId: string
  round: number
  question: string
  topic: InterviewTopic
  endInterview: boolean
  transcript: string
  emptyReason?: string
  sampleAnswer?: string
  tts?: TtsPayload
}

export interface ReportScores {
  logic: number
  expression: number
  depth: number
  relevance: number
  adaptability: number
  overall: number
}

export interface PerQuestionItem {
  round: number
  question: string
  answer: string
  score: number
  comment: string
  better_answer: string
}

export type Verdict =
  | 'strong_hire'
  | 'hire'
  | 'lean_hire'
  | 'no_hire'
  | 'strong_no_hire'
  | string

export interface InterviewReport {
  scores: ReportScores
  per_question: PerQuestionItem[]
  summary: string
  improvements: string[]
  verdict: Verdict
}

export interface ReportResponse {
  sessionId: string
  report: InterviewReport
}

export interface SessionTurn {
  round: number
  question: string
  answer: string
  topic: InterviewTopic
  sampleAnswer?: string
  startedAt?: number
  endedAt?: number
}

export interface SessionSnapshot {
  sessionId: string
  direction: string
  candidateName: string
  status: 'active' | 'finished' | string
  startedAt: number
  endedAt?: number
  endReason?: string
  turns: SessionTurn[]
}

export interface MimoSettings {
  apiKeySet: boolean
  apiKeyMasked: string
  baseUrl: string
  asrModel: string
  ttsModel: string
  ttsVoice: string
  ttsFormat: string
  systemPrompt: string
}

export interface DeepseekSettings {
  apiKeySet: boolean
  apiKeyMasked: string
  baseUrl: string
  model: string
}

export interface PublicSettings {
  mimo: MimoSettings
  deepseek: DeepseekSettings
  keyApplyUrls: {
    mimo: { url: string; label: string; hint?: string }
    deepseek: { url: string; label: string; hint?: string }
  }
}

export interface SettingsUpdatePayload {
  mimo?: Partial<{
    apiKey: string
    baseUrl: string
    asrModel: string
    ttsModel: string
    ttsVoice: string
    ttsFormat: string
    systemPrompt: string
  }>
  deepseek?: Partial<{
    apiKey: string
    baseUrl: string
    model: string
  }>
}

export interface HealthInfo {
  ok: boolean
  hasApiKey: boolean
  hasDeepseekKey: boolean
  mimo: {
    asrModel: string
    ttsModel: string
    ttsVoice: string
    ttsFormat: string
    baseUrl: string
  }
  deepseek: { model: string; maxRounds: number }
  maxUploadBytes: number
}

export interface TestResultItem {
  ok: boolean
  message: string
  latencyMs?: number
  detail?: string
}
export interface SettingsTestResponse {
  results: {
    mimo?: TestResultItem
    deepseek?: TestResultItem
  }
}

/* ---------------- History (SQLite-backed) ---------------- */

export interface HistorySession {
  id: string
  direction: string
  candidate_name: string
  status: 'active' | 'finished'
  started_at: number
  ended_at: number | null
  end_reason: string | null
  total_rounds: number
  final_score: number | null
  verdict: string | null
  summary: string | null
}

export interface HistoryTurn {
  id: number
  session_id: string
  round: number
  question: string
  answer: string
  topic: string | null
  sample_answer: string | null
  audio_path: string | null
  audio_bytes: number | null
  stt_elapsed_ms: number | null
  llm_elapsed_ms: number | null
  tts_elapsed_ms: number | null
  created_at: number
}

export interface HistoryMarker {
  id: number
  session_id: string
  round: number
  created_at: number
  label: string
}

export interface HistoryDetailResponse {
  session: HistorySession
  turns: HistoryTurn[]
  markers: HistoryMarker[]
  /** Cached LLM report (may be null if never generated). */
  report: InterviewReport | null
}

export interface HistoryListResponse {
  sessions: HistorySession[]
}
