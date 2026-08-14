// modelSettings.ts — 运行时模型配置
//
// 模型配置（API Key / Base URL / 模型名 / TTS 声音等）原本只存在于 .env 里，
// 改一次就要重启。本模块让用户在网页「模型配置」里直接修改：
//
//   - 有效值 = 运行时覆盖（有的话） ?? .env 默认值
//   - 运行时覆盖会持久化到项目根目录 .model-settings.json，重启后依然生效
//   - API Key 只会以掩码形式（sk-****abcd）返回给浏览器，完整 key 不出服务器
//
// 服务器内部请用 getEffectiveSettings() 拿完整配置（含真实 key）；
// 返回给前端用 getPublicSettings()（key 已掩码，另附申请网址）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from './config.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SETTINGS_FILE = path.resolve(__dirname, '..', '.model-settings.json')

type FieldKey = keyof typeof FIELD_DEFAULTS

/** 各平台 API Key 申请网址（设置界面里展示给用户）。 */
export const KEY_APPLY_URLS: {
  mimo: { label: string; url: string; hint: string }
  deepseek: { label: string; url: string; hint: string }
} = {
  mimo: {
    label: '小米 MiMo 开放平台',
    url: 'https://platform.xiaomimimo.com/console/api-keys',
    hint: '登录后进入「API Keys」页面创建密钥（按量计费 / Token Plan）。',
  },
  deepseek: {
    label: 'DeepSeek 开放平台',
    url: 'https://platform.deepseek.com/api_keys',
    hint: '登录后进入「API Keys」页面创建密钥（需先充值少量余额）。',
  },
}

/** 每个配置项的 .env 默认值。 */
const FIELD_DEFAULTS = {
  mimoApiKey: config.mimoApiKey,
  mimoBaseUrl: config.mimoBaseUrl,
  mimoAsrModel: config.mimoAsrModel,
  mimoTtsModel: config.mimoTtsModel,
  mimoTtsVoice: config.mimoTtsVoice,
  mimoTtsFormat: config.mimoTtsFormat,
  mimoSystemPrompt: config.mimoSystemPrompt,
  deepseekApiKey: config.deepseekApiKey,
  deepseekBaseUrl: config.deepseekBaseUrl,
  deepseekModel: config.deepseekModel,
  deepseekMaxRounds: config.deepseekMaxRounds,
}

// 运行时覆盖（从磁盘加载，可能是 {}）。
let overrides: Partial<Record<FieldKey, unknown>> = loadOverrides()

function loadOverrides(): Partial<Record<FieldKey, unknown>> {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {}
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    const clean: Partial<Record<FieldKey, unknown>> = {}
    for (const k of Object.keys(FIELD_DEFAULTS) as FieldKey[]) {
      if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') clean[k] = raw[k]
    }
    return clean
  } catch (err: any) {
    console.warn(`[modelSettings] 读取 ${SETTINGS_FILE} 失败，忽略：`, err.message)
    return {}
  }
}

function persistOverrides() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(overrides, null, 2) + '\n', 'utf8')
  } catch (err: any) {
    console.warn(`[modelSettings] 写入 ${SETTINGS_FILE} 失败：`, err.message)
  }
}

/** 完整合并配置（含真实 API Key）。仅限服务端内部使用。 */
export function getEffectiveSettings() {
  const s: Record<FieldKey, unknown> = { ...FIELD_DEFAULTS }
  for (const k of Object.keys(overrides) as FieldKey[]) {
    if (overrides[k] !== undefined && overrides[k] !== null) s[k] = overrides[k]
  }
  return s
}

function maskKey(key: string): string {
  if (!key) return ''
  const k = String(key)
  if (k.length <= 8) return '****'
  return `${k.slice(0, 4)}****${k.slice(-4)}`
}

/**
 * 返回给浏览器的安全视图：
 *  - key 只给「是否已配置 + 掩码」
 *  - 附上各平台 Key 申请网址
 *  - source 标明每项来自 env 还是运行时覆盖
 */
export function getPublicSettings() {
  const s = getEffectiveSettings()
  const src: Record<string, 'runtime' | 'env'> = {}
  for (const k of Object.keys(FIELD_DEFAULTS) as FieldKey[]) {
    src[k] = Object.prototype.hasOwnProperty.call(overrides, k) ? 'runtime' : 'env'
  }
  return {
    mimo: {
      apiKeySet: Boolean(s.mimoApiKey),
      apiKeyMasked: maskKey(s.mimoApiKey as string),
      baseUrl: s.mimoBaseUrl as string,
      asrModel: s.mimoAsrModel as string,
      ttsModel: s.mimoTtsModel as string,
      ttsVoice: s.mimoTtsVoice as string,
      ttsFormat: s.mimoTtsFormat as string,
      systemPrompt: s.mimoSystemPrompt as string,
    },
    deepseek: {
      apiKeySet: Boolean(s.deepseekApiKey),
      apiKeyMasked: maskKey(s.deepseekApiKey as string),
      baseUrl: s.deepseekBaseUrl as string,
      model: s.deepseekModel as string,
      maxRounds: s.deepseekMaxRounds as number,
    },
    keyApplyUrls: KEY_APPLY_URLS,
    sources: src,
  }
}

interface PartialPayload {
  mimo?: Record<string, unknown>
  deepseek?: Record<string, unknown>
}

/**
 * 把浏览器传来的部分配置（{ mimo: {...}, deepseek: {...} }）应用到一个扁平配置对象上。
 */
function applyPartialTo(flat: Record<string, unknown>, payload: PartialPayload | undefined | null) {
  const m = (payload && payload.mimo) || {}
  const d = (payload && payload.deepseek) || {}

  const set = (k: string, v: unknown, opts: { allowEmpty?: boolean } = {}) => {
    if (v === undefined) return
    const s = String(v).trim()
    if (s === '' && !opts.allowEmpty) return
    flat[k] = s
  }

  set('mimoApiKey', m.apiKey)
  set('mimoBaseUrl', m.baseUrl)
  set('mimoAsrModel', m.asrModel)
  set('mimoTtsModel', m.ttsModel)
  set('mimoTtsVoice', m.ttsVoice)
  set('mimoTtsFormat', m.ttsFormat)
  set('mimoSystemPrompt', m.systemPrompt, { allowEmpty: true })

  set('deepseekApiKey', d.apiKey)
  set('deepseekBaseUrl', d.baseUrl)
  set('deepseekModel', d.model)
  if (d.maxRounds !== undefined) {
    const n = Number.parseInt(String(d.maxRounds), 10)
    if (!Number.isNaN(n) && n > 0 && n <= 100) flat.deepseekMaxRounds = n
  }
  return flat
}

/** 更新运行时设置并持久化（立即生效）。 */
export function updateSettings(payload: PartialPayload) {
  const next: Record<string, unknown> = { ...overrides }
  applyPartialTo(next, payload)
  overrides = next as Partial<Record<FieldKey, unknown>>
  persistOverrides()
  return getPublicSettings()
}

/** 用一组「候选」部分配置临时计算有效配置（用于保存前测试，不持久化）。 */
export function effectiveWithOverrides(payload: PartialPayload) {
  return applyPartialTo(getEffectiveSettings(), payload)
}

/** 清空运行时覆盖，恢复到 .env 默认值（并删除持久化文件）。 */
export function resetSettings() {
  overrides = {}
  try {
    if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE)
  } catch (err: any) {
    console.warn(`[modelSettings] 删除 ${SETTINGS_FILE} 失败：`, err.message)
  }
  return getPublicSettings()
}
