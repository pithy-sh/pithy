// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { applyFixes, audit, fixFiles } from "./audit";
import { describeFinding, isFixable } from "./describeFinding";

/** What a run produced: what to print, and what to exit with. */
export interface Result {
  /** `0` clean, `1` findings, `2` bad usage. */
  code: number;
  /** Everything to print. No trailing newline. */
  output: string;
}

const USAGE = [
  "License headers and LICENSE files.",
  "",
  "  --check            Report every problem. Exit 1 if there are any. The CI gate.",
  "  --fix [paths...]   Stamp missing headers and write absent LICENSE files.",
  "                     With paths, touch only those — how lint-staged calls it.",
  "  --help             This.",
].join("\n");

/**
 * Run the tool against the repo at `root`.
 *
 * Returns rather than calling `process.exit` so every path is testable; the entry point is what
 * turns a {@link Result} into an exit code.
 */
export function run(argv: string[], root: string): Result {
  if (argv.includes("--help")) return { code: 0, output: USAGE };

  const fix = argv.includes("--fix");
  const paths = argv.filter((arg) => !arg.startsWith("--"));
  const unknown = argv.filter((arg) => arg.startsWith("--") && !["--check", "--fix", "--help"].includes(arg));
  if (unknown.length > 0) {
    return { code: 2, output: `Unknown flag: ${unknown.join(", ")}.\n\n${USAGE}` };
  }

  if (fix) {
    const changed = paths.length > 0 ? fixFiles(root, paths) : applyFixes(root);
    if (changed.length === 0) return { code: 0, output: "Nothing to do." };
    return { code: 0, output: `${changed.join("\n")}\n\nStamped ${changed.length}.` };
  }

  const findings = audit(root);
  if (findings.length === 0) return { code: 0, output: "Done." };

  const fixable = findings.filter(isFixable).length;
  const action = fixable === 0 ? "None can be fixed automatically." : `Run with --fix to repair ${fixable}.`;

  return {
    code: 1,
    output: `${findings.map(describeFinding).join("\n")}\n\n${findings.length} problem(s). ${action}`,
  };
}
