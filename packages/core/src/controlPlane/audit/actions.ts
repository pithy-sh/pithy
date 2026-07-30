import type { AuditEventInput } from "../../audit/auditEvent";
import type { AuditEmit } from "../../audit/recorder";
import type { Logger } from "../../logger/logger";

/**
 * The audit action codes the `control-plane` seam emits, as `domain/reason` strings under the
 * `controlplane` domain.
 *
 * **The domain is one word on purpose.** `AuditAction`'s pattern allows no hyphen, so
 * `control-plane/call_allowed` is not a valid code at all. The route-strategy literal stays
 * `control-plane`; every namespace token — capability, migrations, table prefix, error codes, these
 * actions — is `controlplane`. The audit *actor kind* is the hyphenated `"control-plane"`, because
 * that is an enum member and not a namespace. (None of this is Cloudflare's control plane; that is the
 * outbound provisioning API behind `@pithy-sh/cloudflare`.)
 *
 * These are declared as a plain `as const` map rather than through `@pithy-sh/audit`'s
 * `defineAuditActions`, because audit already depends on core — importing it back would be a cycle.
 * `actions.test.ts` asserts every value against core's `AuditAction` pattern instead, so the map is
 * held to the same contract the helper would have enforced.
 *
 * Emission goes through core's `emit` seam (`c.var.emit`), a no-op when the audit capability is
 * absent, so the seam never imports audit at runtime either (principle 4).
 */
export const ControlPlaneAuditActions = {
  /** A verified, in-scope management call was admitted. The trail of what the dashboard actually did. */
  callAllowed: "controlplane/call_allowed",
  /** A management call was refused — no connection, bad credential, or an ungranted scope. Outcome `denied`. */
  callDenied: "controlplane/call_denied",
  /** A new public key was registered on a connection, opening a rotation overlap. */
  keyRegistered: "controlplane/key_registered",
  /** A superseded public key was given an end date and stopped being accepted. */
  keyExpired: "controlplane/key_expired",
  /** A management client was connected to this environment for the first time. */
  connectionRegistered: "controlplane/connection_registered",
  /** An existing connection changed — its granted scopes, or the Worker URL it is pointed at. */
  connectionUpdated: "controlplane/connection_updated",
  /** A connection was removed. The seam returns to its shipped state: connected to nothing, denying everything. */
  connectionRemoved: "controlplane/connection_removed",
} as const;

/** One of the control-plane audit action codes. */
export type ControlPlaneAuditAction = (typeof ControlPlaneAuditActions)[keyof typeof ControlPlaneAuditActions];

/**
 * Emit an audit event and swallow any failure.
 *
 * **Every denial emits an event, and that is exactly why this cannot throw.** By the time the seam
 * records a call, the security-relevant outcome is already decided — the 401 or 403 is going out
 * whatever happens next. An audit write that threw would convert a correct denial into a 500: it would
 * hand the caller a different response for a *failing* store than for a healthy one, and turn a
 * transient D1 problem into an availability bug on the admin surface. The record is evidence of the
 * decision, never part of making it.
 *
 * The real recorder is non-fatal by contract already ({@link AuditEmit}), so this is belt and braces —
 * but the gate is a security boundary and does not get to assume its collaborators behave. The failure
 * is logged when a logger is at hand, so a store that has stopped accepting writes is visible rather
 * than silent.
 */
export async function safeEmit(emit: AuditEmit, event: AuditEventInput, log?: Logger): Promise<void> {
  try {
    await emit(event);
  } catch (error) {
    log?.warn("control-plane audit event dropped", { action: event.action, error });
  }
}
