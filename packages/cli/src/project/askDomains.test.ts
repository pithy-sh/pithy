// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import { askDomains } from "./askDomains";

/** Every Cloudflare client the picker built. One is a call to the account; none is the point. */
const cloudflare = vi.hoisted(() => ({ built: [] as { accountId: string }[] }));
vi.mock("../cloudflare/clients", () => ({
  cloudflareClients: async (credentials: { accountId: string }) => {
    cloudflare.built.push({ accountId: credentials.accountId });
    return { zones: () => ({ listZones: async () => [{ id: "z", name: "other.example", status: "active" }] }) };
  },
}));

/** What the prompts showed and asked. Every domain question is skipped, as on a project's first day. */
const prompts = vi.hoisted(() => ({ notes: [] as string[], selects: 0 }));
vi.mock("@clack/prompts", () => ({
  isCancel: () => false,
  note: (message: string) => {
    prompts.notes.push(message);
  },
  text: async () => "",
  select: async () => {
    prompts.selects += 1;
    return "other.example";
  },
}));

/**
 * **The picker degrades on an account mismatch, the way it degrades on everything else (#739).**
 *
 * Declaring a domain must work offline, so every failure falls back to free text with a line saying why.
 * The mismatch was the one that threw instead: the guard sat outside the `try`, and in `worker add` the
 * Worker was already on disk when it did. Another account's zones are still never offered — the picker
 * lists none and asks Cloudflare nothing.
 */
describe("askDomains under another account's credentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    cloudflare.built.length = 0;
    prompts.notes.length = 0;
    prompts.selects = 0;
  });

  test("offers free text with a line naming the mismatch, lists no zones, and finishes", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "other-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");

    const asked = await askDomains({
      projectDir: "/project",
      workerName: "api",
      interactive: true,
      account: { accountId: "pinned-account" },
    });

    expect(asked).toEqual({ domains: undefined, prompted: true });
    expect(prompts.notes).toEqual([
      "This project pins Cloudflare account pinned-account, and the environment supplies credentials for other-account. Zones are not listed. Type the domain instead.",
    ]);
    expect(prompts.selects).toBe(0);
    expect(cloudflare.built).toEqual([]);
  });

  test("lists the zones when the credentials are for the pinned account", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "pinned-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");

    await askDomains({
      projectDir: "/project",
      workerName: "api",
      interactive: true,
      account: { accountId: "pinned-account" },
    });

    expect(prompts.notes).toEqual([]);
    expect(cloudflare.built).toEqual([{ accountId: "pinned-account" }]);
  });
});
