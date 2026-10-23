// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowBinding } from "@pithy-sh/core/src/workflow/spec";
import { AuthPurgeParams } from "./specs";

/**
 * Starting one account's purge, from either door (#622) — a hard deletion's route and the daily pass.
 *
 * **Under an id the deletion names, so two starts of one purge are one instance.** A hard deletion repeated, a
 * hard deletion the daily pass also finds due, a `start` step the pass retries: each asks for the same
 * instance, and Cloudflare holds one instance per id, so the second `create` is refused and nothing runs
 * twice. Two purges of one account running at once would both pass `due` and both reach the mail.
 *
 * **The id is the account, the deletion's start, and the UTC day of the start.** The account and the deletion,
 * so a restored and re-deleted account is a different purge. The day, because the daily pass is the outer
 * retry (`./retryPolicy.ts`): an instance that failed keeps its id, and a purge started under the same id
 * forever could never be started again. So tomorrow's pass gets a fresh instance for an account still due,
 * and every start within one day is the same one. Two instances of one purge can overlap only across a day
 * boundary, while the first is still retrying; `complete` then records, audits and fires once whatever
 * overlaps (`../lifecycle/transitions.ts`).
 *
 * **Hashed.** An instance id is at most 100 characters of `[A-Za-z0-9_-]`, and a user id is up to 255 of
 * anything. A SHA-256 of the pair keeps the id inside the rule and says nothing about the account.
 */

/** What starting a purge needs to know. */
export interface PurgeStart {
  /** The account. */
  readonly userId: string;
  /** The deletion it is purged under — its start, ms-epoch. */
  readonly deletedAt: number;
  /** A hard deletion's `notify`, when it named one. The deletion's row carries it too. */
  readonly notify?: boolean;
  /** Now, for the day the id is named for. */
  readonly at: Date;
}

/** The instance id of one purge, on one day. Deterministic: the same start always names the same instance. */
export async function purgeInstanceId(start: Pick<PurgeStart, "userId" | "deletedAt" | "at">): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${start.userId}\n${start.deletedAt}`));
  const hex = Array.from(new Uint8Array(digest).slice(0, 20), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const day = start.at.toISOString().slice(0, 10).replaceAll("-", "");
  return `auth-purge-${hex}-${day}`;
}

/** The half of a Workflow binding that looks an instance up — present on the real one, resolving when it exists. */
interface InstanceLookup {
  get(id: string): Promise<unknown>;
}

function canLookUp(binding: WorkflowBinding): binding is WorkflowBinding & InstanceLookup {
  return typeof (binding as Partial<InstanceLookup>).get === "function";
}

/**
 * Start one purge, or find it started. A `create` refused because the id is taken is a purge already started,
 * so this asks the binding for the instance and succeeds when it is there. Any other failure is thrown, for the
 * caller to report as `pending`. The parameters are the job's own schema, parsed.
 */
export async function startPurgeInstance(binding: WorkflowBinding, start: PurgeStart): Promise<void> {
  const id = await purgeInstanceId(start);
  const params = AuthPurgeParams.parse({
    userId: start.userId,
    ...(start.notify === undefined ? {} : { notify: start.notify }),
  });
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
