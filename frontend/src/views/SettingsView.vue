<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSettingsStore } from '@/stores/settings'
import { useHealthStore } from '@/stores/health'
import { useToast } from '@/composables/useToast'
import { testSettings } from '@/api'
import type { SettingsTestResponse, SettingsUpdatePayload } from '@/types'
import { MIMO_VOICES, isKnownMimoVoice } from '@/data/mimoVoices'
import IconMic from '@/components/IconMic.vue'
import IconBrain from '@/components/IconBrain.vue'
import IconKey from '@/components/IconKey.vue'
import IconExt from '@/components/IconExt.vue'
import IconCheck from '@/components/IconCheck.vue'
import IconX from '@/components/IconX.vue'
import IconZap from '@/components/IconZap.vue'
import IconReset from '@/components/IconReset.vue'

const settings = useSettingsStore()
const health = useHealthStore()
const toast = useToast()
const router = useRouter()
const mimoKey = ref('')
const mimoBaseUrl = ref('')
const mimoAsr = ref('')
const mimoTts = ref('')
const mimoVoice = ref('')
const mimoVoiceCustom = ref('')
const mimoFormat = ref('wav')

// MiMo TTS voices are defined in @/data/mimoVoices — single source of truth
// shared with HomeView so the two dropdowns never drift apart.
const mimoPrompt = ref('')
const dsKey = ref('')
const dsBaseUrl = ref('')
const dsModel = ref('')

const testResult = ref<SettingsTestResponse | null>(null)
const testing = ref(false)
const testPanel = ref(false)

const saveState = computed(() => settings.saveState)

onMounted(async () => {
  await settings.load()
  if (settings.data) {
    mimoBaseUrl.value = settings.data.mimo.baseUrl
    mimoAsr.value = settings.data.mimo.asrModel
    mimoTts.value = settings.data.mimo.ttsModel
    // If the saved voice is one of the known options, keep it. Otherwise
    // it's a custom voice — fall back to the "Custom..." option and
    // populate the custom input.
    const savedVoice = settings.data.mimo.ttsVoice
    if (isKnownMimoVoice(savedVoice)) {
      mimoVoice.value = savedVoice
      mimoVoiceCustom.value = ''
    } else if (savedVoice) {
      mimoVoice.value = '__custom__'
      mimoVoiceCustom.value = savedVoice
    } else {
      mimoVoice.value = 'mimo_default'
      mimoVoiceCustom.value = ''
    }
    mimoFormat.value = settings.data.mimo.ttsFormat || 'wav'
    mimoPrompt.value = settings.data.mimo.systemPrompt
    dsBaseUrl.value = settings.data.deepseek.baseUrl
    dsModel.value = settings.data.deepseek.model
  }
})

function collectPayload(): SettingsUpdatePayload {
  // Resolve custom voice: if the dropdown is set to "Custom..." we use
  // whatever the user typed in the custom input. Empty custom input
  // falls back to the default voice so we never send an empty string.
  const resolvedVoice =
    mimoVoice.value === '__custom__'
      ? (mimoVoiceCustom.value.trim() || 'mimo_default')
      : mimoVoice.value.trim() || 'mimo_default'
  const payload: SettingsUpdatePayload = {
    mimo: {
      baseUrl: mimoBaseUrl.value.trim(),
      asrModel: mimoAsr.value.trim(),
      ttsModel: mimoTts.value.trim(),
      ttsVoice: resolvedVoice,
      ttsFormat: mimoFormat.value,
      systemPrompt: mimoPrompt.value,
    },
    deepseek: {
      baseUrl: dsBaseUrl.value.trim(),
      model: dsModel.value.trim(),
    },
  }
  if (mimoKey.value) payload.mimo!.apiKey = mimoKey.value
  if (dsKey.value) payload.deepseek!.apiKey = dsKey.value
  return payload
}

async function save() {
  try {
    await settings.save(collectPayload())
    toast.show('模型配置已保存，立即生效。', false, 3000)
    health.refresh()
  } catch (err: any) {
    toast.show(`保存失败：${err.message}`, true)
  }
}

async function test() {
  testing.value = true
  testPanel.value = true
  testResult.value = null
  try {
    testResult.value = await testSettings(collectPayload())
  } catch (err: any) {
    testResult.value = {
      results: {
        mimo: { ok: false, message: err.message },
        deepseek: { ok: false, message: '未测试' },
      },
    }
  } finally {
    testing.value = false
  }
}

async function reset() {
  if (!confirm('确定恢复默认配置吗？将清空你在网页里保存的所有模型设置，回到 .env 的初始值。')) return
  try {
    await settings.reset()
    mimoKey.value = ''
    dsKey.value = ''
    toast.show('已恢复 .env 默认配置。', false, 3000)
    health.refresh()
  } catch (err: any) {
    toast.show(`恢复默认失败：${err.message}`, true)
  }
}

const mimoBadge = computed(() => {
  if (!settings.data) return { text: '检测中…', kind: 'warn' }
  return settings.data.mimo.apiKeySet
    ? { text: `已配置 ${settings.data.mimo.apiKeyMasked}`, kind: 'ok' }
    : { text: '未配置 Key', kind: 'warn' }
})

const dsBadge = computed(() => {
  if (!settings.data) return { text: '检测中…', kind: 'warn' }
  return settings.data.deepseek.apiKeySet
    ? { text: `已配置 ${settings.data.deepseek.apiKeyMasked}`, kind: 'ok' }
    : { text: '未配置 Key', kind: 'warn' }
})
</script>

<template>
  <main class="view-settings">
    <section class="card settings-card">
      <div class="card-head">
        <div class="head-left">
          <div class="modal-icon settings-icon">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
              />
            </svg>
          </div>
          <div>
            <h2 class="settings-title">模型配置</h2>
            <p class="settings-sub">
              修改后立即生效，无需重启。API Key 仅保存在本地服务器，不会上传。
            </p>
          </div>
        </div>
        <button class="btn-ghost" type="button" @click="router.push('/')">关闭</button>
      </div>

      <div class="settings-body">
        <section class="settings-section">
          <div class="settings-section-head">
            <h3>
              <IconMic :size="15" />
              语音识别 / 合成 · MiMo
            </h3>
            <span class="settings-badge" :class="mimoBadge.kind">{{ mimoBadge.text }}</span>
          </div>

          <div class="settings-field">
            <label for="setMimoKey">API Key（留空＝保持当前 Key 不变）</label>
            <input
              id="setMimoKey"
              v-model="mimoKey"
              type="password"
              placeholder="sk-mimo-…"
              autocomplete="off"
              spellcheck="false"
            />
            <a
              class="settings-link"
              :href="settings.data?.keyApplyUrls.mimo.url || '#'"
              target="_blank"
              rel="noopener"
            >
              <IconKey :size="13" />
              去 {{ settings.data?.keyApplyUrls.mimo.label || 'MiMo 开放平台' }} 申请 Key
              <IconExt :size="12" />
            </a>
          </div>

          <div class="settings-grid-2">
            <div class="settings-field">
              <label for="setMimoBaseUrl">Base URL</label>
              <input
                id="setMimoBaseUrl"
                v-model="mimoBaseUrl"
                type="text"
                placeholder="https://api.xiaomimimo.com/v1/chat/completions"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <div class="settings-field">
              <label for="setMimoAsr">ASR 模型（语音转文字）</label>
              <input
                id="setMimoAsr"
                v-model="mimoAsr"
                type="text"
                placeholder="mimo-v2.5-asr"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <div class="settings-field">
              <label for="setMimoTts">TTS 模型（文字转语音）</label>
              <input
                id="setMimoTts"
                v-model="mimoTts"
                type="text"
                placeholder="mimo-v2.5-tts"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <div class="settings-field">
              <label for="setMimoVoice">TTS 声音</label>
              <select
                id="setMimoVoice"
                v-model="mimoVoice"
              >
                <option
                  v-for="v in MIMO_VOICES"
                  :key="v.value"
                  :value="v.value"
                >{{ v.label }} — {{ v.note }}</option>
                <option value="__custom__">自定义...</option>
              </select>
              <input
                v-if="mimoVoice === '__custom__'"
                v-model="mimoVoiceCustom"
                type="text"
                placeholder="输入米莫 API 文档里的声音 ID，例如 silver / 林溪"
                class="settings-custom-voice"
                autocomplete="off"
                spellcheck="false"
              />
              <p class="settings-hint">
                不知道选哪个？试试 <code>mimo_default</code>（最安全）。
                名字是中文的（如「冰糖」）是中文音色，英文名（Mia/Chloe）是英文音色。
                选「自定义」可填 API 文档里其他任何声音名。
              </p>
            </div>
            <div class="settings-field">
              <label for="setMimoFormat">TTS 格式</label>
              <select id="setMimoFormat" v-model="mimoFormat">
                <option value="wav">wav</option>
                <option value="mp3">mp3</option>
                <option value="opus">opus</option>
              </select>
            </div>
          </div>

          <div class="settings-field">
            <label for="setMimoPrompt">转写系统提示词（可选）</label>
            <textarea
              id="setMimoPrompt"
              v-model="mimoPrompt"
              rows="2"
              placeholder="例如：音频内容是技术面试，注意专业术语的转写。留空清除。"
            />
          </div>
        </section>

        <section class="settings-section">
          <div class="settings-section-head">
            <h3>
              <IconBrain :size="15" />
              面搭子的大脑 · DeepSeek
            </h3>
            <span class="settings-badge" :class="dsBadge.kind">{{ dsBadge.text }}</span>
          </div>

          <div class="settings-field">
            <label for="setDsKey">API Key（留空＝保持当前 Key 不变）</label>
            <input
              id="setDsKey"
              v-model="dsKey"
              type="password"
              placeholder="sk-…"
              autocomplete="off"
              spellcheck="false"
            />
            <a
              class="settings-link"
              :href="settings.data?.keyApplyUrls.deepseek.url || '#'"
              target="_blank"
              rel="noopener"
            >
              <IconKey :size="13" />
              去 {{ settings.data?.keyApplyUrls.deepseek.label || 'DeepSeek 开放平台' }} 申请 Key
              <IconExt :size="12" />
            </a>
          </div>

          <div class="settings-grid-2">
            <div class="settings-field">
              <label for="setDsBaseUrl">Base URL</label>
              <input
                id="setDsBaseUrl"
                v-model="dsBaseUrl"
                type="text"
                placeholder="https://api.deepseek.com/v1"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <div class="settings-field">
              <label for="setDsModel">模型</label>
              <input
                id="setDsModel"
                v-model="dsModel"
                type="text"
                placeholder="deepseek-v4-flash"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
          </div>
        </section>

        <div v-if="testPanel" class="settings-test-result" :class="{ open: testPanel }">
          <div v-if="testing" class="settings-test-row">
            <IconZap :size="14" /> 正在用当前表单配置测试 MiMo 与 DeepSeek 连接…
          </div>
          <template v-else-if="testResult">
            <template v-for="(item, key) in testResult.results" :key="key">
              <div v-if="item" class="settings-test-row">
                <span :class="item.ok ? 'ok' : 'fail'">
                  <component :is="item.ok ? IconCheck : IconX" :size="13" />
                  {{ key === 'mimo' ? 'MiMo 语音' : 'DeepSeek 大脑' }}：{{ item.message }}
                </span>
                <span v-if="item.latencyMs != null" class="settings-test-detail">{{ item.latencyMs }}ms</span>
                <span v-if="item.detail" class="settings-test-detail">{{ item.detail }}</span>
              </div>
            </template>
          </template>
        </div>
      </div>

      <div class="settings-foot">
        <span class="settings-save-state" v-if="saveState">
          <IconCheck :size="12" /> {{ saveState }}
        </span>
        <span class="settings-save-state" v-else></span>
        <button class="btn-ghost" type="button" @click="reset">
          <IconReset :size="14" />
          恢复默认
        </button>
        <button type="button" :disabled="testing" @click="test">
          <IconZap :size="14" />
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn-primary" type="button" :disabled="settings.loading" @click="save">
          <IconCheck :size="14" />
          保存配置
        </button>
      </div>
    </section>
  </main>
</template>

<style scoped>
.view-settings {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 28px 24px 60px;
  overflow-y: auto;
}
.settings-card {
  max-width: 880px;
  width: 100%;
  margin: auto;
  background: var(--ink-2);
}
.head-left {
  display: flex;
  align-items: center;
  gap: 14px;
}
.settings-title {
  font-size: 18px;
  font-weight: 700;
  margin: 0;
  color: var(--paper-100);
}
.settings-sub {
  margin: 4px 0 0;
  color: var(--paper-400);
  font-size: 12px;
}
.modal-icon {
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--ink-3);
  color: var(--paper-300);
  flex-shrink: 0;
}
.modal-icon.settings-icon {
  background: var(--signal-wash);
  color: var(--signal-soft);
}

.settings-body {
  padding: 24px 30px;
  display: flex;
  flex-direction: column;
  gap: 26px;
}
.settings-section {
  border: 1px solid var(--line);
  border-radius: var(--r-card);
  padding: 18px 20px;
  background: var(--ink-3);
}
.settings-section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  gap: 12px;
  flex-wrap: wrap;
}
.settings-section-head h3 {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  margin: 0;
  color: var(--paper-100);
}
.settings-badge {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  padding: 3px 10px;
  border-radius: var(--r-pill);
  border: 1px solid var(--line-2);
}
.settings-badge.ok {
  color: var(--green);
  border-color: var(--green);
  background: rgba(74, 222, 128, 0.1);
}
.settings-badge.warn {
  color: var(--warning);
  border-color: var(--warning);
  background: rgba(250, 204, 21, 0.1);
}
.settings-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.settings-hint {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--paper-500);
}
.settings-hint code {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 1px 5px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 3px;
  color: var(--paper-300);
}
.settings-custom-voice {
  margin-top: 6px;
}
.settings-field label {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--paper-400);
}
.settings-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
@media (max-width: 640px) {
  .settings-grid-2 {
    grid-template-columns: 1fr;
  }
}
.settings-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--signal-soft);
}
.settings-link:hover {
  color: var(--paper-100);
}
.settings-test-result {
  margin-top: 4px;
  padding: 12px 14px;
  background: var(--ink-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12px;
  display: none;
}
.settings-test-result.open {
  display: block;
}
.settings-test-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  flex-wrap: wrap;
}
.settings-test-row .ok {
  color: var(--green);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.settings-test-row .fail {
  color: var(--danger);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.settings-test-detail {
  color: var(--paper-400);
  font-family: var(--mono);
  font-size: 11px;
}
.settings-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 24px;
  border-top: 1px solid var(--line);
  background: var(--ink-3);
  flex-wrap: wrap;
}
.settings-save-state {
  margin-right: auto;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  color: #6ca0ff;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>
