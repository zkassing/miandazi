import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useInterviewStore } from '@/stores/interview'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { title: '首页' },
  },
  {
    path: '/interview',
    name: 'interview',
    component: () => import('@/views/InterviewView.vue'),
    meta: { title: '面搭子在听你说话' },
    // 进入面试页必须有 session，否则跳回首页
    beforeEnter: () => {
      const store = useInterviewStore()
      if (!store.sessionId) return { name: 'home' }
      return true
    },
  },
  {
    path: '/report',
    name: 'report',
    component: () => import('@/views/ReportView.vue'),
    meta: { title: '面搭子给你的复盘' },
    beforeEnter: () => {
      const store = useInterviewStore()
      if (!store.sessionId) return { name: 'home' }
      return true
    },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { title: '面搭子设置' },
  },
  {
    path: '/history',
    name: 'history',
    component: () => import('@/views/HistoryView.vue'),
    meta: { title: '过往的面试' },
  },
  {
    path: '/history/:id',
    name: 'history-detail',
    component: () => import('@/views/ReportView.vue'),
    meta: { title: '翻看一份老报告' },
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 }
  },
})

router.afterEach((to) => {
  const t = to.meta?.title as string | undefined
  document.title = t ? `${t} · 🍜 面搭子` : '🍜 面搭子 · 你的语音模拟面试搭子'
})
