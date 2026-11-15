# Dragon sprites

Drop pixel-art sprite strips here and the kingdom uses them instead of the vector placeholder.

Required: `manifest.json`

```json
{
  "frameWidth": 64,
  "frameHeight": 64,
  "scale": 1,
  "facing": "right",
  "animations": {
    "fly":   { "file": "fly.png",   "frames": 8, "fps": 10 },
    "roar":  { "file": "roar.png",  "frames": 6, "fps": 8 },
    "sleep": { "file": "sleep.png", "frames": 4, "fps": 3 },
    "idle":  { "file": "idle.png",  "frames": 4, "fps": 4 }
  }
}
```

Each PNG is a single horizontal strip of `frames` frames, each `frameWidth` x `frameHeight`.
Draw the dragon in light grey or white: the app tints it per realm.

State to animation: working = fly, waiting = roar, idle = sleep, dead = idle (frozen, greyed).
Missing animations fall back to `idle`, then `fly`.
