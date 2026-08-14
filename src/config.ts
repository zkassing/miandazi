// config.ts — load and validate env
import 'dotenv/config'

const rawApiKey = process.env.MIMO_API_KEY || ''
const isPlaceholderKey = !rawApiKey || rawApiKey.includes('REPLACE_ME')
if (isPlaceholderKey) {
  console.warn(
    '[config] MIMO_API_KEY is not set (or still placeholder). ' +
      'STT / TTS requests will fail until you fill it in .env',
  )
}

const rawDsKey = process.env.DEEPSEEK_API_KEY || ''
if (!rawDsKey) {
  console.warn(
    '[config] DEEPSEEK_API_KEY is not set. ' +
      'Interview endpoints will fail until you fill it in .env',
  )
}

export interface AppConfig {
  mimoApiKey: string
  mimoBaseUrl: string
  mimoAsrModel: string
  mimoTtsModel: string
  mimoTtsVoice: string
  mimoTtsFormat: string
  mimoSystemPrompt: string
  deepseekApiKey: string
  deepseekBaseUrl: string
  deepseekModel: string
  deepseekMaxRounds: number
  sessionTtlMs: number
  port: number
  host: string
  corsOrigin: string
  maxUploadBytes: number
}

export const config: AppConfig = Object.freeze({
  mimoApiKey: isPlaceholderKey ? '' : rawApiKey,
  mimoBaseUrl: (process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1/chat/completions')
    .replace(/\/+$/, ''),
  mimoAsrModel: process.env.MIMO_ASR_MODEL || 'mimo-v2.5-asr',
  mimoTtsModel: process.env.MIMO_TTS_MODEL || 'mimo-v2.5-tts',
  mimoTtsVoice: process.env.MIMO_TTS_VOICE || 'mimo_default',
  mimoTtsFormat: process.env.MIMO_TTS_FORMAT || 'wav',
  mimoSystemPrompt: process.env.MIMO_SYSTEM_PROMPT || '',

  deepseekApiKey: rawDsKey,
  deepseekBaseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1')
    .replace(/\/+$/, ''),
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  deepseekMaxRounds: Number.parseInt(process.env.DEEPSEEK_MAX_ROUNDS || '8', 10),

  sessionTtlMs: Number.parseInt(
    process.env.INTERVIEW_SESSION_TTL_MS || `${30 * 60 * 1000}`,
    10,
  ),

  port: Number.parseInt(process.env.PORT || '5174', 10),
  host: process.env.HOST || '0.0.0.0',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  maxUploadBytes: Number.parseInt(
    process.env.MAX_UPLOAD_BYTES || `${100 * 1024 * 1024}`,
    10,
  ),
})

export const transcriptionsUrl = config.mimoBaseUrl

export const deepseekChatUrl = `${config.deepseekBaseUrl}/chat/completions`

/** True if a non-placeholder MiMo key is configured. */
export function hasRealApiKey(): boolean {
  return config.mimoApiKey.length > 0
}

/** True if a DeepSeek key is configured. */
export function hasDeepseekKey(): boolean {
  return config.deepseekApiKey.length > 0
}

/** Supported audio formats the upstream API accepts. */
export const SUPPORTED_AUDIO_FORMATS: Set<string> = new Set(['wav', 'mp3'])
