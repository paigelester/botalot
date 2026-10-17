import { useEffect, useMemo, useRef, useState } from 'react'
import type { Issue, IssueList, Tracker } from '@shared/types'
import { api } from '../api'

interface Props {
  projectId: string
  tracker: Tracker['kind']
  selected: Issue | null
  onSelect(issue: Issue | null): void
  /** Lets the parent know whether any issues exist, to enable or disable the option. */
  onLoaded?(list: IssueList): void
}

const TRACKER_LABEL: Record<Tracker['kind'], string> = { none: 'issue', github: 'GitHub', jira: 'Jira' }

function matches(issue: Issue, q: string): boolean {
  const needle = q.toLowerCase()
  return (
    issue.key.toLowerCase().includes(needle.replace(/^#/, '')) ||
    issue.title.toLowerCase().includes(needle) ||
    issue.labels.some((l) => l.toLowerCase().includes(needle)) ||
    issue.assignees.some((a) => a.toLowerCase().includes(needle))
  )
}

/** Searchable issue list: type to filter the recent issues, or search the tracker itself when the list is truncated. */
export function IssuePicker({ projectId, tracker, selected, onSelect, onLoaded }: Props) {
  const [query, setQuery] = useState('')
  const [list, setList] = useState<IssueList | null>(null)
  const [serverResults, setServerResults] = useState<IssueList | null>(null)
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const latest = useRef(0)

  useEffect(() => {
    setLoading(true)
    setList(null)
    setServerResults(null)
    setQuery('')
    const n = ++latest.current
    void api.projects.issues(projectId).then((res) => {
      if (n !== latest.current) return
      setList(res)
      setLoading(false)
      onLoaded?.(res)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const base = serverResults ?? list
  const filtered = useMemo(() => {
    const all = base?.issues ?? []
    const q = query.trim()
    if (!q || serverResults) return all
    return all.filter((i) => matches(i, q))
  }, [base, query, serverResults])

  useEffect(() => setCursor(0), [query, serverResults])

  async function searchServer() {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    const res = await api.projects.issues(projectId, q)
    setServerResults(res)
    setSearching(false)
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[cursor]) onSelect(filtered[cursor])
      else if (list?.truncated) void searchServer()
    }
  }

  const label = TRACKER_LABEL[tracker]

  if (selected) {
    return (
      <div className="issue-selected">
        <div className="issue-row selected">
          <span className="issue-key">{selected.key}</span>
          <span className="issue-title">{selected.title}</span>
          {selected.status ? <span className="issue-status">{selected.status}</span> : null}
        </div>
        <button type="button" className="ghost small" onClick={() => onSelect(null)}>
          Change
        </button>
      </div>
    )
  }

  return (
    <div className="issue-picker">
      <div className="row">
        <input
          ref={inputRef}
          type="text"
          placeholder={`Filter by key, title, label or assignee…`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            if (serverResults) setServerResults(null)
          }}
          onKeyDown={onKey}
          autoFocus
        />
        {list?.truncated || serverResults ? (
          <button type="button" className="small" onClick={() => void searchServer()} disabled={!query.trim() || searching} title={`Search all ${label} issues, not just the recent ones`}>
            {searching ? '…' : `Search ${label}`}
          </button>
        ) : null}
      </div>
      {loading ? <div className="hint">Loading {label} issues…</div> : null}
      {base?.error ? <div className="error">{base.error}</div> : null}
      {!loading && base && !base.error ? (
        <div className="issue-list" role="listbox">
          {filtered.length === 0 ? (
            <div className="hint issue-empty">
              {query.trim() ? `No match in the ${base.issues.length} loaded issues.` : `No open ${label} issues.`}
              {query.trim() && list?.truncated && !serverResults ? ' Press Enter to search the tracker.' : ''}
            </div>
          ) : null}
          {filtered.slice(0, 200).map((i, idx) => (
            <div
              key={i.key}
              role="option"
              aria-selected={idx === cursor}
              className={'issue-row' + (idx === cursor ? ' cursor' : '')}
              onMouseEnter={() => setCursor(idx)}
              onClick={() => onSelect(i)}
            >
              <span className="issue-key">{i.key}</span>
              <span className="issue-title" title={i.title}>
                {i.title}
              </span>
              {i.labels.slice(0, 3).map((l) => (
                <span key={l} className="issue-label">
                  {l}
                </span>
              ))}
              {i.status ? <span className="issue-status">{i.status}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {!loading && base && !base.error ? (
        <div className="hint issue-foot">
          {serverResults ? `${filtered.length} from ${label} search` : `${filtered.length} of ${base.issues.length} recent open issues`}
          {list?.truncated && !serverResults ? ` (more exist; use Search ${label})` : ''}
        </div>
      ) : null}
    </div>
  )
}
