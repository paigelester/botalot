import { Assets, Rectangle, Texture } from 'pixi.js'

/**
 * Optional pixel-art dragon sprites. Drop a manifest and PNGs into
 * src/renderer/public/assets/dragons/ and the scene uses them instead of placeholder shapes.
 *
 * manifest.json: each animation is either a horizontal strip ("file" + "frames" count)
 * or a list of per-frame files ("files").
 * {
 *   "frameWidth": 64, "frameHeight": 64, "scale": 1, "facing": "right",
 *   "animations": {
 *     "fly":   { "file": "fly.png", "frames": 8, "fps": 10 },
 *     "roar":  { "files": ["roar_0.png", "roar_1.png"], "fps": 8 },
 *     "sleep": { "files": ["sleep_0.png", "sleep_1.png"], "fps": 3 },
 *     "idle":  { "files": ["idle_0.png"], "fps": 4 }
 *   }
 * }
 */
export type DragonAnim = 'fly' | 'roar' | 'sleep' | 'idle'

export interface DragonSpriteSet {
  frameWidth: number
  frameHeight: number
  scale: number
  facing: 'left' | 'right'
  animations: Partial<Record<DragonAnim, { textures: Texture[]; fps: number }>>
}

interface ManifestAnim {
  file?: string
  frames?: number
  files?: string[]
  fps: number
}

interface Manifest {
  frameWidth: number
  frameHeight: number
  scale?: number
  facing?: 'left' | 'right'
  animations: Partial<Record<DragonAnim, ManifestAnim>>
}

let cached: Promise<DragonSpriteSet | null> | null = null

async function loadPixelTexture(url: string): Promise<Texture> {
  const tex = (await Assets.load(url)) as Texture
  tex.source.scaleMode = 'nearest'
  return tex
}

export function loadDragonSprites(): Promise<DragonSpriteSet | null> {
  if (cached) return cached
  cached = (async () => {
    try {
      const res = await fetch('./assets/dragons/manifest.json')
      if (!res.ok) return null
      const manifest = (await res.json()) as Manifest
      const set: DragonSpriteSet = {
        frameWidth: manifest.frameWidth,
        frameHeight: manifest.frameHeight,
        scale: manifest.scale ?? 1,
        facing: manifest.facing ?? 'right',
        animations: {}
      }
      for (const [name, anim] of Object.entries(manifest.animations)) {
        if (!anim) continue
        const textures: Texture[] = []
        if (anim.files && anim.files.length > 0) {
          for (const f of anim.files) textures.push(await loadPixelTexture(`./assets/dragons/${f}`))
        } else if (anim.file && anim.frames) {
          const base = await loadPixelTexture(`./assets/dragons/${anim.file}`)
          for (let i = 0; i < anim.frames; i++) {
            textures.push(
              new Texture({
                source: base.source,
                frame: new Rectangle(i * manifest.frameWidth, 0, manifest.frameWidth, manifest.frameHeight)
              })
            )
          }
        }
        if (textures.length > 0) set.animations[name as DragonAnim] = { textures, fps: anim.fps }
      }
      return Object.keys(set.animations).length > 0 ? set : null
    } catch {
      return null
    }
  })()
  return cached
}
