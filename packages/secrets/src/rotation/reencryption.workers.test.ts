// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { secretsTables } from "../data/tables";
import { secrets_0003_reencryptions } from "../migrations/0003_reencryptions";
import { pendingReencryptions, recordReencryption } from "./reencryption";

const db = () => createDatabase(env.SECRETS, secretsTables);

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_reencryptions").run();
  await secrets_0003_reencryptions.up(db());
});

describe("the re-encryption record (#602)", () => {
  test("a dependent that never recorded is pending, and one recorded at the version is not", async () => {
    expect(await pendingReencryptions(db(), "auth-session-secret", ["auth-jwks"], "2")).toEqual(["auth-jwks"]);
    await recordReencryption(db(), { name: "auth-session-secret", dependent: "auth-jwks", version: "2" });
    expect(await pendingReencryptions(db(), "auth-session-secret", ["auth-jwks"], "2")).toEqual([]);
  });

  test("a record behind the version is pending, and one past it is not — compared as numbers", async () => {
    await recordReencryption(db(), { name: "auth-session-secret", dependent: "auth-jwks", version: "9" });
    expect(await pendingReencryptions(db(), "auth-session-secret", ["auth-jwks"], "10")).toEqual(["auth-jwks"]);
    await recordReencryption(db(), { name: "auth-session-secret", dependent: "auth-jwks", version: "11" });
    expect(await pendingReencryptions(db(), "auth-session-secret", ["auth-jwks"], "10")).toEqual([]);
  });

  test("recording again replaces the version rather than adding a row", async () => {
    await recordReencryption(db(), { name: "auth-session-secret", dependent: "auth-jwks", version: "2" });
    await recordReencryption(db(), { name: "auth-session-secret", dependent: "auth-jwks", version: "3" });
    const rows = await env.SECRETS.prepare("select version from pithy_secrets_reencryptions").all<{
      version: string;
    }>();
    expect(rows.results).toEqual([{ version: "3" }]);
  });

  test("a secret with nothing sealed under it has nothing pending", async () => {
    expect(await pendingReencryptions(db(), "email-link-signing-key", [], "2")).toEqual([]);
  });
});
