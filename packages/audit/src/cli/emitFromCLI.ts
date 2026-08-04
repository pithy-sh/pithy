// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { auditDatabase } from "../data/tables";
import { type AuditRecorderOptions, recordAuditEvent } from "../recorder";
import type { ResolvedActor } from "./resolveActor";

/**
 * The event an `emitFromCLI` caller supplies — every audit field except the actor, which comes from
 * {@link ResolvedActor} (resolved from the CF token, not the caller). The CLI describes *what*
 * happened; the resolver decides *who*.
 *
 * Plus `environment`, which the CLI alone may state per event. In a Worker the origin is read from
 * `env` and an emitter can never touch it — there the emitter is a request handler and the whole point
 * is that it cannot lie. A CLI command is not that: it *is* the trusted process, there is no untrusted
 * caller in it, and one invocation legitimately acts on several environments — `pithy storage provision`
 * loops every managed environment in a single run. Nothing else knows which one a given event belongs
 * to, so the event carries it.
 */
export type CliAuditEvent = Omit<AuditEventInput, "actorType" | "actorId"> & {
  /**
   * The environment this one event acted on. Overrides the emitter's configured origin environment;
   * omitted, the configured one stands.
   */
  environment?: string | null;
};

/**
 * Record an audit event from a Node/Bun context — the second emit path, for CLI-originated actions
 * (`pithy migrate`, `pithy deploy`, `pithy secrets set`). The CLI can't use a D1 binding, so it
 * writes over the REST API: `d1` is a `CloudflareD1Manager` from `@pithy-sh/cloudflare` (which
 * implements `D1Database`), and the same Kysely/codec path the in-Worker recorder uses runs against
 * it. The {@link ResolvedActor} is merged in, with its correlation metadata under the caller's own.
 *
 * Like the in-Worker recorder, this is **non-fatal**: a write failure is logged, never thrown, so an
 * audit write never breaks the command it records.
 */
export async function emitFromCLI(
  d1: D1Database,
  event: CliAuditEvent,
  actor: ResolvedActor,
  options?: AuditRecorderOptions,
): Promise<void> {
  // `environment` is an origin field, not an event field — pulled off here so it reaches the origin
  // rather than `AuditEvent`, which has no such key and would drop it silently.
  const { environment, ...rest } = event;
  const merged: AuditEventInput = {
    ...rest,
    actorType: actor.actorType,
    actorId: actor.actorId,
    // The caller's metadata wins on a key clash; the actor's correlation fields fill in the rest.
    metadata: { ...actor.metadata, ...(event.metadata ?? {}) },
  };
  const origin =
    environment === undefined
      ? options?.origin
      : {
          project: options?.origin?.project ?? null,
          environment,
          worker: options?.origin?.worker ?? null,
          version: options?.origin?.version ?? null,
        };
  await recordAuditEvent(auditDatabase(d1), merged, { ...options, ...(origin ? { origin } : {}) });
}
