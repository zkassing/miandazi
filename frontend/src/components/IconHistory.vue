<script setup lang="ts">
defineProps<{ size?: number }>()
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size ?? 14"
    :height="size ?? 14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <polyline points="3 3 3 9 9 9" />
    <path d="M12 7v5l3 2" />
  </svg>
</template>
