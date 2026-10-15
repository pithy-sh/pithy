// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fixOf } from "../terminal/exitClass";
import { commandCredentials, credentialsMissing } from "./commandCredentials";

/** What the account's variables hold, per case. The loader is the subject, not where the variables live. */
const vars = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));

vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  cloudflareEnv: () => vars.current,
  cloudflareAccountConfirmation: () => "vouched",
}));

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-command-credentials-"));
  vars.current = {};
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A Worker under `apps/`, composing `secrets`. */
async function secretsWorker(name: string): Promise<void> {
  const at = join(dir, "apps", name);
  await mkdir(at, { recursive: true });
  await writeFile(join(at, "wrangler.jsonc"), JSON.stringify({ name: `demo-${name}` }));
  await writeFile(join(at, "pithy.config.ts"), "export default {\n  capabilities: [\n    secrets(),\n  ],\n};\n");
}

const refusalOf = (run: () => unknown): PithyError => {
  try {
    run();
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

/** One loader for every provisioning command (#711): what it returns, and what it refuses, said once. */
describe("commandCredentials", () => {
  test("returns the account's credentials, with what vouches for the account", () => {
    vars.current = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok", R2_CREDENTIALS: "r2" };
    expect(commandCredentials(null)).toEqual({
      account: { accountId: "acct", confirmation: "vouched" },
      accountId: "acct",
      apiToken: "tok",
      storeId: "",
      r2Raw: "r2",
    });
  });

  // No command: `pithy init` records credentials only as it scaffolds, and inside a project it is refused (#711).
  test("refuses an account missing either credential, naming what supplies them and no command", () => {
    vars.current = { CLOUDFLARE_ACCOUNT_ID: "acct" };
    const refusal = refusalOf(() => commandCredentials(null));
    expect(refusal.payload).toMatchObject(credentialsMissing().payload);
    expect(refusal.payload.action).toBe(
      "Run pithy cloudflare connect to sign in, or export CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for this project's account. Then run this again.",
    );
  });

  test("asks nothing of the store unless the command needs it", () => {
    vars.current = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" };
    expect(commandCredentials(null).storeId).toBe("");
  });

  test("refuses a missing store id the command needs, naming the add for the Worker composing secrets", async () => {
    await secretsWorker("api");
    vars.current = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" };
    const refusal = refusalOf(() => commandCredentials(null, { projectDir: dir, why: "the worker reads it" }));
    expect(refusal.payload.action).toBe(
      "Run `pithy add secrets --worker api` to record SECRETS_STORE_ID (the worker reads it).",
    );
    expect(fixOf(refusal)).toBe("pithy add secrets --worker api");
  });

  test("returns the store id when the command needs it and it is recorded", () => {
    vars.current = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok", SECRETS_STORE_ID: "store" };
    expect(commandCredentials(null, { projectDir: dir, why: "x" }).storeId).toBe("store");
  });
});
