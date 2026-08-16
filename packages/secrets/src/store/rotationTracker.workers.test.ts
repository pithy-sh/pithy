// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { secretsTables } from "../data/tables";
import { secrets_0001_init } from "../migrations/0001_init";
import { type RotationFailureCode, rotationFailureText } from "../rotation/rotationLedger";
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

  test("markFailure records the terminal status and the code's fixed sentence", async () => {
    const t = tracker();
    const id = await t.startRotation("api-token", "manual", "op");

    await t.markFailure(id, "not-recorded");

    // The row holds `rotationFailureText("not-recorded")` — a sentence this file does not compose and the
    // caller could not have supplied.
    expect(await rowById(id)).toMatchObject({
      status: "failed",
      error_message: "rolled at the issuer, and not recorded here",
    });
  });

  test("every code writes its own fixed sentence, and no code writes anything else", async () => {
    const t = tracker();
    // Enumerated from the type, so a code added without a sentence fails to compile here rather than
    // writing `undefined` into the column.
    const codes: RotationFailureCode[] = ["roll-failed", "not-recorded", "not-rotated", "at-rest-incomplete"];
    const written = new Set<string>();
    for (const code of codes) {
      const id = await t.startRotation("api-token", "cron", "wf");
      await t.markFailure(id, code);
      const text = (await rowById(id)).error_message;
      expect(text, code).toBe(rotationFailureText(code));
      expect(text, code).toBeTypeOf("string");
      written.add(String(text));
    }
    // Distinct, so a reader can tell the four apart — and four, so this does not pass by collapsing.
    expect(written.size).toBe(4);
  });

  /**
   * The gate on `#386`, and it is a compile error rather than an assertion.
   *
   * `rotationLedger.ts` has said since it was written that `error_message` holds *"fixed text, chosen by a
   * code, never composed from an exception"*, and `atRestKeyRotation.ts` composed one from `cause.message`
   * anyway. A sentence in a doc comment is not a gate. The signature is: `markFailure` takes a
   * {@link RotationFailureCode}, so the call below — the exact shape of the defect, an exception's own text
   * heading for the column — does not typecheck.
   *
   * **Proven able to fail, in both directions.** Widen the parameter back to `string` and `tsc` reports
   * *"Unused '@ts-expect-error' directive"* on this line, so the gate going missing is itself a red build
   * rather than a silently passing test. Recorded in the issue.
   */
  test("a call site cannot compose the sentence from an exception", async () => {
    const t = tracker();
    const id = await t.startRotation("api-token", "cron", "wf-3");
    const cause = new Error("decrypt failed for value sk_live_PLANTED under key version 1");

    // @ts-expect-error `markFailure` takes a code. Free text — an exception's own message most of all —
    // has no parameter to arrive through.
    await t.markFailure(id, cause instanceof Error ? cause.message : String(cause));

    // And the runtime half, because a type is absent at runtime and a JavaScript caller is not stopped by
    // one. The column took the unknown code's fixed sentence. It did not take the planted value, and it did
    // not take the rest of the exception's text either.
    const row = await rowById(id);
    expect(row.error_message).toBe("the rotation failed");
    expect(JSON.stringify(row)).not.toContain("sk_live_PLANTED");
    expect(JSON.stringify(row)).not.toContain("decrypt failed");
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
