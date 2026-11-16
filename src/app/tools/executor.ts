/**
 * Worker tools.
 *
 * A worker has exactly one way to report state (`mesh_report`) and a small set of ways
 * to talk to peers. Everything else it needs is a platform tool from the preset.
 *
 * The constraint worth stating: a worker cannot remove a gate. Gates arrive in the
 * dispatch artifact and the Engine re-reads the ticket's gate list rather than trusting
 * the worker's copy, so "I decided the gate was unnecessary" is not an available move.
 */

import { z } from 'zod'
import { Engine } from '../../core/engine.ts'
import { StructuredAnswer, WorkerReport } from '../../core/model.ts'
import type { Resources } from '../resources.ts'
import { tool } from './tool.ts'

/** Dependencies the worker tools need. */
export interface WorkerToolDeps {
  engine: Engine
  resources: Resources
  /** The worker this tool set belongs to. */
  workerId: string
  /** The ticket currently assigned, when any. */
  ticketId?: string
}

/**
 * Build one worker's tool set.
 *
 * @param deps - engine, resources, and the worker's identity.
 */
export function workerTools(deps: WorkerToolDeps) {
  const { engine, resources, workerId } = deps

  return [
    tool(
      'mesh_read',
      'Read Mesh state and ticket detail. Resources: ticket/<id>, message/<id>, thread/<key>, '
        + 'workers, coalition/<id>, usage, directory. Long bodies are paged with offset.',
      z.object({
        resource: z.string(),
        offset: z.number().int().nonnegative().default(0),
      }),
      args => {
        const [name, id] = splitResource(args.resource)
        return resources.read(name, id, args.offset)
      },
    ),

    tool(
      'mesh_report',
      'Report on your ticket. Put the DELIVERABLE in "result": the Router only sees what '
        + 'this tool sends, never your closing message, so an answer written only at the end '
        + 'of your turn is lost. "progress" keeps working; "ready" finishes; "dropped" means '
        + 'out of scope; "blocked" or "failed" parks the ticket for a person.',
      z.object({
        ticketId: z.string(),
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        text: z.string().default('').describe('Short status note, not the deliverable.'),
        result: z.string().optional().describe('The deliverable itself, in full.'),
        humanAction: z.string().optional(),
        refs: z.array(z.string()).default([]),
      }),
      args => {
        const report = WorkerReport.parse({
          state: args.state,
          text: args.text,
          ...(args.result === undefined ? {} : { result: args.result }),
          ...(args.humanAction === undefined ? {} : { humanAction: args.humanAction }),
          refs: args.refs,
        })
        const ticket = engine.report(args.ticketId, report)
        return { ticketId: ticket.id, stage: ticket.stage, ended: ticket.ended?.outcome ?? null }
      },
    ),

    tool(
      'mesh_ack',
      'Acknowledge a message you received. Use sparingly; a report is usually better.',
      z.object({ messageId: z.string(), note: z.string().default('') }),
      args => {
        engine.bus.markDelivered(args.messageId, workerId)
        return { acked: args.messageId }
      },
    ),

    tool(
      'mesh_tell',
      'Send a one-way message to another worker. Use for facts they need, not for questions.',
      z.object({
        to: z.string(),
        body: z.string().min(1).max(1500),
        refs: z.array(z.string()).default([]),
      }),
      args => {
        const sent = engine.tell(workerId, args.to, args.body, args.refs)
        return { messageId: sent.id }
      },
    ),

    tool(
      'mesh_ask',
      'Ask another worker a question. Omit "to" to let the directory pick one; name a role '
        + 'explicitly with "@reviewer: ..." for a direct match. Set gate:true when you may not '
        + 'proceed without an answer — that parks your ticket until the holder decides.',
      z.object({
        to: z.string().optional(),
        question: z.string().min(1).max(1500),
        gate: z.boolean().default(false),
        ttlMin: z.number().int().positive().optional(),
        ticketId: z.string().optional(),
      }),
      args => {
        const result = engine.ask(workerId, args.question, {
          ...(args.to === undefined ? {} : { to: args.to }),
          ...(args.ttlMin === undefined ? {} : { ttlMin: args.ttlMin }),
          gate: args.gate,
          ...(args.ticketId === undefined ? {} : { ticketId: args.ticketId }),
        })
        return {
          messageId: result.message?.id ?? null,
          gateId: result.gate?.id ?? null,
          needsReview: result.needsReview === true,
        }
      },
    ),

    tool(
      'mesh_needs',
      'Declare that this task needs a specialty you do not have. The directory resolves it, or '
        + 'parks the need for the Router. Advisory only: it does not block you.',
      z.object({
        text: z.string().min(1).max(600),
        urgency: z.enum(['advisory', 'blocking']).default('advisory'),
      }),
      args => {
        const match = engine.needs(workerId, args.text)
        if (match.matched) {
          const sent = engine.ask(workerId, args.text, { to: match.matched.id })
          return {
            matched: match.matched.id,
            source: match.source,
            messageId: sent.message?.id ?? null,
          }
        }
        return { matched: null, source: match.source, deferred: true }
      },
    ),

    tool(
      'mesh_publish',
      'Broadcast a short summary to a topic. Detail stays in your own files; put only what peers '
        + 'need in the summary.',
      z.object({
        topic: z.string(),
        summary: z.string().min(1).max(300),
        detailRef: z.string().optional(),
        ttl: z.number().int().positive().default(3),
      }),
      args => {
        const sent = engine.publish(workerId, args.topic, args.summary, {
          ...(args.detailRef === undefined ? {} : { detailRef: args.detailRef }),
          ttl: args.ttl,
        })
        return { messageId: sent.id, ttl: sent.ttl ?? 3 }
      },
    ),

    tool(
      'mesh_subscribe',
      'Subscribe to a topic so future publishes reach you.',
      z.object({ topic: z.string(), ticketId: z.string().optional() }),
      args => {
        if (args.ticketId) {
          engine.intake.subscribeAndFollow(args.ticketId, Engine.topicKey(args.topic), args.topic)
        }
        return { subscribed: args.topic }
      },
    ),

    tool(
      'mesh_gate_decide',
      'Decide a gate someone raised to you. Approve to let them proceed; reject and give an '
        + 'alternative so they know what to do instead.',
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
      'mesh_coalition_answer',
      'Answer a coalition question. Fill the fields the question asked for; the moderator merges '
        + 'them without a further inference round.',
      z.object({
        coalitionId: z.string(),
        fields: z.record(z.string(), z.unknown()).default({}),
        summary: z.string().default(''),
      }),
      args => {
        const answer = StructuredAnswer.parse({ fields: args.fields, summary: args.summary })
        const coalition = engine.coalitionAnswer(args.coalitionId, workerId, answer)
        return { coalitionId: coalition.id, state: coalition.state, round: coalition.round }
      },
    ),

    tool(
      'mesh_handback',
      'Give a ticket back because it exceeds what you were authorised to do. This is the honest '
        + 'move when the request grew; do not silently expand scope.',
      z.object({ ticketId: z.string(), reason: z.string().min(1) }),
      args => {
        const ticket = engine.report(args.ticketId, {
          state: 'dropped',
          text: args.reason,
          refs: [],
        })
        return { ticketId: ticket.id, ended: ticket.ended?.outcome ?? null }
      },
    ),
  ]
}

/** Split `name/<id>` into its parts. */
function splitResource(resource: string): [string, string | undefined] {
  const index = resource.indexOf('/')
  if (index === -1) return [resource, undefined]
  return [resource.slice(0, index), resource.slice(index + 1)]
}
