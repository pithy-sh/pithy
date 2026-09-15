// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolve } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { type ArgsDef, type CommandDef, parseArgs } from "citty";
import { describe, expect, test, vi } from "vitest";
import { readSource } from "../ci/sourceFiles";
import { authorizeDashboard } from "../dashboard/connect";
import type { DashboardClient, DeviceAuthorization } from "../dashboard/contract";
import { defaultGrant, grantableScopes } from "../dashboard/grant";
import { OPEN_PROMPT, offerToOpen } from "../platform/browser";
import type { KeyStream } from "../terminal/keys";
import { readKeys } from "../terminal/keys";
import dashboard, {
  announceFor,
  collectScopeFlags,
  formatConnectReport,
  formatDisconnectReport,
  formatRotateReport,
  formatStatusReport,
  offerIsAnswerable,
  parsePublicKey,
} from "./dashboard";

const JWK = { kty: "OKP", crv: "Ed25519", x: "kHo4iZ3rG3Jm2m7L9pQwXyZ0aBcDeFgHiJkLmNoPqRs" } as const;

/** A composed capability with an admin surface — one read and one write, which is what a grant decides. */
const support: Capability = {
  name: "support",
  requiredBindings: [],
  adminRoutes: [
    { method: "GET", path: "/support/tickets", scope: "support:tickets:read", summary: "Page the queue." },
    { method: "POST", path: "/support/tickets/:id/close", scope: "support:tickets:close", summary: "Close one." },
  ],
};

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

describe("the scope prompt", () => {
  /** What `multiselect` was handed, captured from the mocked prompt. */
  async function renderedPrompt(): Promise<Record<string, unknown>> {
    const seen: Record<string, unknown>[] = [];
    vi.doMock("@clack/prompts", () => ({
      isCancel: () => false,
      multiselect: async (options: Record<string, unknown>) => {
        seen.push(options);
        return options.initialValues;
      },
    }));
    vi.resetModules();
    const { promptScopes } = await import("./dashboard");
    await promptScopes(grantableScopes([controlplane(), support]), defaultGrant([controlplane(), support]));
    vi.doUnmock("@clack/prompts");
    return seen[0] as Record<string, unknown>;
  }

  test("says how to take all of them: `a` toggles all, `i` inverts", async () => {
    const message = String((await renderedPrompt()).message);

    expect(message).toContain("a toggles all");
    expect(message).toContain("i inverts");
  });

  test("offers exactly what the Worker composes, described in each capability's words", async () => {
    const options = (await renderedPrompt()).options as { value: string; hint: string }[];

    expect(options.map((option) => option.value)).toEqual([
      "manifest:read",
      "keys:rotate",
      "support:tickets:read",
      "support:tickets:close",
    ]);
    expect(options[3]?.hint).toContain("support");
  });

  test("preselects the default grant, which still leaves keys:rotate's peers to be chosen", async () => {
    expect((await renderedPrompt()).initialValues).toEqual(["manifest:read", "keys:rotate", "support:tickets:read"]);
  });
});

/**
 * The gate, and what it is no longer asked to hold.
 *
 * **The decision itself is tested where it runs** — `decideGrant` in `dashboard/grant.ts`, every branch,
 * with the prompt as a seam (`grant.test.ts`). This file used to carry the whole invariant as three
 * substring checks over `dashboard.ts`, and its reach was smaller than its claim: dropping `request.all`
 * from the narrowed test disconnected `--scope all` from the command, and changing the prompt's
 * preselection widened every connect, and both stayed green here.
 *
 * **What is left for a source scan is the one thing a unit test cannot see: that `connect` still routes
 * through the decision rather than making its own.** The invariant it used to state — one list, feeding
 * the prompt and `--scope all` alike — is now structural instead of asserted: `decideGrant` computes
 * `grantableScopes` once, internally, and hands it to both. There is no second call to keep in step.
 *
 * Blind spot, stated: this reads `dashboard.ts` only, and a decision re-inlined in a module it imports
 * would pass. Nothing else in the tree decides a grant.
 */
describe("connect decides its grant in one place", () => {
  const SOURCE = blankComments(readSource(resolve(import.meta.dirname, "dashboard.ts")) ?? "");

  test("it calls `decideGrant`, and derives no part of the grant itself", () => {
    expect(SOURCE).toContain("decideGrant(");
    // The three the decision owns. `connect` naming any of them is a second decision, by definition.
    expect(SOURCE).not.toContain("grantableScopes(");
    expect(SOURCE).not.toContain("defaultGrant(");
    expect(SOURCE).not.toContain("resolveScopeRequest(");
  });
});

const AUTHORIZATION: DeviceAuthorization = {
  deviceCode: "dc_1",
  userCode: "ABCD-EFGH",
  verificationUri: "https://app.pithy.sh/cli",
  expiresInSeconds: 600,
  intervalSeconds: 1,
};

/** A management client that goes pending once and then approves — one whole device flow. */
function fakeClient(authorization: DeviceAuthorization = AUTHORIZATION): DashboardClient {
  let polls = 0;
  return {
    startDeviceAuthorization: async () => authorization,
    pollForConnectToken: async () => (polls++ === 0 ? "pending" : { connectToken: "ct_1", expiresInSeconds: 300 }),
    createConnection: async () => {
      throw new Error("unused");
    },
    rotateKey: async () => {
      throw new Error("unused");
    },
    updateConnection: async () => {},
    verifyConnection: async () => ({ status: "connected", keyId: null }),
    deleteConnection: async () => {},
  };
}

/** A stdin double with a real terminal's shape, so the offer is exercised rather than stubbed. */
function fakeStdin(isTTY: boolean): KeyStream & { send: (chunk: string) => void } {
  const listeners: ((chunk: string) => void)[] = [];
  return {
    isTTY,
    setRawMode() {},
    setEncoding() {},
    resume() {},
    pause() {},
    on(_event: "data", listener: (chunk: string) => void) {
      listeners.push(listener);
    },
    off(_event: "data", listener: (chunk: string) => void) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    send(chunk: string) {
      for (const listener of [...listeners]) listener(chunk);
    },
  } as unknown as KeyStream & { send: (chunk: string) => void };
}

/** Drive one announcement, collecting the lines and whatever the offer was pointed at. */
function announced(
  args: { json: boolean; open: boolean },
  seams: { interactive?: boolean; env?: NodeJS.ProcessEnv } = {},
  authorization: DeviceAuthorization = AUTHORIZATION,
): { lines: string[]; urls: string[] } {
  const lines: string[] = [];
  const urls: string[] = [];
  announceFor(args, {
    write: (line) => void lines.push(line),
    offerToOpen: (options) => {
      urls.push(options.url);
      // What the real primitive does when the key is live: state it, once, in its own words.
      options.write(OPEN_PROMPT);
      return { offered: true, stop: () => {} };
    },
    interactive: seams.interactive ?? true,
    env: seams.env ?? {},
  })(authorization);
  return { lines, urls };
}

describe("the offer to open the approval page", () => {
  test("names the URL and the code, then states the key, then says it is waiting", () => {
    const { lines } = announced({ json: false, open: true });
    expect(lines).toEqual([
      "Open https://app.pithy.sh/cli and enter ABCD-EFGH.",
      OPEN_PROMPT,
      "▸ Waiting for approval...",
    ]);
  });

  test("opens the plain verification uri when the client sends nothing better", () => {
    expect(announced({ json: false, open: true }).urls).toEqual(["https://app.pithy.sh/cli"]);
  });

  test("opens verificationUriComplete when the client sends one, and still prints the plain page", () => {
    const { lines, urls } = announced(
      { json: false, open: true },
      {},
      {
        ...AUTHORIZATION,
        verificationUriComplete: "https://app.pithy.sh/cli?code=ABCD-EFGH",
      },
    );

    expect(urls).toEqual(["https://app.pithy.sh/cli?code=ABCD-EFGH"]);
    // Never printed: it carries the code, and a code in a line somebody tees or screenshots is a code
    // somebody else can approve with.
    expect(lines[0]).toBe("Open https://app.pithy.sh/cli and enter ABCD-EFGH.");
    expect(lines.join("\n")).not.toContain("?code=");
  });

  test("--json neither offers nor opens, and the URL-and-code line still stands", () => {
    const { lines, urls } = announced({ json: true, open: true }, { interactive: false });
    expect(urls).toEqual([]);
    expect(lines).toEqual(["Open https://app.pithy.sh/cli and enter ABCD-EFGH.", "▸ Waiting for approval..."]);
  });

  /**
   * **The gate reads the stream the offer is written to.** Every line of this announcement goes to
   * stderr, so `pithy dashboard connect > connection.json` leaves a human watching a real terminal —
   * and the old gate, which required `stdout.isTTY`, silently withheld a key that would have worked.
   * The opposite case is the one that matters more: `2> log` means nobody sees the offer line, so
   * stating a key there would strand raw mode against an audience of nobody.
   */
  test("the offer's gate reads stdin and stderr, because that is where it speaks", () => {
    const tty = { isTTY: true } as NodeJS.ReadStream & NodeJS.WriteStream;
    const piped = { isTTY: false } as NodeJS.ReadStream & NodeJS.WriteStream;

    expect(offerIsAnswerable(false, { stdin: tty, stderr: tty })).toBe(true);
    // stdout redirected, stderr still a terminal: the offer is visible and answerable.
    expect(offerIsAnswerable(false, { stdin: tty, stderr: tty, stdout: piped })).toBe(true);
    // stderr redirected: the line reaches nobody, so no key is stated.
    expect(offerIsAnswerable(false, { stdin: tty, stderr: piped })).toBe(false);
    expect(offerIsAnswerable(false, { stdin: piped, stderr: tty })).toBe(false);
    expect(offerIsAnswerable(true, { stdin: tty, stderr: tty })).toBe(false);
  });

  test("no terminal neither offers nor opens", () => {
    const { lines, urls } = announced({ json: false, open: true }, { interactive: false });
    expect(urls).toEqual([]);
    expect(lines).not.toContain(OPEN_PROMPT);
  });

  test("--no-open neither offers nor opens", () => {
    const { lines, urls } = announced({ json: false, open: false });
    expect(urls).toEqual([]);
    expect(lines).not.toContain(OPEN_PROMPT);
  });

  test("PITHY_NO_OPEN neither offers nor opens", () => {
    const { lines, urls } = announced({ json: false, open: true }, { env: { PITHY_NO_OPEN: "1" } });
    expect(urls).toEqual([]);
    expect(lines).not.toContain(OPEN_PROMPT);
  });

  test("every subcommand that signs in takes --no-open", () => {
    for (const name of ["connect", "rotate", "revoke-key", "disconnect", "status"]) {
      expect(argNames(name)).toContain("open");
    }
  });

  /**
   * The flag is declared as `open`, not as `no-open`, and that is citty's rule rather than a preference:
   * its parser strips a `--no-` prefix off any argument and sets the *stripped* name false. A flag
   * literally named `no-open` would therefore never be set by `--no-open` and would do nothing at all.
   * `ui.ts`'s `--auth`/`--no-auth` is the same shape.
   */
  test("--no-open is what the parser turns into open: false", () => {
    const args = subCommands().connect?.args as ArgsDef;
    expect(parseArgs(["--no-open"], args).open).toBe(false);
    expect(parseArgs([], args).open).toBe(true);
  });

  /**
   * The whole point of a stated key rather than a prompt: the poll finishes whether or not anybody
   * touches the keyboard, and an opener that is missing is a sentence rather than a failed connect.
   */
  test("an opener that cannot run prints one line and the sign-in still completes", async () => {
    const lines: string[] = [];
    const stdin = fakeStdin(true);
    const announce = announceFor(
      { json: false, open: true },
      {
        write: (line) => void lines.push(line),
        offerToOpen: (options) =>
          offerToOpen({
            ...options,
            readKeys: (keyOptions) => readKeys({ ...keyOptions, stdin }),
            openUrl: () => Promise.reject(new Error("spawn xdg-open ENOENT")),
          }),
        interactive: true,
        env: {},
      },
    );

    const token = await authorizeDashboard(fakeClient(), {
      announce,
      // The key is pressed while the flow is between polls, which is the only moment it can be.
      sleep: async () => {
        stdin.send("o");
        await Promise.resolve();
        await Promise.resolve();
      },
    });

    expect(token).toBe("ct_1");
    expect(lines).toContain("spawn xdg-open ENOENT");
  });
});
