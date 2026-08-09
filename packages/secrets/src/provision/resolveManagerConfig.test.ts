// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { describe, expect, test } from "vitest";
import type { ManagedEnvironment } from "../scope";
import { managerCfApiTokenSecretName, masterKeySecretName } from "./provisionSecrets";
import {
  type ManagerWranglerTemplate,
  managerWorkerName,
  resolveAllManagerConfigs,
  resolveManagerConfig,
} from "./resolveManagerConfig";

/** A template mirroring `src/manager/wrangler.jsonc`, with the `<filled-at-provision>` placeholders. */
function template(): ManagerWranglerTemplate {
  return {
    name: "pithy-secrets",
    main: "./worker.ts",
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    d1_databases: [{ binding: "SECRETS", database_name: "pithy-secrets", database_id: "<filled-at-provision>" }],
    secrets_store_secrets: [
      { binding: "SECRETS_ENCRYPTION_KEYS", store_id: "<filled-at-provision>", secret_name: "<filled-at-provision>" },
      { binding: "CLOUDFLARE_API_TOKEN", store_id: "<filled-at-provision>", secret_name: "<filled-at-provision>" },
    ],
    workflows: [
      { binding: "SECRETS_WRITE", name: "pithy-secrets-write", class_name: "SecretsWriteWorkflow" },
      { binding: "AT_REST_ROTATION", name: "pithy-secrets-rotate", class_name: "AtRestKeyRotationWorkflow" },
    ],
    triggers: { crons: ["0 3 * * *"] },
    vars: {
      ROTATION_INTERVAL_DAYS: "30",
      CLOUDFLARE_ACCOUNT_ID: "<filled-at-provision>",
      SECRETS_STORE_ID: "<filled>",
      ENVIRONMENT: "<filled-at-provision>",
      PROJECT: "<filled-at-provision>",
    },
  };
}

describe("managerWorkerName", () => {
  test("is the project- and env-scoped manager name", () => {
    expect(managerWorkerName("acme", "staging")).toBe("acme-staging-secrets");
    expect(managerWorkerName("acme", "prod")).toBe("acme-prod-secrets");
  });

  test("differs between two projects in one account", () => {
    // A Worker script name is account-scoped and `wrangler deploy` upserts: equal names here would mean
    // the second project's provision silently replaces the first project's running manager.
    expect(managerWorkerName("acme", "prod")).not.toBe(managerWorkerName("globex", "prod"));
  });

  test("refuses an environment this project scheme does not accept", () => {
    // A Worker script cannot be renamed once anything points at it, so a stale `production` must not
    // reach a deploy — it would stand up a second manager beside the real one and bind it to nothing.
    expect(() => managerWorkerName("acme", "production" as ManagedEnvironment)).toThrow(/prod/);
  });
});

describe("resolveManagerConfig", () => {
  test("fills the project-scoped name, D1, store, account, and Workflow names", () => {
    const resolved = resolveManagerConfig(template(), {
      env: "staging",
      databaseId: "db-123",
      storeId: "store-abc",
      accountId: "acct-9",
      project: "acme",
    });

    expect(resolved.name).toBe("acme-staging-secrets");
    expect(resolved.d1_databases[0]).toEqual({
      binding: "SECRETS",
      database_name: "acme-staging-secrets",
      database_id: "db-123",
    });
    expect(resolved.secrets_store_secrets[0]).toEqual({
      binding: "SECRETS_ENCRYPTION_KEYS",
      store_id: "store-abc",
      secret_name: masterKeySecretName("acme", "staging"),
    });
    // The CF API token is global — one entry per project, so `global` fills the environment slot. It is
    // resolved here, not passed through: the template literal is a placeholder, and binding a name
    // provisioning never wrote would deploy a manager that dies on its first token read.
    expect(resolved.secrets_store_secrets[1]).toEqual({
      binding: "CLOUDFLARE_API_TOKEN",
      store_id: "store-abc",
      secret_name: managerCfApiTokenSecretName("acme"),
    });
    // The write Workflow name is the CLI's dispatch target; both are composed from the binding, so the
    // template's unscoped literals never reach a deploy.
    expect(resolved.workflows.map((w) => w.name)).toEqual([
      "acme-staging-secrets-write",
      "acme-staging-secrets-rotate",
    ]);
    expect(resolved.vars.CLOUDFLARE_ACCOUNT_ID).toBe("acct-9");
    expect(resolved.vars.SECRETS_STORE_ID).toBe("store-abc");
    // The environment is filled so the worker can target the env-scoped master-key entry on write-back.
    expect(resolved.vars.ENVIRONMENT).toBe("staging");
    // Static fields are untouched.
    expect(resolved.compatibility_date).toBe("2025-01-01");
    expect(resolved.triggers.crons).toEqual(["0 3 * * *"]);
    expect(resolved.vars.ROTATION_INTERVAL_DAYS).toBe("30");
    expect(resolved.workers_dev).toBe(false);
  });

  test("stamps PROJECT so the at-rest rotation can rebuild the master-key entry name inside the Worker", () => {
    // The rotation derives `<project>-<env>-secrets-encryption-keys` at runtime from these two vars.
    // Without PROJECT it would re-encrypt every row under a fresh key and persist that key to an entry
    // the SECRETS_ENCRYPTION_KEYS binding does not read — every stored secret silently undecryptable.
    const resolved = resolveManagerConfig(template(), {
      env: "prod",
      databaseId: "db",
      storeId: "store",
      accountId: "acct",
      project: "acme",
    });

    expect(resolved.vars.PROJECT).toBe("acme");
    expect(masterKeySecretName(resolved.vars.PROJECT ?? "", "prod")).toBe(
      resolved.secrets_store_secrets[0]?.secret_name,
    );
  });

  test("two projects in one account share no name the other could overwrite", () => {
    // The whole reason this resolver takes a project. Every namespace below is flat and account-wide,
    // and a Worker deploy *upserts*: before the project segment, `pithy secrets provision` in a second
    // project replaced the first project's running manager, repointed it at the second project's D1,
    // and left the first project writing secrets it could no longer read. One shared name here is that
    // failure, so all four are asserted together rather than one standing in for the rest.
    const params = { env: "prod", databaseId: "db", storeId: "store", accountId: "acct" } as const;
    const acme = resolveManagerConfig(template(), { ...params, project: "acme" });
    const globex = resolveManagerConfig(template(), { ...params, project: "globex" });

    // The deployed Worker script.
    expect(acme.name).toBe("acme-prod-secrets");
    expect(globex.name).toBe("globex-prod-secrets");
    expect(acme.name).not.toBe(globex.name);

    // Its D1 — found by name, so a shared one is silently adopted rather than created.
    expect(acme.d1_databases.map((db) => db.database_name)).toEqual(["acme-prod-secrets"]);
    expect(globex.d1_databases.map((db) => db.database_name)).toEqual(["globex-prod-secrets"]);

    // Both Workflows — the write one is what `pithy secrets create` dispatches to.
    expect(acme.workflows.map((w) => w.name)).toEqual(["acme-prod-secrets-write", "acme-prod-secrets-rotate"]);
    expect(globex.workflows.map((w) => w.name)).toEqual(["globex-prod-secrets-write", "globex-prod-secrets-rotate"]);

    // And every Secrets Store entry, including the master key each manager decrypts with.
    expect(acme.secrets_store_secrets.map((e) => e.secret_name)).not.toEqual(
      globex.secrets_store_secrets.map((e) => e.secret_name),
    );
  });

  test("refuses a Workflow binding provisioning cannot name rather than deploying an unscoped one", () => {
    // The template's own `name` carries no project, so a binding with no rule here has no scoped name
    // to fall back to — and suffixing the literal is exactly the account-colliding scheme this replaced.
    const rogue = template();
    rogue.workflows = [{ binding: "SOMETHING_ELSE", name: "pithy-secrets-other", class_name: "OtherWorkflow" }];

    expect(() =>
      resolveManagerConfig(rogue, {
        env: "staging",
        databaseId: "db",
        storeId: "store",
        accountId: "acct",
        project: "acme",
      }),
    ).toThrow(PithyError);
  });

  test("refuses a store binding provisioning never writes rather than deploying a dead binding", () => {
    const rogue = template();
    rogue.secrets_store_secrets = [{ binding: "SOMETHING_ELSE", store_id: "<x>", secret_name: "<x>" }];

    expect(() =>
      resolveManagerConfig(rogue, {
        env: "staging",
        databaseId: "db",
        storeId: "store",
        accountId: "acct",
        project: "acme",
      }),
    ).toThrow(PithyError);
  });

  test("does not mutate the input template", () => {
    const input = template();
    resolveManagerConfig(input, {
      env: "prod",
      databaseId: "d",
      storeId: "s",
      accountId: "a",
      project: "acme",
    });
    expect(input.name).toBe("pithy-secrets");
    expect(input.d1_databases[0]?.database_id).toBe("<filled-at-provision>");
    expect(input.secrets_store_secrets[0]?.secret_name).toBe("<filled-at-provision>");
  });
});

describe("the committed manager template", () => {
  test("declares the PROJECT var the resolver stamps", async () => {
    // `template()` above is a hand-written mirror, so it cannot catch the template itself falling behind.
    // A manager deployed without PROJECT loses every secret at its first at-rest rotation.
    const source = await readFile(new URL("../manager/wrangler.jsonc", import.meta.url), "utf8");
    expect(source).toContain('"PROJECT"');
  });
});

describe("resolveAllManagerConfigs", () => {
  test("resolves one config per managed env from each env's ids", () => {
    const all = resolveAllManagerConfigs(
      template(),
      { accountId: "acct-9", project: "acme" },
      {
        staging: { databaseId: "db-s", storeId: "store-s" },
        prod: { databaseId: "db-p", storeId: "store-p" },
      },
      DEFAULT_ENVIRONMENTS,
    );
    expect(all.map((c) => c.env)).toEqual(["staging", "prod"]);
    expect(all[0]?.config.name).toBe("acme-staging-secrets");
    expect(all[0]?.config.d1_databases[0]?.database_id).toBe("db-s");
    expect(all[0]?.config.secrets_store_secrets[0]?.secret_name).toBe(masterKeySecretName("acme", "staging"));
    expect(all[1]?.config.name).toBe("acme-prod-secrets");
    expect(all[1]?.config.secrets_store_secrets[0]?.store_id).toBe("store-p");
    expect(all[1]?.config.vars.PROJECT).toBe("acme");
  });
});
