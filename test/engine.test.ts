import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/core/store.ts'
import { Effects } from '../src/core/effects.ts'
import { Engine, EFFECT } from '../src/core/engine.ts'
import { GateRefused, MAX_GATE_DEPTH } from '../src/core/gates.ts'
import type { DispatchArtifact } from '../src/core/model.ts'

function spec(overrides: Partial<DispatchArtifact> = {}): DispatchArtifact {
  return {
    title: 'Task', workerKind: 'coder', goal: 'g',
    boundaries: [], acceptance: [], gates: [], coalitionScript: [], routingNote: '',
    ...overrides,
  }
}

function withEngine(fn: (engine: Engine, store: Store) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-engine-'))
  const store = new Store(join(dir, 'mesh.db'))
  const effects = new Effects(store)
  const engine = new Engine({ store, effects, evalTimeoutMs: 300_000, coalitionSoft: 0.8, inferredBlocking: false })
  // Register every kind the Engine enqueues, so a command can be exercised without a
  // Session layer. The handlers record calls rather than performing them.
  for (const kind of Object.values(EFFECT)) {
    effects.handle(kind, { limit: 4, ordered: kind === 'relay' || kind === 'notice', quiet: kind === 'deliver' }, () => {})
  }
  const finish = (): void => {
    effects.stop()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
  const result = fn(engine, store)
  if (result instanceof Promise) return result.finally(finish)
  finish()
  return undefined
}

describe('Engine: intake and the fast path', () => {
  it('filters a message with no thread and no subscriber', () => {
    withEngine(engine => {
      const result = engine.receive({ id: 'in-1', text: 'hello', human: true, from: 'human' })
      expect(result.disposition).toBe('filtered')
    })
  })

  it('is idempotent for the same intake id', () => {
    withEngine(engine => {
      engine.receive({ id: 'in-1', text: 'hello', human: true, from: 'human', thread: 'thread:t' })
      const second = engine.receive({ id: 'in-1', text: 'hello', human: true, from: 'human', thread: 'thread:t' })
      expect(second.disposition).toBe('duplicate')
    })
  })

  it('delivers directly to a subscribed ticket with zero inference', () => {
    withEngine(engine => {
      engine.registerWorker({
        id: 'mesh-coder-1', kind: 'coder', sessionId: 's1', status: 'idle',
        offers: { keywords: [] }, resident: true, registeredAt: new Date().toISOString(),
      })
      const created = engine.create(spec(), 'explicit', { human: true, thread: 'thread:t' })
      const result = engine.receive({ id: 'in-2', text: 'continue', human: true, from: 'human', thread: 'thread:t' })
      expect(result.disposition).toBe('delivered')
      expect(result.ticketIds).toContain(created.ticket.id)
      expect(result.directDeliveries).toHaveLength(1)
    })
  })

  it('does not let a worker message revive an ended ticket', () => {
    withEngine(engine => {
      engine.registerWorker({
        id: 'mesh-coder-1', kind: 'coder', sessionId: 's1', status: 'idle',
        offers: { keywords: [] }, resident: true, registeredAt: new Date().toISOString(),
      })
      const created = engine.create(spec(), 'explicit', { human: true, thread: 'thread:t' })
      engine.report(created.ticket.id, { state: 'ready', text: 'done', refs: [] })
      // The ticket subscribed to its own thread but never followed it, so it is closed.
      expect(engine.tickets.require(created.ticket.id).ended?.outcome).toBe('completed')
      const result = engine.receive({ id: 'in-3', text: 'from a bot', human: false, from: 'mesh-coder-2', thread: 'thread:t' })
      expect(result.ticketIds).toHaveLength(0)
      expect(engine.tickets.require(created.ticket.id).ended?.outcome).toBe('completed')
    })
  })

  it('lets a person revive an ended ticket through intake', () => {
    withEngine(engine => {
      engine.registerWorker({
        id: 'mesh-coder-1', kind: 'coder', sessionId: 's1', status: 'idle',
        offers: { keywords: [] }, resident: true, registeredAt: new Date().toISOString(),
      })
      const created = engine.create(spec(), 'explicit', { human: true, thread: 'thread:t' })
      engine.report(created.ticket.id, { state: 'ready', text: 'done', refs: [] })
      const result = engine.receive({ id: 'in-4', text: 'one more thing', human: true, from: 'human', thread: 'thread:t' })
      expect(result.ticketIds).toContain(created.ticket.id)
      expect(engine.tickets.require(created.ticket.id).ended).toBeUndefined()
    })
  })
})

describe('Engine: gates', () => {
  it('refuses a second open gate on the same ticket', () => {
    withEngine(engine => {
      const created = engine.create(spec(), 'explicit', { human: true })
      const ticketId = created.ticket.id
      engine.ask('mesh-coder-1', 'ok to change the API?', { to: 'mesh-reviewer-1', gate: true, ticketId })
      // The gate opened, so the ticket is parked.
      expect(engine.tickets.require(ticketId).stage).toBe('idle')
      const second = engine.ask('mesh-coder-1', 'and this too?', { to: 'mesh-reviewer-1', gate: true, ticketId })
      // Refused, so it escalated instead of opening a parallel gate.
      expect(second.gate).toBeUndefined()
    })
  })

  it('refuses a gate whose holder is itself parked (rule A)', () => {
    withEngine(engine => {
      const first = engine.create(spec(), 'explicit', { human: true })
      const second = engine.create(spec(), 'explicit', { human: true })
      // reviewer is parked waiting on someone else.
      engine.ask('mesh-reviewer-1', 'waiting on you', { to: 'mesh-researcher-1', gate: true, ticketId: first.ticket.id })
      const refused = engine.ask('mesh-coder-1', 'sign here', { to: 'mesh-reviewer-1', gate: true, ticketId: second.ticket.id })
      expect(refused.gate).toBeUndefined()
      expect(engine.gates.gatesAwaiting('mesh-reviewer-1').filter(g => g.ticketId === second.ticket.id)).toHaveLength(0)
    })
  })

  it('releases the ticket on approval', () => {
    withEngine(engine => {
      const created = engine.create(spec(), 'explicit', { human: true })
      const ticketId = created.ticket.id
      const opened = engine.ask('mesh-coder-1', 'ok?', { to: 'mesh-reviewer-1', gate: true, ticketId })
      expect(opened.gate).toBeDefined()
      const decided = engine.decideGate(opened.gate!.id, 'approve')
      expect(decided.state).toBe('approved')
      expect(engine.tickets.require(ticketId).stage).toBe('working')
    })
  })

  it('releases the ticket on rejection and delivers the alternative', () => {
    withEngine(engine => {
      const created = engine.create(spec(), 'explicit', { human: true })
      const ticketId = created.ticket.id
      const opened = engine.ask('mesh-coder-1', 'ok?', { to: 'mesh-reviewer-1', gate: true, ticketId })
      engine.decideGate(opened.gate!.id, 'reject', { alternative: 'use a flag instead' })
      const ticket = engine.tickets.require(ticketId)
      expect(ticket.stage).toBe('working')
      expect(ticket.inputs.some(i => i.text.includes('use a flag instead'))).toBe(true)
    })
  })

  it('escalates a gate that passes its deadline', () => {
    withEngine(engine => {
      const created = engine.create(spec(), 'explicit', { human: true })
      const opened = engine.ask('mesh-coder-1', 'ok?', { to: 'mesh-reviewer-1', gate: true, ticketId: created.ticket.id, ttlMin: 1 })
      const gate = engine.gates.requireGate(opened.gate!.id)
      gate.deadline = new Date(Date.now() - 1000).toISOString()
      engine.store.putGate(gate)
      const swept = engine.sweep()
      expect(swept.gates).toBeGreaterThanOrEqual(1)
      expect(engine.gates.requireGate(opened.gate!.id).state).toBe('escalated')
    })
  })

  it('escalates at MAX_GATE_DEPTH instead of opening deeper', () => {
    withEngine(engine => {
      const created = engine.create(spec(), 'explicit', { human: true })
      const ticketId = created.ticket.id
      // Simulate a deep chain by planting history.
      for (let depth = 0; depth < MAX_GATE_DEPTH; depth += 1) {
        engine.store.putGate({
          id: `gate-hist-${depth}`, ticketId, fromWorker: 'w-a', toWorker: 'mesh-reviewer-1',
          question: 'q', state: 'approved', deadline: new Date().toISOString(),
          createdAt: new Date().toISOString(), depth,
        })
      }
      const refused = engine.ask('mesh-reviewer-1', 'deeper?', { to: 'mesh-researcher-1', gate: true, ticketId })
      expect(refused.gate).toBeUndefined()
    })
  })
})

describe('Engine: budget', () => {
  it('accumulates usage in memory and flushes in one batch', () => {
    withEngine(engine => {
      engine.recordUsage('ticket', 't1', 's1', { inputTokens: 100, outputTokens: 20 })
      engine.recordUsage('ticket', 't1', 's1', { inputTokens: 10, outputTokens: 5 })
      expect(engine.budget.pendingCount).toBe(1)
      expect(engine.budget.used('ticket', 't1')).toBe(135)
      const flushed = engine.flushUsage()
      expect(flushed).toBe(135)
      expect(engine.budget.pendingCount).toBe(0)
      expect(engine.store.usedTokens('ticket', 't1')).toBe(135)
    })
  })

  it('dissolves a coalition that exhausts its budget', () => {
    withEngine(engine => {
      const coalition = engine.proposeCoalition({
        topic: 'risk review', memberIds: ['mesh-researcher-1'], leadId: 'mesh-researcher-1',
        mandate: 'explicit', question: 'what are the risks?', budgetTokens: 100,
      })
      expect(coalition.state).toBe('approved')
      const action = engine.chargeCoalition(coalition.id, 150)
      expect(action).toBe('hard')
      expect(engine.coalitions.require(coalition.id).state).toBe('archived')
    })
  })
})

describe('Engine: coalitions', () => {
  it('runs form B: one collection across all members', () => {
    withEngine(engine => {
      engine.registerWorker({
        id: 'mesh-researcher-1', kind: 'researcher', sessionId: 's1', status: 'idle',
        offers: { keywords: [] }, resident: true, registeredAt: new Date().toISOString(),
      })
      const coalition = engine.proposeCoalition({
        topic: 'risks', memberIds: ['mesh-researcher-1'], leadId: 'mesh-researcher-1',
        mandate: 'explicit', question: 'what are the risks?',
      })
      const step = engine.coalitionStep(coalition.id)
      expect(step.kind).toBe('collect')
      if (step.kind === 'collect') expect(step.speakers).toEqual(['mesh-researcher-1'])
      engine.coalitionAnswer(coalition.id, 'mesh-researcher-1', { fields: { risk: 'schema drift' }, summary: 'one risk' })
      expect(engine.coalitions.require(coalition.id).state).toBe('archived')
    })
  })

  it('halves the budget of an inferred coalition', () => {
    withEngine(engine => {
      const coalition = engine.proposeCoalition({
        topic: 'inferred work', memberIds: ['w1'], leadId: 'w1',
        mandate: 'inferred', question: 'q?', budgetTokens: 1000,
      })
      expect(coalition.budget.tokens).toBe(500)
    })
  })

  it('merges fields without an inference round', () => {
    withEngine(engine => {
      const coalition = engine.proposeCoalition({
        topic: 't', memberIds: ['a', 'b'], leadId: 'a', mandate: 'explicit', question: 'q?',
      })
      engine.coalitionAnswer(coalition.id, 'a', { fields: { risk: 'x' }, summary: '' })
      engine.coalitionAnswer(coalition.id, 'b', { fields: { risk: 'y' }, summary: '' })
      const merged = engine.coalitions.merge(coalition.id)
      expect(merged).toContain('risk: x')
      expect(merged).toContain('risk: y')
    })
  })
})

describe('Engine: needs matching', () => {
  it('matches a need by keyword', () => {
    withEngine(engine => {
      engine.registerWorker({
        id: 'mesh-reviewer-1', kind: 'reviewer', sessionId: 's1', status: 'idle',
        offers: { keywords: [] }, resident: false, registeredAt: new Date().toISOString(),
      })
      const result = engine.needs('mesh-coder-1', '@reviewer: is this safe?')
      expect(result.source).toBe('keyword')
      expect(result.matched?.id).toBe('mesh-reviewer-1')
    })
  })

  it('defers when nothing matches and no router pick is given', () => {
    withEngine(engine => {
      const result = engine.needs('mesh-coder-1', 'something nobody covers')
      expect(result.source).toBe('deferred')
      expect(result.matched).toBeUndefined()
    })
  })

  it('uses the router pick as the second level', () => {
    withEngine(engine => {
      engine.registerWorker({
        id: 'mesh-ops-1', kind: 'ops', sessionId: 's1', status: 'idle',
        offers: { keywords: [] }, resident: false, registeredAt: new Date().toISOString(),
      })
      const result = engine.needs('mesh-coder-1', 'something nobody covers', candidates => candidates[0])
      expect(result.source).toBe('router')
      expect(result.matched?.id).toBe('mesh-ops-1')
    })
  })
})

describe('Engine: audit and evidence', () => {
  it('records one audit row per command and counts by kind', () => {
    withEngine(engine => {
      engine.create(spec(), 'explicit', { human: true })
      engine.create(spec(), 'inferred', { human: false })
      expect(engine.evidence('ticket.create', 2)).toEqual({ count: 2, ready: true })
      expect(engine.evidence('ticket.create', 3)).toEqual({ count: 2, ready: false })
    })
  })

  it('escalates a substantive conflict to the reviewer when it is disinterested', () => {
    withEngine(engine => {
      engine.registerWorker({
        id: 'mesh-reviewer-1', kind: 'reviewer', sessionId: 's1', status: 'idle',
        offers: { keywords: [] }, resident: false, registeredAt: new Date().toISOString(),
      })
      const created = engine.create(spec(), 'explicit', { human: true })
      engine.escalate('mesh-coder-1', 'substantive', { ticketId: created.ticket.id, detail: 'two designs' })
      // The escalate notice is the one whose payload names a target; other notices
      // (a ticket ending, for example) are unrelated.
      const notices = engine.store.dueEffects(100)
        .filter(r => r.kind === 'notice')
        .map(r => JSON.parse(r.value) as { value: { target?: string } })
      const escalate = notices.find(n => n.value.target !== undefined)
      expect(escalate?.value.target).toBe('mesh-reviewer-1')
    })
  })

  it('escalates to a person when the only reviewer is a party', () => {
    withEngine(engine => {
      engine.registerWorker({
        id: 'mesh-reviewer-1', kind: 'reviewer', sessionId: 's1', status: 'idle',
        offers: { keywords: [] }, resident: false, registeredAt: new Date().toISOString(),
      })
      const created = engine.create(spec(), 'explicit', { human: true })
      // The reviewer becomes a party by being assigned.
      engine.tickets.assign(created.ticket.id, 'mesh-reviewer-1')
      engine.escalate('mesh-coder-1', 'substantive', { ticketId: created.ticket.id })
      const notices = engine.store.dueEffects(100)
        .filter(r => r.kind === 'notice')
        .map(r => JSON.parse(r.value) as { value: { target?: string } })
      const escalate = notices.find(n => n.value.target !== undefined)
      expect(escalate?.value.target).toBe('human')
    })
  })
})

describe('Gates: cycle detection', () => {
  it('finds a cycle in the blocks graph', () => {
    withEngine(engine => {
      engine.store.putGate({
        id: 'g1', ticketId: 't1', fromWorker: 'a', toWorker: 'b', question: 'q',
        state: 'pending', deadline: new Date().toISOString(), createdAt: new Date().toISOString(),
        depth: 0, blocksGateId: 'g2',
      })
      engine.store.putGate({
        id: 'g2', ticketId: 't2', fromWorker: 'b', toWorker: 'a', question: 'q',
        state: 'pending', deadline: new Date().toISOString(), createdAt: new Date().toISOString(),
        depth: 0, blocksGateId: 'g1',
      })
      const swept = engine.sweep()
      expect(swept.gates).toBe(2)
      expect(engine.gates.requireGate('g1').state).toBe('escalated')
      expect(engine.gates.requireGate('g2').state).toBe('escalated')
    })
  })

  it('exports GateRefused for callers that escalate on refusal', () => {
    expect(new GateRefused('depth', 'too deep').reason).toBe('depth')
  })
})

describe('Engine: report relay', () => {
  it('relays a ready report to the Router so its result is not lost', () => {
    withEngine(engine => {
      const created = engine.create(spec(), 'explicit', { human: true })
      engine.report(created.ticket.id, {
        state: 'ready',
        text: 'status note',
        result: 'the actual deliverable',
        refs: [],
      })
      const relay = engine.store.dueEffects(100).find(r => r.kind === 'relay')
      expect(relay).toBeDefined()
      const payload = JSON.parse(relay!.value) as { text: string }
      // The deliverable must be in the relayed text, not just a status line.
      expect(payload.text).toContain('the actual deliverable')
      expect(payload.text).toContain('reported ready')
    })
  })

  it('relays a dropped report with its reason', () => {
    withEngine(engine => {
      const created = engine.create(spec(), 'inferred', { human: false })
      engine.report(created.ticket.id, { state: 'dropped', text: 'out of scope', refs: [] })
      const relay = engine.store.dueEffects(100).find(r => r.kind === 'relay')
      expect(relay).toBeDefined()
      expect(JSON.parse(relay!.value).text).toContain('out of scope')
    })
  })

  it('does not relay a progress report, which would spam the Router', () => {
    withEngine(engine => {
      const created = engine.create(spec(), 'explicit', { human: true })
      engine.report(created.ticket.id, { state: 'progress', text: 'still working', refs: [] })
      expect(engine.store.dueEffects(100).find(r => r.kind === 'relay')).toBeUndefined()
    })
  })
})
