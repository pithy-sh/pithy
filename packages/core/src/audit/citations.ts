// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "../capability/capability";

/**
 * **Citing the trail (#823): which recorded events name a resource, and where each sits in its chain.**
 *
 * An erasure attestation proves a purge happened by pointing at the audit events the purge wrote, by event id and
 * chain position. The chain (#822) is what makes those events tamper-evident, so the attestation adds no second
 * integrity mechanism: it cites, and an auditor checks the citation with `pithy audit verify`.
 *
 * Reading the trail is `@pithy-sh/audit`'s, and nothing may import it (principle 4). So, like
 * {@link Capability.auditRecorder}, the audit capability declares a reader built from the env, and
 * {@link composedAuditCitations} finds it among the composed capabilities. With no audit composed there is no
 * trail to cite, and the answer is `null` rather than an empty list: *nothing recorded* and *no recorder* are two
 * different facts, and an attestation must say which.
 */

/** Which events to cite: one kind of resource, some of its ids, and the actions that matter. */
export interface AuditCitationQuery {
  /** The `resourceType` the events were recorded against — `user`, `organization`. */
  readonly resourceType: string;
  /** The resource ids. Every event for any of them, among {@link actions}. */
  readonly resourceIds: readonly string[];
  /** The `domain/reason` actions to cite. Every other action on the resource is left out. */
  readonly actions: readonly string[];
}

/** One recorded event, as an attestation cites it: never its personal values, only where it is. */
export interface AuditCitation {
  /** The event's stable public id. */
  readonly eventId: string;
  /** The `domain/reason` action. */
  readonly action: string;
  /** The resource it was recorded against. */
  readonly resourceId: string;
  /** When it happened. */
  readonly occurredAt: Date;
  /** The tenant whose chain it is in, or null for the untenanted chain. */
  readonly tenant: string | null;
  /** Its 1-based position in that chain, or null for an event recorded before the chain began. */
  readonly seq: number | null;
  /** Its chain hash, or null before the chain. */
  readonly hash: string | null;
  /** The `step` its metadata names, when it names one as a string — which purge step the event records. */
  readonly step: string | null;
}

/** Read the citations for one query, oldest first. */
export type AuditCitationReader = (query: AuditCitationQuery) => Promise<AuditCitation[]>;

/**
 * The composed audit capability's citation reader over this env, or `null` when no capability provides one — no
 * audit is composed, so there is no trail to cite.
 */
export function composedAuditCitations(
  capabilities: readonly Capability[],
  env: Record<string, unknown>,
): AuditCitationReader | null {
  const provider = capabilities.find((capability) => capability.auditCitations !== undefined);
  return provider?.auditCitations ? provider.auditCitations(env) : null;
}
