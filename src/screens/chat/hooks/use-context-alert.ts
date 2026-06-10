import { useCallback, useEffect, useRef, useState } from 'react'

const POLL_MS = 15_000
const STORAGE_KEY = 'claude-ctx-alert'
// 35% threshold fires BEFORE the Hermes compacts (~40% / 80k on 200k window)
const THRESHOLDS = [90, 75, 35] as const

type Threshold = (typeof THRESHOLDS)[number]

type StoredState = {
  date: string
  sent: Record<'35' | '75' | '90', boolean>
}

function getTodayKeyLocal(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function emptySent(): StoredState['sent'] {
  return { '35': false, '75': false, '90': false }
}

function loadStoredState(): StoredState {
  const today = getTodayKeyLocal()
  if (typeof window === 'undefined') return { date: today, sent: emptySent() }
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return { date: today, sent: emptySent() }
    const parsed = JSON.parse(raw) as Partial<StoredState> | null
    if (!parsed || parsed.date !== today)
      return { date: today, sent: emptySent() }
    return {
      date: today,
      sent: {
        '35': Boolean(parsed.sent?.['35']),
        '75': Boolean(parsed.sent?.['75']),
        '90': Boolean(parsed.sent?.['90']),
      },
    }
  } catch {
    return { date: today, sent: emptySent() }
  }
}

function saveStoredState(state: StoredState) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

function readPercent(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

export function useContextAlert(sessionId?: string): {
  alertOpen: boolean
  alertThreshold: number
  alertPercent: number
  dismissAlert: () => void
} {
  const storedRef = useRef<StoredState | null>(null)
  const [alertOpen, setAlertOpen] = useState(false)
  const [alertThreshold, setAlertThreshold] = useState<number>(0)
  const [alertPercent, setAlertPercent] = useState<number>(0)

  const dismissAlert = useCallback(() => {
    setAlertOpen(false)
  }, [])

  const refresh = useCallback(async () => {
    try {
      // Always scope the read to the active session — a session-less poll reads
      // a stale/global value that falsely trips the auto-compaction modal.
      const url = sessionId
        ? `/api/context-usage?sessionId=${encodeURIComponent(sessionId)}`
        : '/api/context-usage'
      const res = await fetch(url)
      if (!res.ok) return
      const data = (await res.json()) as {
        ok?: boolean
        contextPercent?: unknown
      }
      if (!data?.ok) return

      const currentPercent = readPercent(data.contextPercent)
      setAlertPercent(currentPercent)

      // Guard: never fire the alert on a session-less or zero-token read — the
      // real per-session usage is unknown/0 here, so a fired modal would be false.
      if (!sessionId || currentPercent <= 0) return

      if (typeof window === 'undefined') return
      const today = getTodayKeyLocal()
      const stored = storedRef.current ?? loadStoredState()
      if (stored.date !== today) {
        stored.date = today
        stored.sent = emptySent()
        saveStoredState(stored)
      }
      storedRef.current = stored

      if (alertOpen) return

      const candidate = THRESHOLDS.find((threshold) => {
        if (currentPercent < threshold) return false
        return !stored.sent[String(threshold) as keyof StoredState['sent']]
      })
      if (!candidate) return

      stored.sent[String(candidate) as keyof StoredState['sent']] = true
      saveStoredState(stored)

      setAlertThreshold(candidate)
      setAlertOpen(true)
    } catch {
      /* ignore */
    }
  }, [alertOpen, sessionId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    storedRef.current = loadStoredState()
    void refresh()
    const id = window.setInterval(() => {
      void refresh()
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [refresh])

  return { alertOpen, alertThreshold, alertPercent, dismissAlert }
}
