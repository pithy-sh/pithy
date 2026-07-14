import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { scaffoldProject } from "../project/scaffold";
import { runAdd } from "./flow";

/**
 * The migration leg of `pithy add`, run for real: a fixture capability lands in
 * node_modules, `add` wires it, then the *default* migrate step loads the live
 * config and runs the capability's migration against local D1 (Miniflare). The
 * dir lives in-package so vitest transforms the config and the fixture it imports
 * (the same constraint e2e.test.ts documents).
 */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", "..", ".migrate-"));
  await scaffoldProject({ targetDir: dir, appName: "migrate-test" });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Install a fixture capability whose factory ships one D1 migration. */
async function installWidgets({
  projectDir,
}: {
  projectDir: string;
  pkg: string;
}): Promise<{ packageManager: string }> {
  const pkgDir = join(projectDir, "node_modules", "@pithy-sh", "widgets");
  await mkdir(join(pkgDir, "src"), { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@pithy-sh/widgets", type: "module", exports: { "./src/*": "./src/*.ts" } }),
  );
  await writeFile(
    join(pkgDir, "pithy.manifest.json"),
    JSON.stringify({
      name: "widgets",
      package: "@pithy-sh/widgets",
      requiredBindings: [{ type: "d1", name: "DB" }],
      migrationNamespace: "widgets",
    }),
  );
  await writeFile(
    join(pkgDir, "src", "index.ts"),
    `import { defineCapability } from "@pithy-sh/core/src/capability/capability";
export function widgets() {
  return defineCapability({
    name: "widgets",
    requiredBindings: [{ type: "d1", name: "DB" }],
    databases: {
      widgets: {
        binding: "DB",
        tables: {},
        migrationOrder: 100,
        migrations: {
          "0001_init": {
            up: async (db) => {
              await db.schema
                .createTable("pithy_widgets_widgets")
                .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
                .execute();
            },
            down: async (db) => {
              await db.schema.dropTable("pithy_widgets_widgets").execute();
            },
          },
        },
      },
    },
  });
}
`,
  );
  return { packageManager: "bun" };
}

test("add runs the capability's dev migrations and reports what moved", async () => {
  const result = await runAdd({ projectDir: dir, capability: "widgets", install: installWidgets });

  expect(result.databases).toHaveLength(1);
  const run = result.databases[0];
  expect(run?.database).toBe("widgets");
  expect(run?.binding).toBe("DB");
  expect(run?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
    ["0100_widgets_0001_init", "Up", "Success"],
  ]);
});

test("add --eject copies the source, repoints the import, and still migrates via the local copy", async () => {
  const result = await runAdd({ projectDir: dir, capability: "widgets", install: installWidgets, eject: true });

  // The source landed in the repo, structure preserved.
  expect(result.eject?.path).toBe("capabilities/widgets");
  expect(await readFile(join(dir, "capabilities/widgets/index.ts"), "utf8")).toContain("defineCapability");

  // The config now imports the local copy, not the package.
  const config = await readFile(join(dir, "pithy.config.ts"), "utf8");
  expect(config).toContain('from "./capabilities/widgets"');
  expect(config).not.toContain("@pithy-sh/widgets/src/index");

  // Migrate still ran — loading the ejected config and running the capability's migration.
  expect(result.databases[0]?.results.map((r) => r.status)).toEqual(["Success"]);
});
