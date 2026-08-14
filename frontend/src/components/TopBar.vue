<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useHealthStore } from '@/stores/health'
import IconGear from '@/components/IconGear.vue'
import IconHistory from '@/components/IconHistory.vue'

const health = useHealthStore()
const router = useRouter()

onMounted(() => {
  if (!health.health) health.refresh()
})
</script>

<template>
  <header class="topbar">
    <div class="tb-left">
      <RouterLink to="/" class="brand" aria-label="返回首页">
        <span class="brand-mark" aria-hidden="true">🍜</span>
        <span class="brand-word">面<em>搭子</em></span>
      </RouterLink>
      <div class="file-meta">
        <div class="file-sub">VOICE INTERVIEW <span class="dot">●</span> MiMo + DeepSeek</div>
      </div>
    </div>
    <div class="tb-center">
      <div class="status" :class="health.statusKind" @click="health.refresh()" title="点击刷新">
        <span class="dot"></span>
        <span class="status-text">{{ health.statusLabel }}</span>
      </div>
    </div>
    <div class="tb-right">
      <button
        type="button"
        title="查看历史面试"
        @click="router.push('/history')"
      >
        <IconHistory />
        历史
      </button>
      <button
        type="button"
        title="模型配置 / API Key 申请"
        @click="router.push('/settings')"
      >
        <IconGear />
        模型配置
      </button>
    </div>
  </header>
</template>
