// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { reconcileOwnedDatabases } from "./ownedStanzas";

const controlplane = defineCapability({
  name: "controlplane",
  requiredBindings: [{ type: "d1", name: "DB" }] satisfies BindingSpecInput[],
});

/** The two fields of a manifest a naming reads, parsed through the same `BindingSpec` contract. */
const manifest = (name: string, requiredBindings: BindingSpecInput[]) => {
  const parsed = defineCapability({ name, requiredBindings });
  return { name: parsed.name, requiredBindings: parsed.requiredBindings };
};

interface Entry {
  binding: string;
  database_name?: string;
  database_id?: string;
}
interface Config {
  d1_databases?: Entry[];
  env: Record<string, { d1_databases?: Entry[] }>;
}

let dir: string;
let worker: string;

/** The stanzas `pithy add` writes for a shared `DB`, before the Worker owned anything. */
const SCAFFOLDED = `{
  "name": "my-app-other",
  // The top level is the dev environment.
  "d1_databases": [{ "binding": "DB", "database_name": "my-app-dev-db" }],
  "env": {
    "staging": { "d1_databases": [{ "binding": "DB", "database_name": "my-app-staging-db" }] },
    "prod": { "d1_databases": [{ "binding": "DB", "database_name": "my-app-prod-db", "database_id": "d1-prod" }] }
  }
}
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-owned-stanzas-"));
  worker = join(dir, "apps", "other");
  await mkdir(worker, { recursive: true });
  await writeFile(join(worker, "wrangler.jsonc"), SCAFFOLDED);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = async (): Promise<Config> =>
  parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Config;
const reconcile = (ownBindings: string[]) =>
  reconcileOwnedDatabases({
    workerDir: worker,
    project: "my-app",
    capabilities: [controlplane],
    declarations: [],
    ownBindings,
  });

describe("reconcileOwnedDatabases", () => {
  test("gives an owned binding its own name everywhere, and its own top-level database_id", async () => {
    const changes = await reconcile(["DB"]);
    const config = await read();
    expect(config.d1_databases).toEqual([
      { binding: "DB", database_name: "my-app-dev-other---db", database_id: "my-app-dev-other---db" },
    ]);
    expect(config.env.staging?.d1_databases).toEqual([{ binding: "DB", database_name: "my-app-staging-other---db" }]);
    expect(changes.map(({ env, field }) => [env, field])).toEqual([
      ["dev", "database_name"],
      ["dev", "database_id"],
      ["staging", "database_name"],
    ]);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toContain(
      "// The top level is the dev environment.",
    );
  });

  test("leaves a provisioned environment's entry for provision --repoint", async () => {
    await reconcile(["DB"]);
    expect((await read()).env.prod?.d1_databases).toEqual([
      { binding: "DB", database_name: "my-app-prod-db", database_id: "d1-prod" },
    ]);
  });

  test("takes it all back when the entry is taken out", async () => {
    await reconcile(["DB"]);
    const changes = await reconcile([]);
    const config = await read();
    expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "my-app-dev-db" }]);
    expect(config.env.staging?.d1_databases).toEqual([{ binding: "DB", database_name: "my-app-staging-db" }]);
    expect(changes.some((change) => change.field === "database_id" && change.to === undefined)).toBe(true);
  });

  test("changes nothing on a second run, or for a Worker that owns nothing", async () => {
    const before = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    expect(await reconcile([])).toEqual([]);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(before);
    await reconcile(["DB"]);
    expect(await reconcile(["DB"])).toEqual([]);
  });

  test("never rewrites a name the adopter chose", async () => {
    const config = SCAFFOLDED.replace('"my-app-staging-db"', '"my-app-staging-other-db"');
    await writeFile(join(worker, "wrangler.jsonc"), config);
    await reconcile(["DB"]);
    expect((await read()).env.staging?.d1_databases).toEqual([
      { binding: "DB", database_name: "my-app-staging-other-db" },
    ]);
  });

  test("refuses to own a global binding, naming the binding and the capability", async () => {
    const email = defineCapability({
      name: "email",
      requiredBindings: [{ type: "d1", name: "EMAIL_SUPPRESSIONS", scope: "global" }] satisfies BindingSpecInput[],
    });
    await expect(
      reconcileOwnedDatabases({
        workerDir: worker,
        project: "my-app",
        capabilities: [email],
        declarations: [],
        ownBindings: ["EMAIL_SUPPRESSIONS"],
      }),
    ).rejects.toThrow(/owns EMAIL_SUPPRESSIONS, which email declares global/);
  });

  test("refuses a binding its manifest declares global though the capability object does not, and rewrites nothing", async () => {
    const email = defineCapability({
      name: "email",
      requiredBindings: [{ type: "d1", name: "EMAIL_SUPPRESSIONS" }] satisfies BindingSpecInput[],
    });
    const config = `{
  "name": "my-app-other",
  "d1_databases": [{ "binding": "EMAIL_SUPPRESSIONS", "database_name": "my-app-global-email-suppressions" }],
  "env": {
    "staging": { "d1_databases": [{ "binding": "EMAIL_SUPPRESSIONS", "database_name": "my-app-global-email-suppressions" }] }
  }
}
`;
    await writeFile(join(worker, "wrangler.jsonc"), config);
    await expect(
      reconcileOwnedDatabases({
        workerDir: worker,
        project: "my-app",
        capabilities: [email],
        declarations: [manifest("email", [{ type: "d1", name: "EMAIL_SUPPRESSIONS", scope: "global" }])],
        ownBindings: ["EMAIL_SUPPRESSIONS"],
      }),
    ).rejects.toThrow(/owns EMAIL_SUPPRESSIONS, which email declares global/);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(config);
  });

  test("refuses to own a global R2 binding its manifest declares, as it does a D1 one", async () => {
    const support = defineCapability({
      name: "support",
      requiredBindings: [{ type: "r2", name: "SUPPORT_BUCKET" }] satisfies BindingSpecInput[],
    });
    const before = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    await expect(
      reconcileOwnedDatabases({
        workerDir: worker,
        project: "my-app",
        capabilities: [support],
        declarations: [
          manifest("support", [{ type: "r2", name: "SUPPORT_BUCKET", scope: "global", resource: "support" }]),
        ],
        ownBindings: ["SUPPORT_BUCKET"],
      }),
    ).rejects.toThrow(/owns SUPPORT_BUCKET, which support declares global/);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(before);
  });

  test("names a resource: binding by the resource its manifest declares, as provision does", async () => {
    const ledger = defineCapability({
      name: "ledger",
      requiredBindings: [{ type: "d1", name: "LEDGER_DB" }] satisfies BindingSpecInput[],
    });
    await writeFile(
      join(worker, "wrangler.jsonc"),
      `{
  "name": "my-app-other",
  "env": { "staging": { "d1_databases": [{ "binding": "LEDGER_DB", "database_name": "my-app-staging-ledger" }] } }
}
`,
    );
    const changes = await reconcileOwnedDatabases({
      workerDir: worker,
      project: "my-app",
      capabilities: [ledger],
      declarations: [manifest("ledger", [{ type: "d1", name: "LEDGER_DB", resource: "ledger" }])],
      ownBindings: ["LEDGER_DB"],
    });
    expect(changes).toEqual([
      {
        env: "staging",
        binding: "LEDGER_DB",
        field: "database_name",
        from: "my-app-staging-ledger",
        to: "my-app-staging-other---ledger",
      },
    ]);
  });
});
