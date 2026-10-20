import { useEffect, useState } from 'react'
import { currentQuota, formatReset, type Quota, type QuotaWindow } from '@shared/quota'
import { api } from './api'

/**
 * The subscription quota: how much of the 5-hour and weekly windows is used, and when each resets.
 * Every dragon draws on the same quota. Hidden until a Claude dragon reports one.
 */
export function QuotaGauge() {
  const [quota, setQuota] = useState<Quota | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    void api.quota.get().then((q) => q && setQuota(q))
    const off = api.quota.onUpdate(setQuota)
    // Reset times count down, and a window disappears once it resets.
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [])

  const q = currentQuota(quota, now)
  if (!q) return null
  return (
    <span className="quota" title="Subscription usage, shared by every dragon. From Claude Code's status line.">
      {q.fiveHour ? <Meter label="5h" window={q.fiveHour} now={now} /> : null}
      {q.sevenDay ? <Meter label="week" window={q.sevenDay} now={now} /> : null}
    </span>
  )
}

function Meter({ label, window: w, now }: { label: string; window: QuotaWindow; now: number }) {
  const pct = Math.round(w.usedPercent)
  const level = pct >= 90 ? ' quota-high' : pct >= 70 ? ' quota-mid' : ''
  const resets = formatReset(w.resetsAt, now)
  return (
    <span className={'quota-meter' + level} title={`${label}: ${pct}% used, resets ${resets} (${new Date(w.resetsAt).toLocaleString()})`}>
      <span className="quota-label">{label}</span>
      <span className="quota-bar">
        <span className="quota-fill" style={{ width: pct + '%' }} />
      </span>
      <span className="quota-pct">{pct}%</span>
      <span className="quota-reset">{resets}</span>
    </span>
  )
}
