export type AuthStatus = 'loading' | 'ok' | 'needs-key' | 'disabled' | 'error'
export type AuthMode = 'env' | 'cookie' | null
// Why /api/ping couldn't use jack: 'dns', 'down' and 'timeout' mean jack-ui
// can't reach it, 'unauthorized' that jack rejected the jack-ui template's key.
export type AuthProbeReason = 'dns' | 'down' | 'timeout' | 'unauthorized'

export interface AuthState {
  status: AuthStatus
  mode: AuthMode
  message?: string
  reason?: AuthProbeReason
  // Where jack-ui looked for jack (only while it can't reach it).
  url?: string
}

interface PingResponse {
  status: Exclude<AuthStatus, 'loading'>
  mode: AuthMode
  message?: string
  reason?: AuthProbeReason
  url?: string
}

export function useAuthState() {
  return useState<AuthState>('auth', () => ({ status: 'loading', mode: null }))
}

export function useAuth() {
  const state = useAuthState()

  async function refresh(): Promise<void> {
    try {
      const res = await $fetch<PingResponse>('/api/ping')
      state.value = { status: res.status, mode: res.mode, message: res.message, reason: res.reason, url: res.url }
    }
    catch {
      state.value = { status: 'error', mode: null, message: 'Could not reach the UI server.' }
    }
  }

  async function login(key: string): Promise<void> {
    await $fetch('/api/login', { method: 'POST', body: { key } })
    await refresh()
  }

  async function logout(): Promise<void> {
    await $fetch('/api/logout', { method: 'POST' })
    await refresh()
  }

  return { state, refresh, login, logout }
}
