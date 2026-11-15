/**
 * The Watchdog.
 *
 * One hourly prompt into the Router Session asking it to look for stuck work. It is a
 * scheduled message, not a supervisor: it reports anomalies and suggests a move, and it
 * never restarts anything itself.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not refresh worker context.** Stale beliefs are cleared by the per-ticket
 *   reorientation note, which is an append and keeps the prompt prefix intact.
 * - **It does not kill work.** Killing belongs to a person or to an explicit budget
 *   rule; a timer that kills things is how you lose a nearly-finished ticket.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Engine } from '../core/engine.ts'
import type { ScheduleService, SessionId } from './host.ts'

/** What the Watchdog inspects. */
export const WATCHDOG_TITLE = 'Mesh Watchdog'

/** The prompt the Router receives. */
export const WATCHDOG_PROMPT = [
  'Mesh Watchdog check. Read `workers`, `coalitions`, and `state`.',
  'Report only anomalies: a worker that has grown its budget with no ticket progress,',
  'a coalition whose round has not advanced, a ticket parked for a person for a long time.',
  'For each, name the ticket or coalition id and suggest one action (escalate, stop, dissolve).',
  'If nothing is anomalous, reply with a single line: "mesh: no anomalies".',
].join('\n')

/** Result of installing the Watchdog. */
export interface WatchdogHandle {
  installed: boolean
  id?: string
  reason?: string
}

/**
 * Install the Watchdog on the Router Session.
 *
 * @param ctx - the bundle context, used for logging.
 * @param schedule - the Host schedule service.
 * @param engine - used to record the install in the audit log.
 * @param routerSessionId - the Session the prompt is delivered to.
 * @param everySeconds - how often it runs.
 */
export async function installWatchdog(
  ctx: Context,
  schedule: ScheduleService | undefined,
  engine: Engine,
  routerSessionId: string,
  everySeconds: number,
): Promise<WatchdogHandle> {
  if (!schedule) return { installed: false, reason: 'no schedule service in this profile' }
  try {
    const entry = await schedule.create(
      {
        title: WATCHDOG_TITLE,
        prompt: WATCHDOG_PROMPT,
        // A discriminant union, not a bare string: `{kind:'every', every_seconds}`.
        timing: { kind: 'every', every_seconds: everySeconds },
        target: { kind: 'session', sessionId: routerSessionId as SessionId },
      },
      routerSessionId as SessionId,
    )
    engine.store.audit('program', 'watchdog.install', { id: entry.id, everySeconds })
    ctx.logger?.info?.(`[mesh] watchdog scheduled every ${everySeconds}s`)
    return { installed: true, id: entry.id }
  } catch (error) {
    // A profile without a Router Session yet, or a Host that refuses the target, must
    // not fail the boot: the rest of Mesh works without the Watchdog.
    const reason = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`[mesh] watchdog not installed: ${reason}`)
    engine.store.audit('program', 'watchdog.skipped', { reason })
    return { installed: false, reason }
  }
}

/** Run the Watchdog once, without waiting for the schedule. */
export async function runWatchdogNow(schedule: ScheduleService | undefined, id: string): Promise<boolean> {
  if (!schedule) return false
  try {
    await schedule.run({ id })
    return true
  } catch {
    return false
  }
}
