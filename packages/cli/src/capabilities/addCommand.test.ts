// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerDirOf } from "@pithy-sh/core/src/cli/command";
import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fixOf } from "../terminal/exitClass";
import {
  addAction,
  addAgain,
  addCallerOf,
  addListCommand,
  addPlan,
  addSecretsPlan,
  composedBy,
  offeredWorkers,
  projectAddFacts,
  withAddFix,
} from "./addCommand";
import type { AddFacts } from "./kitAddFacts";

/**
 * **Every `pithy add` a line names, built from what the capability declares (#711).** Each command here runs as
 * written: the Worker is named, prerequisites come with the flag that composes them, and an option the kit cannot
 * default is the reader's choice — named as one command per value, and never a `fix`.
 */

const api = workerDirOf({ dir: "/p/apps/api" });
const web = workerDirOf({ dir: "/p/apps/web" });

/** A small kit: auth ⇒ secrets + email, email ⇒ secrets, payments ⇒ secrets with a required choice. */
const FACTS: Record<string, AddFacts> = {
  secrets: { name: "secrets", peerCapabilities: [], requiredOptions: [] },
  email: { name: "email", peerCapabilities: ["secrets"], requiredOptions: [] },
  auth: { name: "auth", peerCapabilities: ["secrets", "email"], requiredOptions: [] },
  vector: { name: "vector", peerCapabilities: [], requiredOptions: [] },
  payments: {
    name: "payments",
    peerCapabilities: ["secrets"],
    requiredOptions: [{ key: "billingSubject", choices: ["user", "organization"] }],
  },
  ledger: { name: "ledger", peerCapabilities: [], requiredOptions: [{ key: "currency" }] },
  bank: { name: "bank", peerCapabilities: ["ledger"], requiredOptions: [] },
  tariff: { name: "tariff", peerCapabilities: ["secrets"], requiredOptions: [{ key: "k", choices: ["v1"] }] },
  shop: { name: "shop", peerCapabilities: ["tariff", "vector"], requiredOptions: [] },
  depot: { name: "depot", peerCapabilities: ["tariff"], requiredOptions: [] },
};
const factsFor = (name: string) => FACTS[name];

describe("addPlan", () => {
  test("names the Worker always, and is the fix when nothing in it is a choice", () => {
    const plan = addPlan({ capability: "vector", workers: [api], factsFor });
    expect(plan.commands).toEqual(["pithy add vector --worker api"]);
    expect(plan.fix).toBe("pithy add vector --worker api");
    expect(addAction(plan, (add) => `Run ${add}.`)).toBe("Run `pithy add vector --worker api`.");
  });

  test("carries --with-prerequisites when the Worker lacks a prerequisite, and not when it has them all", () => {
    expect(addPlan({ capability: "auth", workers: [api], factsFor }).fix).toBe(
      "pithy add auth --worker api --with-prerequisites",
    );
    const composed = new Set(["secrets", "email"]);
    expect(addPlan({ capability: "auth", workers: [api], factsFor, composed }).fix).toBe("pithy add auth --worker api");
  });

  test("names one command per Worker where several could take it, and none of them is the fix", () => {
    const plan = addPlan({ capability: "vector", workers: [api, web], factsFor });
    expect(plan.commands).toEqual(["pithy add vector --worker api", "pithy add vector --worker web"]);
    expect(plan.fix).toBeUndefined();
  });

  // #412: the kit never picks a billing model. Each value is its own command, and none is a `fix`.
  test("names a required option's every value as the reader's choice, never a fix", () => {
    const plan = addPlan({ capability: "payments", workers: [api], factsFor });
    expect(plan.commands).toEqual([
      "pithy add payments --worker api --with-prerequisites --set billingSubject=user",
      "pithy add payments --worker api --with-prerequisites --set billingSubject=organization",
    ]);
    expect(plan.fix).toBeUndefined();
  });

  test("never offers a value pithy add refuses", () => {
    const refusing: AddFacts = {
      name: "payments",
      peerCapabilities: [],
      requiredOptions: [
        { key: "billingSubject", choices: ["user", "organization"], choicesNeedingCode: { organization: "no" } },
      ],
    };
    const plan = addPlan({ capability: "payments", workers: [api], factsFor: () => refusing });
    expect(plan.commands).toEqual(["pithy add payments --worker api --set billingSubject=user"]);
    expect(plan.fix).toBeUndefined();
  });

  test("carries the caller's --set, which settles the option and makes the command the fix", () => {
    const plan = addPlan({
      capability: "payments",
      workers: [api],
      factsFor,
      caller: addCallerOf({ capability: "payments", setFlags: ["billingSubject=user"] }, []),
    });
    expect(plan.fix).toBe("pithy add payments --worker api --with-prerequisites --set billingSubject=user");
  });

  // #711: `pithy add` skips an option the Worker's config already states, so a line about a Worker that answered it
  // names the add that runs, with no choice left in it — and passes no `--set` that could contradict the config.
  test("an option the Worker's config already answers is settled, and no --set is named for it", () => {
    const plan = addPlan({ capability: "tariff", workers: [api], factsFor, answered: new Set(["k"]) });
    expect(plan.commands).toEqual(["pithy add tariff --worker api --with-prerequisites"]);
    expect(plan.fix).toBe("pithy add tariff --worker api --with-prerequisites");
  });

  test("names no command for an option with no fixed values, and says what a person must decide", () => {
    const plan = addPlan({ capability: "ledger", workers: [api], factsFor });
    expect(plan.commands).toEqual([]);
    expect(plan.fix).toBeUndefined();
    expect(addAction(plan, (add) => `Run ${add}.`)).toBe(
      "ledger needs currency decided, and only you can. Pass each to pithy add with --set.",
    );
  });

  // `--with-prerequisites` composes a prerequisite with its defaults, which one with a required option does not have.
  test("names a prerequisite's own add first when the flag could not compose it", () => {
    const plan = addPlan({ capability: "bank", workers: [api], factsFor });
    expect(plan.fix).toBeUndefined();
    expect(plan.decide).toMatch(
      /^bank needs ledger, and --with-prerequisites would give ledger defaults it does not have\./,
    );
    expect(plan.decide).toContain("ledger needs currency decided");
    expect(plan.decide).toContain("`pithy add bank --worker api`");
  });

  // The command after the prerequisite's own add composes only that prerequisite and what it brings: another the
  // Worker still lacks is still missing, and the run after it is refused without --with-prerequisites (#711).
  test("the command after a prerequisite's own add still carries --with-prerequisites for the rest", () => {
    const plan = addPlan({ capability: "shop", workers: [api], factsFor });
    expect(plan.decide).toContain(
      "Compose it first with `pithy add tariff --worker api --with-prerequisites --set k=v1`",
    );
    expect(plan.decide).toContain("Then run `pithy add shop --worker api --with-prerequisites`.");
  });

  test("the command after a prerequisite's own add names no flag when that add brought every other", () => {
    const plan = addPlan({ capability: "depot", workers: [api], factsFor });
    expect(plan.decide).toContain("Then run `pithy add depot --worker api`.");
  });

  // #711: a dry run's every step stays a dry run. The command composing the prerequisite first dropped the caller's
  // flags, so an agent that asked only to see the plan was told to run a real add, which installs and migrates.
  // `--eject` and `--force` were asked of the capability, not of what it needs; the output mode is the caller's.
  test("the prerequisite's own add keeps a dry run's --dry-run and the caller's --json, and nothing else", () => {
    const plan = addPlan({
      capability: "depot",
      workers: [api],
      factsFor,
      caller: addCallerOf({ capability: "depot", dryRun: true, json: true, eject: true }, []),
    });
    expect(plan.decide).toContain(
      "Compose it first with `pithy add tariff --worker api --with-prerequisites --set k=v1 --dry-run --json`",
    );
    expect(plan.decide).toContain("Then run `pithy add depot --worker api --eject --dry-run --json`.");
  });

  test("says what a person must do for a capability nothing describes, or a project with no Worker", () => {
    expect(addPlan({ capability: "nope", workers: [api], factsFor }).decide).toBe(
      "No capability named nope is installed or in the kit. Check the name against pithy add --list.",
    );
    expect(addPlan({ capability: "vector", workers: [], factsFor }).decide).toMatch(/^This project has no Worker/);
  });

  test("carries the caller's other flags", () => {
    const plan = addPlan({
      capability: "vector",
      workers: [api],
      factsFor,
      caller: addCallerOf({ capability: "vector", eject: true, force: true }, []),
    });
    expect(plan.fix).toBe("pithy add vector --worker api --eject --force");
  });
});

describe("withAddFix", () => {
  test("attaches the plan's fix, and nothing when it has none", () => {
    const one = addPlan({ capability: "vector", workers: [api], factsFor });
    const error = withAddFix(new PreconditionFailedError({ message: "m", action: "a" }), one);
    expect(fixOf(error)).toBe("pithy add vector --worker api");
    const choice = addPlan({ capability: "payments", workers: [api], factsFor });
    expect(fixOf(withAddFix(new PreconditionFailedError({ message: "m", action: "a" }), choice))).toBeUndefined();
  });
});

test("addListCommand reads the catalog and names no Worker", () => {
  expect(addListCommand()).toBe("pithy add --list");
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-add-command-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A Worker under `apps/`, composing `composes`, with a `pithy.config.ts` unless told otherwise. */
async function app(name: string, composes: readonly string[] = [], config = true): Promise<string> {
  const at = join(dir, "apps", name);
  await mkdir(at, { recursive: true });
  await writeFile(join(at, "wrangler.jsonc"), JSON.stringify({ name: `demo-${name}` }));
  const calls = composes.map((one) => `    ${one}(),`).join("\n");
  if (config) await writeFile(join(at, "pithy.config.ts"), `export default {\n  capabilities: [\n${calls}\n  ],\n};\n`);
  return at;
}

describe("composedBy", () => {
  test("reads a Worker's registrations, never its imports", async () => {
    const at = await app("api", ["secrets"]);
    await writeFile(join(at, "pithy.config.ts"), 'import { email } from "x";\nexport default [\n  secrets(),\n];\n');
    expect([...composedBy(at, ["secrets", "email"])]).toEqual(["secrets"]);
  });

  test("reads nothing from a Worker with no config", async () => {
    const at = await app("api", [], false);
    expect([...composedBy(at, ["secrets"])]).toEqual([]);
  });
});

/**
 * **A remedy offering one command per Worker offers only the right ones (#711).** `pithy add secrets --worker x`
 * offered for a Worker that composes nothing of secrets composed secrets into an unrelated Worker.
 */
describe("offeredWorkers and addSecretsPlan", () => {
  test("offer only the Workers composing the capability, when any does", async () => {
    await app("api", ["secrets"]);
    await app("web");
    expect(offeredWorkers(dir, "secrets")).toEqual(["api"]);
    expect(addSecretsPlan(dir).commands).toEqual(["pithy add secrets --worker api"]);
  });

  test("offer every configured Worker when none does, by directory and in order", async () => {
    await app("web");
    await app("api");
    await app("frontend", [], false);
    expect(offeredWorkers(dir, "secrets")).toEqual(["api", "web"]);
    expect(addSecretsPlan(dir).commands).toEqual(["pithy add secrets --worker api", "pithy add secrets --worker web"]);
  });
});

/** The caller's own run, again, with every option it settled and every flag it was given (#711). */
describe("addAgain", () => {
  test("carries the run's --set and flags, so the rerun is asked nothing the first run was not", async () => {
    const at = await app("api", ["secrets"]);
    const caller = addCallerOf({ capability: "payments", setFlags: ["billingSubject=user"], eject: true }, []);
    expect(addAgain(caller, { workerDir: at, projectDir: dir })).toBe(
      "`pithy add payments --worker api --set billingSubject=user --eject`",
    );
  });

  // #711: an option the Worker's config already answers is settled in the rerun. It named one command per billing
  // model — one contradicting the config — for a caller that passed no --set because the config had answered it.
  test("settles an option the Worker's config answers, so the rerun names no choice", async () => {
    const at = await app("api", ["secrets"]);
    const caller = addCallerOf({ capability: "payments", json: true }, ["billingSubject"]);
    expect(addAgain(caller, { workerDir: at, projectDir: dir })).toBe("`pithy add payments --worker api --json`");
  });

  // A step on the way carries the run's mode and nothing else of the caller's: its --set answered the caller's
  // capability, and a value for another's option would be refused.
  test("a prerequisite named first carries only the caller's --dry-run and --json", () => {
    const caller = addCallerOf({ capability: "shop", setFlags: ["k=v2"], dryRun: true, json: true, eject: true }, []);
    const plan = addPlan({ capability: "shop", workers: [api], factsFor, caller });
    expect(plan.decide).toContain(
      "Compose it first with `pithy add tariff --worker api --with-prerequisites --set k=v1 --dry-run --json`",
    );
    expect(plan.decide).toContain(
      "Then run `pithy add shop --worker api --with-prerequisites --set k=v2 --eject --dry-run --json`.",
    );
  });

  test("names --with-prerequisites only when the Worker still lacks one", async () => {
    const bare = await app("api");
    expect(addAgain(addCallerOf({ capability: "email" }, []), { workerDir: bare, projectDir: dir })).toBe(
      "`pithy add email --worker api --with-prerequisites`",
    );
  });
});

describe("projectAddFacts", () => {
  test("reads the installed manifest first, then the kit's", async () => {
    const manifestDir = join(dir, "node_modules", "@pithy-sh", "vector");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, "pithy.manifest.json"),
      JSON.stringify({ name: "vector", peerCapabilities: ["secrets"], configOptions: [{ key: "model" }] }),
    );
    expect(projectAddFacts(dir)("vector")).toEqual({
      name: "vector",
      peerCapabilities: ["secrets"],
      requiredOptions: [{ key: "model", choices: undefined, choicesNeedingCode: undefined }],
    });
    expect(projectAddFacts(dir)("payments")?.requiredOptions.map((option) => option.key)).toEqual(["billingSubject"]);
    expect(projectAddFacts(undefined)("nope")).toBeUndefined();
  });
});
