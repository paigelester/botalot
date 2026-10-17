import { useEffect, useState } from 'react'
import type { JiraSite, Project, Tracker } from '@shared/types'
import { api } from '../api'

const TINTS = [0xe05a3a, 0x3a8fe0, 0x4fb563, 0xd8a53b, 0x9c5be0, 0x2fb8b0, 0xe0629c, 0xa0b23a, 0xc46f2f, 0x6c7be0]

interface Props {
  onClose(): void
}

function hex(tint: number): string {
  return '#' + tint.toString(16).padStart(6, '0')
}

/** Manage realms: show, hide or remove projects, add folders, change colours, worktree layout and issue tracker. */
export function RealmsDialog({ onClose }: Props) {
  const [all, setAll] = useState<Project[]>([])
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sites, setSites] = useState<JiraSite[]>([])
  const [editingJira, setEditingJira] = useState<string | null>(null)

  async function reload() {
    setAll(await api.projects.listAll())
    setSites(await api.jira.sites())
  }

  useEffect(() => {
    void reload()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function remove(id: string) {
    setError(null)
    try {
      setAll(await api.projects.remove(id))
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
    setConfirmId(null)
  }

  async function patch(id: string, p: Partial<Pick<Project, 'name' | 'tint' | 'worktreeLayout' | 'hidden' | 'tracker'>>) {
    setAll(await api.projects.update(id, p))
  }

  function setTrackerKind(p: Project, kind: Tracker['kind']) {
    if (kind === 'jira') {
      const prev = p.tracker?.kind === 'jira' ? p.tracker : null
      void patch(p.id, { tracker: { kind: 'jira', site: prev?.site ?? sites[0]?.site ?? '', projectKey: prev?.projectKey ?? '', jql: prev?.jql } })
      setEditingJira(p.id)
    } else {
      void patch(p.id, { tracker: { kind } })
      if (editingJira === p.id) setEditingJira(null)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Realms of the kingdom</h2>
        <p className="hint">Discovered from Claude Code's history. Each realm picks its own issue tracker.</p>
        <div className="realm-list">
          {all.map((p) => {
            const t = p.tracker ?? { kind: 'none' as const }
            return (
              <div key={p.id} className={'realm-block' + (p.hidden ? ' realm-hidden' : '')}>
                <div className="realm-row">
                  <button
                    className="swatch"
                    style={{ background: hex(p.tint) }}
                    title="Change colour"
                    onClick={() => void patch(p.id, { tint: TINTS[(TINTS.indexOf(p.tint) + 1) % TINTS.length] })}
                  />
                  <input className="realm-name" value={p.name} onChange={(e) => void patch(p.id, { name: e.target.value })} />
                  <span className="realm-path" title={p.path}>
                    {p.path}
                    {p.isGit ? '' : ' (not git)'}
                  </span>
                  <select value={t.kind} onChange={(e) => setTrackerKind(p, e.target.value as Tracker['kind'])} title="Issue tracker for this realm">
                    <option value="none">no tracker</option>
                    <option value="github">GitHub issues</option>
                    <option value="jira">Jira</option>
                  </select>
                  <select value={p.worktreeLayout} onChange={(e) => void patch(p.id, { worktreeLayout: e.target.value as Project['worktreeLayout'] })} title="Where new worktrees go">
                    <option value="sibling">sibling folder</option>
                    <option value="inside">.claude/worktrees</option>
                  </select>
                  <button className="ghost small" onClick={() => void patch(p.id, { hidden: !p.hidden })}>
                    {p.hidden ? 'Show' : 'Hide'}
                  </button>
                  {confirmId === p.id ? (
                    <span className="row">
                      <button className="danger small" onClick={() => void remove(p.id)} title="Removes the realm from the kingdom. Files on disk are untouched.">
                        Raze
                      </button>
                      <button className="ghost small" onClick={() => setConfirmId(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button className="ghost small" onClick={() => setConfirmId(p.id)} title="Remove this realm">
                      Remove
                    </button>
                  )}
                </div>
                {t.kind === 'jira' ? (
                  <div className="realm-jira">
                    <label>
                      Jira site
                      <select
                        value={t.site}
                        onChange={(e) => void patch(p.id, { tracker: { ...t, site: e.target.value } })}
                      >
                        <option value="">choose a site…</option>
                        {sites.map((s) => (
                          <option key={s.site} value={s.site}>
                            {s.site.replace(/^https?:\/\//, '')}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Project key
                      <input
                        type="text"
                        placeholder="e.g. PLAT"
                        value={t.projectKey}
                        onChange={(e) => void patch(p.id, { tracker: { ...t, projectKey: e.target.value.toUpperCase().trim() } })}
                      />
                    </label>
                    <label className="grow">
                      Custom JQL (optional, replaces the default open-issues query)
                      <input
                        type="text"
                        placeholder={`project = ${t.projectKey || 'KEY'} AND statusCategory != Done ORDER BY updated DESC`}
                        value={t.jql ?? ''}
                        onChange={(e) => void patch(p.id, { tracker: { ...t, jql: e.target.value || undefined } })}
                      />
                    </label>
                    {sites.length === 0 ? <span className="hint block">Add a Jira site below first.</span> : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>

        <JiraSites sites={sites} onChanged={setSites} />

        {error ? <div className="error">{error}</div> : null}
        <p className="hint">Remove only forgets the realm. Nothing on disk is deleted, and Add folder brings it back.</p>
        <div className="actions">
          <button
            onClick={() => {
              void api.projects.add().then(() => reload())
            }}
          >
            Add folder…
          </button>
          <span className="spacer" />
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/** Jira credentials, one entry per site. Tokens are encrypted by the OS and never shown again. */
function JiraSites({ sites, onChanged }: { sites: JiraSite[]; onChanged(sites: JiraSite[]): void }) {
  const [open, setOpen] = useState(false)
  const [site, setSite] = useState('')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    setStatus(null)
    try {
      const next = await api.jira.saveSite(site, email, token)
      onChanged(next)
      setToken('')
      const who = await api.jira.test(site)
      setStatus(`Connected as ${who}.`)
    } catch (err) {
      setStatus((err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setBusy(false)
    }
  }

  async function test(s: string) {
    setStatus(null)
    try {
      setStatus(`${s.replace(/^https?:\/\//, '')}: connected as ${await api.jira.test(s)}.`)
    } catch (err) {
      setStatus((err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }

  return (
    <fieldset className="jira-sites">
      <legend>
        Jira sites ({sites.length}){' '}
        <button type="button" className="ghost small" onClick={() => setOpen((o) => !o)}>
          {open ? 'hide' : 'manage'}
        </button>
      </legend>
      {open ? (
        <>
          {sites.map((s) => (
            <div key={s.site} className="row jira-site-row">
              <span className="realm-path">{s.site.replace(/^https?:\/\//, '')}</span>
              <span className="hint">{s.email || 'bearer token'}</span>
              <span className="spacer" />
              <button type="button" className="ghost small" onClick={() => void test(s.site)}>
                Test
              </button>
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  setSite(s.site)
                  setEmail(s.email)
                  setToken('')
                }}
              >
                Edit
              </button>
              <button type="button" className="danger small" onClick={() => void api.jira.removeSite(s.site).then(onChanged)}>
                Forget
              </button>
            </div>
          ))}
          <div className="jira-form">
            <label>
              Site URL
              <input type="text" placeholder="https://acme.atlassian.net" value={site} onChange={(e) => setSite(e.target.value)} />
            </label>
            <label>
              Email (leave blank for a Data Center personal access token)
              <input type="text" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label>
              API token {sites.some((s) => s.site === site.trim().toLowerCase().replace(/\/+$/, '')) ? '(blank keeps the saved one)' : ''}
              <input type="password" placeholder="from id.atlassian.com → Security → API tokens" value={token} onChange={(e) => setToken(e.target.value)} />
            </label>
            <div className="row">
              <button type="button" className="primary small" disabled={busy || !site.trim()} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save and test'}
              </button>
              {status ? <span className="hint">{status}</span> : null}
            </div>
          </div>
        </>
      ) : null}
    </fieldset>
  )
}
