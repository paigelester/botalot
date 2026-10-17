import type { Issue, IssueList, Tracker } from '@shared/types'
import { jiraCredentials, normalizeSite } from './secrets'

type JiraTracker = Extract<Tracker, { kind: 'jira' }>

const PAGE = 100

function authHeader(email: string, token: string): string {
  // Jira Cloud: email + API token as basic auth. Data Center personal access tokens: bearer, no email.
  if (email) return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64')
  return `Bearer ${token}`
}

async function call<T>(site: string, path: string, init?: RequestInit): Promise<T> {
  const creds = jiraCredentials(site)
  if (!creds) throw new Error(`No Jira credentials saved for ${normalizeSite(site)}. Add them in Realms.`)
  const res = await fetch(normalizeSite(site) + path, {
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authHeader(creds.email, creds.token), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(20_000)
  })
  if (res.status === 401 || res.status === 403) throw new Error('Jira rejected the credentials (401/403). Check the email and API token.')
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { errorMessages?: string[]; message?: string }
      detail = body.errorMessages?.join('; ') || body.message || ''
    } catch {
      /* no body */
    }
    throw new Error(`Jira returned ${res.status}${detail ? ': ' + detail : ''}`)
  }
  return (await res.json()) as T
}

/** Verify credentials. Returns the account's display name. */
export async function testJira(site: string): Promise<string> {
  const me = await call<{ displayName?: string; emailAddress?: string }>(site, '/rest/api/2/myself')
  return me.displayName || me.emailAddress || 'ok'
}

function escapeJql(text: string): string {
  return text.replace(/["\\]/g, (c) => '\\' + c)
}

export function defaultJql(t: JiraTracker): string {
  if (t.jql?.trim()) return t.jql.trim()
  return `project = "${escapeJql(t.projectKey)}" AND statusCategory != Done ORDER BY updated DESC`
}

interface SearchResponse {
  issues: Array<{
    key: string
    fields: {
      summary: string
      description?: string | null
      updated?: string
      labels?: string[]
      status?: { name?: string }
      assignee?: { displayName?: string; emailAddress?: string } | null
    }
  }>
  isLast?: boolean
  nextPageToken?: string
  total?: number
}

/** Open issues for a realm, newest first. With `search`, adds a text filter to the JQL. */
export async function listJiraIssues(t: JiraTracker, search?: string): Promise<IssueList> {
  try {
    let jql = defaultJql(t)
    const q = search?.trim()
    if (q) {
      // Match a key exactly, or text in summary/description. Wrap the base query so ORDER BY stays last.
      const base = jql.replace(/\s+ORDER\s+BY\s+.*$/i, '')
      const order = /ORDER\s+BY\s+.*$/i.exec(jql)?.[0] ?? 'ORDER BY updated DESC'
      const keyMatch = /^[A-Za-z][A-Za-z0-9_]+-\d+$/.test(q) ? ` OR key = "${escapeJql(q.toUpperCase())}"` : ''
      jql = `(${base}) AND (text ~ "${escapeJql(q)}"${keyMatch}) ${order}`
    }
    const body = JSON.stringify({ jql, maxResults: PAGE, fields: ['summary', 'description', 'updated', 'labels', 'status', 'assignee'] })
    const res = await call<SearchResponse>(t.site, '/rest/api/2/search/jql', { method: 'POST', body })
    const issues: Issue[] = res.issues.map((i) => ({
      key: i.key,
      title: i.fields.summary ?? '',
      body: (i.fields.description ?? '').toString(),
      labels: i.fields.labels ?? [],
      assignees: i.fields.assignee ? [i.fields.assignee.displayName || i.fields.assignee.emailAddress || ''] : [],
      updatedAt: i.fields.updated ?? '',
      status: i.fields.status?.name,
      url: `${normalizeSite(t.site)}/browse/${i.key}`
    }))
    const truncated = res.isLast === false || (typeof res.total === 'number' && res.total > issues.length) || issues.length >= PAGE
    return { tracker: 'jira', issues, truncated }
  } catch (err) {
    return { tracker: 'jira', issues: [], error: (err as Error).message }
  }
}
