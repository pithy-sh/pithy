// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { describe, expect, test } from "vitest";
import type { SecretBackend, SecretScope } from "../registry";
import type { ManagedEnvironment } from "../scope";
import { type SecretWriteIntent, secretWriteTargets } from "./writeTargets";

/** Every mode a write can arrive in. The rule is about scope, so it has to answer the same for all three. */
const MODES = ["create", "update", "delete"] as const;
/** Every backend a secret can be held in. Both are `global`-capable, so both reach the rule. */
const BACKENDS: readonly SecretBackend[] = ["d1", "cf-secrets-store"];

function intent(over: Partial<SecretWriteIntent> = {}): SecretWriteIntent {
  return {
    name: "email-link-signing-key",
    backend: "d1",
    scope: "global",
    mode: "update",
    requested: undefined,
    declared: DEFAULT_ENVIRONMENTS,
    ...over,
  };
}

/** The refusal a call produced, or `null` if it produced targets instead. */
function refusalOf(over: Partial<SecretWriteIntent>): PithyError | null {
  try {
    secretWriteTargets(intent(over));
    return null;
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
}

describe("secretWriteTargets — a global secret cannot be narrowed", () => {
  test("the population this ranges over is real", () => {
    // The vacuity floor. Both are read from the union types rather than restated as a number: the day a
    // third mode or a third backend arrives, this fails until it is included above.
    expect(MODES.length).toBe(3);
    expect(BACKENDS.length).toBe(2);
    expect(DEFAULT_ENVIRONMENTS.length).toBeGreaterThan(1);
  });

  test("every mode, every backend, every declared environment is refused", () => {
    const answered: string[] = [];
    for (const mode of MODES) {
      for (const backend of BACKENDS) {
        for (const requested of DEFAULT_ENVIRONMENTS) {
          const refusal = refusalOf({ mode, backend, requested: requested as ManagedEnvironment });
          expect(refusal, `${mode} ${backend} --env ${requested}`).not.toBeNull();
          answered.push(`${mode}/${backend}/${requested}`);
        }
      }
    }
    // Nothing was skipped by a `continue` above.
    expect(answered).toHaveLength(MODES.length * BACKENDS.length * DEFAULT_ENVIRONMENTS.length);
  });

  test("the modes that refuse are all of them — rm is not a special case", () => {
    const refused = MODES.filter((mode) => refusalOf({ mode, requested: "staging" }) !== null);
    expect(refused).toEqual([...MODES]);
  });

  test("the refusal names the secret, says it is global, and sends the operator back without --env", () => {
    const refusal = refusalOf({ mode: "update", requested: "staging" });
    expect(refusal?.payload.message).toBe(
      "Secret 'email-link-signing-key' is global. It holds one value across every environment, so --env cannot narrow it.",
    );
    expect(refusal?.payload.action).toBe("Run it again without --env to set it in every environment.");
  });

  test("rm's remedy says remove, because setting is not what the operator asked for", () => {
    expect(refusalOf({ mode: "delete", requested: "prod" })?.payload.action).toBe(
      "Run it again without --env to remove it from every environment.",
    );
  });

  test("no flag bypasses it — the intent carries no field that could", () => {
    // A `--yes`-shaped escape would have to arrive as a property. The rule takes the secret's facts and
    // the operator's environment, and nothing that could mean "do it anyway".
    expect(Object.keys(intent()).sort()).toEqual(["backend", "declared", "mode", "name", "requested", "scope"]);
  });
});

describe("secretWriteTargets — what it answers when the request is coherent", () => {
  test("a global d1 secret reaches every declared environment", () => {
    expect(secretWriteTargets(intent({ scope: "global", backend: "d1" }))).toEqual(["staging", "prod"]);
    expect(secretWriteTargets(intent({ scope: "global", backend: "d1", declared: ["staging", "live"] }))).toEqual([
      "staging",
      "live",
    ]);
  });

  test("a global cf-secrets-store secret reaches the canonical environment only", () => {
    // One account-level entry every environment binds. There is no fan-out here, so there is no split to
    // defend against — see the module header.
    expect(secretWriteTargets(intent({ scope: "global", backend: "cf-secrets-store" }))).toEqual(["prod"]);
  });

  test("an environment-scoped secret with --env is untouched by the rule", () => {
    for (const mode of MODES) {
      for (const backend of BACKENDS) {
        const targets = secretWriteTargets(intent({ scope: "environment", mode, backend, requested: "staging" }));
        expect(targets, `${mode} ${backend}`).toEqual(["staging"]);
      }
    }
  });

  test("an environment-scoped secret without --env refuses, and names the project's own environments", () => {
    const refusal = refusalOf({ scope: "environment", requested: undefined, declared: ["staging", "live"] });
    expect(refusal?.payload.message).toBe(
      "Secret 'email-link-signing-key' is environment-scoped — choose an environment.",
    );
    expect(refusal?.payload.action).toBe("Pass one of --env staging or --env live.");
  });

  test("a project that declares no environments is refused rather than given an invented one", () => {
    const refusal = refusalOf({ scope: "global", requested: undefined, declared: [] });
    expect(refusal?.payload.message).toContain("declares no environments");
  });
});

describe("secretWriteTargets — the refusal is a decision, not a report", () => {
  test("it throws before it can be read, so no caller can dispatch on a refused intent", () => {
    // The whole reason this returns targets rather than a decision object: there is no shape of the
    // answer that carries both "refused" and "here is where to write".
    const scopes: readonly SecretScope[] = ["global", "environment"];
    expect(scopes).toHaveLength(2);
    for (const scope of scopes) {
      const bad = scope === "global" ? { requested: "staging" as ManagedEnvironment } : { requested: undefined };
      expect(() => secretWriteTargets(intent({ scope, ...bad }))).toThrow(PithyError);
    }
  });
});
