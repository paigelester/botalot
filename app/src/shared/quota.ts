/**
 * Subscription quota, read from the `rate_limits` field of Claude Code's status line input. Claude Code
 * sends it only to Pro and Max subscribers, and only after a session's first API response; each window
 * may be absent on its own. Pure, so it is testable: imports nothing.
 */

/** One usage window. */
export interface QuotaWindow {
  /** Share of the window used, 0 to 100. */
  usedPercent: number
  /** When the window resets, epoch milliseconds. */
  resetsAt: number
}

/** The latest reading. Quota belongs to the account, so any dragon's reading stands for all of them. */
export interface Quota {
  fiveHour?: QuotaWindow
  sevenDay?: QuotaWindow
}

function parseWindow(v: unknown): QuotaWindow | undefined {
  if (!v || typeof v !== 'object') return undefined
  const w = v as Record<string, unknown>
  const used = w.used_percentage
  const resets = w.resets_at
  if (typeof used !== 'number' || !Number.isFinite(used) || typeof resets !== 'number' || !Number.isFinite(resets)) return undefined
  // resets_at is epoch seconds.
  return { usedPercent: Math.min(100, Math.max(0, used)), resetsAt: resets * 1000 }
}

/** The quota in a status line payload, or null when it carries none (an API-key session, or no response yet). */
export function parseRateLimits(payload: Record<string, unknown>): Quota | null {
  const rl = payload.rate_limits
  if (!rl || typeof rl !== 'object') return null
  const r = rl as Record<string, unknown>
  const q: Quota = {}
  const fiveHour = parseWindow(r.five_hour)
  const sevenDay = parseWindow(r.seven_day)
  if (fiveHour) q.fiveHour = fiveHour
  if (sevenDay) q.sevenDay = sevenDay
  return fiveHour || sevenDay ? q : null
}

/** The reading as of `now`: a window whose reset time has passed is dropped, as Claude Code does. Null when none is left. */
export function currentQuota(q: Quota | null, now: number): Quota | null {
  if (!q) return null
  const live = (w?: QuotaWindow) => (w && w.resetsAt > now ? w : undefined)
  const fiveHour = live(q.fiveHour)
  const sevenDay = live(q.sevenDay)
  if (!fiveHour && !sevenDay) return null
  const out: Quota = {}
  if (fiveHour) out.fiveHour = fiveHour
  if (sevenDay) out.sevenDay = sevenDay
  return out
}

/** Time until a reset, coarse enough to read at a glance: "in 42m", "in 3h 5m", "in 2d 4h". */
export function formatReset(resetsAt: number, now: number): string {
  const mins = Math.max(1, Math.ceil((resetsAt - now) / 60_000))
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `in ${hours}h ${mins % 60}m`
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`
}
