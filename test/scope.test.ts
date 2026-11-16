import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/core/store.ts'
import { Effects } from '../src/core/effects.ts'
import { Engine } from '../src/core/engine.ts'
import { routerSessionId, residentSessionId, tempSessionId, workspaceScope } from '../src/app/host.ts'
import type { DispatchArtifact } from '../src/core/model.ts'

function spec(overrides: Partial<DispatchArtifact> = {}): DispatchArtifact {
  return {
    title: 'Task', workerKind: 'coder', goal: 'g',
    boundaries: [], acceptance: [], gates: [], coalitionScript: [], routingNote: '',
    ...overrides,
  }
}

/** Build one Engine with its own store, as one workspace would have. */
function engineFor(scope: string): { engine: Engine; store: Store; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `mesh-scope-${scope}-`))
  const store = new Store(join(dir, 'mesh.db'))
  const effects = new Effects(store)
  // A command may enqueue any kind, so register them all with no-op bodies. The tests
  // here assert on state and ids, not on delivery.
  for (const kind of ['assess', 'launch', 'deliver', 'coalition', 'relay', 'notice', 'sweep']) {
    effects.handle(kind, { limit: 2, quiet: true }, () => {})
  }
  const engine = new Engine({
    store, effects, scope,
    evalTimeoutMs: 300_000, coalitionSoft: 0.8, inferredBlocking: false,
  })
  return {
    engine,
    store,
    done: () => {
      effects.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('workspaceScope', () => {
  it('gives different directories different scopes', () => {
    expect(workspaceScope('D:/CodeSpace/repo-a')).not.toBe(workspaceScope('D:/CodeSpace/repo-b'))
  })

  it('is stable across separator style and case, so a restart finds its Sessions', () => {
    const a = workspaceScope('D:\\CodeSpace\\Repo-A')
    const b = workspaceScope('d:/codespace/repo-a')
    expect(a).toBe(b)
  })

  it('ignores a trailing separator', () => {
    expect(workspaceScope('D:/CodeSpace/repo-a/')).toBe(workspaceScope('D:/CodeSpace/repo-a'))
  })

  it('is short enough to read inside a Session id', () => {
    expect(workspaceScope('D:/CodeSpace/DSH-AgentMesh/dsh-agent-mesh').length).toBeLessThanOrEqual(8)
  })
})

describe('scoped ids', () => {
  it('namespaces every id so two workspaces cannot collide', () => {
    const a = workspaceScope('D:/repo-a')
    const b = workspaceScope('D:/repo-b')
    expect(routerSessionId(a)).not.toBe(routerSessionId(b))
    expect(residentSessionId(a, 'coder')).not.toBe(residentSessionId(b, 'coder'))
    expect(tempSessionId(a, 'ticket-1')).not.toBe(tempSessionId(b, 'ticket-1'))
  })

  it('keeps the kind readable in a resident id', () => {
    const scope = workspaceScope('D:/repo-a')
    expect(residentSessionId(scope, 'coder')).toContain('coder')
    expect(routerSessionId(scope)).toContain('router')
  })
})

describe('workspace isolation', () => {
  it('mints worker ids under its own scope', () => {
    const a = engineFor('scope-a')
    const b = engineFor('scope-b')
    try {
      const workerA = a.engine.residentWorkerId('coder')
      const workerB = b.engine.residentWorkerId('coder')
      expect(workerA).not.toBe(workerB)
      expect(workerA).toContain('scope-a')
      expect(workerB).toContain('scope-b')
    } finally {
      a.done()
      b.done()
    }
  })

  it('mints temp worker ids under its own scope', () => {
    const a = engineFor('scope-a')
    const b = engineFor('scope-b')
    try {
      // The same ticket id in two stores must not produce the same worker id, or DSH
      // would refuse the second Session with `session/writer-held`.
      expect(a.engine.tempWorkerId('ticket-1')).not.toBe(b.engine.tempWorkerId('ticket-1'))
    } finally {
      a.done()
      b.done()
    }
  })

  it('keeps flat ids when no scope is set, so an existing store keeps working', () => {
    const legacy = engineFor('')
    try {
      expect(legacy.engine.residentWorkerId('coder')).toBe('mesh-coder-1')
      expect(legacy.engine.tempWorkerId('ticket-1')).toBe('mesh-temp-ticket-1')
    } finally {
      legacy.done()
    }
  })

  it('does not let one workspace see the other team', () => {
    const a = engineFor('scope-a')
    const b = engineFor('scope-b')
    try {
      // Each store holds only its own workers. `pickWorker` reads that store, so a
      // Router in A cannot reach a worker registered in B — there is no shared table.
      a.engine.registerWorker({
        id: a.engine.residentWorkerId('coder'), kind: 'coder',
        sessionId: a.engine.residentWorkerId('coder'), status: 'idle',
        offers: { keywords: [] }, resident: true, registeredAt: new Date().toISOString(),
      })
      b.engine.registerWorker({
        id: b.engine.residentWorkerId('coder'), kind: 'coder',
        sessionId: b.engine.residentWorkerId('coder'), status: 'idle',
        offers: { keywords: [] }, resident: true, registeredAt: new Date().toISOString(),
      })
      const pickedByA = a.engine.pickWorker('coder')
      const pickedByB = b.engine.pickWorker('coder')
      expect(pickedByA?.id).toContain('scope-a')
      expect(pickedByB?.id).toContain('scope-b')
      expect(a.store.listWorkers()).toHaveLength(1)
      expect(b.store.listWorkers()).toHaveLength(1)
    } finally {
      a.done()
      b.done()
    }
  })

  it('keeps tickets and audit separate per workspace', () => {
    const a = engineFor('scope-a')
    const b = engineFor('scope-b')
    try {
      a.engine.create(spec(), 'explicit', { human: true })
      expect(a.store.listTickets(false)).toHaveLength(1)
      // B saw none of it: separate stores, not a shared table with a filter.
      expect(b.store.listTickets(false)).toHaveLength(0)
      expect(b.store.countAudit('ticket.create')).toBe(0)
    } finally {
      a.done()
      b.done()
    }
  })
})
