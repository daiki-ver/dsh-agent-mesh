import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/core/store.ts'
import { Tickets } from '../src/core/tickets.ts'
import type { DispatchArtifact } from '../src/core/model.ts'

function spec(overrides: Partial<DispatchArtifact> = {}): DispatchArtifact {
  return {
    title: 'Implement X',
    workerKind: 'coder',
    goal: 'make X work',
    boundaries: [],
    acceptance: [],
    gates: [],
    coalitionScript: [],
    routingNote: '',
    ...overrides,
  }
}

function withTickets(fn: (tickets: Tickets, store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-tickets-'))
  const store = new Store(join(dir, 'mesh.db'))
  try {
    fn(new Tickets(store), store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Tickets', () => {
  it('creates a ticket in waiting with no ending', () => {
    withTickets(tickets => {
      const ticket = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      expect(ticket.stage).toBe('waiting')
      expect(ticket.ended).toBeUndefined()
      expect(ticket.mandate).toBe('explicit')
    })
  })

  it('moves to working on assignment', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      const assigned = tickets.assign(created.id, 'mesh-coder-1')
      expect(assigned.stage).toBe('working')
      expect(assigned.assignments).toHaveLength(1)
    })
  })

  it('ends as completed when a worker reports ready with no follows', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      tickets.assign(created.id, 'mesh-coder-1')
      const ended = tickets.report(created.id, { state: 'ready', text: 'done', refs: [] })
      expect(ended.ended?.outcome).toBe('completed')
      expect(ended.ended?.by).toBe('worker')
      expect(ended.stage).toBe('ended')
    })
  })

  it('parks in person when ready while following a thread', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      tickets.assign(created.id, 'mesh-coder-1')
      tickets.follow(created.id, 'thread:abc')
      const reported = tickets.report(created.id, { state: 'ready', text: 'done', refs: [] })
      // Reported ready, but the followed thread is still open.
      expect(reported.stage).toBe('person')
      expect(reported.ended).toBeUndefined()
    })
  })

  it('ends once the last followed thread closes', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      tickets.assign(created.id, 'mesh-coder-1')
      tickets.follow(created.id, 'thread:abc')
      tickets.report(created.id, { state: 'ready', text: 'done', refs: [] })
      const closed = tickets.threadClosed(created.id, 'thread:abc')
      expect(closed.ended?.outcome).toBe('closed')
    })
  })

  it('keeps the ticket alive when a person spoke after the thread closed', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      tickets.assign(created.id, 'mesh-coder-1')
      tickets.follow(created.id, 'thread:abc')
      tickets.report(created.id, { state: 'ready', text: 'done', refs: [] })
      // A person's message arrives before the thread closes: unfinished work.
      tickets.addInput(created.id, { kind: 'human', text: 'also do Y', delivered: false })
      const closed = tickets.threadClosed(created.id, 'thread:abc')
      expect(closed.ended).toBeUndefined()
      expect(closed.undelivered).toHaveLength(1)
    })
  })

  it('ends as dropped when a worker reports out of scope', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'inferred', human: false })
      tickets.assign(created.id, 'mesh-coder-1')
      const ended = tickets.report(created.id, { state: 'dropped', text: 'out of scope', refs: [] })
      expect(ended.ended?.outcome).toBe('dropped')
    })
  })

  it('parks in person on blocked', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      tickets.assign(created.id, 'mesh-coder-1')
      const parked = tickets.report(created.id, { state: 'blocked', text: 'need a key', humanAction: 'provide key', refs: [] })
      expect(parked.stage).toBe('person')
      expect(parked.ended).toBeUndefined()
    })
  })

  it('clears undelivered input when ending', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      tickets.assign(created.id, 'mesh-coder-1')
      tickets.addInput(created.id, { kind: 'human', text: 'later', delivered: false })
      const ended = tickets.report(created.id, { state: 'ready', text: 'done', refs: [] })
      expect(ended.undelivered).toHaveLength(0)
    })
  })

  it('refuses input to an ended ticket', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      tickets.assign(created.id, 'mesh-coder-1')
      tickets.report(created.id, { state: 'ready', text: 'done', refs: [] })
      expect(() => tickets.addInput(created.id, { kind: 'human', text: 'x', delivered: false })).toThrow(/ended/)
      expect(() => tickets.assertOpen(created.id)).toThrow(/ended/)
    })
  })

  it('revives an ended ticket', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      tickets.assign(created.id, 'mesh-coder-1')
      tickets.report(created.id, { state: 'ready', text: 'done', refs: [] })
      const revived = tickets.revive(created.id)
      expect(revived.ended).toBeUndefined()
      expect(revived.stage).toBe('working')
    })
  })

  it('refuses to revive a stopped ticket', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      tickets.assign(created.id, 'mesh-coder-1')
      tickets.stop(created.id, 'not needed')
      expect(() => tickets.revive(created.id)).toThrow(/stopped/)
    })
  })

  it('retries with a fresh assignment on the same worker', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      tickets.assign(created.id, 'mesh-coder-1')
      tickets.report(created.id, { state: 'ready', text: 'done', refs: [] })
      const retried = tickets.retry(created.id, 'mesh-coder-1')
      expect(retried.ended).toBeUndefined()
      expect(retried.assignments).toHaveLength(2)
      expect(retried.assignments[1]?.note).toBe('RETRIED')
    })
  })

  it('parks and releases on gates', () => {
    withTickets(tickets => {
      const created = tickets.create({ spec: spec(), mandate: 'explicit', human: true })
      tickets.assign(created.id, 'mesh-coder-1')
      const gated = tickets.gate(created.id)
      expect(gated.stage).toBe('idle')
      expect(gated.assignments.at(-1)?.state).toBe('gated')
      const released = tickets.ungate(created.id)
      expect(released.stage).toBe('working')
      expect(released.assignments.at(-1)?.state).toBe('running')
    })
  })
})
