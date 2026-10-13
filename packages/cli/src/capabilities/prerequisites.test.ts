// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { type WorkerDir, workerDirOf } from "@pithy-sh/core/src/cli/command";
import { describe, expect, test } from "vitest";
import { fixOf } from "../terminal/exitClass";
import { type AddRun, addCallerOf, projectAddFacts } from "./addCommand";
import { missingPrerequisites, prerequisiteRefusal, prerequisiteRequired } from "./prerequisites";

/** The real graph, in miniature: auth ⇒ secrets + email, email ⇒ secrets, secrets ⇒ nothing. */
const MANIFESTS = [
  { name: "auth", package: "@pithy-sh/auth", requiredBindings: [], peerCapabilities: ["secrets", "email"] },
  { name: "email", package: "@pithy-sh/email", requiredBindings: [], peerCapabilities: ["secrets"] },
  { name: "secrets", package: "@pithy-sh/secrets", requiredBindings: [] },
  { name: "audit", package: "@pithy-sh/audit", requiredBindings: [] },
].map((raw) => CapabilityManifest.parse(raw));

describe("missingPrerequisites", () => {
  test("names every composed capability whose declared peer is absent, and which peer", () => {
    expect(missingPrerequisites(MANIFESTS, new Set(["auth"]))).toEqual([
      { capability: "auth", requires: "secrets" },
      { capability: "auth", requires: "email" },
    ]);
  });

  test("an installed but uncomposed capability contributes nothing — installed is not composed", () => {
    // Every manifest under the project root is installed; only this Worker's own set is composed.
    expect(missingPrerequisites(MANIFESTS, new Set(["audit"]))).toEqual([]);
  });

  test("a fully composed graph is clean", () => {
    expect(missingPrerequisites(MANIFESTS, new Set(["auth", "email", "secrets"]))).toEqual([]);
  });
});

/** The kit's facts for the refusals below, and the Worker they are about. */
const factsFor = projectAddFacts(undefined);
const board = workerDirOf({ dir: "/p/apps/board" });
const api = workerDirOf({ dir: "/p/apps/api" });
/** A refusal for a caller who ran `pithy add <capability>` with `run`'s flags, whose config answers `answered`. */
const refusalFor = (
  capability: string,
  worker: WorkerDir,
  missing: string[],
  run: Omit<AddRun, "capability"> = {},
  answered: string[] = [],
) => ({
  capability,
  worker,
  missing,
  factsFor,
  composed: new Set<string>(),
  caller: addCallerOf({ capability, ...run }, answered),
});

describe("prerequisiteRefusal", () => {
  test("names the worker, the prerequisites, and the exact commands in order", () => {
    const error = prerequisiteRefusal(refusalFor("auth", board, ["secrets", "email"]));
    expect(error.payload.message).toBe("auth requires secrets and email, which board does not compose.");
    expect(error.payload.action).toBe(
      "Run `pithy add auth --worker board --with-prerequisites`, or compose them first: `pithy add secrets --worker board`, then `pithy add email --worker board`.",
    );
  });

  test("one prerequisite reads as one", () => {
    const error = prerequisiteRefusal(refusalFor("email", board, ["secrets"]));
    expect(error.payload.message).toBe("email requires secrets, which board does not compose.");
    expect(error.payload.action).toBe(
      "Run `pithy add email --worker board --with-prerequisites`, or compose it first: `pithy add secrets --worker board`.",
    );
  });

  // #711: each step of the manual sequence is a dry run when the run was one, and answers in JSON when it was asked to.
  test("keeps a dry run's --dry-run and the caller's --json on every step it names", () => {
    const error = prerequisiteRequired(
      refusalFor("auth", board, ["secrets", "email"], { dryRun: true, json: true, force: true }),
    );
    expect(fixOf(error)).toBe("pithy add auth --worker board --with-prerequisites --force --dry-run --json");
    expect(error.payload.action).toBe(
      "Run `pithy add auth --worker board --with-prerequisites --force --dry-run --json`, or compose them first: `pithy add secrets --worker board --dry-run --json`, then `pithy add email --worker board --dry-run --json`.",
    );
  });

  // #711: a rerun that dropped the run's `--set` was refused for the option the first run had answered.
  test("carries the run's own --set into the command it names", () => {
    const error = prerequisiteRequired(refusalFor("payments", api, ["secrets"], { setFlags: ["billingSubject=user"] }));
    expect(fixOf(error)).toBe("pithy add payments --worker api --with-prerequisites --set billingSubject=user");
  });

  // #711: an option the Worker's config already answers is settled, so the refusal names the caller's own command
  // and has a fix. It named one command per billing model, one contradicting the config, and gave no fix.
  test("settles an option the Worker's config answers, and has a fix", () => {
    const error = prerequisiteRequired(refusalFor("payments", api, ["secrets"], { json: true }, ["billingSubject"]));
    expect(fixOf(error)).toBe("pithy add payments --worker api --with-prerequisites --json");
    expect(error.payload.action).not.toContain("billingSubject");
  });
});

/**
 * A run that could not ask is told it needs `--with-prerequisites`, as `input/required` (#697). A person
 * who was asked and said no gets {@link prerequisiteRefusal}: that is an answer, not a missing one.
 */
describe("prerequisiteRequired", () => {
  test("is input/required naming --with-prerequisites, with the refusal's own words", () => {
    const options = refusalFor("auth", board, ["secrets", "email"]);
    const required = prerequisiteRequired(options);
    const refused = prerequisiteRefusal(options);
    expect(required.payload.code).toBe("input/required");
    if (required.payload.code !== "input/required") throw new Error("narrowing failed");
    expect(required.payload.flag).toBe("--with-prerequisites");
    expect(required.payload.choices).toBeUndefined();
    expect(required.payload.message).toBe(refused.payload.message);
    expect(required.payload.action).toBe(refused.payload.action);
  });

  // #711: `pithy add testers --worker api --json` named `pithy add testers --with-prerequisites`, which a
  // two-Worker project refuses for want of the Worker the caller had already named.
  test("its fix is the command the action leads with, naming the Worker", () => {
    const required = prerequisiteRequired(refusalFor("testers", api, ["email"]));
    expect(fixOf(required)).toBe("pithy add testers --worker api --with-prerequisites");
    expect(required.payload.action?.startsWith(`Run \`${fixOf(required)}\`,`)).toBe(true);
  });

  // An option with no default is the reader's choice: each value is named, and none is the fix (#412, #711).
  test("an option with no default names each value and withholds the fix", () => {
    const required = prerequisiteRequired(refusalFor("payments", api, ["secrets"]));
    expect(fixOf(required)).toBeUndefined();
    expect(required.payload.action).toContain(
      "`pithy add payments --worker api --with-prerequisites --set billingSubject=user`",
    );
    expect(required.payload.action).toContain("--set billingSubject=organization");
  });

  test("a person who said no is given no fix: they answered", () => {
    expect(fixOf(prerequisiteRefusal(refusalFor("email", board, ["secrets"])))).toBeUndefined();
  });

  test("a no is still a validation refusal, because somebody answered", () => {
    expect(prerequisiteRefusal(refusalFor("email", board, ["secrets"])).payload.code).toBe("validation/invalid_input");
  });
});
