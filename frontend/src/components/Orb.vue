<script setup lang="ts">
defineProps<{ state: 'speaking' | 'listening' | 'thinking' | 'idle' }>()
</script>

<template>
  <div class="iv-orb" :class="state" aria-hidden="true">
    <div class="iv-orb-core"></div>
    <div class="iv-orb-ring"></div>
    <div class="iv-orb-ring r2"></div>
  </div>
</template>

<style scoped>
.iv-orb {
  position: relative;
  width: 220px;
  height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.iv-orb-core {
  position: absolute;
  width: 100px;
  height: 100px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, var(--signal-soft), var(--signal-deep));
  box-shadow: 0 0 50px rgba(37, 64, 255, 0.5);
  transition: all 0.3s ease;
}
.iv-orb-ring {
  position: absolute;
  width: 140px;
  height: 140px;
  border-radius: 50%;
  border: 2px solid rgba(107, 125, 255, 0.4);
}
.iv-orb-ring.r2 {
  width: 180px;
  height: 180px;
  border-color: rgba(107, 125, 255, 0.2);
}

/* Listening: gentle pulse */
.iv-orb.listening .iv-orb-core {
  animation: orb-pulse 2.4s ease-in-out infinite;
}
@keyframes orb-pulse {
  0%, 100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.1);
  }
}

/* Speaking: bigger pulse + rings expand */
.iv-orb.speaking .iv-orb-core {
  animation: orb-bounce 1.4s ease-in-out infinite;
}
.iv-orb.speaking .iv-orb-ring {
  animation: orb-ring 1.8s ease-out infinite;
}
.iv-orb.speaking .iv-orb-ring.r2 {
  animation: orb-ring 1.8s ease-out infinite 0.6s;
}
@keyframes orb-bounce {
  0%, 100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.18);
  }
}
@keyframes orb-ring {
  0% {
    opacity: 0.6;
    transform: scale(0.8);
  }
  100% {
    opacity: 0;
    transform: scale(1.4);
  }
}

/* Thinking: rotate */
.iv-orb.thinking .iv-orb-ring {
  animation: orb-spin 4s linear infinite;
  border-top-color: var(--ember);
  border-right-color: transparent;
}
.iv-orb.thinking .iv-orb-core {
  background: radial-gradient(circle at 35% 35%, var(--ember), var(--ember-deep));
  box-shadow: 0 0 50px rgba(255, 122, 77, 0.5);
}
@keyframes orb-spin {
  to {
    transform: rotate(360deg);
  }
}

.iv-orb.idle .iv-orb-core {
  background: radial-gradient(circle at 35% 35%, var(--ink-4), var(--ink-3));
  box-shadow: none;
}
</style>
