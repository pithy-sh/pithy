// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  deprovisionEmail,
  type EmailDeprovisioner,
  type EmailProvisioner,
  emailWorkerName,
  provisionEmail,
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
    const result = await provisionEmail(provisioner);

    expect(calls).toEqual([
      "preflight",
      "ensureSuppressionDatabase",
      "migrate:sup-db",
      "deploy:staging:sup-db",
      "deploy:production:sup-db",
      "ensureRoutingRule",
    ]);
    expect(result).toEqual({
      suppressionDatabaseId: "sup-db",
      environments: ["staging", "production"],
      routing: { created: true, skipped: false },
    });
  });
});

describe("emailWorkerName", () => {
  test("is the env-suffixed worker name", () => {
    expect(emailWorkerName("staging")).toBe("pithy-email-staging");
    expect(emailWorkerName("production")).toBe("pithy-email-production");
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
    await deprovisionEmail(deprovisioner);
    expect(calls).toEqual(["deleteWorker:staging", "deleteWorker:production"]);
  });

  test("deletes the suppression DB only when explicitly asked", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await deprovisionEmail(deprovisioner, { deleteSuppression: true });
    expect(calls).toEqual(["deleteWorker:staging", "deleteWorker:production", "deleteSuppressionDatabase"]);
  });
});
