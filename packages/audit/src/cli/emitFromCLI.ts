import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { auditDatabase } from "../data/tables";
import { type AuditRecorderOptions, recordAuditEvent } from "../recorder";
import type { ResolvedActor } from "./resolveActor";

/**
 * The event an `emitFromCLI` caller supplies — every audit field except the actor, which comes from
 * {@link ResolvedActor} (resolved from the CF token, not the caller). The CLI describes *what*
 * happened; the resolver decides *who*.
 */
export type CliAuditEvent = Omit<AuditEventInput, "actorType" | "actorId">;

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
  const merged: AuditEventInput = {
    ...event,
    actorType: actor.actorType,
    actorId: actor.actorId,
    // The caller's metadata wins on a key clash; the actor's correlation fields fill in the rest.
    metadata: { ...actor.metadata, ...(event.metadata ?? {}) },
  };
  await recordAuditEvent(auditDatabase(d1), merged, options);
}
