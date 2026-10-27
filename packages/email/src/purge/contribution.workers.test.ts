// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields, isRetained, type PurgeContext } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { email } from "../capability";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { EMAIL_PURGE_SUMMARY, EMAIL_RETENTION_BASIS, emailUserPurge } from "./contribution";

/**
 * Email's part of a person's purge and export (#814), over real D1: it retains with a basis, and the export answers
 * for the account's address on the suppression list and in the mail log — never a message's variables, which hold a
 * sign-in link, and never a tracked click's URL.
 */

const T = 1_700_000_000_000;
const purge = emailUserPurge();
const context = (address: string | null): PurgeContext => ({
  subject: { type: "user", id: "ada" },
  env: { DB: env.DB, EMAIL_SUPPRESSIONS: env.EMAIL_SUPPRESSIONS },
  address: async () => address,
});

async function exportOf(input: PurgeContext): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(input);
}

const JOB =
  "INSERT INTO pithy_email_jobs (id, to_address, recipient_key, from_address, from_name, subject, template, category, payload, status, mode, send_at, created_at, updated_at) VALUES (?, ?, ?, 'noreply@acme.test', 'Acme', 'Sign in', 'magicLink', 'transactional', ?, 'sent', 'immediate', ?, ?, ?)";
const EVENT =
  "INSERT INTO pithy_email_events (id, job_id, recipient, type, link_url, created_at) VALUES (?, ?, ?, 'click', ?, ?)";

beforeEach(async () => {
  for (const table of ["pithy_email_events", "pithy_email_jobs"]) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await env.EMAIL_SUPPRESSIONS.exec("DROP TABLE IF EXISTS pithy_email_suppressions");
  await email_0001_init.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  await email_0001_suppressions.up(createDatabase(env.EMAIL_SUPPRESSIONS, {}) as unknown as Kysely<unknown>);
  const link = JSON.stringify({ url: "https://acme.test/verify?token=secret-sign-in" });
  await env.DB.prepare(JOB).bind("j1", "Ada@example.test", "ada@example.test", link, T, T, T).run();
  await env.DB.prepare(JOB).bind("j2", "bob@example.test", "bob@example.test", link, T, T, T).run();
  await env.DB.prepare(EVENT).bind(1, "j1", "ada@example.test", "https://acme.test/verify?token=secret-click", T).run();
  await env.EMAIL_SUPPRESSIONS.prepare(
    "INSERT INTO pithy_email_suppressions (id, email, reason, created_at) VALUES (1, 'ada@example.test', 'unsubscribe', ?), (2, 'bob@example.test', 'complaint', ?)",
  )
    .bind(T, T)
    .run();
});

describe("the email user purge", () => {
  test("email() declares it for the user subject: retained, with a basis and an export, and no erase", () => {
    const declared = email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" }).purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    const [contribution] = declared;
    expect(contribution?.summary).toBe(EMAIL_PURGE_SUMMARY);
    expect(contribution && isRetained(contribution)).toBe(true);
    expect(contribution?.retain?.basis).toBe(EMAIL_RETENTION_BASIS);
    expect(contribution?.erase).toBeUndefined();
  });

  test("exports the address's suppression and its mail log, found by the account's address", async () => {
    const data = await exportOf(context(" Ada@Example.test"));
    expect(data.suppressions).toEqual([expect.objectContaining({ email: "ada@example.test", reason: "unsubscribe" })]);
    expect((data.jobs as { id: string }[]).map((row) => row.id)).toEqual(["j1"]);
    expect((data.events as { id: number }[]).map((row) => row.id)).toEqual([1]);
    expect(JSON.stringify(data)).not.toContain("bob");
  });

  test("never a message's variables or a tracked link, and no credential", async () => {
    const data = await exportOf(context("ada@example.test"));
    expect(JSON.stringify(data)).not.toContain("secret-");
    expect(credentialFields(data)).toEqual([]);
  });

  test("with no address to read, there is nothing to export", async () => {
    expect(await exportOf(context(null))).toEqual({ suppressions: [], jobs: [], events: [] });
  });
});
