// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { recorder } from "./cloudflareRecorder";

/** The recorder is what proves a dry run made no write call, so it has to tell a read from a write. */
describe("recorder", () => {
  test("answers a read with nothing and records it as a call, not a write", async () => {
    const account = recorder();
    const clients = (await account.clients()) as { workers: () => { listWorkers: () => Promise<unknown> } };
    expect(await clients.workers().listWorkers()).toEqual([]);
    expect(account.calls).toEqual(["workers.listWorkers"]);
    expect(account.writes).toEqual([]);
  });

  test("refuses a write and records it, so a test that swallowed the throw still sees it", async () => {
    const account = recorder();
    const clients = (await account.clients()) as { d1: () => { createDatabase: () => Promise<unknown> } };
    await expect(clients.d1().createDatabase()).rejects.toThrow(/d1.createDatabase, which writes/);
    expect(account.writes).toEqual(["d1.createDatabase"]);
  });

  test("a read whose name does not say so is still a read", async () => {
    const account = recorder();
    const clients = (await account.clients()) as { workers: () => { accountSubdomain: () => Promise<unknown> } };
    expect(await clients.workers().accountSubdomain()).toBeNull();
    expect(account.writes).toEqual([]);
  });
});
