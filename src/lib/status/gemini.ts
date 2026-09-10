import type { ServiceComponent, ServiceStatus, Severity } from './types'
import { fetchJson } from './http'
import {
  buildDays,
  quietRatioOf,
  sanitizeIncidentTitle,
  severityRank,
  type IncidentInterval
} from './uptime'
import { asArray, asRecord } from './statuspage'

// The Gemini row. Google does not ship a stock Statuspage for Gemini —
// consumer + Workspace Gemini publish on Apps Status, and Vertex / Code
// Assist / Enterprise publish on Cloud Status. Both expose the same
// incidents.json shape. We read both fixed URLs, keep only incidents that
// name a Gemini product (or say "Gemini" in the service line), and paint
// the 90-day bar from that filtered set. Information-only notices never
// colour the live row.

export const GEMINI_SOURCE_URL = 'https://www.google.com/appsstatus/dashboard/'

const WORKSPACE_INCIDENTS_URL =
  'https://www.google.com/appsstatus/dashboard/incidents.json'
const CLOUD_INCIDENTS_URL = 'https://status.cloud.google.com/incidents.json'

/** Product titles we treat as the Gemini surface (Apps + Cloud catalogs). */
export const GEMINI_PRODUCT_TITLES = Object.freeze([
  'Gemini',
  'Gemini Notebook',
  'Gemini Code Assist',
  'Gemini Enterprise',
  'Vertex Gemini API',
  'Gemini on Agent Platform'
])

const GEMINI_TITLE_RE = /\bgemini\b/i

export type GoogleStatusIncident = {
  id: string
  begin: string
  end: string | null
  external_desc: string
  status_impact: string
  severity?: string
  service_name?: string
  affected_products: { id?: string; title: string }[]
}

function productTitles(incident: Record<string, unknown>): string[] {
  const titles: string[] = []
  for (const item of asArray(incident.affected_products)) {
    const raw = asRecord(item)
    if (raw && typeof raw.title === 'string' && raw.title.trim()) {
      titles.push(raw.title.trim())
    }
  }
  return titles
}

/** True when the incident is about Gemini as a product — not a vague
 *  mention buried only in a long postmortem that also lists other APIs. */
export function incidentTouchesGemini(incident: Record<string, unknown>): boolean {
  const titles = productTitles(incident)
  if (titles.some((title) => GEMINI_TITLE_RE.test(title))) return true
  if (typeof incident.service_name === 'string' && GEMINI_TITLE_RE.test(incident.service_name)) {
    return true
  }
  return false
}

export function parseGoogleIncidents(payload: unknown): GoogleStatusIncident[] {
  const out: GoogleStatusIncident[] = []
  for (const item of asArray(payload)) {
    const raw = asRecord(item)
    if (!raw || typeof raw.id !== 'string') continue
    if (typeof raw.begin !== 'string') continue
    if (typeof raw.external_desc !== 'string') continue
    if (typeof raw.status_impact !== 'string') continue
    if (!incidentTouchesGemini(raw)) continue
    const end = typeof raw.end === 'string' ? raw.end : null
    out.push({
      id: raw.id,
      begin: raw.begin,
      end,
      external_desc: raw.external_desc,
      status_impact: raw.status_impact,
      severity: typeof raw.severity === 'string' ? raw.severity : undefined,
      service_name: typeof raw.service_name === 'string' ? raw.service_name : undefined,
      affected_products: productTitles(raw).map((title) => ({ title }))
    })
  }
  return out
}

/** Map Google's status_impact onto our live severity. Information notices
 *  are history-only — they must not light the row. */
export function severityFromGoogleImpact(impact: string): Severity | null {
  switch (impact.trim().toUpperCase()) {
    case 'SERVICE_OUTAGE':
      return 'outage'
    case 'SERVICE_DISRUPTION':
      return 'degraded'
    case 'SERVICE_INFORMATION':
      return null
    default:
      return 'degraded'
  }
}

/** Day-bar impact word — SERVICE_OUTAGE must paint ember, not ice. */
function dayImpactWord(impact: string): string {
  switch (impact.trim().toUpperCase()) {
    case 'SERVICE_OUTAGE':
      return 'outage'
    case 'SERVICE_DISRUPTION':
      return 'disruption'
    case 'SERVICE_INFORMATION':
      return 'info'
    default:
      return impact
  }
}

function incidentTitle(desc: string): string {
  // Workspace posts often lead with **Title**\n… — prefer that line.
  const titled = desc.match(/\*\*Title\*\*\s*\n([^\n]+)/i)
  if (titled) return sanitizeIncidentTitle(titled[1])
  const first = desc.split(/\n/).map((line) => line.trim()).find(Boolean)
  return sanitizeIncidentTitle(first ?? desc)
}

function toIntervals(incidents: GoogleStatusIncident[]): IncidentInterval[] {
  const intervals: IncidentInterval[] = []
  for (const incident of incidents) {
    const live = severityFromGoogleImpact(incident.status_impact)
    // Information notices still leave a quiet footprint as degraded days
    // so the bar records "something published", matching other vendors'
    // minor/none behaviour via impactDaySeverity's default branch.
    const impact = live === null ? 'info' : dayImpactWord(incident.status_impact)
    intervals.push({
      title: incidentTitle(incident.external_desc),
      impact,
      startedAt: incident.begin,
      resolvedAt: incident.end,
      componentNames: incident.affected_products.map((p) => p.title)
    })
  }
  return intervals
}

function componentSeverities(
  incidents: GoogleStatusIncident[],
  now: Date
): ServiceComponent[] {
  const open = incidents.filter((incident) => {
    if (incident.end) {
      const endMs = Date.parse(incident.end)
      return !Number.isNaN(endMs) && endMs > now.getTime()
    }
    return true
  })

  const byName = new Map<string, Severity>()
  for (const name of GEMINI_PRODUCT_TITLES) {
    // Prefer the public Apps Status name for the consumer product.
    if (name === 'Gemini on Agent Platform') continue
    byName.set(name === 'Vertex Gemini API' ? 'Gemini on Agent Platform' : name, 'operational')
  }
  // Ensure canonical display set:
  byName.clear()
  byName.set('Gemini', 'operational')
  byName.set('Gemini Notebook', 'operational')
  byName.set('Gemini Code Assist', 'operational')
  byName.set('Gemini Enterprise', 'operational')
  byName.set('Gemini on Agent Platform', 'operational')

  for (const incident of open) {
    const severity = severityFromGoogleImpact(incident.status_impact)
    if (severity === null) continue
    const titles = incident.affected_products.map((p) => p.title)
    const mapped = titles.map((title) =>
      title === 'Vertex Gemini API' ? 'Gemini on Agent Platform' : title
    )
    const targets = mapped.filter((title) => byName.has(title))
    const applyTo = targets.length > 0 ? targets : ['Gemini']
    for (const name of applyTo) {
      const prev = byName.get(name) ?? 'operational'
      if (severityRank(severity) > severityRank(prev)) byName.set(name, severity)
    }
  }

  return [...byName.entries()].map(([name, severity]) => ({ name, severity }))
}

export function buildGeminiStatus(
  workspacePayload: unknown,
  cloudPayload: unknown | null,
  now: Date
): ServiceStatus {
  const incidents = [
    ...parseGoogleIncidents(workspacePayload),
    ...(cloudPayload === null ? [] : parseGoogleIncidents(cloudPayload))
  ]
  // Dedupe by id when both feeds mirror the same incident.
  const byId = new Map<string, GoogleStatusIncident>()
  for (const incident of incidents) {
    if (!byId.has(incident.id)) byId.set(incident.id, incident)
  }
  const unique = [...byId.values()]

  const openLive = unique.filter((incident) => {
    const severity = severityFromGoogleImpact(incident.status_impact)
    if (severity === null) return false
    if (incident.end) {
      const endMs = Date.parse(incident.end)
      return !Number.isNaN(endMs) && endMs > now.getTime()
    }
    return true
  })

  let severity: Severity = 'operational'
  let description = 'No unresolved Gemini incidents in the published feeds'
  for (const incident of openLive) {
    const next = severityFromGoogleImpact(incident.status_impact)
    if (next === null) continue
    if (severityRank(next) > severityRank(severity)) {
      severity = next
      description = incidentTitle(incident.external_desc)
    } else if (severity === next && description.startsWith('No unresolved')) {
      description = incidentTitle(incident.external_desc)
    }
  }

  const days = buildDays(toIntervals(unique), now)
  const components = componentSeverities(unique, now)

  return {
    id: 'gemini',
    name: 'Gemini',
    severity,
    description,
    sourceUrl: GEMINI_SOURCE_URL,
    fetchedAt: now.toISOString(),
    components,
    days,
    quietRatio: quietRatioOf(days)
  }
}

export async function fetchGeminiStatus(): Promise<ServiceStatus> {
  const now = new Date()
  const [workspace, cloud] = await Promise.allSettled([
    fetchJson(WORKSPACE_INCIDENTS_URL),
    fetchJson(CLOUD_INCIDENTS_URL)
  ])
  if (workspace.status === 'rejected' && cloud.status === 'rejected') {
    throw workspace.reason
  }
  // Prefer Workspace as the required feed (consumer Gemini). Cloud is
  // additive history for Vertex / Code Assist / Enterprise.
  if (workspace.status === 'rejected') {
    return buildGeminiStatus([], cloud.status === 'fulfilled' ? cloud.value : null, now)
  }
  return buildGeminiStatus(
    workspace.value,
    cloud.status === 'fulfilled' ? cloud.value : null,
    now
  )
}
