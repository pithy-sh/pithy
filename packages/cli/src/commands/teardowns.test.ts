// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CommandDef } from "citty";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * **A teardown's limits hold whatever orchestrator runs it (#591).**
 *
 * `pithy support`, `storage` and `media deprovision` call the orchestrator the project installed; `email` and
 * `secrets` call the CLI's dependency. The kit's own tests prove the current orchestrators refuse. These prove the
 * CLI does not rely on it: each command is run against a **reckless** orchestrator — what every copy before #591
 * did, and worse — which removes what every environment shares first, asks nothing, and then walks every declared
 * environment, deleting whatever it can reach whether or not the operator asked.
 *
 * Nothing reaches Cloudflare. The deprovisioner is a recorder, so "removed" below means "a delete was made".
 */

type Orchestrator = (...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => {
  const calls: string[] = [];
  const running = new Set<string>();
  /** Every method any of the five commands' deprovisioners has, recording what was deleted. */
  class Recorder {
    async hasWorker(env: string) {
      return running.has(env);
    }
    async hasManager(env: string) {
      return running.has(env);
    }
    async countRetained() {
      return [];
    }
    async countSuppressionRetained() {
      return [];
    }
    async deleteWorker(env: string) {
      calls.push(`deleteWorker:${env}`);
    }
    async deleteBucket(env?: string) {
      calls.push(env === undefined ? "deleteBucket" : `deleteBucket:${env}`);
    }
    async deleteKvNamespace(env: string) {
      calls.push(`deleteKvNamespace:${env}`);
    }
    async removeRoutingRule() {
      calls.push("removeRoutingRule");
      return { removed: true };
    }
    async deleteSuppressionDatabase() {
      calls.push("deleteSuppressionDatabase");
    }
    async deleteManager(env: string) {
      calls.push(`deleteManager:${env}`);
    }
    async deleteMasterKey(env: string) {
      calls.push(`deleteMasterKey:${env}`);
    }
    async deleteDatabase(env: string) {
      calls.push(`deleteDatabase:${env}`);
    }
    async deleteManagerToken() {
      calls.push("deleteManagerToken");
    }
  }
  return { calls, running, Recorder, orchestrator: undefined as Orchestrator | undefined, invoked: 0 };
});

/** The orchestrator a command loads, whichever copy it loads it from — counted, so "never called" is checkable. */
const orchestrator: Orchestrator = async (...args) => {
  state.invoked += 1;
  if (!state.orchestrator) throw new Error("no orchestrator set");
  return state.orchestrator(...args);
};

vi.mock("../cloudflare/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/config")>()),
  cloudflareEnv: () => ({ CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token", SECRETS_STORE_ID: "store" }),
  cloudflareAccountConfirmation: () => ({ source: "test" }),
}));
vi.mock("../cloudflare/clients", () => ({ cloudflareClients: async () => ({}) }));
vi.mock("../audit/cliAudit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audit/cliAudit")>()),
  createProjectCliAudit: async () => async () => {},
}));
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: "acme" }),
  projectEnvironments: async () => ["staging", "prod"],
  projectCloudflareAccount: async () => null,
}));
vi.mock("../capabilities/supportProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/supportProvisioner")>()),
  loadSupport: async () => ({ deprovisionSupport: orchestrator }),
  CloudflareSupportDeprovisioner: state.Recorder,
}));
vi.mock("../capabilities/storageProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/storageProvisioner")>()),
  loadStorage: async () => ({ deprovisionStorage: orchestrator }),
  CloudflareStorageDeprovisioner: state.Recorder,
}));
vi.mock("../capabilities/mediaProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/mediaProvisioner")>()),
  loadMedia: async () => ({ deprovisionMedia: orchestrator }),
  CloudflareMediaDeprovisioner: state.Recorder,
}));
vi.mock("../capabilities/emailProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/emailProvisioner")>()),
  CloudflareEmailDeprovisioner: state.Recorder,
}));
vi.mock("../capabilities/secretsProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/secretsProvisioner")>()),
  CloudflareSecretsDeprovisioner: state.Recorder,
}));
vi.mock("@pithy-sh/email/src/provision/provisionEmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/email/src/provision/provisionEmail")>()),
  deprovisionEmail: orchestrator,
}));
vi.mock("@pithy-sh/secrets/src/provision/provisionSecrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/secrets/src/provision/provisionSecrets")>()),
  deprovisionSecrets: orchestrator,
}));

/** The declared environments an orchestrator was handed, in whichever shape it was handed them. */
function declaredOf(target: unknown): string[] {
  const declared = (target as { declared?: readonly string[] }).declared;
  return [...(declared ?? ["staging", "prod"])];
}

type Recorded = InstanceType<typeof state.Recorder>;

/** Shared parts first, every declared environment after, every delete made whatever the options say. */
const RECKLESS: Record<string, Orchestrator> = {
  support: async (d, target) => {
    const deprovisioner = d as Recorded;
    await deprovisioner.removeRoutingRule();
    await deprovisioner.deleteBucket();
    for (const env of declaredOf(target)) await deprovisioner.deleteWorker(env);
  },
  email: async (d, target) => {
    const deprovisioner = d as Recorded;
    await deprovisioner.deleteSuppressionDatabase();
    for (const env of declaredOf(target)) await deprovisioner.deleteWorker(env);
  },
  storage: async (d, target) => {
    const deprovisioner = d as Recorded;
    for (const env of declaredOf(target)) {
      await deprovisioner.deleteWorker(env);
      await deprovisioner.deleteBucket(env);
    }
  },
  media: async (d, target) => {
    const deprovisioner = d as Recorded;
    for (const env of declaredOf(target)) {
      await deprovisioner.deleteWorker(env);
      await deprovisioner.deleteBucket(env);
      await deprovisioner.deleteKvNamespace(env);
    }
  },
  secrets: async (d, target) => {
    const deprovisioner = d as Recorded;
    await deprovisioner.deleteManagerToken();
    for (const env of declaredOf(target)) {
      await deprovisioner.deleteManager(env);
      await deprovisioner.deleteMasterKey(env);
      await deprovisioner.deleteDatabase(env);
    }
  },
};

/** Run `pithy <name> deprovision` to its end, returning the `--json` error it reported, if any. */
async function deprovision(name: string, args: Record<string, unknown>): Promise<{ message: string } | undefined> {
  const command = (await import(`./${name}.ts`)).default as CommandDef;
  const run = (command.subCommands as Record<string, CommandDef>).deprovision?.run;
  const errors: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exited");
  }) as never);
  try {
    await run?.({ args: { json: true, ...args }, rawArgs: [] } as never);
    return undefined;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "exited") throw error;
    return JSON.parse(errors.join("")).error;
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
    exit.mockRestore();
  }
}

const R2 = { "r2-access-key-id": "id", "r2-secret-access-key": "secret" };

beforeEach(() => {
  state.calls.length = 0;
  state.running.clear();
  state.invoked = 0;
});

describe("a shared part is refused before any orchestrator is called", () => {
  test("support --routing-zone --storage for staging, while prod still runs", async () => {
    state.running.add("prod");
    state.orchestrator = RECKLESS.support;
    const error = await deprovision("support", { env: "staging", "routing-zone": "zone", storage: true, ...R2 });
    expect(error?.message).toBe(
      "The support bucket and the inbound routing rule are shared by every environment, and prod still runs. Nothing was deleted.",
    );
    expect(state.invoked).toBe(0);
    expect(state.calls).toEqual([]);
  });

  test("support --routing-zone alone", async () => {
    state.running.add("prod");
    state.orchestrator = RECKLESS.support;
    const error = await deprovision("support", { env: "staging", "routing-zone": "zone", storage: false });
    expect(error?.message).toContain("The inbound routing rule is shared by every environment");
    expect(state.calls).toEqual([]);
  });

  test("email --suppression for staging, while prod still runs", async () => {
    state.running.add("prod");
    state.orchestrator = RECKLESS.email;
    const error = await deprovision("email", { env: "staging", suppression: true, "destroy-retained": "0" });
    expect(error?.message).toBe(
      "The suppression list is shared by every environment, and prod still runs. Nothing was deleted.",
    );
    expect(state.invoked).toBe(0);
    expect(state.calls).toEqual([]);
  });

  // The token is a credential, kept rather than refused: the run goes on without it.
  test("secrets keeps the manager token while prod still runs a manager", async () => {
    state.running.add("prod");
    state.orchestrator = RECKLESS.secrets;
    await deprovision("secrets", { env: "staging", keys: true });
    expect(state.calls).not.toContain("deleteManagerToken");
  });
});

describe("an orchestrator that reaches past the named environment is stopped", () => {
  test.each([
    ["support", { storage: false }],
    ["email", { suppression: false }],
    ["storage", { storage: true, ...R2 }],
    ["media", { storage: true, ...R2 }],
    ["secrets", { keys: true }],
  ])("%s --env staging never deletes prod's", async (name, flags) => {
    state.orchestrator = RECKLESS[name];
    const error = await deprovision(name, { env: "staging", ...flags });
    expect(error?.message).toMatch(/while tearing down staging\. Refused\.$/);
    expect(state.calls.filter((call) => call.endsWith(":prod"))).toEqual([]);
  });
});

/**
 * **Every delete rule, one at a time.** The reckless orchestrators above are refused at the first method they reach,
 * which hides every rule after it: loosening `deleteWorker` to `"read"` in email still refuses — at nothing, because
 * the suppression list came first. So each row below runs an orchestrator that makes exactly one call, and says
 * whether that call is refused, made, or skipped. Loosening any single rule turns its row red.
 *
 * `"read"` rules are not rowed: a lookup deletes nothing, so there is nothing past it to loosen into.
 */
type Outcome = "refused" | "made" | "skipped";
const RULES: [
  command: string,
  flags: Record<string, unknown>,
  method: keyof Recorded,
  arg: string | undefined,
  outcome: Outcome,
][] = [
  // support: the worker is one environment's; the bucket and the routing rule are shared, and only when asked.
  ["support", { storage: false }, "deleteWorker", "prod", "refused"],
  ["support", { storage: false }, "deleteWorker", "staging", "made"],
  ["support", { storage: false }, "deleteBucket", undefined, "refused"],
  ["support", { storage: true, ...R2 }, "deleteBucket", undefined, "made"],
  ["support", { storage: false }, "removeRoutingRule", undefined, "refused"],
  ["support", { storage: false, "routing-zone": "zone" }, "removeRoutingRule", undefined, "made"],
  // email: the worker is one environment's; the suppression list is shared, and only when asked.
  ["email", { suppression: false }, "deleteWorker", "prod", "refused"],
  ["email", { suppression: false }, "deleteWorker", "staging", "made"],
  ["email", { suppression: false }, "deleteSuppressionDatabase", undefined, "refused"],
  ["email", { suppression: true, "destroy-retained": "0" }, "deleteSuppressionDatabase", undefined, "made"],
  // storage: the worker is one environment's; so is the bucket, and only when asked.
  ["storage", { storage: false }, "deleteWorker", "prod", "refused"],
  ["storage", { storage: false }, "deleteWorker", "staging", "made"],
  ["storage", { storage: false }, "deleteBucket", "staging", "refused"],
  ["storage", { storage: true, ...R2 }, "deleteBucket", "prod", "refused"],
  ["storage", { storage: true, ...R2 }, "deleteBucket", "staging", "made"],
  // media: as storage, with a namespace beside the bucket.
  ["media", { storage: false }, "deleteWorker", "prod", "refused"],
  ["media", { storage: false }, "deleteWorker", "staging", "made"],
  ["media", { storage: false }, "deleteBucket", "staging", "refused"],
  ["media", { storage: true, ...R2 }, "deleteBucket", "prod", "refused"],
  ["media", { storage: true, ...R2 }, "deleteBucket", "staging", "made"],
  ["media", { storage: false }, "deleteKvNamespace", "staging", "refused"],
  ["media", { storage: true, ...R2 }, "deleteKvNamespace", "prod", "refused"],
  ["media", { storage: true, ...R2 }, "deleteKvNamespace", "staging", "made"],
  // secrets: the manager and database are one environment's; so is the master key, and only when asked.
  ["secrets", { keys: false }, "deleteManager", "prod", "refused"],
  ["secrets", { keys: false }, "deleteManager", "staging", "made"],
  ["secrets", { keys: false }, "deleteDatabase", "prod", "refused"],
  ["secrets", { keys: false }, "deleteDatabase", "staging", "made"],
  ["secrets", { keys: false }, "deleteMasterKey", "staging", "refused"],
  ["secrets", { keys: true }, "deleteMasterKey", "prod", "refused"],
  ["secrets", { keys: true }, "deleteMasterKey", "staging", "made"],
  // The token is kept, not refused, while another environment runs a manager — and made once none does.
  ["secrets", { keys: false }, "deleteManagerToken", undefined, "skipped"],
  ["secrets", { keys: false }, "deleteManagerToken", undefined, "made"],
];

describe("each teardown rule holds on its own", () => {
  test.each(RULES)("%s %j: %s(%s) is %s", async (name, flags, method, arg, outcome) => {
    // A shared part may go only once no other environment runs; "skipped" is the token while prod still does.
    if (outcome === "skipped") state.running.add("prod");
    state.orchestrator = async (d) => {
      const deprovisioner = d as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      await deprovisioner[method]?.(...(arg === undefined ? [] : [arg]));
      return { environment: "staging", managerTokenDeleted: outcome === "made" };
    };
    const error = await deprovision(name, { env: "staging", ...flags });
    const call = arg === undefined ? method : `${method}:${arg}`;
    expect(state.invoked).toBe(1);
    if (outcome === "refused") {
      expect(error?.message).toMatch(
        new RegExp(`asked for ${method}\\(.*\\) while tearing down staging\\. Refused\\.$`),
      );
      expect(state.calls).toEqual([]);
    } else {
      expect(error).toBeUndefined();
      expect(state.calls).toEqual(outcome === "made" ? [call] : []);
    }
  });
});

describe("every teardown answers --env dev with `pithy dev`", () => {
  test.each(["support", "email", "storage", "media", "secrets"])("%s", async (name) => {
    state.orchestrator = RECKLESS[name];
    const error = (await deprovision(name, { env: "dev" })) as { message: string; action?: string } | undefined;
    expect(error?.message).toBe('"dev" is not an environment this project declares. Nothing was deleted.');
    expect(error?.action).toContain("Run `pithy dev` instead.");
    expect(state.invoked).toBe(0);
  });
});

describe("the current orchestrators run unchanged through the confinement", () => {
  test("support, last environment, everything asked for", async () => {
    const { deprovisionSupport } = await vi.importActual<
      typeof import("@pithy-sh/support/src/provision/provisionSupport")
    >("@pithy-sh/support/src/provision/provisionSupport");
    state.orchestrator = deprovisionSupport as Orchestrator;
    expect(await deprovision("support", { env: "prod", "routing-zone": "zone", storage: true, ...R2 })).toBeUndefined();
    expect(state.calls).toEqual(["removeRoutingRule", "deleteWorker:prod", "deleteBucket"]);
  });

  test("email, last environment, the list with it", async () => {
    const { deprovisionEmail } = await vi.importActual<typeof import("@pithy-sh/email/src/provision/provisionEmail")>(
      "@pithy-sh/email/src/provision/provisionEmail",
    );
    state.orchestrator = deprovisionEmail as Orchestrator;
    expect(await deprovision("email", { env: "prod", suppression: true, "destroy-retained": "0" })).toBeUndefined();
    expect(state.calls).toEqual(["deleteWorker:prod", "deleteSuppressionDatabase"]);
  });

  test("storage and media, with their storage", async () => {
    const { deprovisionStorage } = await vi.importActual<
      typeof import("@pithy-sh/storage/src/provision/provisionStorage")
    >("@pithy-sh/storage/src/provision/provisionStorage");
    state.orchestrator = deprovisionStorage as Orchestrator;
    expect(await deprovision("storage", { env: "staging", storage: true, ...R2 })).toBeUndefined();
    expect(state.calls).toEqual(["deleteWorker:staging", "deleteBucket:staging"]);

    state.calls.length = 0;
    const { deprovisionMedia } = await vi.importActual<typeof import("@pithy-sh/media/src/provision/provisionMedia")>(
      "@pithy-sh/media/src/provision/provisionMedia",
    );
    state.orchestrator = deprovisionMedia as Orchestrator;
    expect(await deprovision("media", { env: "staging", storage: true, ...R2 })).toBeUndefined();
    expect(state.calls).toEqual(["deleteWorker:staging", "deleteBucket:staging", "deleteKvNamespace:staging"]);
  });

  test("secrets, last environment, keys and token", async () => {
    const { deprovisionSecrets } = await vi.importActual<
      typeof import("@pithy-sh/secrets/src/provision/provisionSecrets")
    >("@pithy-sh/secrets/src/provision/provisionSecrets");
    state.orchestrator = deprovisionSecrets as Orchestrator;
    expect(await deprovision("secrets", { env: "prod", keys: true })).toBeUndefined();
    expect(state.calls).toEqual([
      "deleteManager:prod",
      "deleteMasterKey:prod",
      "deleteDatabase:prod",
      "deleteManagerToken",
    ]);
  });
});
