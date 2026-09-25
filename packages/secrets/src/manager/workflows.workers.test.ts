// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { AT_REST_ROTATION_NAME } from "../data/secretRotations";
import { secretsTables } from "../data/tables";
import { resolveEncryptionConfig, type SecretsStoreEnv } from "../env/bindings";
import { secrets_0001_init } from "../migrations/0001_init";
import type { StepRunner } from "../rotation/atRestKeyRotation";
import { RotationTracker } from "../store/rotationTracker";
import { SystemSecretsStore } from "../store/systemSecretsStore";
import { StubConfigStore } from "../test-utils/stubConfigWriter";
import { runRotationWorkflow } from "./rotationWorkflow";
import manager, { type SecretsManagerEnv } from "./worker";
import { runWriteWorkflow, type WriteWorkflowPayload } from "./writeWorkflow";

/** A synchronous step runner (no durable replay in tests). */
const syncStep: StepRunner = { do: (_name, fn) => fn(), sleep: async () => undefined };

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
    // Only the outcome and a boolean escape — never the value.
    expect(result).toEqual({ outcome: "written", audited: true });
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

  /**
   * The end of the read path the CLI depends on: a probe crosses out of the Worker as this instance
   * output and is decoded on the far side (`manager/dispatcher.ts`). It carries the presence bit and
   * nothing else — no value, no envelope, no version — and `audit: true` cannot coax one out, because
   * a probe wrote nothing to read back.
   */
  test("probe answers presence and returns no value, even when asked to audit", async () => {
    await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "session",
      value: "the-live-one",
      valueType: "text",
      rotatable: false,
    });

    expect(await runWriteWorkflow(managerEnv(), { mode: "probe", name: "session", audit: true })).toEqual({
      outcome: "present",
    });
    expect(await runWriteWorkflow(managerEnv(), { mode: "probe", name: "absent-one" })).toEqual({ outcome: "absent" });

    const store = await SystemSecretsStore.fromEnv(managerEnv());
    expect(await store.getValue("session")).toEqual({ currentVersion: "1", versions: { "1": "the-live-one" } });
    expect(await store.getValue("absent-one")).toBeUndefined();
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

/**
 * **The rotation ledger arriving as a dispatch (`#379`).**
 *
 * `pithy secrets rotate` cannot reach `pithy_secrets_rotations` — the master key is worker-only, so every
 * value-touching command is a dispatch — and it must record a rotation anyway, or a fully successful
 * command leaves the secret reporting overdue forever. These two modes are how it does, and they are the
 * same rows the in-Worker ledger writes.
 */
describe("runWriteWorkflow — the rotation ledger", () => {
  test("opens a row and hands back the id, touching no store and no key", async () => {
    const result = await runWriteWorkflow(managerEnv(), {
      mode: "rotation-open",
      name: "CF_TOKEN",
      trigger: "manual",
      rotatedBy: "pithy secrets rotate",
    });

    expect(result.outcome).toBe("opened");
    expect(result.rotationId).toBeTypeOf("number");
    const row = await env.SECRETS.prepare(
      "select status, trigger, rotated_by from pithy_secrets_rotations where id = ?",
    )
      .bind(result.rotationId)
      .first<{ status: string; trigger: string; rotated_by: string }>();
    // `in_progress` is the trace: a rotator that never returns leaves this behind rather than nothing.
    expect(row).toMatchObject({ status: "in_progress", trigger: "manual", rotated_by: "pithy secrets rotate" });
  });

  test("closes a row success, which is what moves lastRotatedAt", async () => {
    const opened = await runWriteWorkflow(managerEnv(), {
      mode: "rotation-open",
      name: "CF_TOKEN",
      trigger: "manual",
      rotatedBy: "op",
    });

    const result = await runWriteWorkflow(managerEnv(), {
      mode: "rotation-close",
      rotationId: opened.rotationId ?? 0,
      closure: { status: "success" },
    });

    expect(result).toEqual({ outcome: "closed" });
    expect(await latestRotationStatus()).toBe("success");
  });

  test("a failed closure carries a code, and the sentence is composed in here", async () => {
    const opened = await runWriteWorkflow(managerEnv(), {
      mode: "rotation-open",
      name: "CF_TOKEN",
      trigger: "manual",
      rotatedBy: "op",
    });

    await runWriteWorkflow(managerEnv(), {
      mode: "rotation-close",
      rotationId: opened.rotationId ?? 0,
      closure: { status: "failed", reason: "not-recorded" },
    });

    const row = await env.SECRETS.prepare("select status, error_message from pithy_secrets_rotations where id = ?")
      .bind(opened.rotationId)
      .first<{ status: string; error_message: string | null }>();
    expect(row?.status).toBe("failed");
    // Fixed text chosen by a code. `admin/status.ts` refuses to publish this column precisely because free
    // text is where a value gets pasted by accident, and nothing on this wire could carry one.
    expect(row?.error_message).toBe("rolled at the issuer, and not recorded here");
  });

  test.each([
    { mode: "rotation-open", name: "", trigger: "manual", rotatedBy: "op" },
    { mode: "rotation-open", name: "CF_TOKEN", trigger: "whenever", rotatedBy: "op" },
    { mode: "rotation-close", rotationId: 0, closure: { status: "success" } },
    { mode: "rotation-close", rotationId: 1, closure: { status: "failed" } },
    { mode: "rotation-close", rotationId: 1, closure: { status: "failed", reason: "because" } },
    { mode: "rotation-close", rotationId: 1, closure: { status: "failed", reason: "the-token-is-sk-live-1" } },
  ])("refuses a ledger payload it cannot read: %s", async (payload) => {
    // The payload crosses from another process, so it is untrusted like any other input — and `rotationId`
    // addresses a row, so an unvalidated one closes somebody else's rotation.
    await expect(runWriteWorkflow(managerEnv(), payload as unknown as WriteWorkflowPayload)).rejects.toThrow();
    expect(await latestRotationStatus()).toBeUndefined();
  });
});

describe("runRotationWorkflow — at-rest rotation runs locally; only the write-back is stubbed", () => {
  test("rotates the key, re-encrypts the store, and records success", async () => {
    await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "a",
      value: "va",
      valueType: "text",
      rotatable: false,
    });
    const bound = await resolveEncryptionConfig(managerEnv());
    const store = new StubConfigStore({ bound });

    const result = await runRotationWorkflow(managerEnv(), store.writer, syncStep, store.reader);

    // Two write-backs: the staged key set under the unchanged pointer, then the promoted envelope.
    // Nothing is pruned in the pass that rotated — the superseded key survives a generation.
    expect(result).toMatchObject({ newCurrentVersion: 2, rotated: 1, failed: 0, pruned: false });
    expect(store.writes.map((write) => write.config.currentVersion)).toEqual(["1", "2"]);
    expect(await latestRotationStatus()).toBe("success");
  });

  /**
   * **The default reader is the Worker's own binding, and that is the whole point of `#647`.**
   *
   * Under Miniflare `SECRETS_ENCRYPTION_KEYS` is a fixed string, so a write can never come back through
   * it — which is exactly the shape of the production failure this seam exists to catch, and it means a
   * caller that passes no reader gets the real one and is correctly refused. Fails if `runRotationWorkflow`
   * ever defaults the read-back to something that can answer its own write.
   */
  test("with no reader supplied it reads the real binding, and refuses a write that cannot come back", async () => {
    await runWriteWorkflow(managerEnv(), {
      mode: "create",
      name: "a",
      value: "va",
      valueType: "text",
      rotatable: false,
    });
    const store = new StubConfigStore({ bound: await resolveEncryptionConfig(managerEnv()) });

    await expect(
      runRotationWorkflow(managerEnv(), store.writer, { do: syncStep.do, sleep: async () => undefined }),
    ).rejects.toThrow("did not come back through the binding");

    // The staged write and nothing else, and no row moved off the old key.
    expect(store.writes).toHaveLength(1);
    expect(await latestRotationStatus()).toBe("failed");
  });
});

/**
 * **The cron's two guards (`#647`).**
 *
 * The rotation Workflow is started by `scheduled()`, and both of the things that keep a pass from
 * destroying a store live there rather than in the pass: the deterministic instance id that makes two
 * concurrent passes impossible, and the backoff that stops a structurally failed pass being re-driven
 * every night at 03:00 forever.
 */
describe("the manager cron", () => {
  function cronEnv(overrides: Partial<SecretsManagerEnv> = {}): SecretsManagerEnv {
    return {
      SECRETS: env.SECRETS,
      SECRETS_ENCRYPTION_KEYS: env.SECRETS_ENCRYPTION_KEYS,
      ENVIRONMENT: "staging",
      PROJECT: "acme",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "token",
      SECRETS_STORE_ID: "store",
      AT_REST_ROTATION: { create: async () => undefined },
      ...overrides,
    } as unknown as SecretsManagerEnv;
  }

  /** Every `create` the cron made, with the id it composed. */
  function recordingBinding(): {
    created: ({ id?: string } | undefined)[];
    create: SecretsManagerEnv["AT_REST_ROTATION"];
  } {
    const created: ({ id?: string } | undefined)[] = [];
    return { created, create: { create: async (options) => void created.push(options) } };
  }

  test("starts the rotation under a deterministic instance id", async () => {
    const binding = recordingBinding();
    await manager.scheduled(null, cronEnv({ AT_REST_ROTATION: binding.create }));
    // The bound config's `lastRotatedAt` is the fixture's, decades of days ago, so the pass is due.
    expect(binding.created).toHaveLength(1);
    expect(binding.created[0]?.id).toMatch(/^at-rest-1-\d{4}-\d{2}-\d{2}$/);
  });

  /**
   * Fails if the backoff is removed: `lastRotatedAt` is deliberately not advanced by a pass that could
   * not confirm its write, so without this the cron mints a fresh key and rewrites the same orphan entry
   * every night, forever.
   */
  test("stands down after a pass that could not confirm its write", async () => {
    const tracker = RotationTracker.fromD1(env.SECRETS);
    const id = await tracker.startRotation(AT_REST_ROTATION_NAME, "cron", "wf");
    await tracker.markFailure(id, "at-rest-unconfirmed");

    const binding = recordingBinding();
    await manager.scheduled(null, cronEnv({ AT_REST_ROTATION: binding.create }));

    expect(binding.created).toEqual([]);
  });

  /** And only that failure holds it back — an ordinary one is worth another attempt on the usual cadence. */
  test("an ordinary failure does not hold the next pass back", async () => {
    const tracker = RotationTracker.fromD1(env.SECRETS);
    const id = await tracker.startRotation(AT_REST_ROTATION_NAME, "cron", "wf");
    await tracker.markFailure(id, "at-rest-incomplete");

    const binding = recordingBinding();
    await manager.scheduled(null, cronEnv({ AT_REST_ROTATION: binding.create }));

    expect(binding.created).toHaveLength(1);
  });
});
