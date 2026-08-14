<script setup lang="ts">
import { computed } from 'vue'
import IconUsers from '@/components/IconUsers.vue'
import IconCode from '@/components/IconCode.vue'
import IconZap from '@/components/IconZap.vue'
import IconGift from '@/components/IconGift.vue'
import IconChat from '@/components/IconChat.vue'
import type { InterviewTopic } from '@/types'

const props = defineProps<{ topic?: InterviewTopic | null }>()

const map: Record<string, [any, string]> = {
  behavioral: [IconUsers, '行为面试'],
  technical: [IconCode, '技术题'],
  scenario: [IconZap, '情景题'],
  wrap_up: [IconGift, '收尾'],
  candidate_questions: [IconChat, '反问环节'],
}

const info = computed(() => {
  const t = props.topic || ''
  if (!t) return null
  return map[t] || null
})
</script>

<template>
  <span v-if="info" class="topic-chip">
    <component :is="info[0]" />
    {{ info[1] }}
  </span>
  <span v-else class="topic-chip empty">—</span>
</template>

<style scoped>
.topic-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: var(--ink-3);
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--paper-300);
  text-transform: uppercase;
}
.topic-chip.empty {
  color: var(--paper-500);
}
</style>
