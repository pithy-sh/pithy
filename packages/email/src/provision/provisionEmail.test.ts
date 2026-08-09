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
  function fakeDeprovisioner(): { deprovisioner: EmailDeprovisioner; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      deprovisioner: {
        async deleteWorker(env) {
          calls.push(`deleteWorker:${env}`);
        },
        async deleteSuppressionDatabase() {
          calls.push("deleteSuppressionDatabase");
        },
      },
    };
  }

  test("deletes every worker and keeps the suppression DB by default", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await deprovisionEmail(deprovisioner, DEFAULT_ENVIRONMENTS);
    expect(calls).toEqual(["deleteWorker:staging", "deleteWorker:prod"]);
  });

  test("deletes the suppression DB only when explicitly asked", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await deprovisionEmail(deprovisioner, DEFAULT_ENVIRONMENTS, { deleteSuppression: true });
    expect(calls).toEqual(["deleteWorker:staging", "deleteWorker:prod", "deleteSuppressionDatabase"]);
  });
});
