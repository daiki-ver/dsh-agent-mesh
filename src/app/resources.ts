/**
 * Resources: what `mesh_read` can fetch.
 *
 * Long content never travels in a message. A message carries a short body plus a
 * resource path, and the reader pulls the detail only when it needs it. That is the
 * whole reason a resident worker can hold many tickets without its context filling up.
 */

import type { Store } from '../core/store.ts'
import type { Engine } from '../core/engine.ts'
import { type Gate, type Ticket } from '../core/model.ts'

/** A page of one resource. */
export interface ResourcePage {
  resource: string
  text: string
  /** Cursor for the next page, when there is more. */
  nextOffset?: number
}

/** Default characters per page. */
export const PAGE_CHARS = 8_000

/** Resources `mesh_read` understands. */
export const RESOURCE_NAMES = [
  'tickets',
  'ticket',
  'thread',
  'message',
  'workers',
  'coalitions',
  'coalition',
  'gates',
  'usage',
  'audit',
  'state',
  'directory',
  'prompts',
  'settings',
] as const

/** One resource name. */
export type ResourceName = (typeof RESOURCE_NAMES)[number]

/**
 * Resources: read, paginate, render.
 */
export class Resources {
  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
  ) {}

  /**
   * Read one resource.
   *
   * @param name - the resource kind.
   * @param id - the specific record, when the kind needs one.
   * @param offset - character offset for pagination.
   */
  read(name: string, id?: string, offset = 0): ResourcePage {
    const text = this.render(name, id)
    if (text.length <= PAGE_CHARS) return { resource: label(name, id), text }
    const start = Math.max(0, offset)
    const slice = text.slice(start, start + PAGE_CHARS)
    const next = start + PAGE_CHARS
    return {
      resource: label(name, id),
      text: slice,
      ...(next < text.length ? { nextOffset: next } : {}),
    }
  }

  /** Render a resource to text without pagination. */
  private render(name: string, id?: string): string {
    switch (name) {
      case 'tickets':
        return this.renderTickets()
      case 'ticket':
        return this.renderTicket(requireId(name, id))
      case 'thread':
        return this.renderThread(requireId(name, id))
      case 'message':
        return this.renderMessage(requireId(name, id))
      case 'workers':
        return this.renderWorkers()
      case 'coalitions':
        return this.renderCoalitions()
      case 'coalition':
        return this.renderCoalition(requireId(name, id))
      case 'gates':
        return this.renderGates()
      case 'usage':
        return this.renderUsage(id)
      case 'audit':
        return this.renderAudit()
      case 'state':
        return JSON.stringify(this.engine.state(), null, 2)
      case 'directory':
        return JSON.stringify(this.engine.directory.listing(), null, 2)
      case 'prompts':
        return this.store.kvGet('prompts.current') ?? '(no prompt overrides)'
      case 'settings':
        return this.store.kvGet('settings.current') ?? '(default settings)'
      default:
        return `Unknown resource "${name}". Known: ${RESOURCE_NAMES.join(', ')}`
    }
  }

  private renderTickets(): string {
    const tickets = this.store.listTickets(false)
    if (tickets.length === 0) return '(no tickets)'
    return tickets.map(t => {
      const ending = t.ended ? ` ended:${t.ended.outcome}` : ''
      return `${t.id} [${t.stage}${ending}] ${t.title} (${t.spec.workerKind}, ${t.mandate})`
    }).join('\n')
  }

  private renderTicket(ticketId: string): string {
    const ticket = this.store.getTicket(ticketId)
    if (!ticket) return `Unknown ticket ${ticketId}`
    const lines = [
      `# ${ticket.id} — ${ticket.title}`,
      `stage: ${ticket.stage}  mandate: ${ticket.mandate}  kind: ${ticket.spec.workerKind}`,
      `goal: ${ticket.spec.goal}`,
    ]
    if (ticket.spec.boundaries.length > 0) {
      lines.push('boundaries:', ...ticket.spec.boundaries.map(b => `  - ${b}`))
    }
    if (ticket.spec.acceptance.length > 0) {
      lines.push('acceptance:', ...ticket.spec.acceptance.map(a => `  - ${a}`))
    }
    if (ticket.gates.length > 0) lines.push(`gates: ${ticket.gates.join(', ')}`)
    if (ticket.follows.length > 0) lines.push(`follows: ${ticket.follows.join(', ')}`)
    if (ticket.assignments.length > 0) {
      lines.push('assignments:', ...ticket.assignments.map(
        a => `  - ${a.id} ${a.workerId} ${a.state}${a.note ? ` (${a.note})` : ''}`,
      ))
    }
    if (ticket.inputs.length > 0) {
      lines.push('inputs:', ...ticket.inputs.map(
        i => `  - [${i.kind}${i.delivered ? '' : ' undelivered'}] ${truncate(i.text, 200)}`,
      ))
    }
    if (ticket.ended) {
      lines.push(`ended: ${ticket.ended.outcome} by ${ticket.ended.by} at ${ticket.ended.at}`)
      if (ticket.ended.reason) lines.push(`reason: ${ticket.ended.reason}`)
    }
    return lines.join('\n')
  }

  private renderThread(key: string): string {
    const thread = this.store.getThread(key)
    if (!thread) return `Unknown thread ${key}`
    const lines = [
      `# ${thread.key} ${thread.topic}`,
      `pending: ${thread.pending.length}  subscribers: ${thread.subscribers.join(', ') || '(none)'}`,
      `lastAt: ${thread.lastAt}`,
    ]
    if (thread.evaluating) {
      lines.push(`evaluating: ${thread.evaluating.id} deadline ${thread.evaluating.deadline} requeues ${thread.evaluating.requeues}`)
    }
    return lines.join('\n')
  }

  private renderMessage(messageId: string): string {
    const message = this.store.getMessage(messageId)
    if (!message) return `Unknown message ${messageId}`
    return [
      `# ${message.id} (${message.type}, ${message.state})`,
      `from: ${message.from}  to: ${message.to ?? message.topic ?? '(broadcast)'}`,
      message.summary ? `summary: ${message.summary}` : '',
      '',
      message.body,
    ].filter(Boolean).join('\n')
  }

  private renderWorkers(): string {
    const workers = this.store.listWorkers()
    if (workers.length === 0) return '(no workers registered)'
    return workers.map(w => {
      const ticket = w.ticketId ? ` ticket:${w.ticketId}` : ''
      const resident = w.resident ? ' resident' : ''
      return `${w.id} [${w.kind}/${w.status}${resident}] session:${w.sessionId}${ticket}`
    }).join('\n')
  }

  private renderCoalitions(): string {
    const coalitions = this.store.listCoalitions(false)
    if (coalitions.length === 0) return '(no coalitions)'
    return coalitions.map(c => {
      const pct = c.budget.tokens > 0 ? Math.round((c.budget.used / c.budget.tokens) * 100) : 0
      return `${c.id} [${c.state}] ${c.topic} members:${c.memberIds.length} budget:${pct}% round:${c.round}`
    }).join('\n')
  }

  private renderCoalition(coalitionId: string): string {
    const coalition = this.store.getCoalition(coalitionId)
    if (!coalition) return `Unknown coalition ${coalitionId}`
    const lines = [
      `# ${coalition.id} — ${coalition.topic}`,
      `state: ${coalition.state}  mandate: ${coalition.mandate}  round: ${coalition.round}`,
      `budget: ${coalition.budget.used}/${coalition.budget.tokens}  deadline: ${coalition.deadline}`,
      `members: ${coalition.memberIds.join(', ')}`,
      `question: ${coalition.question}`,
    ]
    if (coalition.script.length > 0) {
      lines.push('script:', ...coalition.script.map(
        (s, i) => `  ${i}. ${s.speakerKind}: ${s.ask} -> ${s.schema}`,
      ))
    } else {
      lines.push('script: (none — form B, single collection)')
    }
    if (coalition.outputs.length > 0) {
      lines.push('outputs:', ...coalition.outputs.map(
        o => `  round ${o.round} ${o.speaker}: ${JSON.stringify(o.fields)}`,
      ))
    }
    return lines.join('\n')
  }

  private renderGates(): string {
    const gates = this.store.listGates(false)
    if (gates.length === 0) return '(no gates)'
    return gates.map((g: Gate) => {
      const decision = g.decision ? ` decision:${g.decision.at}` : ''
      return `${g.id} [${g.state}] ticket:${g.ticketId} ${g.fromWorker}->${g.toWorker} depth:${g.depth}${decision}`
    }).join('\n')
  }

  private renderUsage(scopeId?: string): string {
    const rows = this.store.listUsage(scopeId === undefined ? {} : { scopeId })
    if (rows.length === 0) return '(no usage recorded)'
    const byScope = new Map<string, number>()
    for (const row of rows) {
      const key = `${row.scope}:${row.scopeId}`
      byScope.set(key, (byScope.get(key) ?? 0) + row.inputTokens + row.outputTokens)
    }
    return [...byScope.entries()].map(([key, total]) => `${key} = ${total} tokens`).join('\n')
  }

  private renderAudit(): string {
    const rows = this.store.listAudit(50)
    if (rows.length === 0) return '(no audit rows)'
    return rows.map(r => `${r.at} ${r.actor} ${r.kind} ${JSON.stringify(r.value)}`).join('\n')
  }
}

/** A human-readable resource label. */
function label(name: string, id?: string): string {
  return id === undefined ? name : `${name}/${id}`
}

/** Require an id for a resource that needs one. */
function requireId(name: string, id: string | undefined): string {
  if (id === undefined || id === '') throw new Error(`mesh_read: "${name}" requires an id`)
  return id
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** Re-exported for tools that render a ticket inline. */
export type { Ticket }
