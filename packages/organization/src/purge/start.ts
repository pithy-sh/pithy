// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowBinding } from "@pithy-sh/core/src/workflow/spec";
import { OrganizationPurgeParams } from "./specs";

/**
 * Starting one organization's purge, from either door (#623) — a hard deletion's route and the daily pass.
 *
 * **Under an id the deletion names, so two starts of one purge are one instance** — the rule `@pithy-sh/auth`'s
 * purge start holds for an account (`@pithy-sh/auth/src/purge/start.ts`), for the same reasons: the organization
 * and the deletion's start, so a restored and re-deleted organization is a different purge, and the UTC day, so
 * an instance that failed can be started again by tomorrow's pass. Hashed, to stay inside the platform's
 * 100-character `[A-Za-z0-9_-]` rule.
 */

/** What starting a purge needs to know. */
export interface OrganizationPurgeStart {
  /** The organization. */
  readonly organizationId: string;
  /** The deletion it is purged under — its start, ms-epoch. */
  readonly deletedAt: number;
  /** Now, for the day the id is named for. */
  readonly at: Date;
}

/** The instance id of one purge, on one day. Deterministic: the same start always names the same instance. */
export async function organizationPurgeInstanceId(start: OrganizationPurgeStart): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${start.organizationId}\n${start.deletedAt}`),
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 20), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const day = start.at.toISOString().slice(0, 10).replaceAll("-", "");
  return `organization-purge-${hex}-${day}`;
}

/** The half of a Workflow binding that looks an instance up — present on the real one. */
interface InstanceLookup {
  get(id: string): Promise<unknown>;
}

function canLookUp(binding: WorkflowBinding): binding is WorkflowBinding & InstanceLookup {
  return typeof (binding as Partial<InstanceLookup>).get === "function";
}

/**
 * Start one purge, or find it started. A `create` refused because the id is taken is a purge already started, so
 * this asks the binding for the instance and succeeds when it is there. Any other failure is thrown, for the
 * caller to report as `pending`.
 */
export async function startOrganizationPurgeInstance(
  binding: WorkflowBinding,
  start: OrganizationPurgeStart,
): Promise<void> {
  const id = await organizationPurgeInstanceId(start);
  const params = OrganizationPurgeParams.parse({ organizationId: start.organizationId });
  try {
    await binding.create({ id, params });
  } catch (error) {
    if (canLookUp(binding)) {
      const found = await binding.get(id).then(
        () => true,
        () => false,
      );
      if (found) return;
    }
    throw error;
  }
}
