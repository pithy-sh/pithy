// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { remedy } from "@pithy-sh/core/src/cli/command";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";

/**
 * **A stanza that already points a binding at a resource other than the one this run names for it.**
 *
 * It happens when a Worker moves between shared and owned: listing a binding in `ownBindings` names that Worker a
 * resource of its own, and the stanza still carries the shared one's id, and the other way round. Rewriting the id
 * silently would move the Worker onto an empty database and leave its rows where they were, so a run is refused
 * unless it passes `--repoint`, and the refusal says the current resource keeps its data.
 */

/** What one binding's entry in a stanza already points at. */
export interface StanzaPointer {
  /** The kind of resource. */
  kind: FeatureResourceKind;
  /** The binding. */
  binding: string;
  /**
   * The identity the entry carries: a D1 `database_id`, a KV namespace `id`, an R2 `bucket_name`, a queue
   * producer's `queue`. Only a real one: a placeholder, an empty string or an absent field points at nothing.
   */
  current: string;
  /** The name the entry states beside the id, where wrangler has a field for it: a D1 `database_name`. */
  currentName?: string;
}

/** One repoint: a Worker's binding, the resource it points at now, and the one this run would point it at. */
export interface ProvisionedRepoint {
  /** The Worker's deploy name. */
  worker: string;
  /** The binding. */
  binding: string;
  /** The kind of resource. */
  kind: FeatureResourceKind;
  /** The resource the stanza points at now: the binding's counterpart, by name. */
  current: string;
  /** The name this run composes for the binding. */
  next: string;
}

/** The parts of a wrangler stanza this reads. */
interface PointerStanza {
  d1_databases?: { binding?: string; database_id?: string; database_name?: string }[];
  kv_namespaces?: { binding?: string; id?: string }[];
  r2_buckets?: { binding?: string; bucket_name?: string }[];
  queues?: { producers?: { binding?: string; queue?: string }[] };
}

/** A value a deploy could address, as `pithy env` reads one: not empty, not `<placeholder>`. */
export function isAddressable(value: string | undefined): value is string {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed !== "" && !/^<.+>$/.test(trimmed) && !/placeholder/i.test(trimmed);
}

/** Every binding in `stanza` that points at a real resource. */
export function stanzaPointers(stanza: unknown): StanzaPointer[] {
  if (typeof stanza !== "object" || stanza === null) return [];
  const read = stanza as PointerStanza;
  const out: StanzaPointer[] = [];
  for (const entry of read.d1_databases ?? []) {
    if (entry.binding && isAddressable(entry.database_id)) {
      out.push({
        kind: "d1",
        binding: entry.binding,
        current: entry.database_id,
        ...(entry.database_name ? { currentName: entry.database_name } : {}),
      });
    }
  }
  for (const entry of read.kv_namespaces ?? []) {
    if (entry.binding && isAddressable(entry.id)) out.push({ kind: "kv", binding: entry.binding, current: entry.id });
  }
  for (const entry of read.r2_buckets ?? []) {
    if (entry.binding && isAddressable(entry.bucket_name)) {
      out.push({ kind: "r2", binding: entry.binding, current: entry.bucket_name });
    }
  }
  for (const entry of read.queues?.producers ?? []) {
    if (entry.binding && isAddressable(entry.queue))
      out.push({ kind: "queue", binding: entry.binding, current: entry.queue });
  }
  return out;
}

/**
 * Whether a pointer addresses the binding's **counterpart**: the resource the binding would have under the other
 * ownership — the shared one for a Worker that now owns the binding, its own for a Worker that now shares it. That
 * is a move between shared and owned, and the one thing a repoint is.
 *
 * An R2 bucket and a queue are addressed by name, so the name is compared. A D1 database and a KV namespace by id,
 * so the id the account answers for the counterpart's name is compared — unless the D1 entry states its name, which
 * is compared instead. Anything else a stanza points at — a database since deleted, another account's id — is not a
 * move this run can name, and is written over as it always was.
 */
export function pointsAtCounterpart(
  pointer: StanzaPointer,
  counterpart: { name: string; foundId: string | null },
): boolean {
  if (pointer.kind === "r2" || pointer.kind === "queue") return pointer.current === counterpart.name;
  if (pointer.currentName !== undefined) return pointer.currentName === counterpart.name;
  return counterpart.foundId !== null && pointer.current === counterpart.foundId;
}

/**
 * The refusal for a run that would repoint without `--repoint`, naming every one. `productionEnvironments` decides
 * whether the rerun is a command or a person's decision, as every provision remedy does.
 */
export function repointRefusal(
  env: string,
  repoints: readonly ProvisionedRepoint[],
  productionEnvironments: readonly string[] = [],
): ValidationError {
  const rerun = remedy(
    "provision",
    { flags: { "--env": env, "--yes": true, "--repoint": true } },
    { productionEnvironments },
  );
  const lines = repoints.map(
    (repoint) =>
      `${repoint.worker}'s ${repoint.binding} points at ${repoint.current}. This run names ${repoint.next}. ${repoint.current} keeps its data.`,
  );
  return new ValidationError({
    message: lines.join(" "),
    action: `Move the data yourself if it should follow. ${rerun.say((command) => `Then run ${command}.`)} Or put ownBindings back the way it was.`,
    detail: `${repoints.length} binding${repoints.length === 1 ? "" : "s"} would change resource in env.${env}.`,
  });
}
