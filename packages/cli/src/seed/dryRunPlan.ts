// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { emptyPlan, type Plan, type PlanData } from "../plan/plan";
import type { SeedRunReport } from "./run";

/**
 * **`pithy seed --dry-run`, as the one plan every dry run shares (#697).** The seed report already says
 * what each set would write; this restates it as `plan.data`, one entry per table, store, object and
 * asset, and each reset database as a `reset`. A database another environment binds is kept by the reset,
 * and that is a note, not an entry, because nothing is written to it.
 *
 * In `dev` a real run also seeds the dev secrets, which a dry run never does; the plan says so.
 */
export function seedDryRunPlan(report: SeedRunReport): Plan {
  const data: PlanData[] = [];
  const notes: string[] = [];
  for (const entry of report.reset ?? []) {
    if (entry.boundBy !== undefined && entry.boundBy.length > 0) {
      notes.push(
        `${entry.database} (${entry.binding}) is bound by ${entry.boundBy.join(", ")}, so the reset keeps it.`,
      );
      continue;
    }
    data.push({
      store: "d1",
      target: `${entry.database} (${entry.binding})`,
      count: entry.migrations,
      action: "reset",
    });
  }
  for (const { worker, sets } of report.workers) {
    for (const set of sets) {
      for (const d1 of set.d1) {
        data.push({ worker, store: "d1", target: `${d1.database}.${d1.table}`, count: d1.rows, action: "write" });
      }
      for (const kv of set.kv) {
        data.push({ worker, store: "kv", target: `${kv.namespace}/${kv.store}`, count: kv.entries, action: "write" });
      }
      for (const r2 of set.r2) {
        data.push({ worker, store: "r2", target: `${r2.binding}/${r2.key}`, count: 1, action: "write" });
      }
      for (const media of set.media) {
        data.push({ worker, store: "media", target: media.store, count: 1, action: media.action });
      }
    }
  }
  if (report.env === LOCAL_ENVIRONMENT) {
    notes.push(
      "A real run also seeds the project's dev secrets into each Worker's .dev.vars and the local SECRETS store.",
    );
  }
  return { ...emptyPlan(), data, notes };
}
