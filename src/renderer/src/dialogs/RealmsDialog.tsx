import { useEffect, useState } from 'react'
import type { Project, Tracker } from '@shared/types'
import { DEFAULT_PATROL_ALLOW, parseAllowList } from '@shared/patrol'
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

  async function reload() {
    setAll(await api.projects.listAll())
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

  async function patch(id: string, p: Partial<Pick<Project, 'name' | 'tint' | 'worktreeLayout' | 'hidden' | 'tracker' | 'patrol'>>) {
    setAll(await api.projects.update(id, p))
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
                  <select value={t.kind} onChange={(e) => void patch(p.id, { tracker: { kind: e.target.value as Tracker['kind'] } })} title="Issue tracker for this realm">
                    <option value="none">no tracker</option>
                    <option value="github">GitHub issues</option>
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
                {t.kind !== 'none' ? (
                  <div className="realm-patrol">
                    <label className="radio" title="Every couple of minutes while Botalot runs, take the oldest ticket labelled factory:ready and factory:agent-owned and summon a background dragon to implement it">
                      <input
                        type="checkbox"
                        checked={!!p.patrol?.enabled}
                        onChange={(e) => void patch(p.id, { patrol: { max: 1, ...p.patrol, enabled: e.target.checked } })}
                      />
                      <span>
                        <b>Patrol</b> — implement <code>factory:ready</code> + <code>factory:agent-owned</code> tickets on its own
                      </span>
                    </label>
                    <span className="realm-patrol-max">
                      at most
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={p.patrol?.max ?? 1}
                        disabled={!p.patrol?.enabled}
                        onChange={(e) =>
                          void patch(p.id, { patrol: { enabled: false, ...p.patrol, max: Math.min(10, Math.max(1, Math.round(Number(e.target.value) || 1))) } })
                        }
                      />
                      dragon{(p.patrol?.max ?? 1) === 1 ? '' : 's'} at once
                    </span>
                    {p.patrol?.enabled ? (
                      <AllowList allow={p.patrol.allow ?? DEFAULT_PATROL_ALLOW} onSave={(allow) => void patch(p.id, { patrol: { enabled: true, max: 1, ...p.patrol, allow } })} />
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>

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

/**
 * The shell commands a realm's patrol dragons may run without asking, one per line. Saved when the box loses
 * focus, so a half-typed line is never saved. File edits are always allowed; anything else asks you.
 */
function AllowList({ allow, onSave }: { allow: string[]; onSave(allow: string[]): void }) {
  const [text, setText] = useState(allow.join('\n'))
  useEffect(() => setText(allow.join('\n')), [allow])
  return (
    <label className="realm-patrol-allow">
      <span>
        Commands its dragons run without asking: one per line, <code>*</code> matches anything. File edits are always allowed; anything
        else waits for you.
      </span>
      <textarea rows={Math.min(10, Math.max(3, allow.length + 1))} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onSave(parseAllowList(text))} spellCheck={false} />
      <button type="button" className="ghost small" onClick={() => onSave(DEFAULT_PATROL_ALLOW)}>
        Reset to defaults
      </button>
    </label>
  )
}
