/**
 * The single SQLite database behind Mesh.
 *
 * Two properties matter more than anything else here:
 *
 * 1. **Every state change and its side-effect intent commit together.** A command
 *    writes its aggregate and enqueues its `effect` row inside one transaction, so a
 *    crash either loses both or keeps both. That is what makes resuming safe.
 * 2. **Usage writes are batched.** `node:sqlite` is synchronous and
 *    `synchronous=FULL` fsyncs on commit, so writing once per assistant message on
 *    the main thread would stall the pass loop. `flushUsage` takes a whole batch.
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type AuditEntry, type Coalition, type Gate, type Message, type Thread, type Ticket,
  type Usage, type Worker, now,
} from './model.ts'

/** Current schema version. Bump when a migration is added. */
export const SCHEMA_VERSION = 1
/** Oldest schema this build can migrate from. */
export const OLDEST_SCHEMA = 1

const KV = {
  schema: 'store.schema',
  settings: 'store.settings',
} as const

/** A row of the effect queue, as stored. */
export interface EffectRow {
  kind: string
  key: string
  value: string
  seq: number
  generation: number
  attempts: number
  error: string
  due: number
  since: string
}

/** What one flush wrote. */
export interface UsageFlush {
  rows: Usage[]
  totalTokens: number
}

/**
 * Store: aggregates, the effect queue, the audit log, and the usage ledger.
 *
 * Construct one per process. It owns the only `DatabaseSync` handle; nothing else
 * opens the file.
 */
export class Store {
  readonly db: DatabaseSync
  private savepointDepth = 0
  private afterCommitQueue: (() => void)[] = []
  private closed = false

  /**
   * Open (or create) the database, applying the schema in one transaction.
   * @param path - absolute path to `mesh.db`.
   * @param report - receives errors thrown by after-commit callbacks without
   *   failing the committed transaction.
   */
  constructor(path: string, private readonly report: (error: unknown) => void = () => {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
    } catch {
      // Windows has no POSIX mode bits; the ACL inherited from the directory applies.
    }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=OFF')
    this.migrate()
  }

  /** Create or upgrade the schema. Idempotent. */
  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const version = this.kvGet(KV.schema)
    if (version !== undefined && Number(version) > SCHEMA_VERSION) {
      throw new Error(`mesh: unsupported database version ${version} (this build understands up to ${SCHEMA_VERSION})`)
    }
    if (version !== undefined && Number(version) < OLDEST_SCHEMA) {
      throw new Error(`mesh: database version ${version} is too old (oldest supported is ${OLDEST_SCHEMA})`)
    }
    this.atomic(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS effect (
          kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
          seq INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
          due INTEGER NOT NULL, since TEXT NOT NULL,
          PRIMARY KEY (kind, key)
        );
        CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);

        CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS message (
          id TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS message_seq ON message(seq);
        CREATE TABLE IF NOT EXISTS worker (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS coalition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS gate (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
          actor TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS usage (
          scope TEXT NOT NULL, scope_id TEXT NOT NULL, session_id TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (scope, scope_id, session_id)
        );
      `)
      this.reconcileGeneratedColumns()
      this.kvSet(KV.schema, String(SCHEMA_VERSION))
    })
  }

  /**
   * Keep generated working-set columns and their partial indexes in step with the
   * definitions below. A column whose definition changed is dropped and re-added,
   * because SQLite cannot alter one in place.
   */
  private reconcileGeneratedColumns(): void {
    const defs: Record<string, Record<string, string>> = {
      ticket: {
        open: `TEXT AS (CASE WHEN json_extract(value,'$.ended') IS NULL THEN id END)`,
        active: `TEXT AS (CASE WHEN json_extract(value,'$.stage') IN ('working','idle','person') THEN id END)`,
      },
      message: {
        pending: `TEXT AS (CASE WHEN json_extract(value,'$.state') = 'pending' THEN id END)`,
      },
      coalition: {
        open: `TEXT AS (CASE WHEN json_extract(value,'$.state') NOT IN ('dissolved','archived') THEN id END)`,
      },
      gate: {
        open: `TEXT AS (CASE WHEN json_extract(value,'$.state') = 'pending' THEN id END)`,
      },
      thread: {
        active: `TEXT AS (CASE WHEN json_array_length(json_extract(value,'$.pending')) > 0
          OR json_extract(value,'$.evaluating.id') IS NOT NULL THEN key END)`,
      },
    }
    for (const [table, columns] of Object.entries(defs)) {
      const sql = String(
        (this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as
          { sql?: string } | undefined)?.sql ?? '',
      )
      const generated = new Set(
        (this.db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2,3)')
          .all(table) as { name: string }[]).map(row => String(row.name)),
      )
      // Drop any generated column whose definition changed or that was removed.
      // Track what survived so the add pass does not re-add a kept column.
      const kept = new Set<string>()
      for (const name of generated) {
        const definition = columns[name]
        if (definition && sql.includes(`${name} ${definition}`)) {
          kept.add(name)
          continue
        }
        this.db.exec(`DROP INDEX IF EXISTS ${table}_${name}`)
        this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${name}`)
      }
      // Re-read the column set now that drops have happened.
      const existing = new Set(
        (this.db.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table) as { name: string }[])
          .map(row => String(row.name)),
      )
      for (const [name, definition] of Object.entries(columns)) {
        if (!kept.has(name) && !existing.has(name)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
        }
        this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_${name} ON ${table}(${name}) WHERE ${name} IS NOT NULL`)
      }
    }
  }

  /**
   * Run `fn` inside a transaction, nesting via savepoints.
   *
   * After-commit callbacks registered through `afterCommit` run only once the
   * outermost transaction commits, and are dropped if it rolls back.
   */
  atomic<T>(fn: () => T): T {
    if (this.closed) throw new Error('mesh: store is closed')
    const depth = this.savepointDepth
    const name = `sp_${depth}`
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`)
    this.savepointDepth += 1
    let result: T
    try {
      result = fn()
    } catch (error) {
      this.savepointDepth -= 1
      if (depth === 0) {
        this.db.exec('ROLLBACK')
        this.afterCommitQueue = []
      } else {
        this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`)
        // Nested rollback discards callbacks registered inside this level only.
      }
      throw error
    }
    this.savepointDepth -= 1
    if (depth === 0) {
      this.db.exec('COMMIT')
      const queued = this.afterCommitQueue
      this.afterCommitQueue = []
      for (const callback of queued) {
        try {
          callback()
        } catch (error) {
          this.report(error)
        }
      }
    } else {
      this.db.exec(`RELEASE ${name}`)
    }
    return result
  }

  /** Register a callback to run after the current outermost transaction commits. */
  afterCommit(callback: () => void): void {
    if (this.savepointDepth === 0) {
      // No transaction in flight: run now, surfacing errors the same way.
      try {
        callback()
      } catch (error) {
        this.report(error)
      }
      return
    }
    this.afterCommitQueue.push(callback)
  }

  // ── kv ────────────────────────────────────────────────────────────────────

  kvGet(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      { value?: string } | undefined
    return row?.value === undefined ? undefined : String(row.value)
  }

  kvSet(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value)
  }

  // ── aggregates ────────────────────────────────────────────────────────────

  getThread(key: string): Thread | undefined {
    return this.readOne<Thread>('thread', 'key', key)
  }

  putThread(thread: Thread): void {
    this.writeOne('thread', 'key', thread.key, thread)
  }

  listThreads(onlyActive = false): Thread[] {
    const sql = onlyActive
      ? 'SELECT value FROM thread WHERE active IS NOT NULL'
      : 'SELECT value FROM thread'
    return this.readMany<Thread>(sql)
  }

  getTicket(id: string): Ticket | undefined {
    return this.readOne<Ticket>('ticket', 'id', id)
  }

  putTicket(ticket: Ticket): void {
    this.writeOne('ticket', 'id', ticket.id, ticket)
  }

  listTickets(onlyOpen = false): Ticket[] {
    const sql = onlyOpen
      ? 'SELECT value FROM ticket WHERE open IS NOT NULL'
      : 'SELECT value FROM ticket'
    return this.readMany<Ticket>(sql)
  }

  getMessage(id: string): Message | undefined {
    return this.readOne<Message>('message', 'id', id)
  }

  putMessage(message: Message): void {
    this.db.prepare('INSERT INTO message(id,seq,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(message.id, message.seq, JSON.stringify(message))
  }

  listMessages(filter: { state?: Message['state']; type?: Message['type']; thread?: string } = {}): Message[] {
    const all = this.readMany<Message>('SELECT value FROM message ORDER BY seq ASC')
    return all.filter(m => {
      if (filter.state && m.state !== filter.state) return false
      if (filter.type && m.type !== filter.type) return false
      if (filter.thread && m.thread !== filter.thread) return false
      return true
    })
  }

  nextMessageSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM message').get() as
      { next?: number } | undefined
    return Number(row?.next ?? 0)
  }

  getWorker(id: string): Worker | undefined {
    return this.readOne<Worker>('worker', 'id', id)
  }

  putWorker(worker: Worker): void {
    this.writeOne('worker', 'id', worker.id, worker)
  }

  deleteWorker(id: string): void {
    this.db.prepare('DELETE FROM worker WHERE id = ?').run(id)
  }

  listWorkers(): Worker[] {
    return this.readMany<Worker>('SELECT value FROM worker')
  }

  getCoalition(id: string): Coalition | undefined {
    return this.readOne<Coalition>('coalition', 'id', id)
  }

  putCoalition(coalition: Coalition): void {
    this.writeOne('coalition', 'id', coalition.id, coalition)
  }

  listCoalitions(onlyOpen = false): Coalition[] {
    const sql = onlyOpen
      ? 'SELECT value FROM coalition WHERE open IS NOT NULL'
      : 'SELECT value FROM coalition'
    return this.readMany<Coalition>(sql)
  }

  getGate(id: string): Gate | undefined {
    return this.readOne<Gate>('gate', 'id', id)
  }

  putGate(gate: Gate): void {
    this.writeOne('gate', 'id', gate.id, gate)
  }

  listGates(onlyOpen = false): Gate[] {
    const sql = onlyOpen
      ? 'SELECT value FROM gate WHERE open IS NOT NULL'
      : 'SELECT value FROM gate'
    return this.readMany<Gate>(sql)
  }

  // ── audit ─────────────────────────────────────────────────────────────────

  /** Append one audit row. Audit is never updated or deleted. */
  audit(actor: string, kind: string, value: Record<string, unknown> = {}): void {
    this.db.prepare('INSERT INTO audit(at,actor,kind,value) VALUES(?,?,?,?)')
      .run(now(), actor, kind, JSON.stringify(value))
  }

  listAudit(limit = 100): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT seq,at,actor,kind,value FROM audit ORDER BY seq DESC LIMIT ?')
      .all(limit) as { seq: number; at: string; actor: string; kind: string; value: string }[]
    return rows.map(row => ({
      seq: Number(row.seq),
      at: String(row.at),
      actor: String(row.actor),
      kind: String(row.kind),
      value: JSON.parse(String(row.value)) as Record<string, unknown>,
    }))
  }

  /** Count audit rows of one kind. The gate for starting an optional subsystem. */
  countAudit(kind: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM audit WHERE kind = ?').get(kind) as
      { n?: number } | undefined
    return Number(row?.n ?? 0)
  }

  // ── usage ─────────────────────────────────────────────────────────────────

  /**
   * Write a batch of accumulated usage in ONE transaction.
   *
   * The caller accumulates in memory and hands over the whole delta; this is the
   * only place usage reaches disk, which keeps the fsync count per pass at one.
   */
  flushUsage(rows: Usage[]): UsageFlush {
    if (rows.length === 0) return { rows: [], totalTokens: 0 }
    let totalTokens = 0
    this.atomic(() => {
      for (const row of rows) {
        const existing = this.db
          .prepare('SELECT value FROM usage WHERE scope=? AND scope_id=? AND session_id=?')
          .get(row.scope, row.scopeId, row.sessionId) as { value?: string } | undefined
        const merged = existing?.value === undefined
          ? row
          : mergeUsage(JSON.parse(String(existing.value)) as Usage, row)
        this.db
          .prepare(`INSERT INTO usage(scope,scope_id,session_id,value) VALUES(?,?,?,?)
            ON CONFLICT(scope,scope_id,session_id) DO UPDATE SET value=excluded.value`)
          .run(merged.scope, merged.scopeId, merged.sessionId, JSON.stringify(merged))
        totalTokens += row.inputTokens + row.outputTokens
      }
    })
    return { rows, totalTokens }
  }

  listUsage(filter: { scope?: Usage['scope']; scopeId?: string } = {}): Usage[] {
    const all = this.readMany<Usage>('SELECT value FROM usage')
    return all.filter(u => {
      if (filter.scope && u.scope !== filter.scope) return false
      if (filter.scopeId && u.scopeId !== filter.scopeId) return false
      return true
    })
  }

  /** Sum of `inputTokens + outputTokens` for one scope id. */
  usedTokens(scope: Usage['scope'], scopeId: string): number {
    return this.listUsage({ scope, scopeId })
      .reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0)
  }

  // ── effect queue ──────────────────────────────────────────────────────────

  /** Insert or refresh an effect. A new intent for the same key replaces the old one. */
  enqueueEffect(kind: string, key: string, value: unknown, due: number): void {
    const seq = this.nextEffectSeq()
    this.db.prepare(`
      INSERT INTO effect(kind,key,value,seq,generation,attempts,error,due,since)
      VALUES(?,?,?,?,0,0,'',?,?)
      ON CONFLICT(kind,key) DO UPDATE SET
        value=excluded.value, generation=effect.generation+1, attempts=0, error='', due=excluded.due
    `).run(kind, key, JSON.stringify(value), seq, due, now())
  }

  /** Rows whose `due` has passed, oldest intent first. */
  dueEffects(limit: number): EffectRow[] {
    const rows = this.db.prepare(
      'SELECT kind,key,value,seq,generation,attempts,error,due,since FROM effect WHERE due <= ? ORDER BY seq ASC LIMIT ?',
    ).all(Date.now(), limit) as Record<string, SQLInputValue>[]
    return rows.map(row => ({
      kind: String(row.kind),
      key: String(row.key),
      value: String(row.value),
      seq: Number(row.seq),
      generation: Number(row.generation),
      attempts: Number(row.attempts),
      error: String(row.error),
      due: Number(row.due),
      since: String(row.since),
    }))
  }

  /** Rows of one kind, for the ordered-kind check. */
  effectHead(kind: string): EffectRow | undefined {
    const row = this.db.prepare(
      'SELECT kind,key,value,seq,generation,attempts,error,due,since FROM effect WHERE kind=? ORDER BY seq ASC LIMIT 1',
    ).get(kind) as Record<string, SQLInputValue> | undefined
    if (!row) return undefined
    return {
      kind: String(row.kind), key: String(row.key), value: String(row.value),
      seq: Number(row.seq), generation: Number(row.generation), attempts: Number(row.attempts),
      error: String(row.error), due: Number(row.due), since: String(row.since),
    }
  }

  /** Remove a row, but only if it is still the same intent. Guards against deleting a refreshed row. */
  deleteEffect(kind: string, key: string, seq: number, generation: number): boolean {
    const result = this.db.prepare(
      'DELETE FROM effect WHERE kind=? AND key=? AND seq=? AND generation=?',
    ).run(kind, key, seq, generation)
    return Number(result.changes) > 0
  }

  /** Record a failure: bump attempts, set the next due time, keep the row. */
  retryEffect(kind: string, key: string, attempts: number, due: number, error: string): void {
    this.db.prepare('UPDATE effect SET attempts=?, due=?, error=? WHERE kind=? AND key=?')
      .run(attempts, due, error, kind, key)
  }

  /** Push a row's due time without counting it as a failure. */
  deferEffect(kind: string, key: string, due: number): void {
    this.db.prepare('UPDATE effect SET due=? WHERE kind=? AND key=?').run(due, kind, key)
  }

  countEffects(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM effect').get() as { n?: number } | undefined
    return Number(row?.n ?? 0)
  }

  private nextEffectSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM effect').get() as
      { next?: number } | undefined
    return Number(row?.next ?? 0)
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private readOne<T>(table: string, keyColumn: string, key: string): T | undefined {
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE ${keyColumn} = ?`).get(key) as
      { value?: string } | undefined
    return row?.value === undefined ? undefined : (JSON.parse(String(row.value)) as T)
  }

  private readMany<T>(sql: string): T[] {
    const rows = this.db.prepare(sql).all() as { value: string }[]
    return rows.map(row => JSON.parse(String(row.value)) as T)
  }

  private writeOne(table: string, keyColumn: string, key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO ${table}(${keyColumn},value) VALUES(?,?)
      ON CONFLICT(${keyColumn}) DO UPDATE SET value=excluded.value`)
      .run(key, JSON.stringify(value))
  }

  /** Close the handle. Further calls throw. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  get isClosed(): boolean {
    return this.closed
  }
}

/** Sum two usage records field by field, keeping the newer timestamp. */
function mergeUsage(base: Usage, delta: Usage): Usage {
  return {
    scope: delta.scope,
    scopeId: delta.scopeId,
    sessionId: delta.sessionId,
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + delta.cacheWriteTokens,
    reasoningTokens: base.reasoningTokens + delta.reasoningTokens,
    updatedAt: delta.updatedAt,
  }
}
