// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { describe, expect, test } from "vitest";
import {
  bounceRoutingRuleName,
  deprovisionEmail,
  type EmailDeprovisioner,
  type EmailProvisioner,
  emailWorkerName,
  provisionEmail,
  suppressionDatabaseName,
} from "./provisionEmail";

/** A fake provisioner that records the call order and returns a fixed suppression DB id. */
function fakeProvisioner(): { provisioner: EmailProvisioner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    provisioner: {
      async preflight() {
        calls.push("preflight");
      },
      async ensureSuppressionDatabase() {
        calls.push("ensureSuppressionDatabase");
        return { databaseId: "sup-db" };
      },
      async migrateSuppression(id) {
        calls.push(`migrate:${id}`);
      },
      async deployWorker(env, id) {
        calls.push(`deploy:${env}:${id}`);
      },
      async ensureRoutingRule() {
        calls.push("ensureRoutingRule");
        return { created: true, skipped: false };
      },
    },
  };
}

describe("provisionEmail", () => {
  test("creates + migrates the suppression DB once, then deploys every environment in order", async () => {
    const { provisioner, calls } = fakeProvisioner();
    const result = await provisionEmail(provisioner, DEFAULT_ENVIRONMENTS);

    expect(calls).toEqual([
      "preflight",
      "ensureSuppressionDatabase",
      "migrate:sup-db",
      "deploy:staging:sup-db",
      "deploy:prod:sup-db",
      "ensureRoutingRule",
    ]);
    expect(result).toEqual({
      suppressionDatabaseId: "sup-db",
      environments: ["staging", "prod"],
      routing: { created: true, skipped: false },
    });
  });

  /**
   * The narrowed list is how skip-and-report reaches this orchestrator (pithy-sh/pithy#512): the CLI hands
   * it the environments whose app database exists, and this stays the same fan-out over whatever it is
   * given. What must not narrow with it is the suppression database — one per project, shared across every
   * environment, and the whole point of the change is that it does not wait for production.
   */
  test("a narrowed environment list deploys only those workers, and the suppression DB is still created", async () => {
    const { provisioner, calls } = fakeProvisioner();
    const result = await provisionEmail(provisioner, ["staging"]);

    expect(calls).toEqual([
      "preflight",
      "ensureSuppressionDatabase",
      "migrate:sup-db",
      "deploy:staging:sup-db",
      "ensureRoutingRule",
    ]);
    expect(result.environments).toEqual(["staging"]);
    expect(result.suppressionDatabaseId).toBe("sup-db");
  });

  test("no environment at all still creates the suppression DB, and makes no routing rule", async () => {
    const { provisioner, calls } = fakeProvisioner();
    const result = await provisionEmail(provisioner, []);

    // The database is a project-global resource and is created on the first run however many environments
    // skip. The rule is not: creating one over a run that deployed no handler starts delivering real bounce
    // mail to a Worker that is not there.
    expect(calls).toEqual(["preflight", "ensureSuppressionDatabase", "migrate:sup-db"]);
    expect(result).toEqual({
      suppressionDatabaseId: "sup-db",
      environments: [],
      routing: { created: false, skipped: true },
    });
  });
});

describe("names", () => {
  test("the worker is named for the project and the environment", () => {
    expect(emailWorkerName("acme", "staging")).toBe("acme-staging-email");
    expect(emailWorkerName("acme", "prod")).toBe("acme-prod-email");
  });

  test("the suppression database is one per project, shared across that project's environments", () => {
    // `global` in the environment slot is the scope stated out loud: "do not email this person again"
    // must hold in staging and prod alike, so both bind the same database.
    expect(suppressionDatabaseName("acme")).toBe("acme-global-email-suppressions");
    expect(suppressionDatabaseName("acme")).toBe(suppressionDatabaseName("acme"));
  });

  test("a second project gets its own suppression list, so one product cannot mute another's mail", () => {
    // The old fixed `pithy-email-suppressions` was found-and-reused by every project in the account:
    // one product's unsubscribe silently suppressed another product's transactional mail.
    expect(suppressionDatabaseName("acme")).not.toBe(suppressionDatabaseName("globex"));
  });

  test("the bounce routing rule carries the project, so two projects on one zone do not share it", () => {
    expect(bounceRoutingRuleName("acme")).toBe("acme-global-email-bounce");
    expect(bounceRoutingRuleName("acme")).not.toBe(bounceRoutingRuleName("globex"));
  });

  test("every name comes off core's facade, so each namespace carries its own cap", () => {
    // Not a tautology: the facade is what decides that the suppression database is measured against
    // D1's limit and the worker against a Worker script's 63, rather than both against the single 63
    // the generic composer defaults to. Composing either here by hand would re-introduce that.
    const names = resourceNames("acme");
    expect(suppressionDatabaseName("acme")).toBe(names.global.d1("email-suppressions"));
    expect(emailWorkerName("acme", "prod")).toBe(names.env("prod").worker("email"));
  });

  test("`production` is not an environment — the worker namer says so, with the new spelling", () => {
    // The environment reaches the name verbatim, so the old spelling has to fail loudly rather than
    // deploy a second, parallel `acme-production-email` beside the real one.
    expect(() => emailWorkerName("acme", "production" as never)).toThrowError(/not an environment name/);
  });
});

describe("deprovisionEmail", () => {
  /**
   * Records every destructive call. `suppressed` is the rows the list holds; `workers` is which environments run an
   * email worker before the run, and a deleted one stops running.
   */
  function fakeDeprovisioner(
    suppressed = 0,
    workers: readonly string[] = DEFAULT_ENVIRONMENTS,
  ): { deprovisioner: EmailDeprovisioner; calls: string[] } {
    const calls: string[] = [];
    const running = new Set(workers);
    return {
      calls,
      deprovisioner: {
        async countSuppressionRetained() {
          return suppressed === 0
            ? []
            : [{ binding: "acme-global-email-suppressions", table: "pithy_email_suppressions", rows: suppressed }];
        },
        async hasWorker(env) {
          return running.has(env);
        },
        async deleteWorker(env) {
          running.delete(env);
          calls.push(`deleteWorker:${env}`);
        },
        async deleteSuppressionDatabase() {
          calls.push("deleteSuppressionDatabase");
        },
      },
    };
  }

  const staging = { environment: "staging", declared: DEFAULT_ENVIRONMENTS };
  const prod = { environment: "prod", declared: DEFAULT_ENVIRONMENTS };

  /**
   * **#591, in email.** `pithy email deprovision` walked every declared environment: a run meant for staging removed
   * production's email worker, and with it every send, digest and retry production had scheduled. Planting the old
   * loop back fails the first two tests.
   */
  test("removes the named environment's worker and no other, and keeps the suppression list", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner(4);
    expect(await deprovisionEmail(deprovisioner, staging)).toEqual({ env: "staging" });
    expect(calls).toEqual(["deleteWorker:staging"]);
  });

  test("naming no environment refuses, lists the declared ones, and deletes nothing", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await expect(
      deprovisionEmail(deprovisioner, { environment: undefined, declared: DEFAULT_ENVIRONMENTS }),
    ).rejects.toMatchObject({
      message: "Name the environment to deprovision. Nothing was deleted.",
      payload: { action: "Pass --env with one of: staging, prod." },
    });
    expect(calls).toEqual([]);
  });

  test("naming an environment the project does not declare refuses, and deletes nothing", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await expect(
      deprovisionEmail(deprovisioner, { environment: "live", declared: DEFAULT_ENVIRONMENTS }),
    ).rejects.toThrow('"live" is not an environment this project declares. Nothing was deleted.');
    expect(calls).toEqual([]);
  });

  /**
   * **The list is every environment's.** A staging teardown with `--suppression` deleted production's opt-outs:
   * the next production send went to addresses that asked not to be mailed. It goes with the last environment.
   */
  test("--suppression refuses while another environment still runs a worker, before anything is deleted", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner(0);
    await expect(deprovisionEmail(deprovisioner, staging, { deleteSuppression: true })).rejects.toMatchObject({
      message: "The suppression list is shared by every environment, and prod still runs. Nothing was deleted.",
      payload: { action: "Deprovision prod first, or drop --suppression." },
    });
    expect(calls).toEqual([]);
  });

  test("the last environment's teardown deletes an empty list when explicitly asked", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner(0, ["prod"]);
    await deprovisionEmail(deprovisioner, prod, { deleteSuppression: true });
    expect(calls).toEqual(["deleteWorker:prod", "deleteSuppressionDatabase"]);
  });

  /**
   * **#591's other vault.** `--suppression` deleted every address that asked not to be mailed, with nothing
   * counted — the same deletion of rows that exist nowhere else as the secrets teardown, one flag instead of
   * none. #588's guard, spent here: counted before the worker goes, and refused unless the operator counted the
   * same.
   */
  test("a suppression list holding rows refuses without the count, before the worker is deleted", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner(4, ["prod"]);
    await expect(deprovisionEmail(deprovisioner, prod, { deleteSuppression: true })).rejects.toThrow(
      "Retained 4 rows would be dropped: pithy_email_suppressions on acme-global-email-suppressions (4 rows). Refused before anything was deleted.",
    );
    expect(calls).toEqual([]);
  });

  test("the exact count deletes it", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner(4, ["prod"]);
    await deprovisionEmail(deprovisioner, prod, { deleteSuppression: true, destroyRetained: 4 });
    expect(calls).toEqual(["deleteWorker:prod", "deleteSuppressionDatabase"]);
  });
});
