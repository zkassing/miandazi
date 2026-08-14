<script setup lang="ts">
import { useToast } from '@/composables/useToast'
const { state } = useToast()
</script>

<template>
  <Transition name="toast">
    <div v-if="state.visible" class="toast" :class="{ error: state.kind === 'error' }" role="alert">
      {{ state.text }}
    </div>
  </Transition>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
