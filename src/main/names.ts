// Dragon names. Each spawned session gets one that is not already in use.

const NAMES = [
  'Ember', 'Vyrax', 'Sylthra', 'Nimbus', 'Ashfang', 'Kaelith', 'Thornmaw', 'Zephyra',
  'Ignis', 'Morrow', 'Cindra', 'Vaelor', 'Skarn', 'Lumina', 'Drakthar', 'Oriel',
  'Rhuvok', 'Seraphyx', 'Tidewing', 'Umbra', 'Pyrrha', 'Galdric', 'Wyrmling', 'Nyxara',
  'Fennwick', 'Brimstone', 'Aurelion', 'Kestrel', 'Vorath', 'Mistral', 'Solenne', 'Hexlor',
  'Quillon', 'Ravaxis', 'Tamsin', 'Yrdrith', 'Calder', 'Ophira', 'Brannoc', 'Eldrin',
  'Sable', 'Marrowind', 'Ilyndra', 'Grimvale', 'Peregrine', 'Vesper', 'Halcyon', 'Rook'
]

export function randomName(taken: Set<string> = new Set()): string {
  const free = NAMES.filter((n) => !taken.has(n))
  const pool = free.length > 0 ? free : NAMES
  const base = pool[Math.floor(Math.random() * pool.length)]
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base} ${i}`)) i++
  return `${base} ${i}`
}
