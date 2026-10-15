// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import { CloudflareManager, type CloudflareManagerConfig } from "./manager";

// Each SDK client is recorded with the token it was built for, so a test can see when one is rebuilt.
const built: string[] = [];
vi.mock("cloudflare", () => ({
  Cloudflare: class {
    readonly token: string;
    constructor(options: { apiToken: string }) {
      this.token = options.apiToken;
      built.push(options.apiToken);
    }
  },
}));

/** The smallest concrete manager: exposes what a subclass sees. */
class Probe extends CloudflareManager {
  getServiceType(): string {
    return "Probe";
  }
  async validateServiceAccess(): Promise<boolean> {
    return true;
  }
  currentToken(): string {
    return this.getApiToken();
  }
  sdk(): unknown {
    return this.getClient();
  }
}

describe("CloudflareManager — the token it calls with", () => {
  test("a plain token is used as given, for the manager's whole life", () => {
    built.length = 0;
    const manager = new Probe({ apiToken: "tok", accountId: "acct" });
    expect(manager.currentToken()).toBe("tok");
    manager.sdk();
    manager.sdk();
    expect(built).toEqual(["tok"]);
  });

  test("a provider is read at each call, and the SDK client is rebuilt only when the token changed (#759)", () => {
    // A session renews hourly. A manager built at the start of a long run must send the renewed token,
    // not the one it was constructed with — and must not rebuild a client per call to get there.
    built.length = 0;
    let current = "AT1";
    const config: CloudflareManagerConfig = { apiToken: "AT1", accountId: "acct", tokenProvider: () => current };
    const manager = new Probe(config);
    manager.sdk();
    manager.sdk();
    expect(manager.currentToken()).toBe("AT1");
    current = "AT2";
    expect(manager.currentToken()).toBe("AT2");
    expect((manager.sdk() as { token: string }).token).toBe("AT2");
    manager.sdk();
    expect(built).toEqual(["AT1", "AT2"]);
  });

  test("a provider that answers blank is refused at the call, not sent", () => {
    const manager = new Probe({ apiToken: "AT1", accountId: "acct", tokenProvider: () => "" });
    const failure = (() => {
      try {
        manager.currentToken();
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.code).toBe("cloudflare/not_configured");
  });
});
