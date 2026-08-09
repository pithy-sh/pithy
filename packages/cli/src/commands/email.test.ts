// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { CommandDef } from "citty";
import { beforeEach, describe, expect, test, vi } from "vitest";
import email, { resolveRouting } from "./email";

/** The three flags, in the order the refusal names them. */
const ROUTING_FLAGS = ["--routing-zone", "--inbound-address", "--app-worker"] as const;

/**
 * The project name is resolved at this command edge, and every email name leads with it — the
 * `<project>-global-email-suppressions` database, the per-environment workers, the bounce routing rule.
 * The suppression database is found by name and reused, so a guessed name adopts another project's
 * opt-out list; teardown recomputes the same names, so a guessed name there deletes nothing and exits 0.
 */

const root = vi.hoisted(() => ({ config: {} as { name?: string } }));

// Belt and braces: no credentials resolve, so nothing here can reach a real Cloudflare account even if the
// name check is ever moved later in the command. The refusal under test is local and comes first anyway.
vi.mock("@pithy-sh/cloudflare/src/env/devVars", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/cloudflare/src/env/devVars")>()),
  loadCloudflareEnv: () => ({}),
}));

// Only the root config is stubbed. `requireProjectName` stays real, so this exercises the actual refusal.
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => root.config,
}));

function subcommand(name: string): CommandDef {
  const entry = (email.subCommands as Record<string, CommandDef>)[name];
  if (!entry) throw new Error(`expected subcommand "${name}"`);
  return entry;
}

/** Run a subcommand to its first failure and return the `--json` error payload it reported. */
async function failure(name: string, args: Record<string, unknown>): Promise<{ code: string; message: string }> {
  const lines: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  // withErrorReporting exits the process after reporting; throwing instead keeps the run in this test.
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exited");
  }) as never);
  try {
    await expect(subcommand(name).run?.({ args, rawArgs: [] } as never)).rejects.toThrow("exited");
  } finally {
    stderr.mockRestore();
    exit.mockRestore();
  }
  return JSON.parse(lines.join("")).error;
}

describe("pithy email", () => {
  beforeEach(() => {
    root.config = {};
  });

  test("provision refuses a project with no name, before it reaches Cloudflare", async () => {
    const error = await failure("provision", { json: true });
    expect(error.code).toBe("validation/invalid_input");
    expect(error.message).toBe("pithy.config.ts has no `name`.");
  });

  test("deprovision refuses a project with no name rather than deleting nothing and exiting 0", async () => {
    const error = await failure("deprovision", { json: true, suppression: false });
    expect(error.message).toBe("pithy.config.ts has no `name`.");
  });
});

/**
 * **A partial routing set is a refusal, not a silent "no routing".**
 *
 * `provision` used to wire inbound routing only when all three flags were present and carry on
 * otherwise — no rule, no warning, exit 0. Two flags of three looks like success, and the consequence
 * is invisible until somebody replies to a message and the mail goes nowhere. `pithy support` makes the
 * same decision and refuses (`commands/support.ts` `resolveRouting`); this is that rule adopted.
 */
describe("email provision's routing flags are all three or none", () => {
  test("all three is a rule", () => {
    expect(resolveRouting("zone-1", "bounce@bounce.example.com", "pithy-app-prod")).toEqual({
      zoneId: "zone-1",
      address: "bounce@bounce.example.com",
      appWorkerName: "pithy-app-prod",
    });
  });

  test("none is the ordinary opt-out", () => {
    expect(resolveRouting(undefined, undefined, undefined)).toBeUndefined();
  });

  // The refusal names what is *missing*, because that is the only thing the operator has to type next.
  test.each([
    [
      ["zone-1", undefined, undefined],
      ["--inbound-address", "--app-worker"],
    ],
    [
      [undefined, "bounce@bounce.example.com", undefined],
      ["--routing-zone", "--app-worker"],
    ],
    [
      [undefined, undefined, "pithy-app-prod"],
      ["--routing-zone", "--inbound-address"],
    ],
    [["zone-1", "bounce@bounce.example.com", undefined], ["--app-worker"]],
    [["zone-1", undefined, "pithy-app-prod"], ["--inbound-address"]],
    [[undefined, "bounce@bounce.example.com", "pithy-app-prod"], ["--routing-zone"]],
  ] as [[string | undefined, string | undefined, string | undefined], string[]][])(
    "%j refuses and names %j",
    (flags, missing) => {
      const thrown = (() => {
        try {
          resolveRouting(...flags);
        } catch (error) {
          return error;
        }
        return undefined;
      })();
      expect(thrown).toBeInstanceOf(ValidationError);
      const payload = (thrown as ValidationError).payload;
      expect(payload.message).toBe("The inbound routing options are incomplete.");
      for (const flag of missing) expect(payload.action).toContain(flag);
      // And it never names a flag that *was* given: an action that lists all three reads as "you got
      // everything wrong", which is the sentence that sends an operator back to the docs.
      for (const flag of ROUTING_FLAGS.filter((candidate) => !missing.includes(candidate))) {
        expect(payload.action?.split(", or none of the three")[0]).not.toContain(flag);
      }
    },
  );

  // Before the project name, the credentials, and every Cloudflare call: a flag typo must cost nothing.
  test("the command refuses a partial set before it reaches Cloudflare", async () => {
    root.config = { name: "acme" };
    const error = await failure("provision", { json: true, "routing-zone": "zone-1" });
    expect(error.code).toBe("validation/invalid_input");
    expect(error.message).toBe("The inbound routing options are incomplete.");
  });
});
