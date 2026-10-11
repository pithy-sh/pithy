// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { email as emailCapability } from "@pithy-sh/email/src/capability";
import { afterEach, describe, test, vi } from "vitest";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";

/**
 * **What `pithy email test` writes under `--json`, held to the schema `pithy schema email test` publishes
 * (#697).** The template renders for real, through the project's own email capability; only the send is
 * replaced, with what Cloudflare's Email Service answers. Provision and deprovision are held to theirs in
 * `environmentSkipExit.test.ts` and `teardowns.test.ts`, where their real runs already are.
 */

const sent = vi.hoisted(() => ({ messageId: "msg-1" as string | undefined }));

vi.mock("../project/workerScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/workerScope")>()),
  resolveWorkers: async () => [
    {
      name: "api",
      dir: "/does/not/exist",
      capabilities: [emailCapability({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" })],
    },
  ],
}));
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  projectCloudflareAccount: async () => null,
}));
vi.mock("../cloudflare/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/config")>()),
  cloudflareEnv: () => ({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token", SECRETS_STORE_ID: "store" }),
  cloudflareAccountConfirmation: () => ({ source: "test" }),
}));
vi.mock("../cloudflare/clients", () => ({
  cloudflareClients: async () => ({
    email: () => ({ send: async () => (sent.messageId === undefined ? {} : { messageId: sent.messageId }) }),
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pithy email test --json conforms to its published payload", () => {
  test("with the provider's message id, and without one", async () => {
    await expectConforms("email test", await runCaptured("email test", ["--to", "ada@example.test", "--json"]));
    sent.messageId = undefined;
    await expectConforms(
      "email test",
      await runCaptured("email test", ["--to", "ada@example.test", "--template", "welcome", "--json"]),
    );
  });
});
