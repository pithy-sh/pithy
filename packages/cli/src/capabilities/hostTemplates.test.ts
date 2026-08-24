// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import type { EmailWorkerWranglerTemplate } from "@pithy-sh/email/src/provision/resolveEmailConfig";
import { resolveEmailConfig } from "@pithy-sh/email/src/provision/resolveEmailConfig";
import { defaultTheme } from "@pithy-sh/email/src/templates/theme";
import { MediaConfig } from "@pithy-sh/media/src/config/config";
import { resolveMediaConfig } from "@pithy-sh/media/src/provision/resolveMediaConfig";
import { PaymentsConfig } from "@pithy-sh/payments/src/config/config";
import { resolvePaymentsConfig } from "@pithy-sh/payments/src/provision/resolvePaymentsConfig";
import { managerCfApiTokenSecretName, masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { ManagerWranglerTemplate } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import { resolveManagerConfig } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import { type ManagedEnvironment, managedEnvironments } from "@pithy-sh/secrets/src/scope";
import { StorageConfig } from "@pithy-sh/storage/src/config/config";
import { resolveStorageConfig } from "@pithy-sh/storage/src/provision/resolveStorageConfig";
import { SupportConfig } from "@pithy-sh/support/src/config/config";
import { resolveSupportConfig } from "@pithy-sh/support/src/provision/resolveSupportConfig";
import { TestersConfig } from "@pithy-sh/testers/src/config/config";
import { resolveTestersConfig } from "@pithy-sh/testers/src/provision/resolveTestersConfig";
import { VectorConfig } from "@pithy-sh/vector/src/config/config";
import { resolveVectorConfig } from "@pithy-sh/vector/src/provision/resolveVectorConfig";
import { parse } from "comment-json";
import { describe, expect, test } from "vitest";

/**
 * Every capability that owns Workflows ships a committed `wrangler.jsonc` **template** beside its worker
 * entry, and `pithy <capability> provision` resolves it into one deployable config per environment. The
 * template marks each value provisioning supplies with `<filled-at-provision>` — a marker nothing in the
 * resolver matches, because resolution is structural: fields are overwritten by binding-name lookup.
 *
 * Which means a template field the resolver forgets is not an error. It is a deploy: a Worker bound to a
 * D1 whose id is the literal string `<filled-at-provision>`, or a Secrets Store entry by that name, failing
 * on its first request for a reason that reads like a code fault. Nothing else in CI notices — `parse()`
 * hands back `unknown`, every provisioner casts it, and each capability's own resolver test drives an
 * inline fixture that is free to drift from the file on disk.
 *
 * So this is the one property, asserted across every capability at once: **resolve the real committed
 * template through the real resolver and nothing is left to fill in.** Templates are discovered from disk
 * rather than listed, so a new capability's template is covered here or named in {@link UNRESOLVED} — it
 * cannot arrive unnoticed.
 *
 * `emailTemplate.test.ts` stays: it asserts what email's resolved config *is* (which id lands on which
 * binding, which Workflow names, which crons). This asserts only what no resolved config may contain.
 */

/**
 * Any `<filled…>` marker, not just today's two spellings. Both are in the tree — `<filled-at-provision>`
 * everywhere and a shorter `<filled>` in a couple of fixtures — and a third would be a new way to fail
 * silently rather than a new thing to allow.
 */
const PLACEHOLDER = /<filled[^>]*>/;

/** The project every resolution below is driven with — the `<project>` segment of every derived name. */
const PROJECT = "acme";

/** The Secrets Store id provisioning would have discovered. Distinctive so a pass-through is visible. */
const STORE_ID = "store-1a2b3c";

/** The account id the secrets manager stamps into its own vars. */
const ACCOUNT_ID = "acct-9f8e7d";

/** The provisioned database ids, one per binding a host template can carry. */
const DATABASE = { app: "db-app-1", secrets: "db-secrets-1", suppression: "db-suppression-1" } as const;

/** `packages/` — the root every capability's template is discovered under and reported relative to. */
const PACKAGES_DIR = resolve(import.meta.dirname, "../../..");

/**
 * Read a capability's committed template exactly as its provisioner does: resolve the worker entry
 * through the module graph — never a relative path, so a moved package still resolves — and parse the
 * sibling `wrangler.jsonc` with `comment-json`. The cast is the same one every provisioner makes; this
 * suite exists because nothing type-checks what is behind it.
 */
async function readTemplate<T extends WorkflowHostTemplate>(entry: string): Promise<T> {
  return parse(await readFile(templatePath(entry), "utf8")) as unknown as T;
}

/** The absolute path of the `wrangler.jsonc` beside a worker entry. */
function templatePath(entry: string): string {
  return join(dirname(fileURLToPath(import.meta.resolve(entry))), "wrangler.jsonc");
}

/** One capability's coverage: where its template lives, and how provisioning fills it. */
interface HostCoverage {
  /** The capability's name, for test titles. */
  readonly capability: string;
  /** The worker entry the provisioner resolves; the template is its sibling. */
  readonly entry: string;
  /**
   * Every provisioning mode that resolves this template differently, keyed by name. A mode is a real
   * branch — media with records in KV versus D1, testers with and without a sending identity — and each
   * one is a deploy an adopter can get, so each one has to come out clean.
   *
   * Takes `entry` back rather than closing over the specifier, so the module the template is found
   * beside is written once per capability and cannot drift from the one this suite counts.
   */
  readonly resolve: (env: ManagedEnvironment, entry: string) => Promise<Record<string, WorkflowHostTemplate>>;
}

/**
 * The hosts that read a secret at runtime, and so bind the master key that decrypts the D1 store.
 *
 * Written down rather than inferred from what each resolution happens to produce: support, testers and
 * vector hold no credential at all — support's whole dependency is its `AI` binding — and that is a
 * deliberate property worth failing on if it changes in either direction.
 */
const READS_THE_MASTER_KEY: ReadonlySet<string> = new Set(["email", "media", "storage", "payments", "secrets"]);

/**
 * The sending identity testers copies from the email capability when a project composes one.
 *
 * `messages` states the project that speaks one language, out loud. The field is required rather than
 * optional for exactly that: a provisioner that forgot the catalogs is what left `EMAIL_MESSAGES`
 * written by nobody, twice (pithy-sh/pithy#441).
 */
const TESTERS_EMAIL = { fromAddress: "beta@acme.test", fromName: "Acme Beta", theme: defaultTheme, messages: {} };

/** One configured vector index, since the `vectorize` array is rebuilt from config rather than filled. */
const VECTOR_INDEX = VectorConfig.parse({
  indexes: { docs: { model: "@cf/baai/bge-base-en-v1.5", dimensions: 768 } },
});

const COVERAGE: readonly HostCoverage[] = [
  {
    capability: "email",
    entry: "@pithy-sh/email/src/workflows/worker",
    async resolve(env, entry) {
      const template = await readTemplate<EmailWorkerWranglerTemplate>(entry);
      return {
        default: resolveEmailConfig(template, {
          project: PROJECT,
          env,
          appDatabaseId: DATABASE.app,
          suppressionDatabaseId: DATABASE.suppression,
          secretsDatabaseId: DATABASE.secrets,
          storeId: STORE_ID,
          baseUrl: "https://api.acme.test",
          theme: defaultTheme,
        }),
      };
    },
  },
  {
    capability: "media",
    entry: "@pithy-sh/media/src/workflows/worker",
    async resolve(env, entry) {
      const template = await readTemplate(entry);
      const base = {
        project: PROJECT,
        env,
        appDatabaseId: DATABASE.app,
        secretsDatabaseId: DATABASE.secrets,
        storeId: STORE_ID,
      };
      return {
        // Records in D1 — the default. The `MEDIA` KV binding is dropped rather than filled.
        "records in d1": resolveMediaConfig(template, {
          ...base,
          resources: { bucketName: `${PROJECT}-${env}-media`, kvNamespaceId: null },
          mediaConfig: MediaConfig.parse({ recordStore: "d1" }),
        }),
        // Records in KV — the one mode where the namespace id has to arrive.
        "records in kv": resolveMediaConfig(template, {
          ...base,
          resources: { bucketName: `${PROJECT}-${env}-media`, kvNamespaceId: "kv-1" },
          mediaConfig: MediaConfig.parse({ recordStore: "kv" }),
        }),
      };
    },
  },
  {
    capability: "storage",
    entry: "@pithy-sh/storage/src/workflows/worker",
    async resolve(env, entry) {
      const template = await readTemplate(entry);
      return {
        default: resolveStorageConfig(template, {
          project: PROJECT,
          env,
          appDatabaseId: DATABASE.app,
          secretsDatabaseId: DATABASE.secrets,
          storeId: STORE_ID,
          resources: { bucketName: `${PROJECT}-${env}-storage` },
          storageConfig: StorageConfig.parse({}),
        }),
      };
    },
  },
  {
    capability: "payments",
    entry: "@pithy-sh/payments/src/workflows/worker",
    async resolve(env, entry) {
      const template = await readTemplate(entry);
      return {
        default: resolvePaymentsConfig(template, {
          project: PROJECT,
          env,
          appDatabaseId: DATABASE.app,
          secretsDatabaseId: DATABASE.secrets,
          storeId: STORE_ID,
          paymentsConfig: PaymentsConfig.parse({ billingSubject: "user" }),
        }),
      };
    },
  },
  {
    capability: "support",
    entry: "@pithy-sh/support/src/workflows/worker",
    async resolve(env, entry) {
      const template = await readTemplate(entry);
      return {
        default: resolveSupportConfig(template, {
          project: PROJECT,
          env,
          appDatabaseId: DATABASE.app,
          supportConfig: SupportConfig.parse({}),
        }),
      };
    },
  },
  {
    capability: "testers",
    entry: "@pithy-sh/testers/src/workflows/worker",
    async resolve(env, entry) {
      const template = await readTemplate(entry);
      const base = {
        project: PROJECT,
        env,
        appDatabaseId: DATABASE.app,
        suppressionDatabaseId: DATABASE.suppression,
        testersConfig: TestersConfig.parse({}),
      };
      return {
        // A project that composes email: the three `EMAIL_*` vars are written.
        sending: resolveTestersConfig(template, { ...base, email: TESTERS_EMAIL }),
        // A project that composes none: they are deleted, because `resolveWorkflowHost` merges vars —
        // not writing them would leave the placeholders standing, and the host reads one as an address.
        silent: resolveTestersConfig(template, { ...base, email: undefined }),
      };
    },
  },
  {
    capability: "vector",
    entry: "@pithy-sh/vector/src/workflows/worker",
    async resolve(env, entry) {
      const template = await readTemplate(entry);
      return {
        // One index configured: the template's single `vectorize` entry is rebuilt and filled.
        "one index": resolveVectorConfig(template, {
          project: PROJECT,
          env,
          appDatabaseId: DATABASE.app,
          indexNames: { docs: `${PROJECT}-${env}-docs` },
          config: VECTOR_INDEX,
        }),
        // None configured — the legal, inert state `pithy add vector` leaves behind. The array is
        // rebuilt as empty, so the template's placeholder must not survive into the deploy either.
        "no index": resolveVectorConfig(template, {
          project: PROJECT,
          env,
          appDatabaseId: DATABASE.app,
          indexNames: {},
          config: VectorConfig.parse({}),
        }),
      };
    },
  },
  {
    capability: "secrets",
    entry: "@pithy-sh/secrets/src/manager/worker",
    async resolve(env, entry) {
      const template = await readTemplate<ManagerWranglerTemplate>(entry);
      return {
        default: resolveManagerConfig(template, {
          env,
          databaseId: DATABASE.secrets,
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          project: PROJECT,
        }),
      };
    },
  },
];

/**
 * Committed templates no resolver drives, and why. **An entry here is a decision, not a gap that went
 * unnoticed** — the count assertion below fails the moment a template is neither covered nor listed.
 */
const UNRESOLVED: Readonly<Record<string, string>> = {
  // Leaderboard's rank worker ships a complete template and a `RankRefreshWorkflow`, but no
  // `resolveLeaderboardConfig` and no `leaderboardProvisioner` in the CLI — `pithy add leaderboard`
  // wires the routes and migrations and deploys nothing. There is no resolver to drive, so driving one
  // here would mean writing it. Its `<filled-at-provision>` markers (both database fields, the cron,
  // `LEADERBOARD_CONFIG`, `ENVIRONMENT`) are unfilled today because nothing fills anything.
  "leaderboard/src/rank/wrangler.jsonc": "no resolver and no provisioner exist yet",
};

/**
 * Every `wrangler.jsonc` committed under a package's `src/`, relative to `packages/`.
 *
 * Scoped to `packages/` deliberately: `templates/starter/apps/api/wrangler.jsonc` is the adopter's own
 * Worker config, written by `pithy init` from `scaffold.ts` rather than resolved at provision, and it
 * carries no placeholder to leave behind.
 */
async function committedTemplates(): Promise<string[]> {
  const found: string[] = [];
  for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(PACKAGES_DIR, pkg.name, "src");
    // A package with no `src/` (or none yet) contributes nothing rather than failing the discovery.
    const entries = await readdir(src, { withFileTypes: true, recursive: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name === "wrangler.jsonc") {
        found.push(relative(PACKAGES_DIR, join(entry.parentPath, entry.name)));
      }
    }
  }
  return found.sort();
}

/**
 * Every path inside a resolved config still holding a placeholder. Paths rather than a boolean: a
 * failure has to say *which* field, or the next person re-derives it by hand — which is how this test
 * came to be written.
 */
function placeholderPaths(value: unknown, path = ""): string[] {
  if (typeof value === "string") return PLACEHOLDER.test(value) ? [`${path} = ${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => placeholderPaths(item, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => placeholderPaths(item, path ? `${path}.${key}` : key));
  }
  return [];
}

describe("the committed worker templates", () => {
  test("every one on disk is either resolved here or a named exclusion", async () => {
    const covered = COVERAGE.map((entry) => relative(PACKAGES_DIR, templatePath(entry.entry))).sort();
    const excluded = Object.keys(UNRESOLVED).sort();

    // The vacuity guard. A suite that silently covered nothing would pass every assertion below it, so
    // the set of templates it drives is pinned against the set that exists — a new capability's
    // template fails here until it is resolved or explicitly excluded.
    expect([...covered, ...excluded].sort()).toEqual(await committedTemplates());
    expect(covered).toHaveLength(COVERAGE.length);
    expect(excluded).toEqual(["leaderboard/src/rank/wrangler.jsonc"]);
  });

  test.each(COVERAGE)("$capability's template still marks what provisioning fills", async ({ entry }) => {
    // The other half of the vacuity guard: a template that stopped carrying placeholders would make its
    // resolution below prove nothing at all.
    expect(await readFile(templatePath(entry), "utf8")).toMatch(PLACEHOLDER);
  });

  describe.each(COVERAGE)("$capability resolves", ({ entry, resolve: resolveFor }) => {
    test.each(managedEnvironments(DEFAULT_ENVIRONMENTS))("clean in %s, in every mode", async (env) => {
      const modes = await resolveFor(env, entry);
      expect(Object.keys(modes).length).toBeGreaterThan(0);
      for (const [mode, config] of Object.entries(modes)) {
        expect(placeholderPaths(config), `${mode}: unresolved`).toEqual([]);
        // The name is the one field a placeholder could never reach — asserted anyway, because a
        // resolver that returned the template untouched would otherwise pass the scan above.
        expect(config.name.startsWith(`${PROJECT}-${env}-`), `${mode}: ${config.name}`).toBe(true);
      }
    });

    /**
     * The entry that prompted all of this: `"secret_name": "SECRETS_ENCRYPTION_KEYS"` sat in four
     * committed templates reading like a value nobody filled. It was filled — but only a resolver run
     * proved it, and the account's Secrets Store is one flat namespace where the name is the whole
     * partition. An unscoped entry name is one project's manager reading another's master key.
     */
    test.each(managedEnvironments(DEFAULT_ENVIRONMENTS))(
      "every Secrets Store entry, project-scoped, in %s",
      async (env) => {
        for (const [mode, config] of Object.entries(await resolveFor(env, entry))) {
          for (const secret of config.secrets_store_secrets ?? []) {
            const where = `${mode}: ${secret.binding}`;
            expect(secret.store_id, where).toBe(STORE_ID);
            expect(secret.secret_name.startsWith(`${PROJECT}-`), `${where} = ${secret.secret_name}`).toBe(true);
            // Scoped to an environment or explicitly `global` — never a bare name, and never the binding.
            expect(secret.secret_name, where).toMatch(new RegExp(`^${PROJECT}-(${env}|global)-`));
          }
        }
      },
    );
  });

  /**
   * The two entry names, asserted through the functions that own them rather than as literals. A copy
   * here would be a second declaration free to drift from the value provisioning actually writes — and
   * a drifted entry name deploys a worker that dies on its first secret read.
   */
  test("the master key and the manager's token resolve to the names secrets wrote", async () => {
    const template = await readTemplate<ManagerWranglerTemplate>("@pithy-sh/secrets/src/manager/worker");
    const config = resolveManagerConfig(template, {
      env: "prod",
      databaseId: DATABASE.secrets,
      storeId: STORE_ID,
      accountId: ACCOUNT_ID,
      project: PROJECT,
    });
    expect(Object.fromEntries(config.secrets_store_secrets.map((s) => [s.binding, s.secret_name]))).toEqual({
      SECRETS_ENCRYPTION_KEYS: masterKeySecretName(PROJECT, "prod"),
      CLOUDFLARE_API_TOKEN: managerCfApiTokenSecretName(PROJECT),
    });
  });

  test.each(COVERAGE)(
    "$capability binds the master key it should, under this environment's name",
    async ({ capability, entry, resolve: resolveFor }) => {
      for (const env of managedEnvironments(DEFAULT_ENVIRONMENTS)) {
        for (const [mode, config] of Object.entries(await resolveFor(env, entry))) {
          const master = config.secrets_store_secrets?.find((s) => s.binding === "SECRETS_ENCRYPTION_KEYS");
          // Presence is asserted, not assumed. A template that lost its `secrets_store_secrets` block, or
          // a resolver that stopped passing `secretsStoreId`, would otherwise slip past the scan above by
          // having nothing left to check — the host would deploy and fail on its first secret read.
          expect(master !== undefined, `${capability} (${mode})`).toBe(READS_THE_MASTER_KEY.has(capability));
          if (master) expect(master.secret_name, mode).toBe(masterKeySecretName(PROJECT, env));
        }
      }
    },
  );
});
