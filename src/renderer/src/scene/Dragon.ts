import { AnimatedSprite, Container, Graphics, Text } from 'pixi.js'
import type { Session, SessionState } from '@shared/types'
import type { DragonAnim, DragonSpriteSet } from './sprites'

export interface Perch {
  /** Where the dragon sits when landed. */
  x: number
  y: number
  /** Centre of the flight orbit when working. */
  orbitX: number
  orbitY: number
}

const GREY = 0x6e6e78

/** One session rendered as a dragon. Handles its own state animation each tick. */
export class Dragon extends Container {
  readonly id: string
  state: SessionState = 'idle'
  realmTint = 0xffffff
  perch: Perch = { x: 0, y: 0, orbitX: 0, orbitY: 0 }
  selected = false
  hovered = false

  private body = new Container()
  private placeholder: PlaceholderDragon | null = null
  private sprite: AnimatedSprite | null = null
  private sprites: DragonSpriteSet | null
  private currentAnim: DragonAnim | null = null
  private nameLabel: Text
  private marker = new Graphics()
  private ring = new Graphics()
  private zzz: Text
  private grave = new Graphics()
  private t = Math.random() * 100
  private phase = Math.random() * Math.PI * 2
  private facing = 1

  constructor(session: Session, sprites: DragonSpriteSet | null) {
    super()
    this.id = session.id
    this.sprites = sprites
    this.eventMode = 'static'
    this.cursor = 'pointer'

    this.addChild(this.ring)
    this.addChild(this.grave)
    this.addChild(this.body)
    if (sprites) {
      const first = sprites.animations.idle ?? sprites.animations.fly ?? sprites.animations.sleep ?? sprites.animations.roar
      this.sprite = new AnimatedSprite(first!.textures)
      this.sprite.anchor.set(0.5, 0.5)
      this.sprite.scale.set(sprites.scale)
      this.sprite.play()
      this.body.addChild(this.sprite)
    } else {
      this.placeholder = new PlaceholderDragon()
      this.body.addChild(this.placeholder)
    }
    this.addChild(this.marker)
    this.zzz = new Text({ text: 'z', style: { fontFamily: 'Georgia, serif', fontSize: 14, fill: 0xdfe6ff, fontStyle: 'italic' } })
    this.zzz.anchor.set(0.5, 1)
    this.zzz.visible = false
    this.addChild(this.zzz)
    this.nameLabel = new Text({
      text: session.agent === 'copilot' ? session.name + ' ✦' : session.name,
      // Wild dragons (background sessions Botalot did not summon) carry a green, italic name.
      style: {
        fontFamily: 'Georgia, serif',
        fontSize: 12,
        fill: session.wild ? 0xa8e6a1 : 0xf6edd6,
        fontStyle: session.wild ? 'italic' : 'normal',
        stroke: { color: 0x1a1024, width: 3 }
      }
    })
    this.nameLabel.anchor.set(0.5, 0)
    this.nameLabel.resolution = 2
    this.addChild(this.nameLabel)

    this.on('pointerover', () => (this.hovered = true))
    this.on('pointerout', () => (this.hovered = false))
    this.apply(session)
  }

  apply(session: Session): void {
    this.state = session.state
    this.nameLabel.text = session.agent === 'copilot' ? session.name + ' ✦' : session.name
    const colour = session.state === 'dead' ? GREY : session.state === 'dormant' ? mix(this.realmTint, 0x5a6080, 0.6) : this.realmTint
    this.placeholder?.setTint(colour)
    if (this.sprite) this.sprite.tint = colour
  }

  setTint(tint: number): void {
    this.realmTint = tint
    const colour = this.state === 'dead' ? GREY : this.state === 'dormant' ? mix(tint, 0x5a6080, 0.6) : tint
    this.placeholder?.setTint(colour)
    if (this.sprite) this.sprite.tint = colour
  }

  private setAnim(anim: DragonAnim): void {
    if (!this.sprite || !this.sprites || this.currentAnim === anim) return
    const a = this.sprites.animations[anim] ?? this.sprites.animations.idle ?? this.sprites.animations.fly
    if (!a) return
    this.currentAnim = anim
    this.sprite.textures = a.textures
    this.sprite.animationSpeed = a.fps / 60
    this.sprite.gotoAndPlay(0)
  }

  tick(dtMs: number): void {
    this.t += dtMs / 1000
    const t = this.t + this.phase
    const p = this.perch
    const baseScale = this.hovered ? 1.12 : 1
    this.alpha = 1
    this.marker.clear()
    this.ring.clear()
    this.grave.clear()
    this.zzz.visible = false
    this.body.rotation = 0

    if (this.state === 'working') {
      const a = t * 1.1
      const x = p.orbitX + Math.cos(a) * 62
      const y = p.orbitY + Math.sin(a * 2) * 10 - 10
      const dir = -Math.sin(a) >= 0 ? 1 : -1
      this.facing = dir
      this.position.set(x, y)
      this.body.scale.set(baseScale * this.facing, baseScale)
      this.placeholder?.flap(Math.sin(t * 14) * 0.8 + 0.2, true)
      this.placeholder?.fire(Math.sin(t * 3) > 0.6)
      this.setAnim('fly')
    } else if (this.state === 'waiting') {
      this.position.set(p.x, p.y + Math.sin(t * 5) * 2)
      this.body.scale.set(baseScale * this.facing, baseScale)
      this.placeholder?.flap(Math.sin(t * 6) * 0.3 + 0.5, false)
      this.placeholder?.fire(false)
      this.setAnim('roar')
      // Pulsing gold ring and exclamation marker: the loudest thing in the kingdom.
      const pulse = (Math.sin(t * 4) + 1) / 2
      const r = this.sprite ? 36 : 26
      this.ring.circle(0, 12, r + pulse * 10).stroke({ width: 3, color: 0xffd26a, alpha: 0.9 - pulse * 0.6 })
      this.marker
        .roundRect(-6, -58 - pulse * 4 - (this.sprite ? 8 : 0), 12, 20, 3)
        .fill(0xffd26a)
        .rect(-2, -54 - pulse * 4 - (this.sprite ? 8 : 0), 4, 10)
        .fill(0x3a2410)
        .rect(-2, -41 - pulse * 4 - (this.sprite ? 8 : 0), 4, 3)
        .fill(0x3a2410)
    } else if (this.state === 'idle') {
      const breathe = 1 + Math.sin(t * 1.5) * 0.03
      this.position.set(p.x, p.y + 2)
      this.body.scale.set(0.9 * baseScale * this.facing * breathe, 0.9 * baseScale * breathe)
      this.placeholder?.flap(0, false)
      this.placeholder?.fire(false)
      this.setAnim('sleep')
      const cycle = (t * 0.7) % 1
      this.zzz.visible = true
      this.zzz.position.set(14 + cycle * 10, -22 - cycle * 18)
      this.zzz.alpha = 1 - cycle
      this.zzz.scale.set(0.8 + cycle * 0.6)
    } else if (this.state === 'dormant') {
      // Remembered from an earlier run: a faded sleeper, waiting to be woken.
      this.position.set(p.x, p.y + 2)
      this.alpha = 0.55
      this.body.scale.set(0.9 * baseScale * this.facing, 0.9 * baseScale)
      this.placeholder?.flap(0, false)
      this.placeholder?.fire(false)
      this.setAnim('sleep')
      if (this.sprite) this.sprite.stop()
    } else {
      this.position.set(p.x, p.y + 6)
      this.alpha = 0.7
      this.body.scale.set(0.9 * this.facing, 0.9)
      this.body.rotation = this.sprite ? 0 : this.facing * 0.5
      this.placeholder?.flap(0, false)
      this.placeholder?.fire(false)
      this.setAnim('sleep')
      if (this.sprite) this.sprite.stop()
      const gx = this.sprite ? 34 : 22
      this.grave.roundRect(gx, -4, 14, 20, 4).fill(0x8d8d9a).rect(gx + 5, 2, 4, 10).fill(0x55555f).rect(gx + 2, 5, 10, 3).fill(0x55555f)
    }

    if (this.selected) {
      this.ring.ellipse(0, 18, 30, 10).stroke({ width: 2, color: 0xffe9a8, alpha: 0.9 })
    }
    this.nameLabel.position.set(0, this.sprites ? (this.sprites.frameHeight * this.sprites.scale) / 2 - 6 : 20)
  }
}

/** Vector stand-in for a dragon until real sprites arrive. Faces right. */
class PlaceholderDragon extends Container {
  private g = new Graphics()
  private wingL = new Graphics()
  private wingR = new Graphics()
  private flame = new Graphics()
  private colour = 0xffffff

  constructor() {
    super()
    this.addChild(this.wingL)
    this.addChild(this.g)
    this.addChild(this.wingR)
    this.addChild(this.flame)
    this.setTint(0xffffff)
    this.flap(0, false)
  }

  setTint(colour: number): void {
    this.colour = colour
    const g = this.g
    g.clear()
    // tail
    g.moveTo(-14, 4).lineTo(-26, 10).lineTo(-32, 2).stroke({ width: 4, color: colour })
    g.poly([-32, 2, -38, -2, -34, 6]).fill(colour)
    // body
    g.ellipse(-2, 4, 16, 9).fill(colour)
    g.ellipse(0, 8, 11, 5).fill(lighten(colour))
    // neck and head
    g.moveTo(10, 0).lineTo(16, -10).stroke({ width: 7, color: colour })
    g.roundRect(12, -18, 16, 11, 4).fill(colour)
    g.rect(24, -14, 7, 5).fill(colour)
    // horns
    g.poly([14, -18, 12, -26, 18, -19]).fill(darken(colour))
    g.poly([20, -18, 20, -26, 25, -19]).fill(darken(colour))
    // eye
    g.rect(21, -16, 3, 3).fill(0x1a1024)
    g.rect(22, -16, 1, 1).fill(0xffffff)
    // spines
    for (let i = 0; i < 4; i++) g.poly([-10 + i * 6, -5, -7 + i * 6, -10, -4 + i * 6, -5]).fill(darken(colour))
    // legs
    g.rect(-8, 11, 4, 6).fill(darken(colour))
    g.rect(4, 11, 4, 6).fill(darken(colour))
  }

  /** amount 0..1: wing raise. */
  flap(amount: number, flying: boolean): void {
    const c = darken(this.colour)
    const lift = flying ? 1 : 0.35
    const draw = (w: Graphics, dir: number) => {
      w.clear()
      const tipY = -4 - amount * 22 * lift
      const tipX = -6 + dir * 10
      w.poly([-2, 0, tipX - 8 * dir, tipY, tipX + 10, tipY + 6, 10, -2]).fill(c)
      w.moveTo(-2, 0).lineTo(tipX - 8 * dir, tipY).stroke({ width: 1.5, color: darken(c) })
    }
    draw(this.wingL, 1)
    draw(this.wingR, -1)
    this.wingL.position.set(-2, -2)
    this.wingR.position.set(2, -1)
    this.wingR.alpha = 0.85
  }

  fire(on: boolean): void {
    this.flame.clear()
    if (!on) return
    this.flame.poly([31, -11, 48, -16, 44, -11, 50, -8, 42, -6, 46, -2, 31, -7]).fill(0xff8a2a)
    this.flame.poly([31, -10, 40, -12, 42, -9, 38, -6, 31, -8]).fill(0xffd34a)
  }
}

function lighten(c: number): number {
  return mix(c, 0xffffff, 0.35)
}
function darken(c: number): number {
  return mix(c, 0x000000, 0.35)
}
function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | bl
}
