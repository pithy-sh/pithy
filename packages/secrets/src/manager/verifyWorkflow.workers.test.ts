// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { secretsTables } from "../data/tables";
import type { SecretsStoreEnv } from "../env/bindings";
import { secrets_0001_init } from "../migrations/0001_init";
import { runWriteWorkflow, WriteWorkflowOutcome, WriteWorkflowResult } from "./writeWorkflow";

/**
 * `{ mode: "verify" }` on the manager's write Workflow — the one seam the CLI has into the Worker that
 * holds the master key.
 *
 * What is proven here is the wire contract rather than the sweep: that the branch is reachable, that its
 * output survives `WriteWorkflowResult.parse`, that a store which will not open still *resolves* rather
 * than throwing, and that nothing is written. The sweep's own answers are `admin/verifyStore.workers.test.ts`.
 */

/** The manager env — `SECRETS` D1 plus the `SECRETS_ENCRYPTION_KEYS` string binding from Miniflare. */
function managerEnv(): SecretsStoreEnv {
  return { SECRETS: env.SECRETS, SECRETS_ENCRYPTION_KEYS: env.SECRETS_ENCRYPTION_KEYS };
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("runWriteWorkflow — mode verify", () => {
  test("answers `verified` with a verification the result schema accepts whole", async () => {
    await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "api-token",
      value: "v",
      valueType: "text",
      rotatable: false,
    });

    const result = await runWriteWorkflow(managerEnv(), { mode: "verify" });

    expect(result.outcome).toBe("verified");
    expect(WriteWorkflowResult.parse(result)).toEqual(result);
    expect(result.verification).toMatchObject({ keySet: "resolved", rows: 1, readable: 1, unreadable: 0 });
  });

  test("a master key that will not resolve resolves as a finding rather than throwing", async () => {
    // The whole reason the branch is answered before the store is opened. A throw here reaches the CLI
    // as "the manager could not be reached" — exit 1, the code a cron retries forever — over the one
    // state #647 exists for.
    await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "api-token",
      value: "v",
      valueType: "text",
      rotatable: false,
    });

    const result = await runWriteWorkflow(
      { SECRETS: env.SECRETS, SECRETS_ENCRYPTION_KEYS: "{not-an-encryption-config" },
      { mode: "verify" },
    );

    expect(result.outcome).toBe("verified");
    expect(result.verification).toMatchObject({ keySet: "unreadable", rows: 1 });
  });

  test("a batch size outside the schema is refused rather than reaching a LIMIT", async () => {
    // The payload crosses the Workflows REST API from another process, and `batchSize` reaches a `LIMIT`.
    await expect(runWriteWorkflow(managerEnv(), { mode: "verify", batchSize: 100_000 } as never)).rejects.toThrow();
    await expect(runWriteWorkflow(managerEnv(), { mode: "verify", batchSize: 0 } as never)).rejects.toThrow();
  });

  test("a verification writes nothing", async () => {
    await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "api-token",
      value: "v",
      valueType: "text",
      rotatable: false,
    });
    const db = createDatabase(env.SECRETS, secretsTables);
    const rows = await db.selectFrom("pithySecretsSystemSecrets").select(["name", "updatedAt"]).execute();
    const rotations = await db.selectFrom("pithySecretsRotations").select(["id", "status"]).execute();

    await runWriteWorkflow(managerEnv(), { mode: "verify" });

    expect(await db.selectFrom("pithySecretsSystemSecrets").select(["name", "updatedAt"]).execute()).toEqual(rows);
    expect(await db.selectFrom("pithySecretsRotations").select(["id", "status"]).execute()).toEqual(rotations);
  });

  test("adding `verified` did not narrow what the write path itself may answer", async () => {
    // A `z.enum` rebuilt by hand rather than spread from `WriteSecretOutcome.options` would drop these.
    expect(WriteWorkflowOutcome.options).toEqual(
      expect.arrayContaining(["written", "present", "absent", "deleted", "opened", "closed", "verified"]),
    );
  });
});
