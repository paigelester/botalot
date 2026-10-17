import { Application, Container, Graphics, Text } from 'pixi.js'
import type { Project, Session } from '@shared/types'
import { Dragon, type Perch } from './Dragon'
import { loadDragonSprites, type DragonSpriteSet } from './sprites'

/** The kingdom is designed at this logical size and scaled to fit the window. */
export const WORLD_W = 1280
export const WORLD_H = 720

/** Where castles stand, in order of registration. */
const CASTLE_SLOTS: [number, number][] = [
  [230, 500],
  [640, 400],
  [1040, 520],
  [420, 640],
  [880, 300],
  [1120, 360],
  [160, 330],
  [700, 620],
  [980, 660],
  [300, 400],
  [560, 520],
  [1200, 620]
]

/** Offsets of worktree holdings around their castle. */
const HOLDING_OFFSETS: [number, number][] = [
  [-120, 36],
  [124, 36],
  [-96, -66],
  [104, -62],
  [-150, -14],
  [156, -8],
  [-40, 84],
  [60, 86]
]

export interface SceneCallbacks {
  onSelectDragon(id: string | null): void
  onTapCastle(projectId: string): void
}

interface Castle {
  projectId: string
  container: Container
  x: number
  y: number
  holdings: Map<string, Holding>
}

interface Holding {
  cwd: string
  container: Container
  label: Text
  x: number
  y: number
}

export class KingdomScene {
  private app = new Application()
  private root = new Container()
  private bg = new Container()
  private land = new Container()
  private dragonLayer = new Container()
  private castles = new Map<string, Castle>()
  private dragons = new Map<string, Dragon>()
  private projects: Project[] = []
  private sessions: Session[] = []
  private selectedId: string | null = null
  private sprites: DragonSpriteSet | null = null
  private stars: { x: number; y: number; phase: number }[] = []
  private starG = new Graphics()
  private ro: ResizeObserver | null = null
  private host: HTMLElement | null = null
  private t = 0
  private destroyed = false

  constructor(private cb: SceneCallbacks) {}

  async mount(host: HTMLElement): Promise<void> {
    this.host = host
    await this.app.init({
      background: 0x0b0e1a,
      antialias: false,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      roundPixels: true
    })
    if (this.destroyed) {
      this.app.destroy(true)
      return
    }
    host.appendChild(this.app.canvas)
    this.app.stage.addChild(this.root)
    this.root.addChild(this.bg, this.land, this.dragonLayer)
    this.root.eventMode = 'static'
    this.app.stage.eventMode = 'static'
    this.app.stage.hitArea = this.app.screen
    this.app.stage.on('pointertap', (e) => {
      if (e.target === this.app.stage) this.cb.onSelectDragon(null)
    })
    this.drawBackground()
    this.ro = new ResizeObserver(() => this.layout())
    this.ro.observe(host)
    this.layout()
    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS))
    // Real sprites are optional: if they fail to load, the placeholder dragons stay.
    try {
      this.sprites = await loadDragonSprites()
    } catch (err) {
      console.warn('dragon sprites unavailable, using placeholders', err)
      this.sprites = null
    }
    if (this.destroyed) return
    if (this.sprites) {
      for (const d of this.dragons.values()) d.destroy({ children: true })
      this.dragons.clear()
    }
    this.rebuildDragons()
  }

  destroy(): void {
    this.destroyed = true
    this.ro?.disconnect()
    if (this.app.renderer) this.app.destroy(true, { children: true })
  }

  private layout(): void {
    if (!this.host) return
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    if (w === 0 || h === 0) return
    if (this.app.renderer.width !== w || this.app.renderer.height !== h) this.app.renderer.resize(w, h)
    const scale = Math.min(w / WORLD_W, h / WORLD_H)
    this.root.scale.set(scale)
    this.root.position.set((w - WORLD_W * scale) / 2, (h - WORLD_H * scale) / 2)
    this.app.stage.hitArea = this.app.screen
  }

  setProjects(projects: Project[]): void {
    this.projects = projects
    this.rebuildCastles()
    this.rebuildDragons()
  }

  setSessions(sessions: Session[]): void {
    this.sessions = sessions
    this.rebuildDragons()
  }

  setSelected(id: string | null): void {
    this.selectedId = id
    for (const d of this.dragons.values()) d.selected = d.id === id
  }

  // ---------------------------------------------------------------- background

  private drawBackground(): void {
    // Dusk sky in pixel bands, on its own layer so the stars sit above it.
    const bands = [0x0b0e1a, 0x121734, 0x1d1f4d, 0x2f2460, 0x4a2b6b, 0x6b3a6f, 0x8d4a66]
    const horizon = 330
    const sky = new Graphics()
    for (let i = 0; i < bands.length; i++) {
      const y0 = (horizon / bands.length) * i
      sky.rect(-2000, y0 - (i === 0 ? 2000 : 0), WORLD_W + 4000, horizon / bands.length + 1 + (i === 0 ? 2000 : 0)).fill(bands[i])
    }
    this.bg.addChild(sky)
    for (let i = 0; i < 70; i++) {
      this.stars.push({ x: Math.random() * (WORLD_W + 2000) - 1000, y: Math.random() * 400 - 200, phase: Math.random() * 6 })
    }
    this.bg.addChild(this.starG)

    const g = new Graphics()
    // Moon with a few craters.
    g.circle(1090, 92, 34).fill(0xf3e9c6)
    g.circle(1092, 86, 5).fill(0xe3d7ac).circle(1106, 106, 3).fill(0xe3d7ac).circle(1076, 100, 4).fill(0xe3d7ac)
    // Far mountains.
    g.poly([-2000, horizon, -2000, 280, -200, 280, 0, horizon, 90, 250, 180, 300, 260, 220, 350, 290, 430, 240, 520, 310, 600, 260, 690, 320, 780, 230, 870, 300, 950, 250, 1040, 310, 1130, 240, 1210, 290, 1280, 260, 1480, 280, 3280, 280, 3280, horizon]).fill(0x2a2250)
    g.poly([-2000, horizon + 10, -2000, 310, 0, horizon + 10, 120, 290, 230, 330, 340, 280, 470, 335, 560, 300, 700, 340, 820, 290, 940, 330, 1060, 280, 1180, 335, 1280, 300, 3280, 310, 3280, horizon + 10]).fill(0x3a2f5e)
    // Snow caps.
    g.poly([250, 228, 260, 220, 272, 230, 266, 234, 258, 232]).fill(0xd9d6ea)
    g.poly([770, 238, 780, 230, 792, 240, 786, 244, 776, 242]).fill(0xd9d6ea)
    g.poly([1120, 248, 1130, 240, 1142, 250, 1136, 254, 1126, 252]).fill(0xd9d6ea)
    // Rolling hills in three greens.
    g.rect(-2000, horizon, WORLD_W + 4000, WORLD_H - horizon + 2000).fill(0x2f6b3a)
    g.ellipse(200, 420, 360, 90).fill(0x3b7d44)
    g.ellipse(760, 440, 420, 100).fill(0x3b7d44)
    g.ellipse(1150, 470, 300, 90).fill(0x3b7d44)
    g.ellipse(420, 560, 320, 90).fill(0x47904e)
    g.ellipse(980, 600, 420, 110).fill(0x47904e)
    g.rect(-2000, 660, WORLD_W + 4000, 2000).fill(0x2a5e34)
    // River.
    const river = [1280, 420, 1180, 450, 1100, 500, 1010, 520, 930, 560, 860, 600, 780, 650, 700, 720]
    g.poly(widen(river, 16), true).fill(0x2a5e9a)
    g.poly(widen(river, 8), true).fill(0x3f7fc2)
    // Road.
    const road = [230, 540, 420, 520, 640, 440, 880, 360, 1040, 560]
    for (let i = 0; i < road.length - 2; i += 2) {
      g.moveTo(road[i], road[i + 1]).lineTo(road[i + 2], road[i + 3]).stroke({ width: 6, color: 0x8a6b45, alpha: 0.8 })
    }
    // Forests.
    const forests: [number, number, number][] = [[80, 600, 9], [560, 300, 7], [1180, 640, 8], [330, 360, 6], [760, 520, 5], [1220, 450, 5]]
    for (const [fx, fy, n] of forests) {
      for (let i = 0; i < n; i++) {
        const x = fx + ((i * 37) % 90) - 45
        const y = fy + ((i * 53) % 40) - 20
        tree(g, x, y, i % 2 === 0 ? 0x1f4d2b : 0x25603a)
      }
    }
    this.bg.addChild(g)
  }

  // ------------------------------------------------------------------- castles

  private rebuildCastles(): void {
    for (const c of this.castles.values()) c.container.destroy({ children: true })
    this.castles.clear()
    this.land.removeChildren()
    this.projects.forEach((p, i) => {
      const [x, y] = CASTLE_SLOTS[i % CASTLE_SLOTS.length]
      const yy = y + Math.floor(i / CASTLE_SLOTS.length) * 20
      const container = new Container()
      container.position.set(x, yy)
      container.addChild(castleGraphic(p.tint))
      const name = new Text({
        text: p.name,
        style: { fontFamily: 'Georgia, serif', fontSize: 15, fontWeight: 'bold', fill: 0xf6edd6, stroke: { color: 0x1a1024, width: 4 } }
      })
      name.anchor.set(0.5, 0)
      name.position.set(0, 30)
      name.resolution = 2
      container.addChild(name)
      container.eventMode = 'static'
      container.cursor = 'pointer'
      container.on('pointertap', (e) => {
        e.stopPropagation()
        this.cb.onTapCastle(p.id)
      })
      this.land.addChild(container)
      this.castles.set(p.id, { projectId: p.id, container, x, y: yy, holdings: new Map() })
    })
    this.sortLand()
  }

  private ensureHolding(castle: Castle, cwd: string, branch: string, tint: number): Holding {
    const key = cwd.toLowerCase()
    let h = castle.holdings.get(key)
    if (h) {
      // Branches get renamed (draft holdings especially); keep the signpost current.
      if (h.label.text !== branch) h.label.text = branch
      return h
    }
    const [ox, oy] = HOLDING_OFFSETS[castle.holdings.size % HOLDING_OFFSETS.length]
    const x = clamp(castle.x + ox, 40, WORLD_W - 40)
    const y = clamp(castle.y + oy, 340, WORLD_H - 30)
    const container = new Container()
    container.position.set(x, y)
    container.addChild(holdingGraphic(tint))
    const label = new Text({
      text: branch,
      style: { fontFamily: 'Georgia, serif', fontSize: 11, fill: 0xe8dcc0, stroke: { color: 0x1a1024, width: 3 } }
    })
    label.anchor.set(0.5, 0)
    label.position.set(0, 12)
    label.resolution = 2
    container.addChild(label)
    // Path from holding to castle.
    const path = new Graphics()
    path.moveTo(0, 8).lineTo(castle.x - x, castle.y - y + 24).stroke({ width: 3, color: 0x8a6b45, alpha: 0.6 })
    container.addChildAt(path, 0)
    this.land.addChild(container)
    h = { cwd, container, label, x, y }
    castle.holdings.set(key, h)
    this.sortLand()
    return h
  }

  private sortLand(): void {
    this.land.children.sort((a, b) => a.position.y - b.position.y)
  }

  // ------------------------------------------------------------------- dragons

  private rebuildDragons(): void {
    const seen = new Set<string>()
    const perchGroups = new Map<string, { perch: Perch; dragons: Dragon[] }>()
    const tintOf = new Map(this.projects.map((p) => [p.id, p.tint]))

    for (const s of this.sessions) {
      const castle = this.castles.get(s.projectId)
      if (!castle) continue
      seen.add(s.id)
      let d = this.dragons.get(s.id)
      if (!d) {
        d = new Dragon(s, this.sprites)
        d.on('pointertap', (e) => {
          e.stopPropagation()
          this.cb.onSelectDragon(s.id)
        })
        this.dragons.set(s.id, d)
        this.dragonLayer.addChild(d)
      }
      d.setTint(tintOf.get(s.projectId) ?? 0xffffff)
      d.apply(s)
      d.selected = s.id === this.selectedId

      let key: string
      let perch: Perch
      if (s.isWorktree) {
        const h = this.ensureHolding(castle, s.cwd, s.branch || 'worktree', tintOf.get(s.projectId) ?? 0xffffff)
        key = `h:${h.cwd.toLowerCase()}`
        perch = { x: h.x, y: h.y - 34, orbitX: h.x, orbitY: h.y - 80 }
      } else {
        key = `c:${castle.projectId}`
        perch = { x: castle.x, y: castle.y - 52, orbitX: castle.x, orbitY: castle.y - 110 }
      }
      const group = perchGroups.get(key) ?? { perch, dragons: [] }
      group.dragons.push(d)
      perchGroups.set(key, group)
    }

    for (const [id, d] of this.dragons) {
      if (!seen.has(id)) {
        d.destroy({ children: true })
        this.dragons.delete(id)
      }
    }

    // Spread dragons that share a perch so they do not overlap.
    for (const { perch, dragons } of perchGroups.values()) {
      const n = dragons.length
      dragons.forEach((d, i) => {
        const offset = (i - (n - 1) / 2) * 44
        d.perch = { x: perch.x + offset, y: perch.y, orbitX: perch.orbitX + offset * 0.6, orbitY: perch.orbitY - i * 12 }
      })
    }
  }

  private tick(dtMs: number): void {
    this.t += dtMs / 1000
    for (const d of this.dragons.values()) d.tick(dtMs)
    this.dragonLayer.children.sort((a, b) => a.position.y - b.position.y)
    this.starG.clear()
    for (const s of this.stars) {
      const a = 0.4 + 0.6 * ((Math.sin(this.t * 1.5 + s.phase) + 1) / 2)
      this.starG.rect(s.x, s.y, 2, 2).fill({ color: 0xffffff, alpha: a })
    }
  }
}

// -------------------------------------------------------------------- drawing

function castleGraphic(tint: number): Graphics {
  const g = new Graphics()
  const stone = 0x9a9aa8
  const dark = 0x6d6d7c
  const roof = tint
  // Shadow on the ground.
  g.ellipse(0, 26, 70, 12).fill({ color: 0x000000, alpha: 0.25 })
  // Curtain wall.
  g.rect(-56, -10, 112, 34).fill(stone)
  for (let i = 0; i < 7; i++) g.rect(-56 + i * 17, -16, 9, 7).fill(stone)
  // Gate.
  g.rect(-9, 4, 18, 20).fill(0x2a1c14)
  g.circle(0, 4, 9).fill(0x2a1c14)
  // Side towers.
  for (const tx of [-44, 44]) {
    g.rect(tx - 12, -40, 24, 64).fill(dark)
    for (let i = 0; i < 3; i++) g.rect(tx - 12 + i * 9, -46, 5, 7).fill(dark)
    g.rect(tx - 3, -30, 6, 10).fill(0x2a1c14)
    g.poly([tx - 14, -46, tx, -64, tx + 14, -46]).fill(roof)
  }
  // Keep.
  g.rect(-24, -52, 48, 44).fill(stone)
  for (let i = 0; i < 5; i++) g.rect(-24 + i * 10, -58, 6, 7).fill(stone)
  g.rect(-5, -40, 10, 14).fill(0x2a1c14)
  g.poly([-27, -58, 0, -84, 27, -58]).fill(roof)
  // Banner.
  g.rect(0, -102, 2, 20).fill(0x3a2a1a)
  g.poly([2, -102, 22, -96, 2, -90]).fill(roof)
  // Mortar lines.
  for (let y = -4; y < 20; y += 8) g.rect(-56, y, 112, 1).fill({ color: 0x000000, alpha: 0.12 })
  return g
}

function holdingGraphic(tint: number): Graphics {
  const g = new Graphics()
  g.ellipse(0, 10, 22, 6).fill({ color: 0x000000, alpha: 0.25 })
  g.rect(-10, -24, 20, 34).fill(0x8f8f9c)
  for (let i = 0; i < 3; i++) g.rect(-10 + i * 8, -29, 4, 6).fill(0x8f8f9c)
  g.rect(-3, -14, 6, 8).fill(0x2a1c14)
  g.poly([-12, -29, 0, -44, 12, -29]).fill(tint)
  g.rect(-1, -56, 2, 14).fill(0x3a2a1a)
  g.poly([1, -56, 11, -52, 1, -48]).fill(tint)
  return g
}

function tree(g: Graphics, x: number, y: number, colour: number): void {
  g.rect(x - 2, y, 4, 7).fill(0x4a3220)
  g.poly([x - 9, y + 1, x, y - 16, x + 9, y + 1]).fill(colour)
  g.poly([x - 7, y - 6, x, y - 22, x + 7, y - 6]).fill(colour)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Turn a polyline into a closed polygon of the given width, for drawing rivers. */
function widen(pts: number[], width: number): number[] {
  const left: number[] = []
  const right: number[] = []
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1]
    const nx = pts[Math.min(i + 2, pts.length - 2)], ny = pts[Math.min(i + 3, pts.length - 1)]
    const px = pts[Math.max(i - 2, 0)], py = pts[Math.max(i - 1, 1)]
    let dx = nx - px, dy = ny - py
    const len = Math.hypot(dx, dy) || 1
    dx /= len
    dy /= len
    left.push(x - dy * width, y + dx * width)
    right.unshift(x + dy * width, y - dx * width)
  }
  return [...left, ...right]
}
