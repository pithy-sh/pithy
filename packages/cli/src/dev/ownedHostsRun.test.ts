// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { audit } from "@pithy-sh/audit/src/capability";
import { writeCheckpoints } from "@pithy-sh/audit/src/chain/checkpoint";
import { auditDatabase } from "@pithy-sh/audit/src/data/tables";
import { recordAuditEvent } from "@pithy-sh/audit/src/recorder";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { email } from "@pithy-sh/email/src/capability";
import { emailDatabase, emailSuppressionDatabase } from "@pithy-sh/email/src/data/tables";
import { enqueueEmail } from "@pithy-sh/email/src/send/enqueue";
import { runSend } from "@pithy-sh/email/src/send/runSend";
import { defaultTheme } from "@pithy-sh/email/src/templates/theme";
import { parse } from "comment-json";
import type { Kysely } from "kysely";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorkerTarget } from "../project/workers";
import { linkKitPackages } from "../test-utils/linkKit";
import { discoverHostWorkers, hostWorkerDir, materializeHostConfigs } from "./hostWorkers";

/**
 * **`two` owns `DB`, and its own email and audit hosts run its jobs against its database.**
 *
 * `one` shares the project's `DB`; `two` lists it and the checkpoint bucket in `ownBindings`, so its top-level stanza
 * gives `DB` a local id of its own and its audit chain is checkpointed into a bucket no other chain writes. Both compose email and audit. Discovery and materialization build the hosts the way `pithy dev` does,
 * and each host's work is then run against the database its config binds: an email `two` enqueued is sent, and an
 * audit row `two` wrote is checkpointed, through `two`'s own hosts — with `one`'s database untouched.
 */
describe("a Worker's own capability hosts run its jobs against its own database", () => {
  let dir: string;
  let miniflare: Miniflare;
  const shared = "DB";
  const owned = "acme-dev-two---db";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-owned-hosts-"));
    await linkKitPackages(dir, ["email", "audit"]);
    for (const [worker, id] of [
      ["one", shared],
      ["two", owned],
    ] as const) {
      await mkdir(join(dir, "apps", worker), { recursive: true });
      await writeFile(
        join(dir, "apps", worker, "wrangler.jsonc"),
        JSON.stringify({ name: `acme-${worker}`, d1_databases: [{ binding: "DB", database_id: id }] }),
      );
    }
    miniflare = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: "export default {};",
        d1Databases: { SHARED: shared, OWNED: owned, SUPPRESSIONS: "EMAIL_SUPPRESSIONS" },
        r2Buckets: { CHECKPOINTS: "checkpoints" },
      }),
    );
  });
  afterEach(async () => {
    await miniflare.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  /** The local D1 a host config's `DB` binding opens: Miniflare keys it on `database_id`, as wrangler does. */
  async function databaseFor(host: string): Promise<D1Database> {
    const config = parse(
      await readFile(join(hostWorkerDir(dir, host), "wrangler.jsonc"), "utf8"),
    ) as unknown as WorkflowHostTemplate;
    const id = config.d1_databases?.find((entry) => entry.binding === "DB")?.database_id;
    const binding = id === owned ? "OWNED" : id === shared ? "SHARED" : undefined;
    if (binding === undefined) throw new Error(`${host} binds DB to ${id}, which is neither database`);
    return (await miniflare.getD1Database(binding)) as unknown as D1Database;
  }

  /** The checkpoint bucket a host config binds. */
  async function bucketOf(host: string): Promise<string | undefined> {
    const config = parse(
      await readFile(join(hostWorkerDir(dir, host), "wrangler.jsonc"), "utf8"),
    ) as unknown as WorkflowHostTemplate;
    return config.r2_buckets?.find((entry) => entry.binding === "AUDIT_CHECKPOINTS")?.bucket_name;
  }

  /** Every migration a composed capability declares for `DB`, applied in order through its own database factory. */
  async function migrate(d1: D1Database, capabilities: readonly Capability[]): Promise<void> {
    for (const capability of capabilities) {
      const factory = capability.name === "audit" ? auditDatabase : emailDatabase;
      for (const spec of Object.values(capability.databases ?? {})) {
        if (spec?.binding !== "DB") continue;
        for (const name of Object.keys(spec.migrations ?? {}).sort()) {
          await spec.migrations?.[name]?.up(factory(d1) as unknown as Kysely<unknown>);
        }
      }
    }
  }

  test("sends two's email and checkpoints two's audit chain, and touches one's database not at all", async () => {
    const composed: Capability[] = [
      email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" }),
      audit(),
    ];
    const workers: WorkerTarget[] = [
      { name: "acme-one", dir: join(dir, "apps", "one"), hasWrangler: true },
      { name: "acme-two", dir: join(dir, "apps", "two"), hasWrangler: true, ownBindings: ["DB", "AUDIT_CHECKPOINTS"] },
    ];
    const { hosts, notes } = await discoverHostWorkers({
      projectDir: dir,
      workers,
      capabilitiesFor: async () => composed,
    });
    expect(notes).toEqual([]);
    expect(hosts.map((host) => host.worker.name)).toEqual(["email", "two---email", "audit", "two---audit"]);
    const materialized = await materializeHostConfigs({
      projectDir: dir,
      project: "acme",
      baseUrl: "http://localhost:8787",
      hosts,
    });
    expect(materialized).toEqual({ notes: [], failed: [] });

    const one = (await miniflare.getD1Database("SHARED")) as unknown as D1Database;
    const two = (await miniflare.getD1Database("OWNED")) as unknown as D1Database;
    await migrate(one, composed);
    await migrate(two, composed);

    // Written by `two`, into its own database, as its app Worker writes them.
    const now = new Date("2026-11-08T12:00:00.000Z");
    const { jobId } = await enqueueEmail(
      {
        db: emailDatabase(two),
        fromAddress: "noreply@acme.test",
        fromName: "Acme",
        theme: defaultTheme,
        now,
        newId: () => "job-1",
      },
      { to: "u@example.com", template: "magicLink", payload: { url: "https://two.acme.test/s", expiresMinutes: 15 } },
    );
    await recordAuditEvent(auditDatabase(two), {
      action: "auth/login",
      outcome: "success",
      actorType: "user",
      tenant: null,
    });

    // Run by `two`'s own hosts, against the database each one's config binds.
    const sent: string[] = [];
    const suppressions = (await miniflare.getD1Database("SUPPRESSIONS")) as unknown as D1Database;
    await suppressions
      .prepare(
        "create table if not exists pithy_email_suppressions (address text primary key, reason text, created_at text)",
      )
      .run();
    const outcome = await runSend(
      {
        db: emailDatabase(await databaseFor("two---email")),
        suppressionDb: emailSuppressionDatabase(suppressions),
        sender: {
          send: async (message) => {
            sent.push(message.to);
            return { messageId: "msg-1" };
          },
        },
        theme: defaultTheme,
        baseUrl: "http://localhost:8790",
        signing: { key: "signing-key", kid: "1" },
        linkTtlDays: 90,
        maxAttempts: 3,
        passStartedAt: now,
        heartbeatAt: () => now,
      },
      jobId,
    );
    expect(outcome).toMatchObject({ status: "sent", messageId: "msg-1" });
    expect(sent).toEqual(["u@example.com"]);
    const bucket = (await miniflare.getR2Bucket("CHECKPOINTS")) as unknown as R2Bucket;
    expect(await writeCheckpoints(auditDatabase(await databaseFor("two---audit")), bucket, now)).toEqual({
      written: 1,
      unchanged: 0,
    });

    // Two chains never share a checkpoint keyspace: a key names a tenant and a count, never the database.
    expect(await bucketOf("two---audit")).not.toBe(await bucketOf("audit"));

    // The shared hosts read `one`'s database, which holds none of it.
    const jobs = await one.prepare("select count(*) as n from pithy_email_jobs").first<{ n: number }>();
    expect(jobs?.n).toBe(0);
    expect(await writeCheckpoints(auditDatabase(await databaseFor("audit")), bucket, now)).toEqual({
      written: 0,
      unchanged: 0,
    });
  });
});
