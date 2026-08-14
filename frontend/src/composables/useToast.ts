import { ref } from 'vue'

interface ToastState {
  text: string
  kind: 'info' | 'error'
  visible: boolean
}

const state = ref<ToastState>({ text: '', kind: 'info', visible: false })
let timer: number | null = null

export function useToast() {
  function show(msg: string, isError = false, ttl = 4500) {
    state.value.text = msg
    state.value.kind = isError ? 'error' : 'info'
    state.value.visible = true
    if (timer != null) clearTimeout(timer)
    timer = window.setTimeout(() => {
      state.value.visible = false
    }, ttl)
  }
  function hide() {
    state.value.visible = false
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
  }
  return { state, show, hide }
}
