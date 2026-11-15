// Dragon names. Each spawned session gets one that is not already in use.

const NAMES = [
  'Ember', 'Vyrax', 'Sylthra', 'Nimbus', 'Ashfang', 'Kaelith', 'Thornmaw', 'Zephyra',
  'Ignis', 'Morrow', 'Cindra', 'Vaelor', 'Skarn', 'Lumina', 'Drakthar', 'Oriel',
  'Rhuvok', 'Seraphyx', 'Tidewing', 'Umbra', 'Pyrrha', 'Galdric', 'Wyrmling', 'Nyxara',
  'Fennwick', 'Brimstone', 'Aurelion', 'Kestrel', 'Vorath', 'Mistral', 'Solenne', 'Hexlor',
  'Quillon', 'Ravaxis', 'Tamsin', 'Yrdrith', 'Calder', 'Ophira', 'Brannoc', 'Eldrin',
  'Sable', 'Marrowind', 'Ilyndra', 'Grimvale', 'Peregrine', 'Vesper', 'Halcyon', 'Rook'
]

/** The same name every time for the same seed: a run dragon keeps its name across restarts. */
export function nameFor(seed: string): string {
  // FNV-1a, then fold the high bits down: seeds that differ only near the start must still spread.
  let h = 0x811c9dc5
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0
  return NAMES[((h ^ (h >>> 16)) >>> 0) % NAMES.length]
}

export function randomName(taken: Set<string> = new Set()): string {
  const free = NAMES.filter((n) => !taken.has(n))
  const pool = free.length > 0 ? free : NAMES
  const base = pool[Math.floor(Math.random() * pool.length)]
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base} ${i}`)) i++
  return `${base} ${i}`
}
