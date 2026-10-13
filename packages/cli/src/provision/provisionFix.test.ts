// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { fixOf } from "../terminal/exitClass";
import { provisionFixCommand, provisionRemedy, withProvisionFix } from "./provisionFix";

/**
 * **A `fix` is runnable as written, so a production environment gets none (#697).**
 *
 * Five refusals end "this environment has nothing provisioned behind it" and used to name the same
 * `pithy provision --env <env> --yes` as their `fix`. For a production environment that command is refused
 * in turn, `core/person_required`, exit 5, because provisioning production also needs the `--confirm`
 * phrase, and the phrase is a person's to give. `docs/CLI.md` §3.3 says a `fix` rights the failure as
 * written, so a production environment carries no `fix`: its action line still says what to do, for the
 * person who has to do it.
 */
function refusal(): PreconditionFailedError {
  return new PreconditionFailedError({ message: "Nothing is provisioned.", action: "Provision it." });
}

describe("withProvisionFix", () => {
  test("a staging refusal names the provisioning command", () => {
    expect(fixOf(withProvisionFix(refusal(), "staging"))).toBe("pithy provision --env staging --yes");
  });

  test("a feature refusal names the feature form, since provision refuses --env feature", () => {
    expect(fixOf(withProvisionFix(refusal(), "feature"))).toBe("pithy provision --feature");
  });

  test.each(["prod", "production", "PROD"])("%s, production by name, gets no fix", (env) => {
    expect(fixOf(withProvisionFix(refusal(), env))).toBeUndefined();
  });

  test("an environment the project declares production gets no fix", () => {
    expect(fixOf(withProvisionFix(refusal(), "live", ["live"]))).toBeUndefined();
  });

  test("the error is the same one, so the caller throws what it built", () => {
    const error = refusal();
    expect(withProvisionFix(error, "prod")).toBe(error);
    expect(withProvisionFix(error, "staging")).toBe(error);
  });
});

/** The same rule as a bare command, for a report that names a remedy without throwing — `pithy doctor` (#697). */
describe("provisionFixCommand", () => {
  test("the command withProvisionFix attaches, and none for production", () => {
    expect(provisionFixCommand("staging")).toBe("pithy provision --env staging --yes");
    expect(provisionFixCommand("feature")).toBe("pithy provision --feature");
    expect(provisionFixCommand("prod")).toBeNull();
    expect(provisionFixCommand("live", ["live"])).toBeNull();
  });

  test.each([
    ["staging", []],
    ["feature", []],
    ["prod", []],
    ["live", ["live"]],
    ["qa", ["live"]],
  ] as const)("agrees with the fix the refusal carries, for %s", (env, production) => {
    expect(provisionFixCommand(env, production) ?? undefined).toBe(fixOf(withProvisionFix(refusal(), env, production)));
  });
});

/**
 * What a sentence names for provisioning (#711): an action line, a skip reason, a doctor line. The `fix` where
 * there is one, so the two cannot disagree. Production has no `fix`, because `pithy provision --env prod --yes`
 * run as written ends `core/person_required`, exit 5 — so the sentence says it is a person's decision, and that
 * the `--confirm` phrase is theirs to give, rather than offering a command an agent would be refused.
 */
describe("provisionRemedy", () => {
  test.each(["staging", "feature", "qa"])("says the fix for %s", (env) => {
    expect(provisionRemedy(env).say((command) => `Run ${command}.`)).toBe(`Run ${provisionFixCommand(env)}.`);
  });

  test.each([
    ["prod", []],
    ["production", []],
    ["live", ["live"]],
  ] as const)("says production environment %s is a person's decision, with no fix", (env, production) => {
    expect(provisionRemedy(env, production).say((command) => `Run ${command}.`)).toBe(
      `\`pithy provision --env ${env} --yes\` with its --confirm phrase, which only a person gives, runs against ${env}, a production environment. That is a person's decision, not a fix.`,
    );
    expect(provisionFixCommand(env, production)).toBeNull();
  });
});
