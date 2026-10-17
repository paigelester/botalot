import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { configDir } from './config'

/**
 * Small encrypted store for tracker credentials. Values are encrypted with Electron's
 * safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on Linux) and kept in
 * secrets.json next to the app config. Plain text is never written to disk.
 */
interface SecretsFile {
  jira: Record<string, { email: string; token: string }> // token is base64 ciphertext
}

function file(): string {
  return join(configDir(), 'secrets.json')
}

function load(): SecretsFile {
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<SecretsFile>
    return { jira: parsed.jira ?? {} }
  } catch {
    return { jira: {} }
  }
}

function save(s: SecretsFile): void {
  writeFileSync(file(), JSON.stringify(s, null, 2), 'utf8')
}

export function normalizeSite(site: string): string {
  let s = site.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  return s.toLowerCase()
}

function encrypt(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available, so credentials cannot be stored safely.')
  return safeStorage.encryptString(plain).toString('base64')
}

function decrypt(cipher: string): string {
  return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
}

export function listJiraSites(): { site: string; email: string; hasToken: boolean }[] {
  const s = load()
  return Object.entries(s.jira).map(([site, v]) => ({ site, email: v.email, hasToken: !!v.token }))
}

export function saveJiraSite(site: string, email: string, token: string): void {
  const s = load()
  const key = normalizeSite(site)
  const existing = s.jira[key]
  s.jira[key] = { email: email.trim(), token: token ? encrypt(token) : (existing?.token ?? '') }
  save(s)
}

export function removeJiraSite(site: string): void {
  const s = load()
  delete s.jira[normalizeSite(site)]
  save(s)
}

export function jiraCredentials(site: string): { email: string; token: string } | null {
  const s = load()
  const v = s.jira[normalizeSite(site)]
  if (!v || !v.token) return null
  try {
    return { email: v.email, token: decrypt(v.token) }
  } catch {
    return null
  }
}

export { existsSync as _secretsExists }
