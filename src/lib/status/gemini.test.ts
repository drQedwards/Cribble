import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildGeminiStatus,
  incidentTouchesGemini,
  parseGoogleIncidents,
  severityFromGoogleImpact
} from './gemini'

const FIXTURE = JSON.parse(
  readFileSync(new URL('./__fixtures__/gemini-incidents.json', import.meta.url), 'utf8')
) as unknown[]

const NOW = new Date('2026-08-17T15:30:00.000Z')

describe('incidentTouchesGemini', () => {
  it('keeps product-titled Gemini incidents and drops unrelated ones', () => {
    expect(
      incidentTouchesGemini({
        affected_products: [{ title: 'Gmail' }],
        external_desc: 'mail delay'
      })
    ).toBe(false)
    expect(
      incidentTouchesGemini({
        affected_products: [{ title: 'Vertex Gemini API' }],
        external_desc: 'errors'
      })
    ).toBe(true)
  })
})

describe('severityFromGoogleImpact', () => {
  it('maps outage / disruption / information', () => {
    expect(severityFromGoogleImpact('SERVICE_OUTAGE')).toBe('outage')
    expect(severityFromGoogleImpact('SERVICE_DISRUPTION')).toBe('degraded')
    expect(severityFromGoogleImpact('SERVICE_INFORMATION')).toBeNull()
  })
})

describe('buildGeminiStatus', () => {
  it('reads the captured Gemini fixtures as operational with history', () => {
    const status = buildGeminiStatus(FIXTURE, null, NOW)
    expect(status.id).toBe('gemini')
    expect(status.name).toBe('Gemini')
    expect(status.sourceUrl).toBe('https://www.google.com/appsstatus/dashboard/')
    expect(status.severity).toBe('operational')
    expect(status.days).toHaveLength(90)
    expect(status.components.some((c) => c.name === 'Gemini')).toBe(true)
    // June 2026 Workspace disruption should paint a day.
    const byDate = new Map(status.days!.map((day) => [day.date, day]))
    expect(byDate.get('2026-06-10')?.severity).toBe('degraded')
  })

  it('lights degraded when an unresolved disruption is open', () => {
    const open = [
      {
        id: 'open1',
        begin: '2026-08-16T12:00:00+00:00',
        end: null,
        external_desc: '**Title**\nGemini App errors\n**Description**\nInvestigating.',
        status_impact: 'SERVICE_DISRUPTION',
        affected_products: [{ title: 'Gemini' }]
      }
    ]
    const status = buildGeminiStatus(open, null, NOW)
    expect(status.severity).toBe('degraded')
    expect(status.description).toContain('Gemini App errors')
    expect(status.components.find((c) => c.name === 'Gemini')?.severity).toBe('degraded')
  })

  it('parses only Gemini-touching rows from a mixed list', () => {
    const parsed = parseGoogleIncidents([
      {
        id: 'a',
        begin: '2026-01-01T00:00:00Z',
        end: '2026-01-01T01:00:00Z',
        external_desc: 'Gmail blip',
        status_impact: 'SERVICE_DISRUPTION',
        affected_products: [{ title: 'Gmail' }]
      },
      {
        id: 'b',
        begin: '2026-01-02T00:00:00Z',
        end: '2026-01-02T01:00:00Z',
        external_desc: 'Gemini blip',
        status_impact: 'SERVICE_OUTAGE',
        affected_products: [{ title: 'Gemini' }]
      }
    ])
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe('b')
  })
})
