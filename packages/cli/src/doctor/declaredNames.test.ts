// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkDeclaredNames, type DeclaredNamesWorker, describeDeclaredName } from "./declaredNames";

const db = defineCapability({
  name: "controlplane",
  requiredBindings: [{ type: "d1", name: "DB" }] satisfies BindingSpecInput[],
});

let dir: string;
let api: string;
let other: string;

const stanza = (name: string) => `{ "d1_databases": [{ "binding": "DB", "database_name": "${name}" }] }`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-declared-names-"));
  await writeFile(
    join(dir, "pithy.config.ts"),
    'export default { name: "my-app", environments: ["staging", "prod"] };\n',
  );
  api = join(dir, "apps", "api");
  other = join(dir, "apps", "other");
  await mkdir(api, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(
    join(api, "wrangler.jsonc"),
    `{ "name": "my-app-api", "env": { "staging": ${stanza("my-app-staging-db")}, "prod": ${stanza("my-app-prod-db")} } }`,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const workers = (own: string[]) => async (): Promise<DeclaredNamesWorker[]> => [
  { dir: api, capabilities: [db], ownBindings: [] },
  { dir: other, capabilities: [db], ownBindings: own },
];

describe("checkDeclaredNames", () => {
  test("reports the reporter's hand-edited name against the shared name, with both remedies, and writes nothing", async () => {
    const config = `{ "name": "my-app-other", "env": { "staging": ${stanza("my-app-staging-other-db")}, "prod": ${stanza("my-app-prod-db")} } }`;
    await writeFile(join(other, "wrangler.jsonc"), config);

    const check = await checkDeclaredNames(dir, workers([]));

    expect(check.state).toBe("drifted");
    expect(check.mismatches).toEqual([
      {
        worker: "other",
        env: "staging",
        binding: "DB",
        kind: "d1",
        declared: "my-app-staging-other-db",
        expected: "my-app-staging-db",
        owned: false,
      },
    ]);
    const sentence = describeDeclaredName(check.mismatches[0] as (typeof check.mismatches)[number]);
    expect(sentence).toContain("add DB to ownBindings in apps/other/pithy.worker.jsonc");
    expect(sentence).toContain("pithy provision --env staging --yes --repoint");
    expect(await readFile(join(other, "wrangler.jsonc"), "utf8")).toBe(config);
  });

  test("holds an owned binding to the owned name, so the same edit reads against that", async () => {
    await writeFile(
      join(other, "wrangler.jsonc"),
      `{ "name": "my-app-other", "env": { "staging": ${stanza("my-app-staging-other-db")}, "prod": ${stanza("my-app-prod-other---db")} } }`,
    );
    const check = await checkDeclaredNames(dir, workers(["DB"]));
    expect(check.mismatches.map(({ env, expected, owned }) => ({ env, expected, owned }))).toEqual([
      { env: "staging", expected: "my-app-staging-other---db", owned: true },
    ]);
  });

  test("reports a shared binding whose stanza still names the Worker's own database", async () => {
    await writeFile(
      join(other, "wrangler.jsonc"),
      `{ "name": "my-app-other", "env": { "staging": ${stanza("my-app-staging-other---db")} } }`,
    );
    const check = await checkDeclaredNames(dir, workers([]));
    expect(check.mismatches.map(({ declared, expected }) => [declared, expected])).toEqual([
      ["my-app-staging-other---db", "my-app-staging-db"],
    ]);
  });

  test("is quiet when every name is the one provision composes", async () => {
    await writeFile(
      join(other, "wrangler.jsonc"),
      `{ "name": "my-app-other", "env": { "staging": ${stanza("my-app-staging-other---db")} } }`,
    );
    expect(await checkDeclaredNames(dir, workers(["DB"]))).toEqual({ state: "ok", mismatches: [], unrecognized: [] });
  });

  test("reports an ownBindings entry naming nothing the Worker composes", async () => {
    await writeFile(join(other, "wrangler.jsonc"), '{ "name": "my-app-other" }');
    const check = await checkDeclaredNames(dir, workers(["DBB"]));
    expect(check.unrecognized).toEqual([{ worker: "other", binding: "DBB" }]);
    expect(check.state).toBe("drifted");
  });

  test("cannot check a project with no root config", async () => {
    await rm(join(dir, "pithy.config.ts"));
    expect((await checkDeclaredNames(dir, workers([]))).state).toBe("could-not-check");
  });
});
