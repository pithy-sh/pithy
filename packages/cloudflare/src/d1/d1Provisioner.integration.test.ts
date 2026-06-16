import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadCloudflareEnv } from "../env/devVars";
import { CloudflareD1Provisioner } from "./d1Provisioner";

/**
 * LIVE integration test — creates and deletes a real D1 database to exercise the control-plane
 * client against the account. Reads creds from the package's `.dev.vars` (symlinked to the root);
 * skipped when absent. Run via `bun run test:integration`. Cleans up the database it creates.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const vars = loadCloudflareEnv(path.join(__dirname, "../.."));
const hasCreds = Boolean(vars.CLOUDFLARE_API_TOKEN && vars.CLOUDFLARE_ACCOUNT_ID);

describe.skipIf(!hasCreds)("CloudflareD1Provisioner — LIVE", () => {
  test("validates access, creates a database, then deletes it", async () => {
    const provisioner = new CloudflareD1Provisioner({
      accountId: vars.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: vars.CLOUDFLARE_API_TOKEN ?? "",
    });

    expect(await provisioner.validateServiceAccess()).toBe(true);

    const name = `pithy-int-test-${Date.now()}`;
    const db = await provisioner.createDatabase(name);
    try {
      expect(db.uuid).toBeTruthy();
      expect(db.name).toBe(name);
    } finally {
      await provisioner.deleteDatabase(db.uuid);
    }
  });
});
