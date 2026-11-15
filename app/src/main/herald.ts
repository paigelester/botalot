import { app, BrowserWindow, Notification, nativeImage } from 'electron'
import type { Session } from '@shared/types'

/**
 * Tells you when a dragon starts waiting on you while you are looking elsewhere: an OS notification
 * per transition into waiting, and the waiting count as a badge on the taskbar icon.
 */
export class Herald {
  private lastState = new Map<string, Session['state']>()
  /** Kept alive until clicked or closed; a collected Notification never fires its click event. */
  private shown = new Set<Notification>()

  constructor(
    private getWindow: () => BrowserWindow | null,
    private focusDragon: (id: string) => void
  ) {}

  /** Call with every session update. */
  observe(s: Session): void {
    const before = this.lastState.get(s.id)
    this.lastState.set(s.id, s.state)
    if (s.state !== 'waiting' || before === 'waiting') return
    const win = this.getWindow()
    if (!win || win.isDestroyed() || win.isFocused()) return
    if (!Notification.isSupported()) return
    const n = new Notification({ title: `${s.name} awaits your word`, body: s.attention || 'Waiting for you', silent: false })
    this.shown.add(n)
    n.on('click', () => {
      this.shown.delete(n)
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      this.focusDragon(s.id)
    })
    n.on('close', () => this.shown.delete(n))
    n.show()
  }

  forget(id: string): void {
    this.lastState.delete(id)
  }

  /**
   * Show the waiting count on the taskbar. The renderer draws the badge (it has a canvas) and sends it as a
   * PNG data URL; null clears it. Windows shows it as an overlay icon; macOS and Linux get the dock count.
   */
  setBadge(count: number, pngDataUrl: string | null): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    if (process.platform === 'win32') {
      const img = count > 0 && pngDataUrl ? nativeImage.createFromDataURL(pngDataUrl) : null
      win.setOverlayIcon(img, count > 0 ? `${count} dragon${count === 1 ? '' : 's'} awaiting you` : '')
    } else {
      app.setBadgeCount(count)
    }
  }
}
