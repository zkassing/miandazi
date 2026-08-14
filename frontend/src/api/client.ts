import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios'

/**
 * Axios instance pre-configured for the Fastify backend.
 *
 * - In dev, Vite proxies `/api/*` to `http://localhost:5174`.
 * - In production, the SPA and API share an origin (e.g. behind reverse proxy).
 *
 * A 401/404/500 wraps the upstream error into a thrown Error with a clean
 * `message` and a `status` field, so views don't have to inspect axios's
 * response object.
 */
const instance: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 0, // uploads + TTS synthesis can be slow; let the server decide
})

instance.interceptors.response.use(
  (r) => r,
  (err: AxiosError<{ error?: string; message?: string }>) => {
    const status = err.response?.status ?? 0
    const data = err.response?.data
    const message =
      data?.message ||
      data?.error ||
      err.message ||
      '网络请求失败'
    const wrapped = new Error(message) as Error & { status: number; data: unknown }
    wrapped.status = status
    wrapped.data = data
    return Promise.reject(wrapped)
  },
)

export default instance

export type { AxiosRequestConfig }
