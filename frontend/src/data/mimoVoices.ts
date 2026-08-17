// MiMo TTS 内置声音清单
//
// 这是前端声音下拉的**唯一权威来源**——首页 HomeView 和设置页 SettingsView
// 都从这里读，避免两边列表不同步。
//
// MiMo 平台本身不提供「列出全部声音」的 API，所以这里硬编码维护。
// 字段含义：
//   value  实际传给后端 / MiMo API 的声音 ID（保存到 .env / .model-settings.json）
//   label  在下拉里给用户看的主名
//   note   简短描述（中文/英文、音色特点），下拉里会显示为「label — note」
//
// 新增声音时请同步在下方数组里加，UI 会自动出现。

export interface MimoVoice {
  value: string
  label: string
  note: string
}

export const MIMO_VOICES: readonly MimoVoice[] = [
  { value: 'mimo_default', label: 'mimo_default', note: '默认 / 官方推荐' },
  { value: '冰糖',         label: '冰糖',          note: '中文 · 清亮女声' },
  { value: '茉莉',         label: '茉莉',          note: '中文 · 柔美女声' },
  { value: '苏打',         label: '苏打',          note: '中文 · 活力男声' },
  { value: '白桦',         label: '白桦',          note: '中文 · 沉稳男声' },
  { value: 'Mia',          label: 'Mia',           note: 'English · young female' },
  { value: 'Chloe',        label: 'Chloe',         note: 'English · warm female' },
  { value: 'Milo',         label: 'Milo',          note: 'English · young male' },
  { value: 'Dean',         label: 'Dean',          note: 'English · deep male' },
] as const

export const MIMO_VOICE_VALUES: ReadonlySet<string> = new Set(
  MIMO_VOICES.map((v) => v.value)
)

/** 已知声音值的 set，便于判断「是不是内置选项」。 */
export function isKnownMimoVoice(v: string | null | undefined): boolean {
  return !!v && MIMO_VOICE_VALUES.has(v)
}
