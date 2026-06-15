import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { secretsTables } from "../data/tables";
import { secrets_0001_init } from "../migrations/0001_init";
import { RotationTracker } from "./rotationTracker";

function tracker(): RotationTracker {
  return RotationTracker.fromD1(env.SECRETS);
}

async function rowById(
  id: number,
): Promise<{ status: string; completed_at: number | null; error_message: string | null }> {
  const row = await env.SECRETS.prepare(
    "select status, completed_at, error_message from pithy_secrets_rotations where id = ?",
  )
    .bind(id)
    .first<{ status: string; completed_at: number | null; error_message: string | null }>();
  if (!row) throw new Error(`no rotation row ${id}`);
  return row;
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("RotationTracker", () => {
  test("startRotation opens an in_progress row; markSuccess closes it", async () => {
    const t = tracker();
    const id = await t.startRotation("api-token", "cron", "wf-1");
    expect(await rowById(id)).toMatchObject({ status: "in_progress", completed_at: null });

    await t.markSuccess(id);

    const row = await rowById(id);
    expect(row.status).toBe("success");
    expect(row.completed_at).toBeTypeOf("number");
  });

  test("markFailure records the terminal status and a reason", async () => {
    const t = tracker();
    const id = await t.startRotation("api-token", "manual", "op");

    await t.markFailure(id, "decrypt failed under key version 1");

    expect(await rowById(id)).toMatchObject({ status: "failed", error_message: "decrypt failed under key version 1" });
  });

  test("recordBaseline seeds a success row; getLatestSuccess returns its Date", async () => {
    const t = tracker();
    expect(await t.getLatestSuccess("api-token")).toBeNull();

    await t.recordBaseline("api-token");

    const latest = await t.getLatestSuccess("api-token");
    expect(latest).toBeInstanceOf(Date);
  });

  test("purgeHistory removes a secret's rows and returns the count", async () => {
    const t = tracker();
    await t.recordBaseline("api-token");
    await t.startRotation("api-token", "cron", "wf-2");

    const removed = await t.purgeHistory("api-token");

    expect(removed).toBe(2);
    expect(await t.getLatestSuccess("api-token")).toBeNull();
  });
});
