// sessionStore.ts — in-memory interview session store with TTL.

import { config } from './config.ts'

export interface InterviewSession {
  id: string
  createdAt: number
  updatedAt: number
  direction: string
  jdText: string
  candidateName: string
  maxRounds: number
  voice: string
  ttsFormat: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; meta?: object }>
  turns: Array<{
    round: number
    question: string
    answer: string
    topic?: string
    sampleAnswer?: string
    audioBytes?: number
    sttElapsedMs?: number
    llmElapsedMs?: number
    ttsElapsedMs?: number
    createdAt: number
  }>
  finished: boolean
  endedAt?: number
  endReason?: string
  report?: object
}

const sessions = new Map<string, InterviewSession>()

let nextId = 1
function genId() {
  const t = Date.now().toString(36)
  const n = (nextId++).toString(36)
  return `iv_${t}_${n}`
}

export function createSession(opts: {
  direction?: string
  jdText?: string
  candidateName?: string
  maxRounds?: number
  voice?: string
  ttsFormat?: string
  systemPrompt?: string
}): InterviewSession {
  const id = genId()
  const session: InterviewSession = {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    direction: opts.direction || '通用求职面试',
    jdText: opts.jdText || '',
    candidateName: opts.candidateName || '',
    maxRounds: Math.max(1, Math.min(20, Number(opts.maxRounds) || config.deepseekMaxRounds)),
    voice: opts.voice || 'alloy',
    ttsFormat: opts.ttsFormat || 'wav',
    messages: opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : [],
    turns: [],
    finished: false,
  }
  sessions.set(id, session)
  return session
}

export function getSession(id: string): InterviewSession | null {
  const s = sessions.get(id)
  if (!s) return null
  if (Date.now() - s.updatedAt > config.sessionTtlMs) {
    sessions.delete(id)
    return null
  }
  return s
}

export function touchSession(s: InterviewSession): InterviewSession {
  s.updatedAt = Date.now()
  sessions.set(s.id, s)
  return s
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id)
}

function gc() {
  const cutoff = Date.now() - config.sessionTtlMs
  for (const [id, s] of sessions) {
    if (s.updatedAt < cutoff) sessions.delete(id)
  }
}
const gcTimer = setInterval(gc, 60 * 1000) as unknown as { unref?: () => void }
gcTimer.unref?.()
