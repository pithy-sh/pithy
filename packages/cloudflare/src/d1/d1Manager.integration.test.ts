import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "../test-utils/harness";
import { CloudflareD1Manager } from "./d1Manager";
import { CloudflareD1Provisioner } from "./d1Provisioner";

/**
 * LIVE integration test — the D1 query manager (REST counterpart to the D1Database binding, and the
 * engine behind `pithy migrate`). Creates a real D1 database with the provisioner, runs DDL/DML/SELECT
 * through the manager, then deletes the database. See `kvManager.integration.test.ts` for the template.
 */
const creds = loadIntegrationCreds();

describe.skipIf(!creds.hasCreds)("CloudflareD1Manager — LIVE", () => {
  const provisioner = new CloudflareD1Provisioner({ accountId: creds.accountId, apiToken: creds.apiToken });

  test("creates a database, runs DDL/DML/SELECT, introspects, then deletes it", async () => {
    await withThrowawayResource(
      () => provisioner.createDatabase(uniqueName("pithy-int-d1")),
      async (db) => {
        const d1 = new CloudflareD1Manager({
          accountId: creds.accountId,
          apiToken: creds.apiToken,
          databaseId: db.uuid,
        });

        // Happy path: the database record is reachable and decodes.
        expect(await d1.validateServiceAccess()).toBe(true);
        expect((await d1.getDatabaseInfo()).uuid).toBe(db.uuid);

        // DDL + DML through the REST query path.
        await d1.executeQuery("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
        await d1.executeQuery("INSERT INTO widgets (name) VALUES (?)", ["saffron"]);

        // SELECT decodes to the expected row shape.
        const rows = await d1.executeQuery("SELECT name FROM widgets");
        expect(rows[0]?.results).toEqual([{ name: "saffron" }]);

        // Introspection helpers.
        expect(await d1.listTables()).toContain("widgets");
        const schema = await d1.getTableSchema("widgets");
        expect(schema.some((col) => (col as { name?: string }).name === "name")).toBe(true);

        // Error path: an invalid identifier is rejected before it can reach SQL (injection guard).
        await expect(d1.getTableSchema("widgets; DROP TABLE widgets")).rejects.toThrowError(
          expect.objectContaining({ payload: expect.objectContaining({ code: "validation/invalid_input" }) }),
        );
      },
      (db) => provisioner.deleteDatabase(db.uuid),
    );
  });
});
