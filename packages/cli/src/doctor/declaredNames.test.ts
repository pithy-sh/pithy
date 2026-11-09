// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { linkKitPackages } from "../test-utils/linkKit";
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
  { dir: api, capabilities: [db], ownBindings: [], declarations: [] },
  { dir: other, capabilities: [db], ownBindings: own, declarations: [] },
];

/** Email and support as their capability objects declare them: neither carries `scope` or `resource`. */
const email = defineCapability({
  name: "email",
  requiredBindings: [{ type: "d1", name: "EMAIL_SUPPRESSIONS" }] satisfies BindingSpecInput[],
});
const support = defineCapability({
  name: "support",
  requiredBindings: [{ type: "r2", name: "SUPPORT_BUCKET", optional: true }] satisfies BindingSpecInput[],
});
/** The two fields of a manifest a naming reads, parsed through the same `BindingSpec` contract. */
const manifest = (name: string, requiredBindings: BindingSpecInput[]) => {
  const parsed = defineCapability({ name, requiredBindings });
  return { name: parsed.name, requiredBindings: parsed.requiredBindings };
};
/** What their manifests declare, which is where `scope` and `resource` live. */
const MANIFESTS = [
  manifest("email", [{ type: "d1", name: "EMAIL_SUPPRESSIONS", scope: "global" }]),
  manifest("support", [{ type: "r2", name: "SUPPORT_BUCKET", scope: "global", resource: "support" }]),
];
const globalStanza = (suppressions: string, bucket: string) =>
  `{ "d1_databases": [{ "binding": "EMAIL_SUPPRESSIONS", "database_name": "${suppressions}" }], "r2_buckets": [{ "binding": "SUPPORT_BUCKET", "bucket_name": "${bucket}" }] }`;
const globalWorkers = (own: string[]) => async (): Promise<DeclaredNamesWorker[]> => [
  { dir: other, capabilities: [email, support], ownBindings: own, declarations: MANIFESTS },
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
        global: false,
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

  test("holds a global binding to the one global name in every environment, as the manifest declares it", async () => {
    const stanza = globalStanza("my-app-global-email-suppressions", "my-app-global-support");
    await writeFile(
      join(other, "wrangler.jsonc"),
      `{ "name": "my-app-other", "env": { "staging": ${stanza}, "prod": ${stanza} } }`,
    );
    expect(await checkDeclaredNames(dir, globalWorkers([]))).toEqual({ state: "ok", mismatches: [], unrecognized: [] });
  });

  test("reports a global binding naming something else against the global name, and never offers ownBindings", async () => {
    await writeFile(
      join(other, "wrangler.jsonc"),
      `{ "name": "my-app-other", "env": { "staging": ${globalStanza("my-app-staging-email-suppressions", "my-app-global-support")} } }`,
    );
    const check = await checkDeclaredNames(dir, globalWorkers([]));
    expect(check.mismatches).toEqual([
      {
        worker: "other",
        env: "staging",
        binding: "EMAIL_SUPPRESSIONS",
        kind: "d1",
        declared: "my-app-staging-email-suppressions",
        expected: "my-app-global-email-suppressions",
        owned: false,
        global: true,
      },
    ]);
    const sentence = describeDeclaredName(check.mismatches[0] as (typeof check.mismatches)[number]);
    expect(sentence).not.toContain("ownBindings");
    expect(sentence).toContain("pithy provision --env staging --yes --repoint");
  });

  test("names a resource: binding by its resource, as the manifest declares it", async () => {
    const media = defineCapability({
      name: "media",
      requiredBindings: [{ type: "r2", name: "MEDIA_BUCKET" }] satisfies BindingSpecInput[],
    });
    await writeFile(
      join(other, "wrangler.jsonc"),
      `{ "name": "my-app-other", "env": { "staging": { "r2_buckets": [{ "binding": "MEDIA_BUCKET", "bucket_name": "my-app-staging-media" }] } } }`,
    );
    const check = await checkDeclaredNames(dir, async () => [
      {
        dir: other,
        capabilities: [media],
        ownBindings: [],
        declarations: [manifest("media", [{ type: "r2", name: "MEDIA_BUCKET", resource: "media" }])],
      },
    ]);
    expect(check).toEqual({ state: "ok", mismatches: [], unrecognized: [] });
  });

  test("cannot check a project with no root config", async () => {
    await rm(join(dir, "pithy.config.ts"));
    expect((await checkDeclaredNames(dir, workers([]))).state).toBe("could-not-check");
  });
});

describe("checkDeclaredNames on the real composition", () => {
  let project: string;
  let api: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "pithy-declared-names-real-"));
    await writeFile(
      join(project, "pithy.config.ts"),
      'export default { name: "acme", environments: ["staging", "prod"] };\n',
    );
    await linkKitPackages(project, ["core"]);
    api = join(project, "apps", "api");
    await mkdir(api, { recursive: true });
    // The shipped email package, installed in the Worker's own node_modules: its manifest is the one place
    // EMAIL_SUPPRESSIONS is declared global, so a check that read the project root's alone would miss it.
    await linkKitPackages(api, ["email"]);
    // A capability object named email that, like the shipped one, carries no `scope`.
    await writeFile(
      join(api, "pithy.config.ts"),
      `import { defineCapability } from "@pithy-sh/core/src/capability/capability";

const email = defineCapability({ name: "email", requiredBindings: [{ type: "d1", name: "EMAIL_SUPPRESSIONS" }] });

export default { capabilities: [email] };
`,
    );
  });
  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  const suppressions = (name: string) =>
    `{ "d1_databases": [{ "binding": "EMAIL_SUPPRESSIONS", "database_name": "${name}" }] }`;

  test("is quiet when every environment names the global database, as the installed manifest declares it", async () => {
    const stanza = suppressions("acme-global-email-suppressions");
    await writeFile(
      join(api, "wrangler.jsonc"),
      `{ "name": "acme-api", "env": { "staging": ${stanza}, "prod": ${stanza} } }`,
    );
    expect(await checkDeclaredNames(project)).toEqual({ state: "ok", mismatches: [], unrecognized: [] });
  });

  test("holds a per-environment name to the global one, and offers no ownBindings", async () => {
    await writeFile(
      join(api, "wrangler.jsonc"),
      `{ "name": "acme-api", "env": { "staging": ${suppressions("acme-staging-email-suppressions")} } }`,
    );
    const check = await checkDeclaredNames(project);
    expect(check.mismatches).toEqual([
      expect.objectContaining({
        worker: "api",
        env: "staging",
        binding: "EMAIL_SUPPRESSIONS",
        expected: "acme-global-email-suppressions",
        owned: false,
        global: true,
      }),
    ]);
  });
});
