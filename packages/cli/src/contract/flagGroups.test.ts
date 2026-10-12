// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { runCommand } from "citty";
import { afterEach, describe, expect, test, vi } from "vitest";
import { refuseEventsFlag } from "../declaredFlags";
import { main } from "../main";
import { planGroupRollback } from "../migrations/groups";
import { EXIT, exitCodeOf } from "../terminal/exitClass";
import { commandAt } from "../test-utils/payloadContract";
import { contractOf, type FlagGroup } from "./commandContract";
import { walkTree } from "./describe";

/**
 * **Every flag group `pithy schema` publishes is a rule the command enforces (#697).**
 *
 * A group is declared as data beside the command, and enforced by the command's own validator — the two
 * are written in different places, so they can drift. This holds them together from both ends: every
 * declared group has a case here, and every case breaks its rule and expects the command to refuse it as a
 * usage error, exit 2, before it changes anything. A group declared and not enforced fails its case; a
 * group added without a case fails the census.
 */

// `support provision` reads its project before it reaches the routing rule. Nothing past the refusal runs.
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: "acme" }),
  projectCloudflareAccount: async () => null,
}));
vi.mock("../cloudflare/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/config")>()),
  cloudflareEnv: () => ({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token" }),
  cloudflareAccountConfirmation: () => ({ source: "test" }),
}));
vi.mock("../capabilities/supportProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/supportProvisioner")>()),
  loadSupport: async () => ({ provisionSupport: async () => ({}), isSupportCapability: () => true }),
}));
vi.mock("../project/capabilityWorker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/capabilityWorker")>()),
  resolveCapabilityWorker: async () => ({
    worker: { name: "api", dir: "/nowhere" },
    capability: { supportConfig: {} },
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

/** The one line a refused `--json` run writes, and the code it exits with. */
async function refusal(path: string, argv: readonly string[]): Promise<{ exit: number | undefined; message: string }> {
  const cmd = await commandAt(path);
  const err: string[] = [];
  let exit: number | undefined;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exit = code;
    throw new Error("exited");
  }) as never);
  await runCommand(cmd, { rawArgs: [...argv, "--json"] }).catch((error: unknown) => {
    if (!(error instanceof Error) || error.message !== "exited") throw error;
  });
  const line = JSON.parse(err.join("") || "{}") as { error?: { message?: string } };
  return { exit, message: line.error?.message ?? "" };
}

/**
 * `--events` without `--json` is refused by the bin, before any command runs, as `--pretty` is — so the case
 * asks the one function the bin asks, with the command's own argv.
 */
function eventsRefusal(argv: readonly string[]): { exit: number | undefined; message: string } {
  try {
    refuseEventsFlag(argv);
  } catch (error) {
    const { payload } = error as { payload: { code: string; message: string } };
    return { exit: exitCodeOf(payload), message: payload.message };
  }
  return { exit: undefined, message: "" };
}

/** One group's identity, as the census compares it. */
function keyOf(path: string, group: FlagGroup): string {
  const flags = group.kind === "requires" ? [group.flag, ...group.needs] : group.flags;
  return `${path}: ${group.kind} ${flags.join(" ")}`;
}

/** Each declared group, and a call that breaks it. */
const CASES: Record<string, () => Promise<{ exit: number | undefined; message: string }>> = {
  "alias: atMostOne --remove --status": () => refusal("alias", ["--remove", "--status"]),
  "doctor: atMostOne --disable-notifier --enable-notifier": () =>
    refusal("doctor", ["--disable-notifier", "--enable-notifier"]),
  "dev: atMostOne --disable-autostart --enable-autostart": () =>
    refusal("dev", ["--app", "api", "--disable-autostart", "--enable-autostart"]),
  "dev: requires --disable-autostart --app": () => refusal("dev", ["--disable-autostart"]),
  "dev: requires --enable-autostart --app": () => refusal("dev", ["--enable-autostart"]),
  "dashboard connect: requires --public-key --issuer": () => refusal("dashboard connect", ["--public-key", "key.json"]),
  "dashboard connect: requires --issuer --public-key": () =>
    refusal("dashboard connect", ["--issuer", "https://client.example.com"]),
  "dashboard connect: requires --key-id --public-key": () => refusal("dashboard connect", ["--key-id", "key_1"]),
  "dashboard connect: requires --update --worker-url --scope --public-key": () =>
    refusal("dashboard connect", ["--update"]),
  "deploy: requires --force --env": () => refusal("deploy", ["--force"]),
  "deploy: requires --events --json": async () => eventsRefusal(["deploy", "--env", "staging", "--events"]),
  "docs connect: atMostOne --client --all": () => refusal("docs connect", ["--client", "cursor", "--all"]),
  "docs disconnect: atMostOne --client --all": () => refusal("docs disconnect", ["--client", "cursor", "--all"]),
  "email provision: allOrNone --routing-zone --inbound-address --app-worker": () =>
    refusal("email provision", ["--routing-zone", "zone"]),
  "support provision: allOrNone --routing-zone --inbound-address --app-worker": () =>
    refusal("support provision", ["--routing-zone", "zone"]),
  "provision: requires --events --json": async () => eventsRefusal(["provision", "--env", "staging", "--events"]),
  "provision: exactlyOne --env --feature": async () => {
    const both = await refusal("provision", ["--env", "staging", "--feature"]);
    const neither = await refusal("provision", []);
    return { exit: both.exit === neither.exit ? both.exit : undefined, message: `${both.message} ${neither.message}` };
  },
  "upgrade: requires --latest --packages": () => refusal("upgrade", ["--latest"]),
  "upgrade: atMostOne --packages --worker": () => refusal("upgrade", ["--packages", "--worker", "api"]),
  // `migrate` reads its databases before it can name the group to reverse, so the refusal is asked of the
  // one function the run reaches it through, with nothing in scope.
  "migrate: requires --rollback --group": async () => {
    const refused = await planGroupRollback({
      env: "dev",
      driver: {} as never,
      databases: [],
      kept: [],
      requested: undefined,
    }).catch((error: unknown) => error as { payload: { code: string; message: string } });
    const payload = (refused as { payload: { code: string; message: string } }).payload;
    return { exit: exitCodeOf(payload), message: payload.message };
  },
};

describe("every published flag group is enforced", () => {
  test("every declared group has a case, and every case a declared group", async () => {
    const declared: string[] = [];
    for (const node of await walkTree(main)) {
      for (const group of contractOf(node.cmd)?.flagGroups ?? []) declared.push(keyOf(node.path.join(" "), group));
    }
    expect(declared.length).toBeGreaterThan(10);
    expect(declared.sort()).toEqual(Object.keys(CASES).sort());
  });

  test.each(Object.keys(CASES))("%s — broken, it is refused as a usage error", async (key) => {
    const run = CASES[key];
    if (run === undefined) throw new Error(`no case for ${key}`);
    const { exit, message } = await run();
    expect({ key, exit }).toEqual({ key, exit: EXIT.usage });
    expect(message).not.toBe("");
  });
});
