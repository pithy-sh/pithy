// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCommand } from "citty";
import { adoptRefusals, adoptSafeToRemove, renderAdoptText, runAdopt } from "../adopt/adopt";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy adopt` (docs/CLI.md §5.8): the sort `pithy doctor` reports, performed.
 *
 * **The plan is announced before the writes happen, not after them.** `runAdopt` calls back through
 * `onPlan` once the plan is built and before a byte is written, and this writes to stdout there — so a
 * run interrupted mid-write has already told the operator what it was doing.
 *
 * **A dry run is the default and there is no prompt.** `pithy adopt` prints the plan and touches nothing;
 * `--apply` performs it. A confirmation an agent cannot answer would be a command an agent cannot run,
 * and the two-invocation shape reads identically in a terminal and in CI.
 *
 * **A refusal fails the exit.** A conflicting value or one this command could not place is drift a script
 * has to notice: everything else moved, and the two or three that did not are still in the checkout with
 * nothing but this exit code to say so. `leave` — a key nothing composes — is not a refusal and does not
 * gate: it is the ordinary residue of an old project, and it is the adopter's to delete.
 *
 * **The `--json` payload is written out key by key here**, rather than assembled by a renderer and spread
 * in. That is what puts it inside `doctorDocs.test.ts`'s reach: the gate reads the object literal at this
 * call site and holds §5.8 to naming every field of it. A payload built by spreading a typed object is
 * invisible to that scan, which the gate says outright — and the whole point of documenting this command
 * there is that the document cannot half-describe it.
 */
export default defineCommand({
  meta: { name: "adopt", description: "Copy stray dev values to where the current layout keeps them" },
  args: {
    apply: { type: "boolean", default: false, description: "Perform the plan (default: print it and write nothing)" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const result = await runAdopt({
        projectDir: process.cwd(),
        apply: args.apply,
        // Announced before the write, and only when there is a write to announce. `--json` is one object
        // on one line, so it has nowhere to put a second document and prints the outcome only.
        ...(args.apply && !args.json
          ? { onPlan: () => process.stdout.write("\nAdopting. Nothing is deleted from any source file.\n") }
          : {}),
      });

      if (args.json) {
        const payload = formatJsonLine({
          command: "adopt",
          project: result.project,
          applied: result.applied,
          entries: result.entries,
          safeToRemove: adoptSafeToRemove(result),
          refused: adoptRefusals(result).map(refusedLine),
        });
        process.stdout.write(`${payload}\n`);
      } else {
        process.stdout.write(renderAdoptText(result));
        if (result.applied && result.entries.length > 0) process.stdout.write(`${formatDone()}\n`);
      }

      if (adoptRefusals(result).length > 0) process.exit(1);
    }),
});

/** One refused value, as the source line that identifies it. Never a value, on the failure path either. */
function refusedLine(entry: { source: string; key: string }): { file: string; key: string } {
  return { file: entry.source, key: entry.key };
}
