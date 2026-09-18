// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DevSecretsTarget } from "../devSecrets/targets";
import { checkDevVarsLocal, describeDevVarsLocal } from "./devVarsLocal";

const registry = defineSecretRegistry({
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
  "email-link-signing-key": {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
});

const empty = { devOnly: [], shadowing: [], shadowingBinding: [], unresolvable: [] };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-local-vars-"));
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A Worker whose `wrangler.jsonc` declares exactly `config`. */
async function worker(name: string, config: unknown): Promise<string> {
  const path = join(dir, "apps", name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

function targets(dirs: string[]): DevSecretsTarget[] {
  return dirs.map((path) => ({ name: "board", dir: path, registry }));
}

describe("checkDevVarsLocal", () => {
  test("a project with no .dev.vars.local anywhere has nothing to say", async () => {
    const board = await worker("board", { vars: { ENVIRONMENT: "dev" } });
    expect(await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) })).toBeNull();
  });

  test("a key that exists only in dev is named — that failure otherwise lands at deploy", async () => {
    const board = await worker("board", { vars: { ENVIRONMENT: "dev" } });
    await writeFile(join(dir, ".dev.vars.local"), "FEATURE_FLAG=1\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) });

    expect(check?.devOnly).toEqual([{ key: "FEATURE_FLAG", file: ".dev.vars.local" }]);
    const line = describeDevVarsLocal(check ?? empty)[0];
    expect(line).toContain("wrangler.jsonc vars");
    // Doctor cannot know whether production needs it, so the line gives both outcomes and assumes neither.
    expect(line).not.toContain("belongs in");
    expect(line).toContain("If production needs it, declare it in wrangler.jsonc vars.");
    expect(line).toContain("If nothing reads it, delete it.");
  });

  test("a key declared in wrangler.jsonc vars is not dev-only", async () => {
    const board = await worker("board", { vars: { ENVIRONMENT: "dev" } });
    await writeFile(join(dir, ".dev.vars.local"), "ENVIRONMENT=staging\n");

    expect(await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) })).toBeNull();
  });

  test("env.<name>.vars REPLACES the top level, so a key declared only there still counts", async () => {
    // The starter's own `wrangler.jsonc` warns about this: every environment repeats every variable.
    // Reading the top level alone would name a staging-only variable as one that exists only in dev.
    const board = await worker("board", { vars: {}, env: { staging: { vars: { REGION: "weur" } } } });
    await writeFile(join(dir, ".dev.vars.local"), "REGION=local\n");

    expect(await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) })).toBeNull();
  });

  test("a key that shadows a registry secret is legitimate, and never invisible", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(board, ".dev.vars.local"), "auth-session-secret=mine\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) });

    expect(check?.shadowing).toEqual([{ key: "auth-session-secret", file: join("apps", "board", ".dev.vars.local") }]);
    expect(check?.devOnly).toEqual([]);
    expect(check?.shadowingBinding).toEqual([]);
    expect(describeDevVarsLocal(check ?? empty)).toEqual([
      "auth-session-secret in apps/board/.dev.vars.local shadows the secret of that name. Fine, and never silent.",
    ]);
  });

  test("the root file is judged against every Worker's vars, because it reaches every Worker", async () => {
    const board = await worker("board", { vars: { ENVIRONMENT: "dev" } });
    const web = await worker("web", { vars: { PUBLIC_URL: "http://localhost" } });
    await writeFile(join(dir, ".dev.vars.local"), "PUBLIC_URL=http://elsewhere\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board, web], targets: targets([board]) });

    expect(check).toBeNull();
  });

  test("a key named like a top-level workflows binding shadows it, and the line says remove it (#636)", async () => {
    const board = await worker("board", {
      vars: {},
      workflows: [{ binding: "EMAIL_SENDER", name: "replay-dev-email-sender", class_name: "S", script_name: "e" }],
    });
    await writeFile(join(board, ".dev.vars.local"), "EMAIL_SENDER=x\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) });

    expect(check?.devOnly).toEqual([]);
    expect(check?.shadowingBinding).toEqual([
      {
        key: "EMAIL_SENDER",
        file: join("apps", "board", ".dev.vars.local"),
        bindings: [{ worker: "board", kind: "workflows", in: null }],
        moveTo: [],
      },
    ]);
    // Not "reads a string where the binding should be": wrangler dev keeps a top-level binding and drops
    // the .dev.vars value of that name — shown against wrangler 4.125 for workflows, d1, kv, services, ai.
    expect(describeDevVarsLocal(check ?? empty)).toEqual([
      "EMAIL_SENDER in apps/board/.dev.vars.local has the name of board's workflows binding. wrangler dev ignores the value: the binding wins. Remove it.",
    ]);
  });

  test("a binding declared only under env.<name> is still shadowed (#636)", async () => {
    const board = await worker("board", {
      vars: {},
      env: { staging: { workflows: [{ binding: "EMAIL_SENDER", name: "w", class_name: "S" }] } },
    });
    await writeFile(join(board, ".dev.vars.local"), "EMAIL_SENDER=x\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) });

    expect(check?.shadowingBinding.map((entry) => [entry.key, entry.bindings])).toEqual([
      ["EMAIL_SENDER", [{ worker: "board", kind: "workflows", in: "env.staging" }]],
    ]);
    expect(check?.devOnly).toEqual([]);
  });

  test("a nested durable_objects binding and a secrets_store_secrets binding are named by kind (#636)", async () => {
    const board = await worker("board", {
      vars: {},
      durable_objects: { bindings: [{ name: "ROOMS", class_name: "Room" }] },
      env: { prod: { secrets_store_secrets: [{ binding: "PAYMENTS_KEY", store_id: "s", secret_name: "k" }] } },
    });
    await writeFile(join(board, ".dev.vars.local"), "ROOMS=x\nPAYMENTS_KEY=y\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) });

    expect(check?.shadowingBinding.map((entry) => [entry.key, entry.bindings.map((b) => b.kind)])).toEqual([
      ["PAYMENTS_KEY", ["secrets_store_secrets"]],
      ["ROOMS", ["durable_objects"]],
    ]);
    expect(check?.devOnly).toEqual([]);
  });

  test("the root file is judged against every Worker's bindings, as it is against their vars (#636)", async () => {
    const board = await worker("board", { vars: {} });
    const web = await worker("web", { vars: {}, kv_namespaces: [{ binding: "SESSIONS" }] });
    await writeFile(join(dir, ".dev.vars.local"), "SESSIONS=x\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board, web], targets: targets([board]) });

    expect(check?.shadowingBinding).toEqual([
      {
        key: "SESSIONS",
        file: ".dev.vars.local",
        bindings: [{ worker: "web", kind: "kv_namespaces", in: null }],
        moveTo: [],
      },
    ]);
  });

  test("a Worker's own file is judged against its own bindings, not a sibling's", async () => {
    const board = await worker("board", { vars: {} });
    await worker("web", { vars: {}, kv_namespaces: [{ binding: "SESSIONS" }] });
    await writeFile(join(board, ".dev.vars.local"), "SESSIONS=x\n");

    const check = await checkDevVarsLocal({
      projectDir: dir,
      workerDirs: [board, join(dir, "apps", "web")],
      targets: targets([board]),
    });

    expect(check?.shadowingBinding).toEqual([]);
    expect(check?.devOnly.map((entry) => entry.key)).toEqual(["SESSIONS"]);
  });

  test("a store secret's binding is the secret, so it reads as the secret it shadows", async () => {
    // `email-link-signing-key` is bound, and materialized into .dev.vars, as EMAIL_LINK_SIGNING_KEY (#603).
    // Overriding it locally is what the file is for — never a binding to remove.
    const board = await worker("board", {
      vars: {},
      env: {
        prod: { secrets_store_secrets: [{ binding: "EMAIL_LINK_SIGNING_KEY", store_id: "s", secret_name: "k" }] },
      },
    });
    await writeFile(join(board, ".dev.vars.local"), "EMAIL_LINK_SIGNING_KEY=x\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) });

    expect(check?.shadowing.map((entry) => entry.key)).toEqual(["EMAIL_LINK_SIGNING_KEY"]);
    expect(check?.shadowingBinding).toEqual([]);
    expect(check?.devOnly).toEqual([]);
  });

  test("a name in secrets.required is a secret the Worker reads — shadowed, never dev-only (#636)", async () => {
    const board = await worker("board", {
      vars: {},
      secrets: { required: ["STRIPE_KEY"] },
      env: { staging: { secrets: { required: ["STAGING_KEY"] } } },
    });
    await writeFile(join(board, ".dev.vars.local"), "STAGING_KEY=x\nSTRIPE_KEY=sk_test\n");
    await writeFile(join(dir, ".dev.vars.local"), "STRIPE_KEY=sk_root\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: [] });

    expect(check?.devOnly).toEqual([]);
    expect(check?.shadowing.map((entry) => [entry.file, entry.key])).toEqual([
      [".dev.vars.local", "STRIPE_KEY"],
      [join("apps", "board", ".dev.vars.local"), "STAGING_KEY"],
      [join("apps", "board", ".dev.vars.local"), "STRIPE_KEY"],
    ]);
    const lines = describeDevVarsLocal(check ?? empty).join("\n");
    expect(lines).not.toContain("wrangler.jsonc vars");
    expect(lines).not.toContain("nowhere else");
    expect(lines).toContain("STRIPE_KEY in apps/board/.dev.vars.local shadows the secret of that name.");
  });

  test("secrets.required is wrangler.jsonc's word, so it survives a registry nobody read (#636)", async () => {
    const board = await worker("board", { vars: {}, secrets: { required: ["STRIPE_KEY"] } });
    await writeFile(join(board, ".dev.vars.local"), "STRIPE_KEY=sk_test\n");
    const broken = [{ name: "board", dir: board, reason: "pithy.config.ts would not import." }];

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: [], unresolvable: broken });

    expect(check?.shadowing.map((entry) => entry.key)).toEqual(["STRIPE_KEY"]);
  });

  test("a Worker's own file is judged against its own secrets: a sibling's does not hide its binding (#636)", async () => {
    const board = await worker("board", { vars: {} });
    const web = await worker("web", { vars: {}, services: [{ binding: "EMAIL_LINK_SIGNING_KEY", service: "api" }] });
    await writeFile(join(web, ".dev.vars.local"), "EMAIL_LINK_SIGNING_KEY=x\n");

    // Only board composes the registry that binds EMAIL_LINK_SIGNING_KEY as a store secret.
    const check = await checkDevVarsLocal({
      projectDir: dir,
      workerDirs: [board, web],
      targets: [{ name: "board", dir: board, registry }],
    });

    expect(check?.shadowing).toEqual([]);
    expect(check?.shadowingBinding).toEqual([
      {
        key: "EMAIL_LINK_SIGNING_KEY",
        file: join("apps", "web", ".dev.vars.local"),
        bindings: [{ worker: "web", kind: "services", in: null }],
        moveTo: [],
      },
    ]);
  });

  test("a sibling's registry secret still reaches this Worker's .dev.vars, so overriding it is shadowing", async () => {
    const board = await worker("board", { vars: {} });
    const web = await worker("web", { vars: {} });
    await writeFile(join(web, ".dev.vars.local"), "auth-session-secret=x\n");

    const check = await checkDevVarsLocal({
      projectDir: dir,
      workerDirs: [board, web],
      targets: [{ name: "board", dir: board, registry }],
    });

    expect(check?.shadowing.map((entry) => entry.file)).toEqual([join("apps", "web", ".dev.vars.local")]);
  });

  test("the root file names the Worker whose binding it has the name of (#636)", async () => {
    const board = await worker("board", { vars: {} });
    const web = await worker("web", { vars: {}, kv_namespaces: [{ binding: "SESSIONS" }] });
    await writeFile(join(dir, ".dev.vars.local"), "SESSIONS=x\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board, web], targets: targets([board]) });

    expect(describeDevVarsLocal(check ?? empty)).toEqual([
      "SESSIONS in .dev.vars.local has the name of web's kv_namespaces binding. wrangler dev ignores the value: the binding wins. Remove it.",
    ]);
  });

  test("a root key one Worker binds and another reads as a var moves into the reader's file, never removed (#636)", async () => {
    const board = await worker("board", { vars: { API_URL: "https://api.example" } });
    const web = await worker("web", { vars: {}, services: [{ binding: "API_URL", service: "api" }] });
    await writeFile(join(dir, ".dev.vars.local"), "API_URL=http://localhost:9999\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board, web], targets: targets([board]) });

    expect(check?.shadowingBinding).toEqual([
      {
        key: "API_URL",
        file: ".dev.vars.local",
        bindings: [{ worker: "web", kind: "services", in: null }],
        moveTo: [join("apps", "board", ".dev.vars.local")],
      },
    ]);
    expect(describeDevVarsLocal(check ?? empty)).toEqual([
      "API_URL in .dev.vars.local has the name of web's services binding. wrangler dev ignores the value: the binding wins. board reads it as a value: move it into apps/board/.dev.vars.local.",
    ]);
  });

  test("a root key one Worker binds and another reads as its own secret moves too (#636)", async () => {
    const board = await worker("board", { vars: {} });
    const web = await worker("web", { vars: {}, services: [{ binding: "auth-session-secret", service: "api" }] });
    await writeFile(join(dir, ".dev.vars.local"), "auth-session-secret=x\n");

    const check = await checkDevVarsLocal({
      projectDir: dir,
      workerDirs: [board, web],
      targets: [{ name: "board", dir: board, registry }],
    });

    expect(check?.shadowing).toEqual([]);
    expect(check?.shadowingBinding.map((entry) => [entry.bindings.map((b) => b.worker), entry.moveTo])).toEqual([
      [["web"], [join("apps", "board", ".dev.vars.local")]],
    ]);
  });

  test("a binding only previews or an environment declares is said to be there, and what dev reads (#636)", async () => {
    const board = await worker("board", {
      vars: {},
      previews: {
        ai: { binding: "PREVIEW_AI" },
        workflows: [{ binding: "EMAIL_SENDER", name: "p", class_name: "C" }],
      },
      workflows: [{ binding: "EMAIL_SENDER", name: "w", class_name: "C" }],
      env: { staging: { d1_databases: [{ binding: "STAGING_DB" }] } },
    });
    await writeFile(join(board, ".dev.vars.local"), "EMAIL_SENDER=x\nPREVIEW_AI=y\nSTAGING_DB=z\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) });

    expect(describeDevVarsLocal(check ?? empty)).toEqual([
      "EMAIL_SENDER in apps/board/.dev.vars.local has the name of board's workflows binding. wrangler dev ignores the value: the binding wins. Remove it.",
      "PREVIEW_AI in apps/board/.dev.vars.local has the name of board's ai binding in previews. pithy dev runs the top level, which has no such binding, so in dev the Worker reads this string instead. Remove it.",
      "STAGING_DB in apps/board/.dev.vars.local has the name of board's d1_databases binding in env.staging. pithy dev runs the top level, which has no such binding, so in dev the Worker reads this string instead. Remove it.",
    ]);
  });

  test("no value ever reaches the report", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars.local"), "TOKEN=s3cr3t\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) });

    expect(JSON.stringify(check)).not.toContain("s3cr3t");
    expect(describeDevVarsLocal(check ?? empty).join("\n")).not.toContain("s3cr3t");
  });
});

/**
 * A Worker whose `pithy.config.ts` will not import (#208).
 *
 * `devOnly` is the negative claim — "nothing but this file knows about this key" — and a registry that
 * would not load is exactly what could have known about it. `shadowing` is positive evidence and survives.
 */
describe("a Worker nobody could ask (#208)", () => {
  const broken = [{ name: "board", dir: "/p/apps/board", reason: "pithy.config.ts would not import." }];

  test("no key is called dev-only on the strength of a registry nobody could read", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(board, ".dev.vars.local"), "MAYBE_A_SECRET=x\n");

    const result = await checkDevVarsLocal({
      projectDir: dir,
      workerDirs: [board],
      targets: [],
      unresolvable: broken,
    });

    expect(result?.devOnly).toEqual([]);
    expect(result?.unresolvable).toEqual(broken);
  });

  test("a key a readable registry declares still shadows — positive evidence survives", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(board, ".dev.vars.local"), "auth-session-secret=x\n");

    const result = await checkDevVarsLocal({
      projectDir: dir,
      workerDirs: [board],
      targets: targets([board]),
      unresolvable: broken,
    });

    expect(result?.shadowing.map((entry) => entry.key)).toEqual(["auth-session-secret"]);
  });

  test("a binding shadow rests on wrangler.jsonc, not the registry, so it survives (#636)", async () => {
    const board = await worker("board", {
      vars: {},
      workflows: [{ binding: "EMAIL_SENDER", name: "w", class_name: "S" }],
    });
    await writeFile(join(board, ".dev.vars.local"), "EMAIL_SENDER=x\n");

    const result = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: [], unresolvable: broken });

    expect(result?.shadowingBinding.map((entry) => entry.key)).toEqual(["EMAIL_SENDER"]);
  });

  test("…except a store-secret binding, which the unread registry may have declared as a secret", async () => {
    const board = await worker("board", {
      vars: {},
      secrets_store_secrets: [{ binding: "MAYBE_A_SECRET", store_id: "s", secret_name: "k" }],
    });
    await writeFile(join(board, ".dev.vars.local"), "MAYBE_A_SECRET=x\n");

    const result = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: [], unresolvable: broken });

    expect(result?.shadowingBinding).toEqual([]);
    expect(result?.devOnly).toEqual([]);
  });

  test("with every config readable the dev-only claim is made exactly as before", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(board, ".dev.vars.local"), "MAYBE_A_SECRET=x\n");

    const result = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) });

    expect(result?.devOnly.map((entry) => entry.key)).toEqual(["MAYBE_A_SECRET"]);
  });
});
