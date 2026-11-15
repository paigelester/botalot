import { contextBridge, ipcRenderer } from 'electron'
import type { DragonApi, Issue, Project, Session, SpawnRequest } from '@shared/types'
import type { Quota } from '@shared/quota'
import type { RunView } from '@shared/runs'

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: DragonApi = {
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    listAll: () => ipcRenderer.invoke('projects:listAll'),
    add: () => ipcRenderer.invoke('projects:add'),
    update: (id, patch) => ipcRenderer.invoke('projects:update', id, patch),
    remove: (id) => ipcRenderer.invoke('projects:remove', id),
    worktrees: (id) => ipcRenderer.invoke('projects:worktrees', id),
    remoteBase: (id) => ipcRenderer.invoke('projects:remoteBase', id),
    setup: (id) => ipcRenderer.invoke('projects:setup', id),
    issues: (id, search) => ipcRenderer.invoke('projects:issues', id, search),
    onChanged: (cb) => subscribe<[Project[]]>('projects:changed', cb)
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    spawn: (req: SpawnRequest) => ipcRenderer.invoke('sessions:spawn', req),
    kill: (id) => ipcRenderer.invoke('sessions:kill', id),
    dismiss: (id) => ipcRenderer.invoke('sessions:dismiss', id),
    wake: (id) => ipcRenderer.invoke('sessions:wake', id),
    write: (id, data) => ipcRenderer.send('sessions:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('sessions:resize', id, cols, rows),
    scrollback: (id) => ipcRenderer.invoke('sessions:scrollback', id),
    refreshGit: (id) => ipcRenderer.invoke('sessions:refreshGit', id),
    attach: (id) => ipcRenderer.invoke('sessions:attach', id),
    detach: (id) => ipcRenderer.invoke('sessions:detach', id),
    onUpdate: (cb) => subscribe<[Session]>('session:update', cb),
    onData: (cb) => subscribe<[string, string]>('session:data', cb),
    onRemoved: (cb) => subscribe<[string]>('session:removed', cb),
    onFocus: (cb) => subscribe<[string]>('session:focus', cb)
  },
  names: {
    random: () => ipcRenderer.invoke('names:random')
  },
  app: {
    setBadge: (count, png) => ipcRenderer.send('app:badge', count, png)
  },
  runs: {
    list: () => ipcRenderer.invoke('runs:list'),
    start: (projectId: string, issue: Issue) => ipcRenderer.invoke('runs:start', projectId, issue),
    carryOn: (id) => ipcRenderer.invoke('runs:carryOn', id),
    stop: (id) => ipcRenderer.invoke('runs:stop', id),
    openSession: (runId, sessionId) => ipcRenderer.invoke('runs:openSession', runId, sessionId),
    onUpdate: (cb) => subscribe<[RunView[]]>('runs:update', cb)
  },
  quota: {
    get: () => ipcRenderer.invoke('quota:get'),
    onUpdate: (cb) => subscribe<[Quota]>('quota:update', cb)
  }
}

contextBridge.exposeInMainWorld('dragon', api)
