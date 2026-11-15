import { useEffect, useRef } from 'react'
import type { Project, Session } from '@shared/types'
import { KingdomScene } from './KingdomScene'

interface Props {
  projects: Project[]
  sessions: Session[]
  selectedId: string | null
  onSelectDragon(id: string | null): void
  onTapCastle(projectId: string): void
}

/** React wrapper around the PixiJS kingdom. Props flow in, taps flow out. */
export function Kingdom({ projects, sessions, selectedId, onSelectDragon, onTapCastle }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<KingdomScene | null>(null)
  const ready = useRef(false)
  const latest = useRef({ projects, sessions, selectedId, onSelectDragon, onTapCastle })
  latest.current = { projects, sessions, selectedId, onSelectDragon, onTapCastle }

  useEffect(() => {
    if (!host.current) return
    const s = new KingdomScene({
      onSelectDragon: (id) => latest.current.onSelectDragon(id),
      onTapCastle: (id) => latest.current.onTapCastle(id),
      // The main process opens window.open targets in the default browser.
      onOpenUrl: (url) => void window.open(url)
    })
    scene.current = s
    ready.current = false
    void s.mount(host.current).then(() => {
      if (scene.current !== s) return
      ready.current = true
      s.setProjects(latest.current.projects)
      s.setSessions(latest.current.sessions)
      s.setSelected(latest.current.selectedId)
    })
    return () => {
      ready.current = false
      s.destroy()
      if (scene.current === s) scene.current = null
    }
  }, [])

  useEffect(() => {
    if (ready.current) scene.current?.setProjects(projects)
  }, [projects])
  useEffect(() => {
    if (ready.current) scene.current?.setSessions(sessions)
  }, [sessions])
  useEffect(() => {
    if (ready.current) scene.current?.setSelected(selectedId)
  }, [selectedId])

  return <div ref={host} className="kingdom" />
}
