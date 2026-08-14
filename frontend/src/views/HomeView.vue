<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useInterviewStore } from '@/stores/interview'
import { useToast } from '@/composables/useToast'
import { fetchSettings } from '@/api'
import { MIMO_VOICES, isKnownMimoVoice } from '@/data/mimoVoices'
import IconMic from '@/components/IconMic.vue'
import IconKey from '@/components/IconKey.vue'
import IconExt from '@/components/IconExt.vue'

const DIRECTION_PRESETS = [
  '通用求职面试',
  '前端工程师',
  '后端工程师',
  '算法工程师',
  '数据分析师',
  '产品经理',
  '运维 / SRE',
  '测试工程师',
  '运营 / 市场',
  '销售 / BD',
]

const router = useRouter()
const interview = useInterviewStore()
const toast = useToast()

const candidateName = ref('')
const direction = ref('')
const jdText = ref('')
// 声音选择：
//   '__default__' 表示不传 voice 参给后端，让后端 / .env 决定（首页默认行为）
//   '__custom__'  表示用户填了 mimoVoices 列表里没有的声音，下面 voiceCustom 才有效
//   其它已知值  （如 'mimo_default' / '冰糖' / 'Mia'）直接传给后端
const voice = ref<string>('__default__')
const voiceCustom = ref('')
const showCombo = ref(false)
const submitting = ref(false)
const applyLinks = ref<{ mimo: { url: string; label: string }; deepseek: { url: string; label: string } }>({
  mimo: { url: 'https://platform.xiaomimimo.com/console/api-keys', label: '小米 MiMo 开放平台' },
  deepseek: { url: 'https://platform.deepseek.com/api_keys', label: 'DeepSeek 开放平台' },
})

const canSubmit = computed(
  () => direction.value.trim().length > 0 && !submitting.value,
)

function pickDirection(d: string) {
  direction.value = d
  showCombo.value = false
}

function onComboBlur() {
  // 150ms 延时避免点击选项时 input 先失焦把列表关掉
  setTimeout(() => {
    showCombo.value = false
  }, 150)
}

async function start() {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    await interview.start({
      direction: direction.value.trim(),
      jdText: jdText.value.trim(),
      candidateName: candidateName.value.trim(),
      voice: resolveVoiceParam(),
    })
    router.push('/interview')
  } catch (err: any) {
    toast.show(`开始面试失败：${err.message}`, true)
  } finally {
    submitting.value = false
  }
}

// 把首页声音下拉的值翻译成真正传给后端的 voice 参数：
//   - '__default__' 或为空 → 不传（后端走 .env / 全局设置）
//   - '__custom__'          → 用用户填的自定义声音
//   - 其他                   → 原样返回（必须是 mimoVoices 里的已知值）
function resolveVoiceParam(): string | undefined {
  const v = voice.value
  if (!v || v === '__default__') return undefined
  if (v === '__custom__') {
    const c = voiceCustom.value.trim()
    return c || undefined
  }
  // 防御性：只放已知声音过去，未知则当作 undefined 走默认
  return isKnownMimoVoice(v) ? v : undefined
}

// Best-effort: fetch settings to fill the apply-link labels/hints on the
// start page. Failure is silent.
;(async () => {
  try {
    const data = await fetchSettings()
    if (data.keyApplyUrls) {
      applyLinks.value = {
        mimo: data.keyApplyUrls.mimo,
        deepseek: data.keyApplyUrls.deepseek,
      }
    }
  } catch {
    /* keep defaults */
  }
})()
</script>

<template>
  <main class="view view-home">
    <section class="card hero">
      <div class="card-head">
        <span class="label">/ 开始面试</span>
        <span class="meta">SETUP</span>
      </div>
      <div class="hero-body">
        <h2>
          准备和面搭子开始一场面试
          <span class="en">/ Mock Interview</span>
        </h2>
        <p class="hero-sub">
          选一个方向，或者把目标岗位的 JD 贴进来。面搭子会用语音向你提问，最多 8 轮。
        </p>

        <form class="start-form" @submit.prevent="start">
          <div class="grid-2">
            <label class="field">
              <span class="field-label">你的名字（可选）</span>
              <input
                v-model="candidateName"
                type="text"
                placeholder="比如 张三"
                autocomplete="off"
              />
            </label>
            <label class="field">
              <span class="field-label">
                方向（选择预设或直接输入自定义）
              </span>
              <div class="combo" :class="{ open: showCombo }">
                <input
                  v-model="direction"
                  type="text"
                  placeholder="选择预设方向，或输入自定义方向…"
                  autocomplete="off"
                  spellcheck="false"
                  @focus="showCombo = true"
                  @blur="onComboBlur"
                />
                <button
                  type="button"
                  class="combo-toggle"
                  tabindex="-1"
                  @mousedown.prevent
                  @click.stop="showCombo = !showCombo"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                <ul v-if="showCombo" class="combo-list" role="listbox">
                  <li
                    v-for="d in DIRECTION_PRESETS"
                    :key="d"
                    role="option"
                    :class="{ active: d === direction }"
                    @mousedown.prevent="pickDirection(d)"
                  >
                    {{ d }}
                  </li>
                </ul>
              </div>
            </label>
          </div>

          <label class="field">
            <span class="field-label">
              目标岗位 JD（可选 · 留空则按方向出题）
            </span>
            <textarea
              v-model="jdText"
              rows="6"
              placeholder="把 JD 粘贴在这里，AI 会围绕 JD 里的技能点和职责来设计专业题和追问。"
            />
          </label>

          <div class="grid-2">
            <label class="field">
              <span class="field-label">面搭子的声音（默认跟随设置）</span>
              <select v-model="voice">
                <option value="__default__">默认（跟随设置）</option>
                <option
                  v-for="v in MIMO_VOICES"
                  :key="v.value"
                  :value="v.value"
                >{{ v.label }} — {{ v.note }}</option>
                <option value="__custom__">自定义...</option>
              </select>
              <input
                v-if="voice === '__custom__'"
                v-model="voiceCustom"
                type="text"
                placeholder="输入米莫 API 文档里的声音 ID，例如 silver / 林溪"
                class="settings-custom-voice"
                autocomplete="off"
                spellcheck="false"
              />
            </label>
            <div class="field hint-field">
              <span class="form-hint">
                不填则使用设置页 / .env 里的声音。面试不会自动结束，由你说了算——随时点 ⏹ 结束查看报告。
              </span>
            </div>
          </div>

          <div class="form-actions">
            <button
              type="submit"
              class="btn-primary btn-big"
              :disabled="!canSubmit"
            >
              <IconMic :size="16" />
              {{ submitting ? '准备中…' : '开始面试' }}
            </button>
            <span class="form-hint">
              点击按钮后，面搭子会用语音向你问第一题。面试不设轮数上限，你可以随时点 ⏹ 结束查看报告。
            </span>
          </div>
        </form>

        <div class="hero-foot">
          <span class="hero-foot-label">还没有 API Key？</span>
          <a
            class="settings-link"
            :href="applyLinks.mimo.url"
            target="_blank"
            rel="noopener"
          >
            <IconKey :size="13" />
            <span class="link-label">{{ applyLinks.mimo.label }}</span>
            <IconExt :size="12" />
          </a>
          <a
            class="settings-link"
            :href="applyLinks.deepseek.url"
            target="_blank"
            rel="noopener"
          >
            <IconKey :size="13" />
            <span class="link-label">{{ applyLinks.deepseek.label }}</span>
            <IconExt :size="12" />
          </a>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.view-home {
  display: flex;
  flex-direction: column;
  padding: 28px 24px 60px;
  overflow-y: auto;
}
.hero {
  max-width: 780px;
  width: 100%;
  margin: auto;
}
.hero-body {
  padding: 28px 32px 32px;
}
.hero-body h2 {
  font-size: 26px;
  font-weight: 900;
  letter-spacing: -0.01em;
  color: var(--paper-100);
}
.hero-body h2 .en {
  font-size: 16px;
  color: var(--paper-400);
  margin-left: 8px;
  font-weight: 400;
}
.hero-sub {
  color: var(--paper-300);
  margin: 8px 0 24px;
  font-size: 14px;
  line-height: 1.6;
}
.start-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 640px) {
  .grid-2 {
    grid-template-columns: 1fr;
  }
}
.combo {
  position: relative;
}
.combo-list {
  position: absolute;
  z-index: 50;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 260px;
  overflow-y: auto;
  background: var(--ink-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
  list-style: none;
  margin: 0;
  padding: 4px;
}
.combo-list li {
  padding: 8px 12px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--paper-200);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.combo-list li:hover {
  background: var(--ink-3);
}
.combo-list li.active {
  color: var(--signal-soft);
  background: var(--signal-wash);
}
.combo-toggle {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--paper-400);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.hint-field {
  justify-content: flex-end;
}
.settings-custom-voice {
  margin-top: 6px;
}
.form-hint {
  color: var(--paper-400);
  font-size: 12px;
  line-height: 1.6;
}
.form-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.hero-foot {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px dashed var(--line-2);
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  color: var(--paper-400);
  font-size: 12px;
}
.hero-foot-label {
  color: var(--paper-500);
}
.settings-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--r-pill);
  border: 1px solid var(--line);
  color: var(--paper-300);
  transition: border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.settings-link:hover {
  border-color: var(--paper-400);
  color: var(--paper-100);
}
</style>
