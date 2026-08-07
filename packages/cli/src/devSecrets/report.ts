// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DEV_SECRETS_FILE } from "@pithy-sh/secrets/src/dev/devSecretsFile";
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
  if (report.minted.length > 0) {
    lines.push(`Minted ${list(report.minted)} into ${DEV_SECRETS_FILE}. Local only.`);
  }
  if (report.seeded.length > 0) {
    lines.push(`Seeded ${list(report.seeded)} into the local secrets store.`);
  }
  for (const { worker, reason } of report.skipped) {
    lines.push(`${worker}: secrets not seeded. ${reason}`);
  }
  // Both of these describe a value that is in the file, is in the store, and still will not resolve in
  // dev — which until #153 is the only thing that matters. They are run outcomes, not standing states:
  // a project with neither hears nothing, and a project with either hears it every run until it is fixed.
  for (const reason of report.devVarsRefused ?? []) lines.push(reason);
  for (const dir of report.shadowed ?? []) {
    lines.push(`${dir} has a .dev.vars of its own. wrangler reads that one, so nothing seeded reaches it.`);
  }
  // Last, and never silent. A refusal is the one line here that describes something the adopter has to
  // do before the command can finish its job — every other line reports work already done.
  if (report.refused) lines.push(report.refused);
  return lines;
}

/** `a`, `a and b`, `a, b and c` — a sentence, not a JSON array. */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
