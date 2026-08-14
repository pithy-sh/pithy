// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DevSecretsSeedReport } from "./seed";

/**
 * What a seeding run says out loud — shared by `pithy add`, `pithy seed`, and `pithy dev`, so the same
 * state reads identically whichever command reached it.
 *
 * **Silence is the default.** A run that seeded nothing new says nothing: `pithy dev` seeds on every
 * start, and a line per start about secrets that have not changed since last week is noise that trains
 * people to skip the block where the one real problem eventually appears. Only what this run *changed*,
 * and what stopped it from running at all, gets a line.
 *
 * **`missing` and `undeclared` are deliberately not among them.** Both are standing states rather than
 * run outcomes, and both were wrong here for the same reason twice over. `missing`: auth declares four
 * OAuth credential pairs and almost every project sets none, so naming them put four names in front of
 * every `pithy dev` and every `pithy seed`, forever, about nothing that had changed. `undeclared`: this
 * runs inside `pithy add`, which has just rewritten `pithy.config.ts` — and the process is still holding
 * the module it imported before that write, so `pithy add auth` reported the value it had itself just
 * minted as one no capability declares. A snapshot taken mid-change is not a standing state.
 * `pithy doctor` loads the config fresh, in its own process, and is where both of those live.
 *
 * **A value never appears here.** Names only — these lines reach a terminal scrollback and `logs/dev.log`.
 */
export function renderDevSecretsNotes(report: DevSecretsSeedReport): string[] {
  const lines: string[] = [];
  // The path, not the file's name. It is outside the checkout now (#156), so "minted into
  // secrets.jsonc" names nothing the reader can open — and a project whose name collides with
  // another's is only visible from the whole path.
  if (report.minted.length > 0) {
    lines.push(`Minted ${list(report.minted)} into ${report.path ?? "the dev secrets file"}. Local only.`);
  }
  // Before the mints and the seeds, because it is about bytes that were already there. An adopter
  // reading this block wants to know what changed in the file they maintain before what was added to it.
  if ((report.migrated ?? []).length > 0) {
    lines.push(
      `Restated ${list(report.migrated ?? [])} in ${report.path ?? "the dev secrets file"}: the file states the value its destination receives.`,
    );
  }
  if (report.seeded.length > 0) {
    lines.push(`Seeded ${list(report.seeded)} into the local secrets store.`);
  }
  for (const { worker, reason } of report.skipped) {
    lines.push(`${worker}: secrets not seeded. ${reason}`);
  }
  // These describe a `cf-secrets-store` value that is in the file and still will not reach a Worker —
  // its binding is the only place it is ever read from. They are run outcomes, not standing states: a
  // project with none hears nothing, and a project with any hears it every run until it is fixed.
  lines.push(
    ...renderDevVarsNotes({
      refused: report.devVarsRefused ?? [],
      ...(report.relinked !== undefined ? { relinked: report.relinked } : {}),
    }),
  );
  return lines;
}

/** The two ways a generated `.dev.vars` is worth a sentence. Structurally a {@link WriteDevVarsResult}. */
export interface DevVarsDelivery {
  /**
   * One sentence per value or Worker directory that did not get one — a value no quoting survives, a
   * `.dev.vars` pithy did not generate, a directory it may not write into. Already actionable.
   */
  refused: readonly string[];
  /** Worker directories whose `.dev.vars` was a symlink from the old shared-file design, now a real file. */
  relinked?: readonly string[];
}

/**
 * What one `.dev.vars` generation says out loud.
 *
 * **Shared, because a caller that reads only `refused` puts the defect back.** `writeDevVars` grew a
 * delivery report to end a run claiming a value had arrived when it had not; `pithy add`'s two direct
 * calls then took `.refused` off the result and dropped the rest, so `pithy add secrets` printed "Minted
 * a dev master key" while the Worker answered `Missing required bindings`. One renderer means the next
 * caller gets every list by taking the only thing there is to take.
 *
 * **Silence for the ordinary run.** `generated` and `unchanged` say nothing: a file rewritten with the
 * same three bindings on every `pithy dev` is not news, and a line per Worker per start is how a block
 * stops being read.
 *
 * A value never appears here. Names and directories only — these lines reach a terminal scrollback.
 */
export function renderDevVarsNotes(delivery: DevVarsDelivery): string[] {
  const lines = [...delivery.refused];
  for (const dir of delivery.relinked ?? []) {
    lines.push(
      `${dir}/.dev.vars was a symlink at the project's shared file. It is a generated file now — put anything you kept in that shared file into .dev.vars.local.`,
    );
  }
  return lines;
}

/** `a`, `a and b`, `a, b and c` — a sentence, not a JSON array. */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
