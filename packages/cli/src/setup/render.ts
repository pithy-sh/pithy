// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative, sep } from "node:path";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { type SetupReport, seedSentences } from "./run";

/**
 * **What a `pithy setup` run says, one line per thing that happened (#764).**
 *
 * Shared with `pithy feature sync`, which runs the same steps and says them the same way. A step that did
 * nothing says nothing, so a second run is two lines: that nothing changed, and what is left that only a
 * person can do.
 */

/** `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A Worker directory as a person reads it: relative to the checkout. */
function shown(projectDir: string, dir: string): string {
  return relative(projectDir, dir).split(sep).join("/") || ".";
}

/**
 * The lines for what a run did. No install line, no next step: those are the command's to say.
 *
 * `feature: true` is `pithy feature sync`'s form, which says its own block's ports and its own verdict on
 * them first: the addresses and the "nothing changed" line are left out, because each is the sync's to say.
 */
export function setupLines(projectDir: string, report: SetupReport, options: { feature?: boolean } = {}): string[] {
  const lines: string[] = [];
  const { secrets, dev } = report;
  if (secrets.minted.length > 0) lines.push(`Minted ${listed(secrets.minted)} into ${secrets.path}.`);
  if (secrets.adopted.length > 0) {
    lines.push(`Carried the ${listed(secrets.adopted)} this machine already had into ${secrets.path}.`);
  }
  if (report.migrations.length > 0) {
    lines.push(`Migrated dev: ${report.migrations.length} applied.`);
  }
  if (options.feature !== true && dev.allocated && dev.dev !== null) {
    for (const [worker, endpoint] of Object.entries(dev.dev.workers)) lines.push(`${worker}: ${endpoint.origin}`);
  }
  if (dev.devVars.length > 0) {
    lines.push(`Generated .dev.vars for ${listed(dev.devVars.map((dir) => shown(projectDir, dir)))}.`);
  }
  if (dev.seededSecrets.length > 0) lines.push(`Seeded ${listed(dev.seededSecrets)} into the local secrets store.`);
  lines.push(...seedSentences(report.seed));
  lines.push(...report.notes);
  if (!report.changed && options.feature !== true) lines.push("Already set up. Nothing changed.");
  return lines;
}

/** One line per secret somebody else issues, each with the command that opens the file it goes in. */
export function externalLines(report: Pick<SetupReport, "external" | "secrets">): string[] {
  if (report.external.length === 0) return [];
  return [
    `Issued by somebody else, so setup cannot supply ${report.external.length === 1 ? "it" : "them"}:`,
    ...report.external.map((name) => `  ${name} — ${commandName("secrets edit")}, into ${report.secrets.path}`),
  ];
}
