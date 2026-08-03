// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { isReservedProjectName, RESERVED_TEST_PREFIX, resourceName } from "@pithy-sh/core/src/naming/resource";
import { workflowHostName, workflowScriptName } from "@pithy-sh/core/src/workflow/naming";
import { describe, expect, it } from "vitest";
import { RESERVED_TEST_PROJECT, uniqueName } from "./harness";

/**
 * The reservation, proved in both directions.
 *
 * `pithy-int-` is only worth anything if two statements hold at once, and each is useless without the
 * other:
 *
 * 1. **Nothing real lands inside it.** If a project a human could plausibly name produced
 *    `pithy-int-…` resources, the reaper — which deletes on prefix alone — would eventually delete a
 *    customer's database. This is the safety direction.
 * 2. **Everything under the reserved project lands inside it.** If a live test could create a resource
 *    outside the namespace, the reaper cannot see it and debris accumulates on a real account
 *    indefinitely. This is the hygiene direction, and it is the one that was actually failing.
 *
 * Both reduce to the same structural fact: `<project>-<env>-<thing>` puts the project first and takes it
 * **verbatim** (`resource.ts` refuses to hash it, precisely so a prefix filter means what it says). So
 * the prefix of every generated name is decided by the project name and nothing else, and the whole
 * reservation is enforceable at one point — the guard on `pithy init`.
 */

/** Environments a name is composed for. `global` is the scope-wide slot, not an omission. */
const ENVIRONMENTS = ["dev", "staging", "production", "feature", "global"] as const;

/** A spread of the `thing` segment: capability, binding, secret, token profile, and an over-long one. */
const THINGS = [
  "db",
  "sessions",
  "media-images",
  "secrets-encryption-keys",
  "secrets-manager-cf-api-token",
  "an-extremely-long-thing-segment-that-will-certainly-be-truncated",
] as const;

/**
 * The rule the `pithy init` guard has to enforce is `isReservedProjectName`, in `@pithy-sh/core` beside
 * the composer — one predicate, exercised here against the names the composer actually produces and used
 * verbatim by `scaffoldProject`. Its own unit tests cover the two traps in it (a name that only *kebabs*
 * into the reservation, and the bare `pithy-int` the composer's trailing hyphen puts inside it).
 */
describe("no name a real project generates falls inside the reservation", () => {
  const ACCEPTABLE = [
    "acme",
    "pithy",
    "pithy-app",
    "pithysh",
    "pithy-internal",
    "pithy-integration",
    "pithy-interview-tool",
    "int",
    "my-pithy-int-app",
    "Acme Corp",
    "PITHY",
  ] as const;

  it.each(ACCEPTABLE)("`%s` is a project name the guard must accept", (project) => {
    expect(isReservedProjectName(project)).toBe(false);
  });

  it.each(ACCEPTABLE)("`%s` never composes a reserved resource name", (project) => {
    for (const env of ENVIRONMENTS) {
      for (const thing of THINGS) {
        expect(resourceName({ project, env, thing }).startsWith(RESERVED_TEST_PREFIX)).toBe(false);
      }
    }
  });

  it.each(["acme", "pithy", "pithy-app", "pithysh", "pithy-internal", "int"])(
    "`%s` never composes a reserved workflow or host name",
    (project) => {
      for (const env of ["dev", "staging", "production"]) {
        expect(workflowHostName({ project, capability: "email", env }).startsWith(RESERVED_TEST_PREFIX)).toBe(false);
        expect(
          workflowScriptName({ project, capability: "email", job: "send", env }).startsWith(RESERVED_TEST_PREFIX),
        ).toBe(false);
      }
    },
  );

  it.each(["pithy-int", "pithy-int-test", "pithy-int-anything", "Pithy Int Ruse", "PITHY_INT_x"])(
    "`%s` is reserved, so the guard must reject it",
    (project) => {
      expect(isReservedProjectName(project)).toBe(true);
    },
  );

  it("rejects on the kebabbed form, because that is what the composer uses", () => {
    // The trap: neither of these *looks* reserved, and both generate reserved names.
    expect(resourceName({ project: "Pithy Int Ruse", env: "production", thing: "db" })).toMatch(/^pithy-int-/);
    expect(resourceName({ project: "pithy-int", env: "production", thing: "db" })).toMatch(/^pithy-int-/);
  });
});

describe("every name the reserved project generates falls inside the reservation", () => {
  it("composes reserved resource names for every environment and thing", () => {
    for (const env of ENVIRONMENTS) {
      for (const thing of THINGS) {
        const name = resourceName({ project: RESERVED_TEST_PROJECT, env, thing });
        expect(name.startsWith(RESERVED_TEST_PREFIX)).toBe(true);
      }
    }
  });

  it("composes reserved workflow host and script names", () => {
    for (const env of ["dev", "staging", "production"]) {
      expect(workflowHostName({ project: RESERVED_TEST_PROJECT, capability: "email", env })).toMatch(/^pithy-int-/);
      expect(workflowScriptName({ project: RESERVED_TEST_PROJECT, capability: "email", job: "send", env })).toMatch(
        /^pithy-int-/,
      );
    }
  });

  it("composes reserved throwaway names, whatever the label", () => {
    for (const label of ["kv", "d1", "r2", "vectorize-index", "some very long label indeed"]) {
      expect(uniqueName(label).startsWith(RESERVED_TEST_PREFIX)).toBe(true);
    }
  });

  it("truncates only the thing segment, so the reserved head survives an over-long name", () => {
    // `resourceName` refuses to hash the project — that refusal is what keeps the prefix filter honest,
    // and it is the single property the whole reservation rests on.
    const name = resourceName({ project: RESERVED_TEST_PROJECT, env: "production", thing: THINGS[5] });
    expect(name.startsWith(`${RESERVED_TEST_PROJECT}-production-`)).toBe(true);
  });
});
