import http from './client'
import type {
  HealthInfo,
  HistoryDetailResponse,
  HistoryListResponse,
  HistoryMarker,
  PublicSettings,
  ReportResponse,
  SessionSnapshot,
  SettingsTestResponse,
  SettingsUpdatePayload,
  StartInterviewRequest,
  StartInterviewResponse,
  TurnResponse,
} from '@/types'

// Re-export the request/response payload types so callers can `import { ... } from '@/api'`
// without having to also touch `@/types`.
export type {
  HealthInfo,
  HistoryDetailResponse,
  HistoryListResponse,
  HistoryMarker,
  PublicSettings,
  ReportResponse,
  SessionSnapshot,
  SettingsTestResponse,
  SettingsUpdatePayload,
  StartInterviewRequest,
  StartInterviewResponse,
  TurnResponse,
}

export const fetchHealth = () => http.get<HealthInfo>('/health').then((r) => r.data)

export const fetchSettings = () =>
  http.get<PublicSettings>('/settings').then((r) => r.data)

export const updateSettings = (payload: SettingsUpdatePayload) =>
  http.post<PublicSettings>('/settings', payload).then((r) => r.data)

export const resetSettings = () =>
  http.post<PublicSettings>('/settings/reset').then((r) => r.data)

export const testSettings = (payload: SettingsUpdatePayload & { provider?: 'all' | 'mimo' | 'deepseek' }) =>
  http
    .post<SettingsTestResponse>('/settings/test', {
      provider: 'all',
      ...payload,
    })
    .then((r) => r.data)

export const startInterview = (body: StartInterviewRequest) =>
  http.post<StartInterviewResponse>('/interview/start', body).then((r) => r.data)

/**
 * Submit a recorded take. The audio is expected to be a 16kHz mono WAV Blob
 * (see `composables/useRecorder.ts` — the browser transcodes before upload).
 */
export const submitTurn = (params: {
  sessionId: string
  blob: Blob
  language?: string
  textOverride?: string
}) => {
  const fd = new FormData()
  fd.append('file', new File([params.blob], 'answer.wav', { type: 'audio/wav' }))
  fd.append('sessionId', params.sessionId)
  fd.append('language', params.language || 'zh')
  if (params.textOverride) fd.append('textOverride', params.textOverride)
  return http.post<TurnResponse>('/interview/turn', fd).then((r) => r.data)
}

export const endInterview = (sessionId: string) =>
  http
    .post<{ sessionId: string; finished: boolean; endedAt: number; endReason: string }>(
      '/interview/end',
      { sessionId },
    )
    .then((r) => r.data)

export const fetchReport = (sessionId: string) =>
  http.post<ReportResponse>('/interview/report', { sessionId }).then((r) => r.data)

export const fetchSession = (sessionId: string) =>
  http.get<SessionSnapshot>(`/interview/session/${sessionId}`).then((r) => r.data)

export const dropSession = (sessionId: string) =>
  http.delete<{ ok: boolean }>(`/interview/session/${sessionId}`).then((r) => r.data)

export const transcribeOnly = (blob: Blob, language = '') => {
  const fd = new FormData()
  fd.append('file', new File([blob], 'audio.wav', { type: 'audio/wav' }))
  if (language) fd.append('language', language)
  return http
    .post<{ text: string; elapsedMs: number }>('/transcribe', fd)
    .then((r) => r.data)
}

/* ---------------- History (SQLite) ---------------- */

export const fetchHistory = () =>
  http.get<HistoryListResponse>('/history').then((r) => r.data)

export const fetchHistoryDetail = (id: string) =>
  http.get<HistoryDetailResponse>(`/history/${id}`).then((r) => r.data)

export const deleteHistorySession = (id: string) =>
  http.delete<{ ok: boolean }>(`/history/${id}`).then((r) => r.data)

export const addMarker = (sessionId: string, round: number) =>
  http
    .post<HistoryMarker>(`/history/${sessionId}/marker`, { round })
    .then((r) => r.data)

/** Build the audio stream URL for a turn. */
export const audioUrl = (turnId: number) => `/api/audio/${turnId}`
