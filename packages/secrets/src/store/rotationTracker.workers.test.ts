// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, test } from "vitest";
import { secretsTables } from "../data/tables";
import { secrets_0001_init } from "../migrations/0001_init";
import {
  type RotationFailureCode,
  rotationBackedOff,
  rotationFailureCodeOf,
  rotationFailureText,
  UNCONFIRMED_BACKOFF_MS,
} from "../rotation/rotationLedger";
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
    const codes: RotationFailureCode[] = [
      "roll-failed",
      "not-recorded",
      "not-rotated",
      "at-rest-incomplete",
      "at-rest-unconfirmed",
    ];
    const written = new Set<string>();
    for (const code of codes) {
      const id = await t.startRotation("api-token", "cron", "wf");
      await t.markFailure(id, code);
      const text = (await rowById(id)).error_message;
      expect(text, code).toBe(rotationFailureText(code));
      expect(text, code).toBeTypeOf("string");
      written.add(String(text));
      // And the sentence resolves back to the code that wrote it, which is how the cron reads a failure
      // it must not re-drive tonight. Derived from one table, so the two halves cannot drift.
      expect(rotationFailureCodeOf(text), code).toBe(code);
    }
    // Distinct, so a reader can tell them apart — and as many as there are codes, so this does not pass
    // by collapsing.
    expect(written.size).toBe(codes.length);
    // Anything this release did not write is not a code. Fails if the reverse lookup ever guesses.
    expect(rotationFailureCodeOf("the rotation failed")).toBeNull();
    expect(rotationFailureCodeOf(null)).toBeNull();
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

/** How far back a row has to be for every wall-clock window this guard ever had to have expired. */
const LONGER_THAN_ANY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Backdate a row's `started_at`, which is the only thing a time-based guard ever looked at. */
async function backdate(id: number, ms: number): Promise<void> {
  await env.SECRETS.prepare("update pithy_secrets_rotations set started_at = ? where id = ?")
    .bind(Date.now() - ms, id)
    .run();
}

/**
 * **The two ledger writes and reads the at-rest rotation's guards are built on (`#647`).**
 *
 * `claimRotation` is the single-flight lock: two overlapping passes each confirm their own read-backs and
 * the loser's promoted write deletes the key every row is sealed under. `lastClosed` is the cadence guard:
 * a pass that could not confirm its write leaves `lastRotatedAt` untouched, so without a backoff the cron
 * re-drives it nightly, forever.
 */
describe("RotationTracker — the at-rest guards", () => {
  test("liveRotation sees an open pass and stops seeing it once it closes", async () => {
    const t = tracker();
    expect(await t.liveRotation("__at_rest_key_rotation__")).toBeNull();

    const id = await t.startRotation("__at_rest_key_rotation__", "cron", "wf");
    expect(await t.liveRotation("__at_rest_key_rotation__")).toBe(id);
    // A different name is a different pass, and never holds this one back.
    expect(await t.liveRotation("api-token")).toBeNull();

    await t.markSuccess(id);
    expect(await t.liveRotation("__at_rest_key_rotation__")).toBeNull();
  });

  test("the holder that already claimed retakes its own row rather than declining itself", async () => {
    // **The wedge this closes (#647 review).** `step.do` is at-least-once for the step *body*, not for its
    // effect: the claim's insert can commit and the step result never reach the journal. The resume then
    // re-executes the body, finds the open row it wrote itself, and — before this — declined. Nothing
    // releases that row, because the lock deliberately has no expiry a long pass could outlive, so one
    // ambiguous D1 fault stopped at-rest rotation permanently and looked exactly like the healthy refusal.
    //
    // Delete the `rotatedBy`-matched re-read at the tail of claimRotation and this goes red.
    const t = tracker();
    const first = await t.claimRotation("__at_rest_key_rotation__", "cron", "wf-abc", undefined, "wf-abc");

    expect(first).toBeTypeOf("number");
    // The same instance, resuming: `reclaimAs` is the Workflow instance id, identical on every attempt.
    expect(await t.claimRotation("__at_rest_key_rotation__", "cron", "wf-abc", undefined, "wf-abc")).toBe(first);
  });

  test("a pass that cannot name itself gets a pure lock, never a reclaim", () => {
    // **The reclaim is opt-in, and this is why (#647 review).** The ledger's `rotatedBy` default is the
    // constant `"cron"`. Keyed on it, every pass would match every other pass's open row and be handed the
    // lock — the collision the reclaim exists to prevent, made universal. Pass `reclaimAs` and this
    // retakes; omit it and the second caller is refused. Delete the `reclaimAs === undefined` guard in
    // claimRotation and this goes red.
    return (async () => {
      const t = tracker();
      const held = await t.claimRotation("__at_rest_key_rotation__", "cron", "cron");

      expect(held).toBeTypeOf("number");
      expect(await t.claimRotation("__at_rest_key_rotation__", "cron", "cron")).toBeNull();
    })();
  });

  test("retaking is the holder's alone — another pass still declines against an open row", async () => {
    // The re-read must not become a way in. A holder that did not open the row gets the refusal it always got.
    const t = tracker();
    const held = await t.claimRotation("__at_rest_key_rotation__", "cron", "wf-abc", undefined, "wf-abc");

    expect(held).toBeTypeOf("number");
    // Another instance, however it was created, is not this pass and does not get its row.
    expect(await t.claimRotation("__at_rest_key_rotation__", "cron", "wf-def", undefined, "wf-def")).toBeNull();
  });

  test("claimRotation opens the row and answers its id, exactly like a start", async () => {
    const t = tracker();
    const id = await t.claimRotation("__at_rest_key_rotation__", "cron", "wf");
    expect(id).toBeTypeOf("number");
    expect(await rowById(id as number)).toMatchObject({ status: "in_progress", completed_at: null });
    // And it is the row the reader sees, so the two halves of the guard agree about one row.
    expect(await t.liveRotation("__at_rest_key_rotation__")).toBe(id);
  });

  /**
   * **The overlap the wall clock let through.**
   *
   * The guard this replaced declined only while an open row was younger than six hours, and a pass that
   * runs longer than any window is a real shape: a large store, a read-back spending its propagation
   * tolerance on both gates, a Cloudflare outage the platform retries through. Its row aged out, the next
   * trigger started a second pass over the same pointer, and the loser's promoted write deleted the key
   * every row was by then sealed under.
   *
   * Fails the moment the lock keys on an age instead of on the row: a month-old open row is what the old
   * window called dead.
   */
  test("an open row declines a claim however old it is", async () => {
    const t = tracker();
    const held = await t.claimRotation("__at_rest_key_rotation__", "cron", "wf");
    await backdate(held as number, LONGER_THAN_ANY_WINDOW_MS);

    expect(await t.claimRotation("__at_rest_key_rotation__", "cron", "wf-2")).toBeNull();
    // Declined, not recorded: a pass that never started writes no history, so the ledger still holds the
    // one row and the manifest still reports the pass that is genuinely open.
    const { results } = await env.SECRETS.prepare("select id from pithy_secrets_rotations").all<{ id: number }>();
    expect(results).toHaveLength(1);

    // Closing the held row releases it, which is the only thing that does.
    await t.markFailure(held as number, "at-rest-incomplete");
    expect(await t.claimRotation("__at_rest_key_rotation__", "cron", "wf-2")).toBeTypeOf("number");
  });

  /**
   * **The gap between a select and an insert.** Two triggers that look at the same instant both see nothing
   * open, and both insert — the read-then-write shape had no barrier at all, whatever window it used. The
   * condition is on the insert now, so the statement that looks is the statement that writes.
   */
  test("two claims at once take one row between them", async () => {
    const t = tracker();
    const claims = await Promise.all([
      t.claimRotation("__at_rest_key_rotation__", "cron", "a"),
      t.claimRotation("__at_rest_key_rotation__", "cron", "b"),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const { results } = await env.SECRETS.prepare(
      "select id from pithy_secrets_rotations where status = 'in_progress'",
    ).all<{ id: number }>();
    expect(results).toHaveLength(1);
  });

  /** A different name is a different pass. One secret's rotation never holds the whole store's back. */
  test("a claim is per name", async () => {
    const t = tracker();
    await t.claimRotation("__at_rest_key_rotation__", "cron", "wf");
    expect(await t.claimRotation("api-token", "manual", "op")).toBeTypeOf("number");
  });

  test("lastClosed reports the most recent closed row, and ignores an open one", async () => {
    const t = tracker();
    const closed = await t.startRotation("__at_rest_key_rotation__", "cron", "wf");
    await t.markFailure(closed, "at-rest-unconfirmed");
    await t.startRotation("__at_rest_key_rotation__", "cron", "wf-2");

    const last = await t.lastClosed("__at_rest_key_rotation__");
    expect(last?.status).toBe("failed");
    expect(rotationFailureCodeOf(last?.errorMessage)).toBe("at-rest-unconfirmed");
    expect(last?.completedAt).toBeInstanceOf(Date);
  });

  test("lastClosed is null for a name with no closed row", async () => {
    const t = tracker();
    await t.startRotation("__at_rest_key_rotation__", "cron", "wf");
    expect(await t.lastClosed("__at_rest_key_rotation__")).toBeNull();
  });

  /**
   * The decision the cron makes off that row. Fails if the backoff stops keying on the code — an ordinary
   * failure is worth another attempt on the usual cadence, and only the unconfirmed one is a key minted
   * into an address nothing reads.
   */
  test("only an unconfirmed pass holds the cron back, and only inside the window", async () => {
    const now = new Date("2026-02-08T03:00:00.000Z");
    const inside = new Date(now.getTime() - UNCONFIRMED_BACKOFF_MS + 1000);
    const outside = new Date(now.getTime() - UNCONFIRMED_BACKOFF_MS - 1000);
    const unconfirmed = rotationFailureText("at-rest-unconfirmed");

    expect(rotationBackedOff({ status: "failed", completedAt: inside, errorMessage: unconfirmed }, now)).toBe(true);
    expect(rotationBackedOff({ status: "failed", completedAt: outside, errorMessage: unconfirmed }, now)).toBe(false);
    expect(
      rotationBackedOff(
        { status: "failed", completedAt: inside, errorMessage: rotationFailureText("at-rest-incomplete") },
        now,
      ),
    ).toBe(false);
    expect(rotationBackedOff({ status: "success", completedAt: inside, errorMessage: null }, now)).toBe(false);
    expect(rotationBackedOff(null, now)).toBe(false);
  });
});

/**
 * **`metadata_snapshot` is a write-side hole, and a read-side guard cannot close it (`#647`).**
 *
 * Four files refuse to publish this column and every one of them is a promise about the reader. The writer
 * took `unknown`, and the writer is the dangerous half: the at-rest rotation's steps hold the key set, a
 * read-back's answer and a decrypt failure in scope, and "let us journal what the read-back saw" is one
 * reasonable-looking commit. The parameter is `RotationSnapshot` now — counts, and no string leaf for a key
 * to arrive through — so the unsafe value has no shape to travel in.
 */
describe("RotationTracker — what a rotation may journal", () => {
  /** A base64-looking sentinel, the shape of the thing that must never reach this column. */
  const PLANTED_KEY = "c2tfbGl2ZV9QTEFOVEVEX0tFWV9NQVRFUklBTA==";

  async function snapshots(): Promise<(string | null)[]> {
    const { results } = await env.SECRETS.prepare("select metadata_snapshot as s from pithy_secrets_rotations").all<{
      s: string | null;
    }>();
    return results.map((row) => row.s);
  }

  test("a snapshot of counts is journalled exactly as declared", async () => {
    const t = tracker();
    await t.startRotation("api-token", "cron", "wf", { keySetSize: 3 });
    await t.claimRotation("__at_rest_key_rotation__", "cron", "wf", { keySetSize: 4 });

    expect(await snapshots()).toEqual(['{"keySetSize":3}', '{"keySetSize":4}']);
  });

  test("a caller that journals nothing writes null, not an empty object", async () => {
    await tracker().startRotation("api-token", "cron", "wf");
    expect(await snapshots()).toEqual([null]);
  });

  /**
   * The compile-time half, which is the half that matters: a key has no member to arrive through, so the
   * edit that would have journalled one does not build.
   *
   * **Proven able to fail.** Widen the parameter back to `unknown` and `tsc` reports *"Unused
   * '@ts-expect-error' directive"* on each line below, so the gate going missing is itself a red build.
   */
  test("a key, a key set and an exception have no member to arrive through", async () => {
    const t = tracker();

    // @ts-expect-error the snapshot holds counts. A key set is not one of them.
    await expect(t.startRotation("api-token", "cron", "wf", { versions: { "1": PLANTED_KEY } })).rejects.toThrow(
      PithyError,
    );
    // @ts-expect-error nor is an exception's own text, which is what reaches the at-rest catch.
    await expect(t.claimRotation("__at_rest_key_rotation__", "cron", "wf", { error: PLANTED_KEY })).rejects.toThrow(
      PithyError,
    );
    // @ts-expect-error nor is a declared count with a key smuggled beside it — `strictObject` refuses the
    // whole object rather than dropping the extra member, because dropping is silent.
    await expect(t.startRotation("api-token", "cron", "wf", { keySetSize: 1, key: PLANTED_KEY })).rejects.toThrow(
      PithyError,
    );

    // And the runtime half, because a type is absent at runtime and a JavaScript caller is not stopped by
    // one. Nothing was written at all — not the row, and so not the column.
    expect(await snapshots()).toEqual([]);
  });

  test("the refusal names the shape and nothing that arrived", async () => {
    const thrown: unknown = await tracker()
      // @ts-expect-error the shape of the edit this refuses.
      .startRotation("api-token", "cron", "wf", { readBack: PLANTED_KEY })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(PithyError);
    const payload = (thrown as PithyError).payload;
    expect(payload.detail).toBe(
      "rotation snapshot: a member is missing, is not a whole number, or is not one this table records",
    );
    // The whole payload, so a `params` or a `message` that grew a copy of the rejected value fails here too.
    expect(JSON.stringify(payload)).not.toContain(PLANTED_KEY);
    expect(JSON.stringify(payload)).not.toContain("readBack");
  });
});
