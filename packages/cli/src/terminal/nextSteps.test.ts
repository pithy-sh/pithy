// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  addNext,
  deployNext,
  NextKey,
  type NextStep,
  nextOrAbsent,
  provisionNext,
  uiAddNext,
  upgradeNext,
} from "./nextSteps";

/**
 * **`next` is a follow-up the run knows is required, or it is absent (#697).**
 *
 * Each emitting command is held to its condition here, both ways: the fact that makes the step required
 * produces it, and every fact short of that produces no key at all — never `[]`, which an agent would read
 * as "a list I should walk" and a script as "the run had an opinion". The payload-wide half, that no
 * command's schema admits an empty `next`, is `contract/nextKeys.test.ts`.
 */

const commands = (steps: NextStep[] | undefined) => steps?.map((step) => step.command);

describe("nextOrAbsent", () => {
  test("an empty list is no key at all", () => {
    expect(nextOrAbsent([])).toBeUndefined();
  });

  test("a list with a step is that list", () => {
    const step = { command: "pithy migrate --env staging", why: "One migration is not applied to staging." };
    expect(nextOrAbsent([step])).toEqual([step]);
  });
});

describe("NextKey", () => {
  test("refuses an empty list, so no payload can publish one", () => {
    expect(NextKey.safeParse([]).success).toBe(false);
  });

  test("takes absence, and a list of whole steps", () => {
    expect(NextKey.safeParse(undefined).success).toBe(true);
    expect(NextKey.safeParse([{ command: "pithy deploy --env staging", why: "Nothing is deployed." }]).success).toBe(
      true,
    );
    expect(NextKey.safeParse([{ command: "", why: "Nothing." }]).success).toBe(false);
  });
});

describe("deploy: migrations the environment has not applied", () => {
  test("pending after a deploy that shipped names migrate for that environment", () => {
    const next = deployNext({ env: "staging", pending: 3, failed: false });
    expect(commands(next)).toEqual(["pithy migrate --env staging"]);
    expect(next?.[0]?.why).toBe("3 migrations are not applied to staging. Deploy does not migrate.");
  });

  test("one migration reads as one", () => {
    expect(deployNext({ env: "prod", pending: 1, failed: false })?.[0]?.why).toBe(
      "1 migration is not applied to prod. Deploy does not migrate.",
    );
  });

  test.each([
    ["nothing pending", { env: "staging", pending: 0, failed: false }],
    ["a count nobody took", { env: "staging", pending: undefined, failed: false }],
    ["a bare deploy, which counts nothing", { env: undefined, pending: 4, failed: false }],
    ["a deploy that failed, whose next step is its own failure", { env: "staging", pending: 4, failed: true }],
  ])("%s carries none", (_, facts) => {
    expect(deployNext(facts)).toBeUndefined();
  });
});

describe("provision: an environment with Workers nothing has deployed", () => {
  test("a Worker not deployed names deploy for that environment, and the Worker", () => {
    const next = provisionNext({ env: "staging", undeployed: ["acme-staging-api"] });
    expect(commands(next)).toEqual(["pithy deploy --env staging"]);
    expect(next?.[0]?.why).toBe("acme-staging-api is not deployed in staging.");
  });

  test("several are named together, once", () => {
    const next = provisionNext({ env: "feature", undeployed: ["acme-12-x-api", "acme-12-x-web"] });
    expect(commands(next)).toEqual(["pithy deploy --env feature"]);
    expect(next?.[0]?.why).toBe("acme-12-x-api and acme-12-x-web are not deployed in feature.");
  });

  test("every Worker deployed, or nobody able to say, carries none", () => {
    expect(provisionNext({ env: "staging", undeployed: [] })).toBeUndefined();
    expect(provisionNext({ env: "staging", undeployed: undefined })).toBeUndefined();
  });
});

describe("add: what the capability left an environment that was ready", () => {
  test("a provisioned environment the add gave an id-less binding names provision, not migrate", () => {
    const next = addNext({
      capability: "auth",
      unprovisioned: ["staging"],
      pending: [{ env: "staging", pending: 2 }],
    });
    expect(commands(next)).toEqual(["pithy provision --env staging --yes"]);
    expect(next?.[0]?.why).toBe(
      "auth added bindings staging has no resources for, so deploy refuses it. Provisioning creates them and migrates.",
    );
  });

  test("migrations the add brought, pending where it is provisioned, name migrate", () => {
    const next = addNext({
      capability: "auth",
      unprovisioned: [],
      pending: [
        { env: "staging", pending: 2 },
        { env: "prod", pending: 0 },
      ],
    });
    expect(commands(next)).toEqual(["pithy migrate --env staging"]);
    // The count is the environment's whole ledger, not only what this add brought, so `why` claims no more.
    expect(next?.[0]?.why).toBe("2 migrations are not applied to staging. Add migrates only dev.");
  });

  test("each environment gets its own step, in the order given", () => {
    const next = addNext({
      capability: "email",
      unprovisioned: ["qa"],
      pending: [{ env: "staging", pending: 1 }],
    });
    expect(commands(next)).toEqual(["pithy provision --env qa --yes", "pithy migrate --env staging"]);
  });

  test("a production environment left unprovisioned names no step: its provision stops at a person's --confirm phrase", () => {
    expect(addNext({ capability: "email", unprovisioned: ["prod"], pending: [{ env: "prod", pending: 3 }] })).toBe(
      undefined,
    );
    const next = addNext({
      capability: "email",
      unprovisioned: ["live", "qa"],
      pending: [{ env: "staging", pending: 1 }],
      productionEnvironments: ["live"],
    });
    expect(commands(next)).toEqual(["pithy provision --env qa --yes", "pithy migrate --env staging"]);
  });

  test("migrations pending in a provisioned production environment still name migrate, which needs no phrase", () => {
    const next = addNext({ capability: "email", unprovisioned: [], pending: [{ env: "prod", pending: 1 }] });
    expect(commands(next)).toEqual(["pithy migrate --env prod"]);
  });

  test("nothing left behind carries none", () => {
    expect(addNext({ capability: "auth", unprovisioned: [], pending: [] })).toBeUndefined();
    expect(addNext({ capability: "auth", unprovisioned: [], pending: [{ env: "staging", pending: 0 }] })).toBe(
      undefined,
    );
  });
});

describe("upgrade: migrations it did not run, and a reconcile it left to the new CLI", () => {
  test("pending without --migrate names migrate for the environment it counted", () => {
    const next = upgradeNext({ env: "staging", dryRun: false, migrate: false, failed: false, pending: 2 });
    expect(commands(next)).toEqual(["pithy migrate --env staging"]);
    expect(next?.[0]?.why).toBe("2 migrations are not applied to staging. Upgrade migrates only under --migrate.");
  });

  test("a CLI that moved names the project's own CLI to reconcile with", () => {
    const next = upgradeNext({
      env: "dev",
      dryRun: false,
      migrate: false,
      failed: false,
      pending: 0,
      reconcileWith: "bun x pithy upgrade",
    });
    expect(commands(next)).toEqual(["bun x pithy upgrade"]);
    expect(next?.[0]?.why).toBe("@pithy-sh/cli moved, so the new one reconciles. This run wrote no Worker.");
  });

  test.each([
    ["--migrate, which applied them", { env: "staging", dryRun: false, migrate: true, failed: false, pending: 2 }],
    ["--dry-run, which changed nothing", { env: "staging", dryRun: true, migrate: false, failed: false, pending: 2 }],
    ["a failed run", { env: "staging", dryRun: false, migrate: false, failed: true, pending: 2 }],
    ["nothing pending", { env: "staging", dryRun: false, migrate: false, failed: false, pending: 0 }],
  ])("%s carries none", (_, facts) => {
    expect(upgradeNext(facts)).toBeUndefined();
  });
});

describe("ui add: packages it added and nothing has installed", () => {
  test("added dependencies name the project's install", () => {
    const next = uiAddNext({ dryRun: false, packageManager: "pnpm", added: 3 });
    expect(commands(next)).toEqual(["pnpm install"]);
    expect(next?.[0]?.why).toBe("ui add wrote 3 packages into package.json, and the build needs them installed.");
  });

  test("nothing added, or a dry run, carries none", () => {
    expect(uiAddNext({ dryRun: false, packageManager: "bun", added: 0 })).toBeUndefined();
    expect(uiAddNext({ dryRun: true, packageManager: "bun", added: 3 })).toBeUndefined();
  });
});
