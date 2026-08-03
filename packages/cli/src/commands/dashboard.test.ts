// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { CommandDef } from "citty";
import { describe, expect, test } from "vitest";
import dashboard, {
  collectScopeFlags,
  formatConnectReport,
  formatDisconnectReport,
  formatRotateReport,
  formatStatusReport,
  parsePublicKey,
} from "./dashboard";

const JWK = { kty: "OKP", crv: "Ed25519", x: "kHo4iZ3rG3Jm2m7L9pQwXyZ0aBcDeFgHiJkLmNoPqRs" } as const;

/** The subcommands, resolved from the citty parent. */
function subCommands(): Record<string, CommandDef> {
  return dashboard.subCommands as Record<string, CommandDef>;
}

/** One subcommand's declared argument names. */
function argNames(name: string): string[] {
  return Object.keys(subCommands()[name]?.args ?? {});
}

describe("the command surface", () => {
  test("connect, rotate, revoke-key, disconnect, and status", () => {
    expect(Object.keys(subCommands())).toEqual(["connect", "rotate", "revoke-key", "disconnect", "status"]);
  });

  test("every subcommand is agent-drivable — --json and --env on all five", () => {
    for (const name of ["connect", "rotate", "revoke-key", "disconnect", "status"]) {
      expect(argNames(name)).toContain("json");
      expect(argNames(name)).toContain("env");
    }
  });

  test("connect can be driven with no prompt at all — every input is a flag", () => {
    expect(argNames("connect")).toEqual(
      expect.arrayContaining(["env", "worker-url", "scope", "update", "public-key", "issuer", "key-id", "project"]),
    );
  });

  test("disconnect takes --yes, so teardown runs headlessly", () => {
    expect(argNames("disconnect")).toContain("yes");
  });

  test("status takes --verify — a probe is opt-in, never the cost of looking", () => {
    expect(argNames("status")).toContain("verify");
  });
});

describe("collectScopeFlags", () => {
  test("collects every --scope, in both spellings — citty keeps only the last", () => {
    expect(collectScopeFlags(["connect", "--scope", "manifest:read", "--scope=keys:rotate", "--env", "prod"])).toEqual([
      "manifest:read",
      "keys:rotate",
    ]);
  });

  test("no --scope is an empty list, not a default — the caller decides what absent means", () => {
    expect(collectScopeFlags(["connect", "--env", "prod"])).toEqual([]);
  });
});

describe("parsePublicKey", () => {
  test("reads a JWK file and takes its `kid` as the key id", () => {
    const parsed = parsePublicKey(JSON.stringify({ ...JWK, kid: "own_1", use: "sig" }), undefined);
    expect(parsed).toEqual({ keyId: "own_1", publicKey: JWK });
  });

  test("--key-id wins over the file's kid", () => {
    const parsed = parsePublicKey(JSON.stringify({ ...JWK, kid: "own_1" }), "own_2");
    expect(parsed.keyId).toBe("own_2");
  });

  test("a key with no id at all is an actionable error", () => {
    const error = ((): unknown => {
      try {
        return parsePublicKey(JSON.stringify(JWK), undefined);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toContain("--key-id");
  });

  test("a non-Ed25519 key is refused before it can reach the row", () => {
    const error = ((): unknown => {
      try {
        return parsePublicKey(JSON.stringify({ kty: "EC", crv: "P-256", x: "abc", kid: "own_1" }), undefined);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(PithyError);
  });

  test("a file that is not JSON is a PithyError, never a SyntaxError", () => {
    const error = ((): unknown => {
      try {
        return parsePublicKey("-----BEGIN PUBLIC KEY-----", "own_1");
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(PithyError);
  });
});

describe("formatConnectReport", () => {
  const connected = {
    environment: "prod",
    connectionId: "5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31",
    issuer: "https://app.pithy.sh",
    workerUrl: "https://api.example.com",
    scopes: ["manifest:read", "keys:rotate"],
    keyId: "key_1",
    status: "connected" as const,
    updated: false,
  };

  test("--json is one line, carrying the dotted command name", () => {
    const line = formatConnectReport(connected, { json: true });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      command: "dashboard.connect",
      environment: "prod",
      status: "connected",
    });
  });

  test("connected ends with Done.", () => {
    const out = formatConnectReport(connected, { json: false });
    expect(out).toContain("Connected prod.");
    expect(out).toContain("key_1");
    expect(out.trimEnd().endsWith("Done.")).toBe(true);
  });

  test("needs_reconnect never says Done. — the connection is registered, not working", () => {
    const out = formatConnectReport(
      { ...connected, status: "needs_reconnect", detail: "404 from the worker" },
      { json: false },
    );
    expect(out).toContain("404 from the worker");
    expect(out).not.toContain("Done.");
  });

  test("the offline path says plainly that nothing proved the key", () => {
    const out = formatConnectReport({ ...connected, status: "registered", keyId: "own_1" }, { json: false });
    expect(out).toContain("Registered prod.");
    expect(out.toLowerCase()).toContain("prove");
  });

  test("--update reads as a re-point, not a fresh connection", () => {
    const out = formatConnectReport({ ...connected, updated: true, keyId: null }, { json: false });
    expect(out).toContain("Re-pointed prod.");
  });
});

describe("formatRotateReport", () => {
  const rotated = {
    environment: "prod",
    connectionId: "5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31",
    keyId: "key_2",
    previousKeyIds: ["key_1"],
    status: "connected" as const,
  };

  test("--json carries the dotted command name", () => {
    expect(JSON.parse(formatRotateReport(rotated, { json: true }))).toMatchObject({
      command: "dashboard.rotate",
      keyId: "key_2",
    });
  });

  test("says the old key stays live, and that expiring it is the client's call", () => {
    const out = formatRotateReport(rotated, { json: false });
    expect(out).toContain("key_2");
    expect(out).toContain("key_1");
    expect(out).toContain("still live");
    expect(out.trimEnd().endsWith("Done.")).toBe(true);
  });

  test("a rotation that did not verify says the old key is untouched, and does not say Done.", () => {
    const out = formatRotateReport({ ...rotated, status: "needs_reconnect", detail: "401" }, { json: false });
    expect(out).toContain("401");
    expect(out).not.toContain("Done.");
  });
});

describe("formatDisconnectReport", () => {
  test("--json carries the dotted command name", () => {
    expect(
      JSON.parse(
        formatDisconnectReport(
          { environment: "prod", connectionId: "c1", removed: true, dashboardNotified: true },
          { json: true },
        ),
      ),
    ).toMatchObject({ command: "dashboard.disconnect", removed: true });
  });

  test("a dashboard that could not be told does not weaken the revocation", () => {
    const out = formatDisconnectReport(
      {
        environment: "prod",
        connectionId: "c1",
        removed: true,
        dashboardNotified: false,
        detail: "Couldn't reach the management client.",
      },
      { json: false },
    );
    expect(out).toContain("Disconnected prod.");
    expect(out).toContain("Couldn't reach the management client.");
    expect(out.trimEnd().endsWith("Done.")).toBe(true);
  });

  test("nothing connected is reported, not treated as a failure", () => {
    const out = formatDisconnectReport(
      { environment: "staging", connectionId: null, removed: false, dashboardNotified: false },
      { json: false },
    );
    expect(out).toContain("Nothing connected to staging.");
  });
});

describe("formatStatusReport", () => {
  const report = {
    environment: "prod",
    connected: true,
    connectionId: "5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31",
    issuer: "https://app.pithy.sh",
    workerUrl: "https://api.example.com",
    scopes: ["manifest:read"],
    keys: [
      {
        keyId: "key_1",
        live: true,
        ageDays: 210,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: null,
        revokedAt: null,
      },
      {
        keyId: "key_0",
        live: false,
        ageDays: 575,
        validFrom: "2025-01-01T00:00:00.000Z",
        validUntil: "2026-01-02T00:00:00.000Z",
        revokedAt: null,
      },
    ],
    status: "unverified" as const,
  };

  test("--json carries the dotted command name and the whole report", () => {
    const parsed = JSON.parse(formatStatusReport(report, { json: true }));
    expect(parsed).toMatchObject({ command: "dashboard.status", connected: true });
    expect(parsed.keys).toHaveLength(2);
  });

  test("lists every key with its age and whether it is live", () => {
    const out = formatStatusReport(report, { json: false });
    expect(out).toContain("key_1");
    expect(out).toContain("210 days");
    expect(out).toContain("expired");
  });

  test("nothing connected reads as the default denying state, with the next step", () => {
    const out = formatStatusReport(
      {
        environment: "staging",
        connected: false,
        connectionId: null,
        issuer: null,
        workerUrl: null,
        scopes: [],
        keys: [],
        status: "unverified",
      },
      { json: false },
    );
    expect(out).toContain("Nothing connected to staging.");
    expect(out).toContain("pithy dashboard connect");
  });
});
