import { useEffect, useState } from 'react'
import { UNCLAIMED_REALM, type Project, type Session } from '@shared/types'
import { api } from '../api'
import { TerminalView } from './TerminalView'

interface Props {
  session: Session
  project: Project | undefined
  wide: boolean
  onClose(): void
  onToggleWide(): void
}

const STATE_LABEL: Record<Session['state'], string> = {
  working: 'On a quest',
  waiting: 'Awaits your word',
  idle: 'Resting',
  dead: 'Fallen',
  dormant: 'Dormant'
}

function hex(tint: number): string {
  return '#' + tint.toString(16).padStart(6, '0')
}

/** Side panel: themed status strip over a real terminal. */
export function SessionPanel({ session, project, wide, onClose, onToggleWide }: Props) {
  const alive = session.state !== 'dead' && session.state !== 'dormant'
  const wild = !!session.wild
  const background = !!session.backgroundId
  // A background dragon's terminal is a `claude attach` client, open only while its panel is. An owned one
  // that has fallen is not attached, so waking it can start its own terminal.
  const attachable = background && (wild || alive)
  useEffect(() => {
    if (!attachable) return
    void api.sessions.attach(session.id)
    return () => void api.sessions.detach(session.id)
  }, [session.id, attachable])
  const [waking, setWaking] = useState(false)
  const [wakeError, setWakeError] = useState<string | null>(null)
  async function wake() {
    setWaking(true)
    setWakeError(null)
    try {
      await api.sessions.wake(session.id)
    } catch (err) {
      setWakeError((err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setWaking(false)
    }
  }
  const g = session.git

  return (
    <aside className={'panel' + (wide ? ' panel-wide' : '')}>
      <header className="strip" style={{ borderColor: hex(project?.tint ?? 0x888888) }}>
        <div className="strip-row">
          <span className="dragon-name" style={{ color: hex(project?.tint ?? 0xffffff) }}>
            {session.name}
          </span>
          <span className={'badge badge-' + session.state}>{STATE_LABEL[session.state]}</span>
          <span className="badge badge-agent">Claude</span>
          {wild ? (
            <span className="badge badge-wild" title={'Background session ' + session.backgroundId + ', started outside Botalot'}>
              Wild
            </span>
          ) : null}
          {session.patrol ? (
            <a
              className="badge badge-patrol"
              href={session.patrol.issueUrl}
              target="_blank"
              rel="noreferrer"
              title={'Summoned by patrol for issue ' + session.patrol.issueKey + (session.patrol.settled ? ' (' + session.patrol.settled + ')' : '')}
            >
              ⚑ {session.patrol.issueKey}
            </a>
          ) : null}
          {!wild && background ? (
            <span className="badge badge-background" title={'Background session ' + session.backgroundId + '; keeps running when Botalot quits'}>
              Background
            </span>
          ) : null}
          <span className="spacer" />
          <button className="ghost" title="Toggle wide panel (Ctrl+\\)" onClick={onToggleWide}>
            {wide ? '⇤' : '⇥'}
          </button>
          <button className="ghost" title="Close panel (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="strip-row meta">
          <span title={session.cwd}>
            🏰 {project?.name ?? (session.projectId === UNCLAIMED_REALM ? 'Unclaimed lands' : 'Unknown realm')}
            {session.isWorktree ? ' · holding' : ''}
          </span>
          <span>⎇ {session.branch || '—'}</span>
          {g ? (
            <span title="staged / modified / untracked · ahead / behind">
              ±{g.staged}/{g.modified}/{g.untracked}
              {g.ahead || g.behind ? ` · ↑${g.ahead} ↓${g.behind}` : ''}
            </span>
          ) : null}
          <span className="spacer" />
          <button className="ghost small" onClick={() => void api.sessions.refreshGit(session.id)} title="Refresh git status">
            ↻
          </button>
          {wild ? (
            <span className="hint" title={session.cwd}>
              Lives in Claude Code's background
            </span>
          ) : alive ? (
            <button
              className="danger small"
              onClick={() => void api.sessions.kill(session.id)}
              title={background ? 'Stop the background session (claude stop)' : 'Kill the session'}
            >
              Slay
            </button>
          ) : (
            <>
              {session.resumable ? (
                <button className="primary small" onClick={() => void wake()} disabled={waking} title="Resume the agent's session in this folder">
                  {waking ? 'Waking…' : 'Wake'}
                </button>
              ) : null}
              <button
                className="small"
                onClick={() => {
                  void api.sessions.dismiss(session.id)
                  onClose()
                }}
                title={background ? 'Remove the background session (claude rm) and forget it' : 'Remove from the kingdom and forget it'}
              >
                Bury
              </button>
            </>
          )}
        </div>
        {session.stuck ? <div className="attention attention-stuck">Looks stuck: {session.stuck}</div> : null}
        {session.attention ? <div className={'attention attention-' + session.state}>{session.attention}</div> : null}
        {wakeError ? <div className="error">{wakeError}</div> : null}
      </header>
      {session.state === 'dormant' ? (
        <div className="dormant-note">
          <p>This dragon was summoned in an earlier run and is sleeping. Wake it to resume where it left off, in the same folder, with the same conversation.</p>
          <p className="hint">
            {session.claudeSessionId
              ? 'Session ' + session.claudeSessionId.slice(0, 8) + '…'
              : 'No session id was recorded, so waking continues the most recent session in this folder.'}
          </p>
        </div>
      ) : (
        <TerminalView sessionId={session.id} alive={alive || wild} />
      )}
    </aside>
  )
}
