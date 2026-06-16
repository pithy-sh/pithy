import path from "node:path";
import { fileURLToPath } from "node:url";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { deprovisionSecrets, provisionSecrets } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { managedEnvironments } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import { buildManagerDeploy, CloudflareSecretsDeprovisioner, CloudflareSecretsProvisioner } from "./secretsProvisioner";

/**
 * LIVE end-to-end test for the whole secrets capability against a real Cloudflare account:
 *
 *   1. provision — create each env's D1, mint the master key, migrate over REST, deploy the manager.
 *   2. write — dispatch the write Workflow to create a secret, with `audit` so the worker re-reads
 *      and decrypts it and reports a boolean (the value never leaves the worker). Confirms the full
 *      encrypt → store → decrypt round trip live.
 *   3. rotate — trigger the at-rest rotation Workflow and confirm the stored row was re-encrypted
 *      under the new key version (`key_version` 1 → 2).
 *   4. update + delete — round-trip again under the rotated key, then remove the secret.
 *   5. teardown — delete every manager, master key, and database; confirm they are gone.
 *
 * It deploys the real-named `pithy-secrets-<env>` Workers, so it is **double-gated**: it needs CF
 * creds in `.dev.vars` AND `PITHY_LIVE_DEPLOY=1`. Run deliberately — it deploys then deletes the
 * managers, so never point it at an account whose managers you want to keep.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const vars = loadCloudflareEnv(path.join(__dirname, "../.."));
const hasCreds = Boolean(vars.CLOUDFLARE_API_TOKEN && vars.CLOUDFLARE_ACCOUNT_ID && vars.SECRETS_STORE_ID);
const optedIn = process.env.PITHY_LIVE_DEPLOY === "1";

const writeWorkflow = (env: ManagedEnvironment) => `pithy-secrets-write-${env}`;
const rotateWorkflow = (env: ManagedEnvironment) => `pithy-secrets-rotate-${env}`;

/** The `audited` boolean from a write Workflow's output (the only thing the audit returns). */
function auditedOf(output: unknown): boolean | undefined {
  return (output as { audited?: boolean } | null)?.audited;
}

describe.skipIf(!hasCreds || !optedIn)("secrets — LIVE provision, write/rotate/audit, then teardown", () => {
  test("provisions, round-trips a secret through write + rotation, then tears it all down", async () => {
    const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
    const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
    const storeId = vars.SECRETS_STORE_ID ?? "";
    const cf = new CloudflareClients({ accountId, apiToken });
    const workflows = new CloudflareWorkflowsClient({ accountId, apiToken });
    const deprovisioner = new CloudflareSecretsDeprovisioner({ cf, storeId });

    const env: ManagedEnvironment = "staging";
    const secretName = "pithy-itest-secret";
    const originalValue = "round-trips-correctly";

    /** The encryption-key version on the stored row, read fresh from D1 (snake_case column). */
    async function storedKeyVersion(databaseId: string): Promise<number | undefined> {
      const result = await cf
        .d1(databaseId)
        .prepare(`select key_version from pithy_secrets_system_secrets where name = '${secretName}'`)
        .all<{ key_version: number }>();
      return result.results?.[0]?.key_version;
    }

    try {
      // 1. Provision every environment's manager.
      const provisioner = new CloudflareSecretsProvisioner({
        cf,
        accountId,
        storeId,
        deploy: buildManagerDeploy({ accountId, apiToken }),
      });
      const result = await provisionSecrets(provisioner);
      expect(result.perEnv.map((e) => e.env)).toEqual(managedEnvironments());
      const databaseId = result.perEnv.find((e) => e.env === env)?.databaseId ?? "";
      expect(databaseId).not.toBe("");

      // 2. Write a secret through the manager's write Workflow, audited — proves encrypt → store → decrypt.
      const created = await workflows.dispatchAndPoll(writeWorkflow(env), {
        mode: "create",
        name: secretName,
        value: originalValue,
        valueType: "text",
        rotatable: true,
        audit: true,
      });
      expect(auditedOf(created)).toBe(true);
      expect(await storedKeyVersion(databaseId)).toBe(1);

      // 3. Rotate the at-rest key and confirm the stored secret was re-encrypted under the new version.
      await workflows.dispatchAndPoll(rotateWorkflow(env), {});
      expect(await storedKeyVersion(databaseId)).toBe(2);

      // 4. Update (round-trips again under the rotated key), then delete.
      const updated = await workflows.dispatchAndPoll(writeWorkflow(env), {
        mode: "update",
        name: secretName,
        value: originalValue,
        valueType: "text",
        rotatable: true,
        audit: true,
      });
      expect(auditedOf(updated)).toBe(true);

      await workflows.dispatchAndPoll(writeWorkflow(env), { mode: "delete", name: secretName });
      expect(await storedKeyVersion(databaseId)).toBeUndefined();
    } finally {
      // 5. Full teardown, including the throwaway master keys — this is a round-trip test.
      await deprovisionSecrets(deprovisioner, { deleteKeys: true });
    }

    // Teardown removed every manager Worker and database.
    for (const e of managedEnvironments()) {
      const name = managerWorkerName(e);
      expect(await cf.workers().getWorker(name)).toBeNull();
      expect(await cf.d1Provisioner().findDatabaseByName(name)).toBeNull();
    }
  });
});
