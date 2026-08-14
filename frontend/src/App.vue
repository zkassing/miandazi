<script setup lang="ts">
import TopBar from '@/components/TopBar.vue'
import ToastHost from '@/components/ToastHost.vue'
import { RouterView } from 'vue-router'
</script>

<template>
  <TopBar />
  <RouterView v-slot="{ Component }">
    <Transition name="fade" mode="out-in">
      <component :is="Component" />
    </Transition>
  </RouterView>
  <ToastHost />
</template>

<style>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
