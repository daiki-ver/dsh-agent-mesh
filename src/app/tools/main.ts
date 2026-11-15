/**
 * Router tools.
 *
 * The Router is the scheduling plane, so every tool here answers a scheduling question
 * and none of them can do work. There is deliberately no shell, no file write, no
 * subagent: adding one would slowly turn the Router into a worker, and its per-request
 * cost would grow with every tool it carries.
 *
 * `mesh_route` is the one that matters. Its `accept` case produces the dispatch
 * artifact, which is the ticket spec — so the Router's single decision carries the
 * goal, the boundaries, the budget, and the gates, and nothing downstream needs to
 * infer them again.
 */

import { z } from 'zod'
import type { Engine } from '../../core/engine.ts'
import { DispatchArtifact, GateSpec, RoundScriptStep, WorkerKind } from '../../core/model.ts'
import type { Resources } from '../resources.ts'
import { tool, NoArgs } from './tool.ts'

/** Dependencies the Router tools need. */
export interface RouterToolDeps {
  engine: Engine
  resources: Resources
  /** Session id of the Router itself, for logging. */
  routerSessionId: string
}

/** One routing decision. */
const RouteItem = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('accept'),
    thread: z.string().optional(),
    triggerIds: z.array(z.string()).default([]),
    spec: DispatchArtifact,
  }),
  z.object({
    action: z.literal('ignore'),
    thread: z.string().optional(),
    triggerIds: z.array(z.string()).default([]),
    reason: z.string().default(''),
  }),
  z.object({
    action: z.literal('stop'),
    ticketId: z.string(),
    reason: z.string().default(''),
  }),
])

/**
 * Build the Router's tool set.
 *
 * @param deps - engine, resources, and the Router's own session id.
 */
export function routerTools(deps: RouterToolDeps) {
  const { engine, resources } = deps

  return [
    tool(
      'mesh_read',
      'Read Mesh state. Resources: tickets, ticket/<id>, thread/<key>, message/<id>, workers, '
        + 'coalitions, coalition/<id>, gates, usage[/<scopeId>], audit, state, directory, prompts, settings. '
        + 'Use this instead of guessing what exists.',
      z.object({
        resource: z.string().describe('Resource name, optionally with /<id>.'),
        offset: z.number().int().nonnegative().default(0).describe('Character offset for paging long output.'),
      }),
      args => {
        const [name, id] = splitResource(args.resource)
        return resources.read(name, id, args.offset)
      },
    ),

    tool(
      'mesh_route',
      'Act on queued work. "accept" turns a request into a ticket and assigns a typed worker; '
        + 'the spec you supply becomes the ticket contract, so include goal, boundaries, '
        + 'acceptance, budget and any mandatory gates. "ignore" drops it. "stop" ends a ticket. '
        + 'Batch up to 20 items; each is applied independently.',
      z.object({
        items: z.array(RouteItem).min(1).max(20),
      }),
      args => {
        const results: { action: string; ticketId?: string; error?: string }[] = []
        for (const item of args.items) {
          try {
            if (item.action === 'accept') {
              const created = engine.create(item.spec, item.spec.budget ? 'explicit' : 'inferred', {
                human: true,
                ...(item.thread === undefined ? {} : { thread: item.thread }),
                triggerIds: item.triggerIds,
              })
              results.push({ action: 'accept', ticketId: created.ticket.id })
              if (item.thread !== undefined) engine.assessmentDelivered(item.thread)
            } else if (item.action === 'ignore') {
              if (item.thread !== undefined) engine.assessmentDelivered(item.thread)
              results.push({ action: 'ignore' })
            } else {
              engine.stopTicket(item.ticketId, item.reason)
              results.push({ action: 'stop', ticketId: item.ticketId })
            }
          } catch (error) {
            results.push({ action: item.action, error: message(error) })
          }
        }
        return { results }
      },
    ),

    tool(
      'mesh_eval_read',
      'Read the candidate that is waiting for a routing decision on a thread.',
      z.object({ thread: z.string() }),
      args => {
        const thread = engine.store.getThread(args.thread)
        if (!thread) return { found: false }
        return {
          found: true,
          thread: thread.key,
          pending: thread.pending,
          evaluating: thread.evaluating ?? null,
        }
      },
    ),

    tool(
      'mesh_eval_decide',
      'Decide an inferred candidate: accept it as a ticket, or ignore it. Same contract as mesh_route accept.',
      z.object({
        thread: z.string(),
        decision: z.enum(['accept', 'ignore']),
        spec: DispatchArtifact.optional(),
        reason: z.string().default(''),
      }),
      args => {
        if (args.decision === 'ignore') {
          engine.assessmentDelivered(args.thread)
          return { decision: 'ignore' }
        }
        if (!args.spec) throw new Error('mesh_eval_decide: accept requires a spec')
        const created = engine.create(args.spec, 'inferred', { human: false, thread: args.thread })
        engine.assessmentDelivered(args.thread)
        return { decision: 'accept', ticketId: created.ticket.id }
      },
    ),

    tool(
      'mesh_ticket_status',
      'Ask a worker for a status update on a ticket.',
      z.object({ ticketId: z.string() }),
      args => {
        const ticket = engine.tickets.require(args.ticketId)
        engine.note(args.ticketId, 'The Router asked for a status update. Reply with mesh_report.')
        return { ticketId: ticket.id, stage: ticket.stage, assignments: ticket.assignments.length }
      },
    ),

    tool(
      'mesh_ticket_note',
      'Send a note to the worker on a ticket. Use for guidance, not for doing the work yourself.',
      z.object({ ticketId: z.string(), text: z.string().min(1) }),
      args => {
        engine.note(args.ticketId, args.text)
        return { ticketId: args.ticketId, delivered: true }
      },
    ),

    tool(
      'mesh_ticket_retry',
      'Retry an ended ticket on the same worker session, continuing from its existing state.',
      z.object({ ticketId: z.string() }),
      args => {
        const ticket = engine.retryTicket(args.ticketId)
        return { ticketId: ticket.id, stage: ticket.stage }
      },
    ),

    tool(
      'mesh_thread_unsubscribe',
      'Stop routing a thread to a ticket.',
      z.object({ ticketId: z.string(), thread: z.string() }),
      args => {
        engine.intake.unsubscribe(args.ticketId, args.thread)
        return { ok: true }
      },
    ),

    tool(
      'mesh_coalition_approve',
      'Approve a proposed coalition so it may start. Use for inferred groups when confirmation is blocking.',
      z.object({ coalitionId: z.string() }),
      args => {
        const coalition = engine.approveCoalition(args.coalitionId, 'router')
        return { coalitionId: coalition.id, state: coalition.state }
      },
    ),

    tool(
      'mesh_coalition_propose',
      'Assemble a temporary group for one question. Leave script empty unless the steps are known '
        + 'up front; an empty script collects one answer from each member and merges them.',
      z.object({
        topic: z.string(),
        memberIds: z.array(z.string()).min(2),
        leadId: z.string(),
        question: z.string(),
        mandate: z.enum(['explicit', 'inferred']).default('inferred'),
        script: z.array(RoundScriptStep).default([]),
        ticketId: z.string().optional(),
      }),
      args => {
        const coalition = engine.proposeCoalition({
          topic: args.topic,
          memberIds: args.memberIds,
          leadId: args.leadId,
          question: args.question,
          mandate: args.mandate,
          script: args.script,
          ...(args.ticketId === undefined ? {} : { ticketId: args.ticketId }),
        })
        return { coalitionId: coalition.id, state: coalition.state, budget: coalition.budget.tokens }
      },
    ),

    tool(
      'mesh_gate_escalate_decide',
      'Decide a gate that escalated to a person or the Router. Use only when the gate could not be '
        + 'resolved by its holder.',
      z.object({
        gateId: z.string(),
        decision: z.enum(['approve', 'reject']),
        alternative: z.string().optional(),
        note: z.string().default(''),
      }),
      args => {
        const gate = engine.decideGate(args.gateId, args.decision, {
          ...(args.alternative === undefined ? {} : { alternative: args.alternative }),
          note: args.note,
        })
        return { gateId: gate.id, state: gate.state }
      },
    ),

    tool(
      'mesh_settings_save',
      'Persist a settings override. Keys are free-form; Mesh reads only the ones it defines.',
      z.object({ values: z.record(z.string(), z.unknown()) }),
      args => {
        engine.store.kvSet('settings.current', JSON.stringify(args.values))
        return { saved: true, keys: Object.keys(args.values) }
      },
    ),

    tool(
      'mesh_prompts_save',
      'Persist a prompt override. Recorded with a revision so a Session can be traced to the prompt it ran.',
      z.object({ text: z.string().min(1) }),
      args => {
        engine.store.kvSet('prompts.current', args.text)
        const revision = Number(engine.store.kvGet('prompts.revision') ?? '0') + 1
        engine.store.kvSet('prompts.revision', String(revision))
        engine.store.audit('router', 'prompts.save', { revision })
        return { saved: true, revision }
      },
    ),

    tool(
      'mesh_evidence',
      'Count how often a subsystem was actually needed. Use this before proposing to expand Mesh: '
        + 'gate, needs, coalition, escalate.',
      NoArgs,
      () => ({
        gate: engine.evidence('gate.open', 3),
        needs: engine.evidence('needs.match', 5),
        coalition: engine.evidence('coalition.propose', 3),
        escalate: engine.evidence('escalate', 3),
      }),
    ),
  ]
}

/** Split `name/<id>` into its parts. */
function splitResource(resource: string): [string, string | undefined] {
  const index = resource.indexOf('/')
  if (index === -1) return [resource, undefined]
  return [resource.slice(0, index), resource.slice(index + 1)]
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Re-exported for tests that build an artifact inline. */
export { GateSpec, WorkerKind }
