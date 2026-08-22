// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Finding } from "./audit";

/**
 * One finding as a single line: what is wrong, and enough to act on it.
 *
 * These lines are the whole of the gate's user interface — when CI fails, this is all a developer
 * gets. So each one names its subject (a path, or the package when there is no file yet) and says
 * what to do, and none of them wraps.
 */
/**
 * Can `--fix` repair this on its own?
 *
 * The action line is a contract (CLAUDE.md §CLI): pointing a developer at `--fix` for a finding it
 * cannot touch sends them to a command that prints "Nothing to do." and exits 0 while the gate stays
 * red. Only headers and an absent LICENSE are repairable — a drifted license body, an undeclared or
 * unknown license, and a stamped template all need a person.
 */
export function isFixable(finding: Finding): boolean {
  return (
    finding.kind === "missing-header" || finding.kind === "wrong-header" || finding.kind === "missing-license-file"
  );
}

export function describeFinding(finding: Finding): string {
  switch (finding.kind) {
    case "missing-license-field":
      return `${finding.package} — package.json declares no license.`;
    case "unknown-license":
      return `${finding.package} — declares ${finding.license}, which has no canonical text here.`;
    case "missing-license-file":
      return `${finding.path} — missing. ${finding.package} ships no license text.`;
    case "license-file-mismatch":
      return `${finding.path} — text is not the ${finding.package} license. Reconcile it by hand.`;
    case "missing-header":
      return `${finding.path} — no SPDX header. Expected ${finding.expected}.`;
    case "wrong-header":
      return `${finding.path} — declares ${finding.actual}, package is ${finding.expected}.`;
    case "unexpected-header":
      return `${finding.path} — scaffolded template carries an SPDX header. It becomes the adopter's file.`;
  }
}
