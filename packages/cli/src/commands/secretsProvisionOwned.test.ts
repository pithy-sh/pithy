// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { MintedSecret } from "../capabilities/mintSecrets";
import { runCaptured } from "../test-utils/payloadContract";

/** Which manager each mint went through: `undefined` for the shared one, the owner for a Worker's own. */
const minted = vi.hoisted(() => [] as (string | undefined)[]);
const composed = vi.hoisted(() => ({ name: "secrets" }));
/** Every step in the order it ran: a deploy or a migration of an owner's manager, and each mint. */
const steps = vi.hoisted(() => [] as string[]);
/** The `SECRETS` id each environment's stanza of `apps/two` gives its own vault. */
const vaults = vi.hoisted(() => ({ staging: "two-staging", prod: "two-prod" }) as Record<string, string | undefined>);

vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: "acme" }),
  projectCloudflareAccount: async () => null,
  projectEnvironments: async () => ["staging", "prod"],
}));
vi.mock("../cloudflare/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/config")>()),
  cloudflareEnv: () => ({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token", SECRETS_STORE_ID: "store" }),
  cloudflareAccountConfirmation: () => ({ source: "test" }),
}));
vi.mock("../cloudflare/clients", () => ({ cloudflareClients: async () => ({}) }));
vi.mock("../audit/cliAudit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audit/cliAudit")>()),
  createProjectCliAudit: async () => async () => {},
}));
vi.mock("../capabilities/secretsDispatcher", () => ({
  buildSecretDispatcher: async (
    _account: string,
    _token: string,
    _project: string,
    _feature: unknown,
    owner?: string,
  ) => ({
    owner,
  }),
}));
vi.mock("../capabilities/secretsProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/secretsProvisioner")>()),
  CloudflareSecretsProvisioner: class {
    async migrate(env: string, databaseId: string) {
      steps.push(`migrate ${env} ${databaseId}`);
    }
    async deployManager(env: string, resolved: { databaseId: string; owner?: string }) {
      steps.push(`deploy ${env} ${resolved.owner ?? "shared"} ${resolved.databaseId}`);
    }
  },
}));
vi.mock("@pithy-sh/secrets/src/provision/provisionSecrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/secrets/src/provision/provisionSecrets")>()),
  provisionSecrets: async () => ({
    perEnv: [
      { env: "staging", databaseId: "db-staging", storeId: "store" },
      { env: "prod", databaseId: "db-prod", storeId: "store" },
    ],
  }),
}));
vi.mock("../project/workerScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/workerScope")>()),
  resolveWorkers: async () => [
    {
      name: "one",
      dir: "/proj/apps/one",
      config: {},
      capabilities: [composed],
      target: { name: "one", dir: "/proj/apps/one" },
    },
    {
      name: "two",
      dir: "/proj/apps/two",
      config: {},
      capabilities: [composed],
      target: { name: "two", dir: "/proj/apps/two", ownBindings: ["SECRETS"] },
    },
  ],
}));
vi.mock("../capabilities/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/secrets")>()),
  resolveSecretRegistry: () => ({}),
}));
vi.mock("../provision/secretBindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provision/secretBindings")>()),
  workerSecretRegistry: () => ({ "auth-session-secret": {} }),
  secretsStoreBindings: async () => ({
    bound: [
      { binding: "EMAIL_LINK_SIGNING_KEY", store_id: "store", secret_name: "acme-staging-email-link-signing-key" },
    ],
    missing: [],
    minted: ["email-link-signing-key"],
  }),
}));
vi.mock("../provision/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provision/store")>()),
  cloudflareSecretsStore: () => ({ exists: async () => true }),
}));
vi.mock("../provision/wranglerEnv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provision/wranglerEnv")>()),
  applySecretBindings: async () => {},
}));
vi.mock("../project/wrangler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/wrangler")>()),
  readOptionalWranglerConfig: async (dir: string) =>
    dir === "/proj/apps/two"
      ? {
          env: Object.fromEntries(
            Object.entries(vaults).map(([env, id]) => [
              env,
              {
                d1_databases: id
                  ? [{ binding: "SECRETS", database_name: `acme-${env}-two---secrets`, database_id: id }]
                  : [],
              },
            ]),
          ),
        }
      : null,
}));
vi.mock("../capabilities/mintSecrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/mintSecrets")>()),
  mintDeclaredSecrets: async (options: { dispatcher: { owner?: string } }): Promise<MintedSecret[]> => {
    minted.push(options.dispatcher.owner);
    steps.push(`mint ${options.dispatcher.owner ?? "shared"}`);
    return [{ name: "auth-session-secret", environments: ["staging", "prod"], created: ["staging"] }];
  },
}));

/**
 * **`two` owns `SECRETS`, so its vault is its own database, and what it declares is minted there too.** The shared
 * manager's mint reaches `one` and every Worker sharing the vault; `two`'s own manager is asked separately, and the
 * report names it.
 */
describe("pithy secrets provision for a Worker that owns SECRETS", () => {
  beforeEach(() => {
    minted.length = 0;
    steps.length = 0;
    vaults.prod = "two-prod";
  });

  test("mints the shared vault and then the owner's, and reports whose each one is", async () => {
    const [line] = await runCaptured("secrets provision", ["--json"]);
    expect(minted).toEqual([undefined, "two"]);
    const generated = (JSON.parse(line ?? "{}") as { generated: MintedSecret[] }).generated;
    expect(generated).toEqual([
      { name: "auth-session-secret", environments: ["staging", "prod"], created: ["staging"] },
      { name: "auth-session-secret", environments: ["staging", "prod"], created: ["staging"], worker: "two" },
    ]);
  });

  test("deploys and migrates the owner's manager in every environment before it mints into it", async () => {
    await runCaptured("secrets provision", ["--json"]);
    expect(steps).toEqual([
      "mint shared",
      "migrate staging two-staging",
      "deploy staging two two-staging",
      "migrate prod two-prod",
      "deploy prod two two-prod",
      "mint two",
    ]);
  });

  test("an owner with no vault in an environment is refused before anything is minted into its manager", async () => {
    vaults.prod = undefined;
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    await expect(runCaptured("secrets provision", ["--json"])).rejects.toThrow(/exit/);
    expect(errors.join("")).toContain("prod has no SECRETS database for two");
    expect(minted).toEqual([undefined]);
    expect(steps.filter((step) => step.startsWith("deploy"))).toEqual([]);
    vi.restoreAllMocks();
  });
});
