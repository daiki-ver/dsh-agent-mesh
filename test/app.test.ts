import { describe, expect, it } from 'vitest'
import { toJsonSchema, tool, NoArgs } from '../src/app/tools/tool.ts'
import { workerPrompt, ROUTER_PROMPT, SHARED_PROMPT, ROLE_SECTIONS } from '../src/app/prompts.ts'
import { assignmentMessage, reorientationNote } from '../src/executor/dsh.ts'
import { permissionFor } from '../src/app/sessions.ts'
import { z } from 'zod'
import { MIN_TICKET_BUDGET, floorBudget, type DispatchArtifact } from '../src/core/model.ts'

function spec(overrides: Partial<DispatchArtifact> = {}): DispatchArtifact {
  return {
    title: 'Task', workerKind: 'coder', goal: 'make it work',
    boundaries: ['do not touch migrations'], acceptance: ['tests pass'],
    gates: [], coalitionScript: [], routingNote: '',
    ...overrides,
  }
}

describe('toJsonSchema', () => {
  it('converts an object with required and optional fields', () => {
    const schema = z.object({
      name: z.string().min(1).max(10),
      count: z.number().int().default(3),
      flag: z.boolean().optional(),
    })
    const json = toJsonSchema(schema)
    expect(json.type).toBe('object')
    const props = json.properties as Record<string, Record<string, unknown>>
    expect(props.name).toEqual({ type: 'string', minLength: 1, maxLength: 10 })
    expect(props.count).toEqual({ type: 'integer' })
    expect(props.flag).toEqual({ type: 'boolean' })
    // Only `name` is required: the default and the optional both accept omission.
    expect(json.required).toEqual(['name'])
  })

  it('converts arrays, enums, literals, and records', () => {
    const schema = z.object({
      items: z.array(z.string()).min(1).max(5),
      kind: z.enum(['a', 'b']),
      mode: z.literal('fixed'),
      map: z.record(z.string(), z.number()),
    })
    const props = toJsonSchema(schema).properties as Record<string, Record<string, unknown>>
    expect(props.items).toEqual({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 })
    expect(props.kind).toEqual({ type: 'string', enum: ['a', 'b'] })
    expect(props.mode).toEqual({ const: 'fixed' })
    expect(props.map).toEqual({ type: 'object', additionalProperties: { type: 'number' } })
  })

  it('converts unions to anyOf', () => {
    const schema = z.object({ value: z.union([z.string(), z.number()]) })
    const props = toJsonSchema(schema).properties as Record<string, Record<string, unknown>>
    expect(props.value).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] })
  })

  it('always produces an object root even for an empty schema', () => {
    expect(toJsonSchema(NoArgs)).toEqual({ type: 'object', properties: {} })
  })
})

describe('tool wrapper', () => {
  it('parses arguments and returns structured output', async () => {
    const definition = tool('mesh_probe', 'probe', z.object({ n: z.number() }), args => ({ doubled: args.n * 2 }))
    expect(definition.name).toBe('mesh_probe')
    const result = await definition.execute({ n: 21 }, {})
    expect(result).toEqual({ doubled: 42 })
  })

  it('rejects invalid arguments before calling the implementation', async () => {
    let called = false
    const definition = tool('mesh_strict', 'strict', z.object({ n: z.number() }), () => {
      called = true
      return {}
    })
    await expect(definition.execute({ n: 'not a number' }, {})).rejects.toThrow()
    expect(called).toBe(false)
  })

  it('renders its result as JSON text', () => {
    const definition = tool('mesh_render', 'render', NoArgs, () => ({ ok: true }))
    const rendered = definition.output?.render?.({}, { ok: true })
    expect(rendered?.[0]).toEqual({ type: 'text', text: '{"ok":true}' })
  })
})

describe('prompts', () => {
  it('puts the shared discipline before the role and the ticket', () => {
    const prompt = workerPrompt('coder', spec(), 'Reorientation: today is 2026-11-16.')
    const sharedAt = prompt.indexOf(SHARED_PROMPT.slice(0, 40))
    const roleAt = prompt.indexOf(ROLE_SECTIONS.coder.slice(0, 30))
    const ticketAt = prompt.indexOf('Current ticket')
    const reorientAt = prompt.indexOf('Reorientation:')
    expect(sharedAt).toBeGreaterThanOrEqual(0)
    expect(roleAt).toBeGreaterThan(sharedAt)
    expect(ticketAt).toBeGreaterThan(roleAt)
    // The reorientation note is appended last so the prefix above stays cacheable.
    expect(reorientAt).toBeGreaterThan(ticketAt)
  })

  it('keeps the prefix identical when only the reorientation changes', () => {
    const a = workerPrompt('coder', spec(), 'Reorientation: today is day one.')
    const b = workerPrompt('coder', spec(), 'Reorientation: today is day two.')
    const prefixA = a.slice(0, a.indexOf('Reorientation:'))
    const prefixB = b.slice(0, b.indexOf('Reorientation:'))
    expect(prefixA).toBe(prefixB)
  })

  it('names gates as non-removable', () => {
    const prompt = workerPrompt('coder', spec({
      gates: [{ id: 'ux', holderKind: 'reviewer', question: 'ok?', timeoutMin: 30 }],
    }), '')
    expect(prompt).toContain('Mandatory gates')
    expect(prompt).toContain('ux')
  })

  it('tells the Router it has no working tools', () => {
    expect(ROUTER_PROMPT).toContain('no shell')
    expect(ROUTER_PROMPT).toContain('You do not do the work')
  })
})

describe('assignment message', () => {
  it('includes the contract and the worker kind', () => {
    const ticket = {
      id: 't1', title: 'Task', spec: spec(), origin: { triggerIds: [], human: true },
      mandate: 'explicit' as const, assignments: [], inputs: [], undelivered: [],
      follows: [], gates: [], stage: 'waiting' as const,
      createdAt: '', updatedAt: '',
    }
    const text = assignmentMessage(ticket, 'coder', 'Reorientation: fresh start.')
    expect(text).toContain('Ticket t1')
    expect(text).toContain('do not touch migrations')
    expect(text).toContain('tests pass')
    expect(text).toContain('coder worker')
    expect(text).toContain('fresh start')
    // The reporting contract must be spelled out, not implied: a worker that answers only
    // in its closing message leaves the ticket stuck in `working` forever.
    expect(text).toContain('mesh_report')
    expect(text).toContain('ticketId: "t1"')
    expect(text).toContain('result')
    expect(text).toContain('never completes')
  })

  it('reports a first ticket honestly', () => {
    expect(reorientationNote(undefined)).toContain('first ticket')
  })

  it('warns against stale state on a later ticket', () => {
    const note = reorientationNote('Refactor the parser')
    expect(note).toContain('Refactor the parser')
    expect(note).toContain('Do not assume')
  })
})

describe('permissionFor', () => {
  it('gives read-only roles no write access', () => {
    expect(permissionFor('researcher')).toBe('read-only')
    expect(permissionFor('reviewer')).toBe('read-only')
    // The Router does no work, so it is read-only too.
    expect(permissionFor(undefined)).toBe('read-only')
  })

  it('gives coders workspace write and only ops the machine', () => {
    expect(permissionFor('coder')).toBe('workspace-write')
    expect(permissionFor('temp')).toBe('workspace-write')
    expect(permissionFor('ops')).toBe('danger-full-access')
  })
})

describe('budget floor', () => {
  it('raises a Router budget too small to cover one turn', () => {
    // A Router asked to size a budget will answer "200", which cannot pay for a single
    // turn and would stop work that was about to finish.
    expect(floorBudget(200)).toBe(MIN_TICKET_BUDGET)
  })

  it('leaves a workable budget alone', () => {
    expect(floorBudget(200_000)).toBe(200_000)
  })

  it('passes absence through, so an unset budget stays unset', () => {
    expect(floorBudget(undefined)).toBeUndefined()
  })
})
