// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { readSecretStatus } from "../admin/status";
import { dispatchedRotationLedger } from "../cli/rotationLedger";
import { secretsTables } from "../data/tables";
import { WorkflowSecretDispatcher } from "../manager/dispatcher";
import { runWriteWorkflow } from "../manager/writeWorkflow";
import { secrets_0001_init } from "../migrations/0001_init";
import { defineSecretRegistry, type SecretRegistryEntry } from "../registry";
import { RotationTracker, trackerRotationLedger } from "../store/rotationTracker";
import { rotateSecretValue } from "./rotateValue";

/**
 * **`#379`, against a real database: does a successful rotation stop the secret reporting overdue?**
 *
 * The defect was reported as a fact about `lastRotatedAt`, and a test that asked `RotationTracker` what it
 * had just written would have passed while the product stayed broken — the writer agreeing with itself
 * proves nothing about the report an operator reads. So nothing here reads the ledger through the code
 * that fills it:
 *
 * - the **before** state is written by this file, in SQL, with dates this file computes;
 * - the **subject** is `readSecretStatus`, the same read `pithy secrets status` and the dashboard's
 *   rotation pane are served from, which is a different module from every writer involved;
 * - the **expected** `lastRotatedAt` is a bracket taken from this test's own clock either side of the run,
 *   never a value handed back by the thing that stored it.
 *
 * ## What is real
 *
 * A real D1 through Miniflare, the real migration, the real `runWriteWorkflow` — which is what a dispatch
 * lands on inside a manager Worker — and the real `WorkflowSecretDispatcher`, wired to a client that calls
 * that Workflow body in-process instead of over HTTPS. The only stand-in is the network hop, and the CLI's
 * end of it is covered by `cli/secretsRotate.e2e.test.ts` with the real binary.
 */

const NAME = "CF_ACCOUNT_TOKEN";
const MS_PER_DAY = 86_400_000;

/** A `local` secret with a cadence, which is what makes `overdue` answerable at all. */
const entry: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: true,
  valueType: "text",
  rotateEveryDays: 30,
  devValue: "random",
  origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
  rotation: { kind: "local" },
};

const registry = defineSecretRegistry({ [NAME]: entry });

/**
 * The Workflows client, with the network taken out and nothing else.
 *
 * `dispatchAndPoll` is the whole of what {@link WorkflowSecretDispatcher} uses, and this hands its params
 * straight to the Workflow body the real one would reach. The cast is to a class with private fields, which
 * no object literal can satisfy structurally; the surface actually exercised is the one method.
 */
function inProcessClient(): CloudflareWorkflowsClient {
  return {
    dispatchAndPoll: async (_workflowName: string, params: unknown) =>
      // The payload crosses as JSON in production, so it crosses as JSON here — a `Date` or a class
      // instance that survived this hop would be a shape the deployed manager never sees.
      await runWriteWorkflow(env, JSON.parse(JSON.stringify(params))),
  } as unknown as CloudflareWorkflowsClient;
}

/** The status read's own view of one secret. The subject, and never the writer. */
async function statusOf(now: Date) {
  const rows = await readSecretStatus(createDatabase(env.SECRETS, secretsTables), registry, { now });
  const row = rows.find((candidate) => candidate.name === NAME);
  if (!row) throw new Error(`no status row for ${NAME}`);
  return row;
}

/** Every rotation row, oldest first, read in SQL. Physical column names, because this is not a query builder. */
async function ledgerRows(): Promise<
  { status: string; trigger: string; rotated_by: string; completed_at: number | null }[]
> {
  const result = await env.SECRETS.prepare(
    "select status, trigger, rotated_by, completed_at from pithy_secrets_rotations where name = ? order by id",
  )
    .bind(NAME)
    .all<{ status: string; trigger: string; rotated_by: string; completed_at: number | null }>();
  return result.results;
}

/**
 * The state the bug report describes: a secret written long ago, its `baseline` row long ago, and a
 * 30-day cadence. Written here in SQL so the red state does not depend on any code under test.
 */
async function seedLongOverdue(daysAgo: number): Promise<void> {
  await runWriteWorkflow(env, {
    mode: "create",
    name: NAME,
    value: "the-old-value",
    valueType: "text",
    rotatable: true,
  });
  const then = Date.now() - daysAgo * MS_PER_DAY;
  await env.SECRETS.prepare("update pithy_secrets_system_secrets set created_at = ?, updated_at = ? where name = ?")
    .bind(then, then, NAME)
    .run();
  await env.SECRETS.prepare("update pithy_secrets_rotations set started_at = ?, completed_at = ? where name = ?")
    .bind(then, then, NAME)
    .run();
}

/** One rotation, wired exactly as `runSecretRotation` wires it: dispatched store, dispatched ledger. */
async function rotateThroughTheCli(targets: ["prod"], rotator?: () => Promise<string>) {
  const dispatcher = new WorkflowSecretDispatcher(inProcessClient(), "gate");
  return await rotateSecretValue({
    name: NAME,
    entry:
      rotator === undefined
        ? entry
        : {
            ...entry,
            rotation: { kind: "provider", issuer: "cloudflare" },
            rotator: { roll: async () => ({ newValue: await rotator() }) },
          },
    targets,
    ledger: dispatchedRotationLedger(dispatcher, { targets }),
    store: ({ env: target, value }) =>
      dispatcher
        .dispatch({ env: target, mode: "update", name: NAME, value, valueType: "text", rotatable: true })
        .then(() => undefined),
  });
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("a rotation from the command line", () => {
  test("stops the secret reporting overdue, and the report says when", async () => {
    await seedLongOverdue(200);

    // Red first, and red for the reason the issue names: 200 days against a 30-day cadence.
    const before = await statusOf(new Date());
    expect(before.overdue).toBe(true);

    // The bracket. Neither end of it comes from anything that writes a rotation row.
    const opened = Date.now();
    const outcome = await rotateThroughTheCli(["prod"]);
    const closed = Date.now();
    expect(outcome.status).toBe("rotated");

    const after = await statusOf(new Date());
    expect(after.overdue).toBe(false);
    expect(after.lastRotatedAt).not.toBeNull();
    expect(after.lastRotatedAt?.getTime()).toBeGreaterThanOrEqual(opened);
    expect(after.lastRotatedAt?.getTime()).toBeLessThanOrEqual(closed);
  });

  test("records a rotation, and the ledger still says which row was the first write", async () => {
    await seedLongOverdue(200);

    await rotateThroughTheCli(["prod"]);

    const rows = await ledgerRows();
    // Two events, not one event counted twice. A first write establishes a value; a rotation replaces one.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ trigger: "baseline", rotated_by: "baseline", status: "success" });
    expect(rows[1]).toMatchObject({ trigger: "manual", rotated_by: "pithy secrets rotate", status: "success" });
    expect(rows[1]?.completed_at).toBeTypeOf("number");
  });

  test("a rotator that has not returned yet has already left a trace", async () => {
    await seedLongOverdue(200);

    // Read from inside the roll. Whatever the rotator goes on to do — return, throw, or never answer — the
    // ledger is in this state at the moment it takes control, which is the property #372's route has and
    // the command line did not.
    let duringTheRoll: { status: string; trigger: string; rotated_by: string }[] = [];
    await rotateThroughTheCli(["prod"], async () => {
      const result = await env.SECRETS.prepare(
        "select status, trigger, rotated_by from pithy_secrets_rotations where name = ? and status = 'in_progress'",
      )
        .bind(NAME)
        .all<{ status: string; trigger: string; rotated_by: string }>();
      duringTheRoll = result.results;
      return "the-new-value";
    });

    expect(duringTheRoll).toHaveLength(1);
    expect(duringTheRoll[0]).toMatchObject({ trigger: "manual", rotated_by: "pithy secrets rotate" });
  });

  test("a rotation that never landed leaves a failed row, and the secret stays overdue", async () => {
    await seedLongOverdue(200);

    const dispatcher = new WorkflowSecretDispatcher(inProcessClient(), "gate");
    const outcome = await rotateSecretValue({
      name: NAME,
      entry,
      targets: ["prod"],
      ledger: dispatchedRotationLedger(dispatcher, { targets: ["prod"] }),
      store: async () => {
        throw new Error("prod refused the write");
      },
      attempts: 1,
    });

    expect(outcome.status).toBe("failed");
    const rows = await ledgerRows();
    expect(rows[1]).toMatchObject({ status: "failed", trigger: "manual" });
    // A failed rotation must never advance freshness. `rotationFacts` takes the newest *successful*
    // completion for exactly this case, and this is the test that would notice if it stopped.
    expect((await statusOf(new Date())).overdue).toBe(true);
  });
});

describe("the two paths agree", () => {
  /**
   * The in-Worker ledger and the dispatched one are the same act reached over different wires — a
   * control-plane rotate route holds the D1, `pithy secrets rotate` holds a dispatcher — so the rows they
   * leave must be indistinguishable but for who asked. That is the whole of what `#379` is about: two paths
   * to one act, and a product that told an operator the command line one had not happened.
   */
  test("the in-Worker ledger writes the same row the dispatched one does", async () => {
    await seedLongOverdue(200);
    const direct = trackerRotationLedger(RotationTracker.fromD1(env.SECRETS), {
      environment: "prod",
      trigger: "manual",
      rotatedBy: "control-plane:owner-1",
    });

    await rotateSecretValue({
      name: NAME,
      entry,
      targets: ["prod"],
      ledger: direct,
      store: async ({ env: target, value }) => {
        await runWriteWorkflow(env, { mode: "update", name: NAME, value, valueType: "text", rotatable: true });
        expect(target).toBe("prod");
      },
    });
    const viaWorker = (await ledgerRows())[1];

    await rotateThroughTheCli(["prod"]);
    const viaCli = (await ledgerRows())[2];

    expect(viaWorker).toMatchObject({ status: "success", trigger: "manual" });
    expect(viaCli).toMatchObject({ status: "success", trigger: "manual" });
    // Everything but the actor. The row that says *who*, says who; nothing else about the two differs.
    expect(viaWorker?.rotated_by).toBe("control-plane:owner-1");
    expect(viaCli?.rotated_by).toBe("pithy secrets rotate");
    expect((await statusOf(new Date())).overdue).toBe(false);
  });
});
