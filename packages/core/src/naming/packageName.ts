// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package a bare specifier names: `@pithy-sh/payments` from `@pithy-sh/payments/src/capability`, and
 * `stripe` from `stripe/lib/x` — **scope-aware, and the only copy in the kit (#709)**.
 *
 * There were five. Three took the first segment or two depending on a leading `@`; two took the first two
 * segments whatever they were, which is right for every `@pithy-sh/*` name they were written against and
 * wrong for the first unscoped dependency anyone passed them. A rule that small drifts precisely because
 * nobody thinks it needs a home, so it has one. That it is the only copy is a gate, not a claim: `packages/cli/src/ci/packageOfCopies.test.ts` fails on any source that writes the rule out by hand, because the first migration left three behind and said it had not.
 *
 * Total, and deliberately unopinionated about what it is handed: a caller with a relative path, a `#`
 * import or a URL gets the first segment back. Deciding whether a specifier is a package at all is the
 * unresolved-import classifier's job (`error/unresolved.ts`), not this function's.
 */
export function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}
