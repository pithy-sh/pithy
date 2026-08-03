// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ResolvedSeedSet } from "@pithy-sh/core/src/seed/compose";
import type { MediaSeedItem } from "@pithy-sh/core/src/seed/seed";

/**
 * The `--dry-run` write plan: what `pithy seed` **would** write, computed from the composed sets alone
 * with no mutation. Emitted as `--json` so a human or an agent can review a run — especially against
 * staging/prod — before authorizing it. Row and entry counts come straight from the fixtures;
 * per-asset media actions come from an optional resolver (the CLI passes one that reads each item's
 * sidecar), defaulting to the action a first run would take.
 */

/** One table's line in the plan: which table in which database, and how many rows would be written. */
export interface SeedPlanD1Entry {
  /** The named database the table lives in. */
  database: string;
  /** The table that would be seeded. */
  table: string;
  /** The number of rows the fixture would write (idempotent — existing rows are ignored). */
  rows: number;
}

/** One store's line in the plan: which store in which namespace, and how many entries would be written. */
export interface SeedPlanKvEntry {
  /** The named KV namespace the store lives in. */
  namespace: string;
  /** The store that would be seeded. */
  store: string;
  /** The number of entries the fixture would write. */
  entries: number;
}

/** One object's line in the plan: the bucket binding and key that would be written. */
export interface SeedPlanR2Entry {
  /** The R2 binding the object would be written to. */
  binding: string;
  /** The object key. */
  key: string;
}

/**
 * What a media item would do on this run: `upload` (a `once` asset with no recorded UUID yet),
 * `skip` (a `once` asset already uploaded — its UUID is on record), or `reupload` (an `always` asset,
 * re-sent every run).
 */
export type SeedPlanMediaAction = "upload" | "skip" | "reupload";

/** One asset's line in the plan: the store, its mode, the action, and the recorded UUID if any. */
export interface SeedPlanMediaEntry {
  /** The shared asset store the item targets. */
  store: MediaSeedItem["store"];
  /** The item's upload policy. */
  mode: MediaSeedItem["mode"];
  /** What this run would do for the item. */
  action: SeedPlanMediaAction;
  /** The already-minted asset UUID, when the sidecar records one (a `skip`). */
  id?: string;
}

/** One set's slice of the plan: its namespaced name and the writes it would make, per backend. */
export interface SeedPlanSet {
  /** The set's namespaced, order-prefixed key (`NNNN_<capability>_<name>`). */
  name: string;
  /** The D1 tables this set would write. */
  d1: SeedPlanD1Entry[];
  /** The KV stores this set would write. */
  kv: SeedPlanKvEntry[];
  /** The R2 objects this set would write. */
  r2: SeedPlanR2Entry[];
  /** The media assets this set would upload. */
  media: SeedPlanMediaEntry[];
}

/** The complete dry-run plan for one environment. Serialized verbatim as the `--json` output. */
export interface SeedPlan {
  /** The command that produced the plan. */
  command: "seed";
  /** The environment the plan targets. */
  env: string;
  /** Always `true` — a plan never writes. */
  dryRun: true;
  /** The per-set plan, in run order. */
  sets: SeedPlanSet[];
}

/**
 * Resolve what a media item would do this run. The CLI passes an implementation that reads the item's
 * `ref` sidecar; the default assumes a first run (a `once` item uploads, an `always` item re-uploads).
 */
export type MediaStateResolver = (item: MediaSeedItem) => { action: SeedPlanMediaAction; id?: string };

/** The default media state: a first run — `once` uploads, `always` re-uploads, nothing recorded yet. */
const firstRunMediaState: MediaStateResolver = (item) => ({
  action: item.mode === "always" ? "reupload" : "upload",
});

/**
 * Assemble the dry-run write plan from the composed, ordered sets — pure, with no backend access. Row
 * and entry counts are read from the fixtures; media actions come from `resolveMedia` (default: a
 * first-run state). The result is the exact shape `pithy seed --dry-run --json` prints.
 */
export function buildDryRunPlan(
  env: string,
  sets: readonly ResolvedSeedSet[],
  resolveMedia: MediaStateResolver = firstRunMediaState,
): SeedPlan {
  return {
    command: "seed",
    env,
    dryRun: true,
    sets: sets.map((resolved) => ({
      name: resolved.key,
      d1: (resolved.set.d1 ?? []).map((group) => ({
        database: group.database,
        table: group.table,
        rows: group.rows.length,
      })),
      kv: (resolved.set.kv ?? []).map((group) => ({
        namespace: group.namespace,
        store: group.store,
        entries: group.entries.length,
      })),
      r2: (resolved.set.r2 ?? []).map((item) => ({ binding: item.binding, key: item.key })),
      media: (resolved.set.media ?? []).map((item) => {
        const state = resolveMedia(item);
        return {
          store: item.store,
          mode: item.mode,
          action: state.action,
          ...(state.id !== undefined ? { id: state.id } : {}),
        };
      }),
    })),
  };
}
