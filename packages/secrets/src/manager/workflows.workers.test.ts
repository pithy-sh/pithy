import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { secretsTables } from "../data/tables";
import type { SecretsStoreEnv } from "../env/bindings";
import { secrets_0001_init } from "../migrations/0001_init";
import type { StepRunner } from "../rotation/atRestKeyRotation";
import { SystemSecretsStore } from "../store/systemSecretsStore";
import type { ConfigWriter } from "./configWriter";
import { runRotationWorkflow } from "./rotationWorkflow";
import { runWriteWorkflow } from "./writeWorkflow";

/** A synchronous step runner (no durable replay in tests). */
const syncStep: StepRunner = { do: (_name, fn) => fn() };

class StubWriter implements ConfigWriter {
  readonly writes: string[] = [];
  async write(value: string): Promise<void> {
    this.writes.push(value);
  }
}

/** The manager env — `SECRETS` D1 + the `SECRETS_ENCRYPTION_KEYS` string binding from Miniflare. */
function managerEnv(): SecretsStoreEnv {
  return { SECRETS: env.SECRETS, SECRETS_ENCRYPTION_KEYS: env.SECRETS_ENCRYPTION_KEYS };
}

async function latestRotationStatus(): Promise<string | undefined> {
  const row = await env.SECRETS.prepare("select status from pithy_secrets_rotations order by id desc limit 1").first<{
    status: string;
  }>();
  return row?.status;
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("runWriteWorkflow — config resolved from the SECRETS_ENCRYPTION_KEYS binding", () => {
  test("creates a secret end to end, encrypting with the bound key", async () => {
    await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "api-token",
      value: "v",
      valueType: "text",
      rotatable: false,
    });

    const store = await SystemSecretsStore.fromEnv(managerEnv());
    expect(await store.getValue("api-token")).toEqual({ currentVersion: "1", versions: { "1": "v" } });
  });

  test("audit confirms the round trip without returning the value", async () => {
    const result = await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "api-token",
      value: "round-trips",
      valueType: "text",
      rotatable: false,
      audit: true,
    });
    // Only a boolean escapes — never the value.
    expect(result).toEqual({ audited: true });
  });

  test("a write without audit returns no audit result", async () => {
    const result = await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "api-token",
      value: "v",
      valueType: "text",
      rotatable: false,
    });
    expect(result.audited).toBeUndefined();
  });

  test("audit on a delete is skipped (nothing to read back)", async () => {
    await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "x",
      value: "v",
      valueType: "text",
      rotatable: false,
    });
    const result = await runWriteWorkflow(managerEnv(), { mode: "delete", name: "x", audit: true });
    expect(result.audited).toBeUndefined();
  });

  test("the create/update intent guard runs in the worker", async () => {
    await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "x",
      value: "v",
      valueType: "text",
      rotatable: false,
    });
    await expect(
      runWriteWorkflow(managerEnv(), { mode: "create", name: "x", value: "v2", valueType: "text", rotatable: false }),
    ).rejects.toThrow();
  });

  test("delete removes the secret", async () => {
    await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "x",
      value: "v",
      valueType: "text",
      rotatable: false,
    });
    await runWriteWorkflow(managerEnv(), { mode: "delete", name: "x" });

    const store = await SystemSecretsStore.fromEnv(managerEnv());
    expect(await store.getValue("x")).toBeUndefined();
  });
});

describe("runRotationWorkflow — at-rest rotation runs locally; only the write-back is stubbed", () => {
  test("rotates the key, re-encrypts the store, prunes, and records success", async () => {
    await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "a",
      value: "va",
      valueType: "text",
      rotatable: false,
    });
    const writer = new StubWriter();

    const result = await runRotationWorkflow(managerEnv(), writer, syncStep);

    expect(result).toMatchObject({ newCurrentVersion: 2, rotated: 1, failed: 0, pruned: true });
    // The only CF-Secrets-Store writes — the merged config then the pruned config — were captured.
    expect(writer.writes).toHaveLength(2);
    expect(await latestRotationStatus()).toBe("success");
  });
});
