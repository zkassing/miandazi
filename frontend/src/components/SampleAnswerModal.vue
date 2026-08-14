<script setup lang="ts">
import IconBulb from '@/components/IconBulb.vue'

defineProps<{ open: boolean; answer: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <Transition name="modal">
    <div v-if="open" class="modal" role="dialog" aria-modal="true" aria-labelledby="sampleAnswerTitle">
      <div class="modal-card">
        <div class="modal-head">
          <div class="modal-icon"><IconBulb :size="22" /></div>
          <h3 id="sampleAnswerTitle">参考答案</h3>
        </div>
        <p class="modal-hint">这道题可以这样答——请认真阅读后再回答。</p>
        <div class="modal-body">{{ answer }}</div>
        <div class="modal-foot">
          <button class="btn-primary btn-big" type="button" @click="emit('close')">
            我已经看完了
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(6px);
  padding: 24px;
}
.modal-card {
  background: var(--ink-2);
  border: 1px solid var(--line);
  border-radius: var(--r-panel);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);
  max-width: 540px;
  width: 100%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 24px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, var(--ink-3), var(--ink-2));
}
.modal-icon {
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--signal-wash);
  color: var(--signal-soft);
  flex-shrink: 0;
}
.modal-head h3 {
  font-size: 17px;
  font-weight: 700;
  color: var(--paper-100);
}
.modal-hint {
  padding: 12px 24px 0;
  color: var(--paper-400);
  font-size: 12px;
  font-family: var(--mono);
  letter-spacing: 0.06em;
}
.modal-body {
  padding: 16px 24px 24px;
  color: var(--paper-200);
  font-size: 14px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.modal-foot {
  padding: 16px 24px;
  border-top: 1px solid var(--line);
  display: flex;
  justify-content: flex-end;
  background: var(--ink-3);
}
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-active .modal-card,
.modal-leave-active .modal-card {
  transition: transform 0.2s ease;
}
.modal-enter-from .modal-card,
.modal-leave-to .modal-card {
  transform: translateY(8px) scale(0.98);
}
</style>
