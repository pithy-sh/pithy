// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import type { DatabaseRun } from "../migrations/run";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { addCapability } from "./add";
import {
  defaultRemoveSteps,
  importsPackage,
  type RemoveSteps,
  removableBindings,
  removeCapability,
  removeFromWrangler,
  unwireConfig,
} from "./remove";

/** A minimal manifest for the pure helpers. */
function manifest(over: Partial<CapabilityManifest> & { name: string }): CapabilityManifest {
  return {
    package: `@pithy-sh/${over.name}`,
    requiredBindings: [],
    peerCapabilities: [],
    optionalCapabilities: [],
    scaffold: [],
    configOptions: [],
    ...over,
  } as CapabilityManifest;
}

describe("unwireConfig", () => {
  test("removes a single-line registration and the package import", () => {
    const source = [
      'import { turnstile } from "@pithy-sh/turnstile/src/index";',
      "export default {",
      "  capabilities: [",
      "    turnstile(),",
      "    // pithy:capabilities",
      "  ],",
      "};",
    ].join("\n");

    const out = unwireConfig(source, "turnstile", "@pithy-sh/turnstile");
    expect(out).not.toContain("@pithy-sh/turnstile/src/index");
    expect(out).not.toContain("turnstile()");
    expect(out).toContain("// pithy:capabilities");
  });

  test("removes a block registration (config options) whole", () => {
    const source = [
      'import { auth } from "@pithy-sh/auth/src/index";',
      "export default {",
      "  capabilities: [",
      "    auth({",
      "      // Base path for auth routes",
      '      basePath: "/auth",',
      "    }),",
      "    // pithy:capabilities",
      "  ],",
      "};",
    ].join("\n");

    const out = unwireConfig(source, "auth", "@pithy-sh/auth");
    expect(out).not.toContain("auth(");
    expect(out).not.toContain("basePath");
    expect(out).not.toContain("@pithy-sh/auth/src/index");
    expect(out).toContain("// pithy:capabilities");
  });

  test("removes an ejected (local) import too", () => {
    const source = [
      'import { auth } from "./capabilities/auth";',
      "  capabilities: [",
      "    auth(),",
      "    // pithy:capabilities",
    ].join("\n");

    const out = unwireConfig(source, "auth", "@pithy-sh/auth");
    expect(out).not.toContain("./capabilities/auth");
    expect(out).not.toContain("auth()");
  });

  test("removes a hand-edited deep import of the capability's package", () => {
    // `add` accepts any specifier into the capability's own package, so `remove` has to take the same
    // set out. Leaving one behind while the package is uninstalled is a config that cannot load.
    const source = [
      'import { auth } from "@pithy-sh/auth/src/capability";',
      "  capabilities: [",
      "    auth(),",
      "    // pithy:capabilities",
    ].join("\n");

    const out = unwireConfig(source, "auth", "@pithy-sh/auth");
    expect(out).not.toContain("@pithy-sh/auth");
    expect(out).not.toContain("auth()");
  });

  test("takes out every import of the capability, not just the first", () => {
    // The wreckage the old `add` left behind: a hand-corrected specifier, plus the broken one put
    // straight back on the next run. Removing one of the two still leaves the config unloadable.
    const source = [
      'import { secrets } from "@pithy-sh/secrets/src/capability";',
      'import { secrets } from "@pithy-sh/secrets/src/index";',
      "    secrets(),",
      "    // pithy:capabilities",
    ].join("\n");

    expect(unwireConfig(source, "secrets", "@pithy-sh/secrets")).not.toContain("@pithy-sh/secrets");
  });

  test("takes the capability out of a shared clause and leaves the adopter's other bindings", () => {
    // Deleting the whole statement deleted bindings that were never ours. `hashPassword` still resolves
    // here; if the uninstall then takes the package, that is a loud typecheck failure, not a silent
    // deletion of code the adopter wrote.
    const source = [
      'import { auth, hashPassword } from "@pithy-sh/auth/src/index";',
      "  capabilities: [",
      "    auth(),",
      "    // pithy:capabilities",
    ].join("\n");

    const out = unwireConfig(source, "auth", "@pithy-sh/auth");
    expect(out).toContain('import { hashPassword } from "@pithy-sh/auth/src/index";');
    expect(out).not.toContain("auth()");
  });

  test("leaves an import of the same name from somewhere else alone", () => {
    // The adopter's own `auth`, which `add` would have refused to wire over. Not ours to delete.
    const source = ['import { auth } from "./lib/myAuth";', "  capabilities: [", "    // pithy:capabilities"].join(
      "\n",
    );
    expect(unwireConfig(source, "auth", "@pithy-sh/auth")).toBe(source);
  });

  test("leaves a config that never had the capability unchanged", () => {
    const source = 'import { email } from "@pithy-sh/email/src/index";\n    email(),\n    // pithy:capabilities';
    expect(unwireConfig(source, "auth", "@pithy-sh/auth")).toBe(source);
  });

  test("does not match a different capability with a shared prefix", () => {
    const source = ['import { authpro } from "@pithy-sh/authpro/src/index";', "    authpro(),"].join("\n");
    expect(unwireConfig(source, "auth", "@pithy-sh/auth")).toBe(source);
  });

  test("throws — never truncates — when a block registration has no closing line", () => {
    // A hand-mangled block whose close isn't the expected `}),` line.
    const source = [
      'import { auth } from "@pithy-sh/auth/src/index";',
      "export default {",
      "  capabilities: [",
      "    auth({",
      '      basePath: "/auth" }),', // close is on the option line, not its own `}),`
      "    // pithy:capabilities",
      "  ],",
      "};",
    ].join("\n");
    expect(() => unwireConfig(source, "auth", "@pithy-sh/auth")).toThrow(PithyError);
  });
});

describe("importsPackage", () => {
  test("matches the wiring import and any deep import of the package", () => {
    expect(importsPackage('import { auth } from "@pithy-sh/auth/src/index";', "@pithy-sh/auth")).toBe(true);
    expect(importsPackage('import { hash } from "@pithy-sh/auth/src/crypto/hash";', "@pithy-sh/auth")).toBe(true);
    expect(importsPackage('import "@pithy-sh/auth";', "@pithy-sh/auth")).toBe(true);
  });

  test("does not match an ejected import or a shared-prefix package", () => {
    expect(importsPackage('import { auth } from "./capabilities/auth";', "@pithy-sh/auth")).toBe(false);
    expect(importsPackage('import { authpro } from "@pithy-sh/authpro/src/index";', "@pithy-sh/auth")).toBe(false);
    expect(importsPackage("export default { capabilities: [] };", "@pithy-sh/auth")).toBe(false);
  });
});

describe("removableBindings", () => {
  test("keeps a binding another installed capability still requires", () => {
    const auth = manifest({
      name: "auth",
      requiredBindings: [
        { type: "d1", name: "DB", optional: false },
        { type: "kv", name: "SESSIONS", optional: false },
      ],
    });
    const email = manifest({ name: "email", requiredBindings: [{ type: "d1", name: "DB", optional: false }] });

    // Removing auth while email remains: DB is shared and stays; SESSIONS is auth-only and goes.
    const removable = removableBindings(auth, [email]);
    expect(removable.map((b) => b.name)).toEqual(["SESSIONS"]);
  });

  test("removes every binding when no other capability needs them", () => {
    const auth = manifest({ name: "auth", requiredBindings: [{ type: "d1", name: "DB", optional: false }] });
    expect(removableBindings(auth, []).map((b) => b.name)).toEqual(["DB"]);
  });
});

describe("removeFromWrangler — durable objects", () => {
  /** Stands in for one `apps/<name>` directory: bindings are stripped from a Worker's own wrangler.jsonc. */
  let worker: string;
  beforeEach(async () => {
    worker = await mkdtemp(join(tmpdir(), "pithy-remove-do-"));
  });
  afterEach(async () => {
    await rm(worker, { recursive: true, force: true });
  });

  test("strips the DO binding from every env and the class from the top-level migration tag", async () => {
    // A project that `pithy add multiplayer` has already wired.
    const wrangler = {
      d1_databases: [{ binding: "DB" }],
      durable_objects: { bindings: [{ name: "SESSIONS", class_name: "MultiplayerSession" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["MultiplayerSession"] }],
      env: {
        staging: { durable_objects: { bindings: [{ name: "SESSIONS", class_name: "MultiplayerSession" }] } },
      },
    };
    await writeFile(join(worker, "wrangler.jsonc"), `${JSON.stringify(wrangler, null, 2)}\n`);

    const target = {
      requiredBindings: [
        BindingSpec.parse({ type: "durable_object", name: "SESSIONS", className: "MultiplayerSession" }),
        BindingSpec.parse({ type: "d1", name: "DB" }),
      ],
    };
    // `DB` is shared with another capability and must survive.
    const others = [{ requiredBindings: [BindingSpec.parse({ type: "d1", name: "DB" })] }];

    const removed = await removeFromWrangler(worker, target, others);
    expect(removed).toEqual(["SESSIONS"]);

    const result = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as typeof wrangler;
    expect(result.durable_objects.bindings).toEqual([]);
    expect(result.env.staging.durable_objects.bindings).toEqual([]);
    // The migration tag is emptied of the class and dropped entirely — the clean inverse of add.
    expect(result.migrations).toBeUndefined();
    // The shared D1 binding stays.
    expect(result.d1_databases).toEqual([{ binding: "DB" }]);
  });
});

describe("add then remove", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-roundtrip-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** One capability declaring every binding kind the writer emits. */
  const everyKind = CapabilityManifest.parse({
    name: "media",
    package: "@pithy-sh/media",
    requiredBindings: [
      { type: "d1", name: "DB" },
      { type: "kv", name: "MEDIA" },
      { type: "r2", name: "MEDIA_BUCKET" },
      { type: "vectorize", name: "MEDIA_INDEX", remote: true },
      { type: "ai", name: "AI", remote: true },
      { type: "workflow", name: "MEDIA_IMAGE_TO_TEXT", className: "ImageToTextWorkflow", optional: true },
      { type: "durable_object", name: "MEDIA_SESSION", className: "MediaSession" },
    ],
  });

  /** A project another capability already wired, with comments inside the binding arrays. */
  const fixture = `{
  "name": "pithy-app",
  "main": "src/index.ts",

  // The app database. Every capability shares it.
  "d1_databases": [{ "binding": "DB" }],
  "kv_namespaces": [
    // Sessions live here — auth owns this namespace.
    { "binding": "SESSIONS" }
  ],
  "r2_buckets": [],
  "vectorize": [],
  "workflows": [],
  "durable_objects": { "bindings": [] },

  "env": {
    "staging": {
      "d1_databases": [{ "binding": "DB" }],
      "kv_namespaces": [
        // auth's namespace, one per environment.
        { "binding": "SESSIONS" }
      ],
      "r2_buckets": [],
      "vectorize": [],
      "workflows": [],
      "durable_objects": { "bindings": [] }
    }
  }
}
`;

  test("restores wrangler.jsonc byte for byte, comments included", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), fixture);
    await writeFile(
      join(dir, "pithy.config.ts"),
      "export default {\n  capabilities: [\n    // pithy:capabilities\n  ],\n};\n",
    );
    // Canonicalize through the writer first, so the comparison proves the mirror is complete rather
    // than re-testing comment-json's formatting choices.
    await writeWranglerConfig(dir, await readWranglerConfig(dir));
    const before = await readFile(join(dir, "wrangler.jsonc"), "utf8");

    await addCapability({ workerDir: dir, manifest: everyKind });
    const added = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    expect(added).not.toBe(before); // the add wrote something to undo

    // `DB` and `SESSIONS` belong to another capability and must survive untouched.
    const others = [
      {
        requiredBindings: [
          BindingSpec.parse({ type: "d1", name: "DB" }),
          BindingSpec.parse({ type: "kv", name: "SESSIONS" }),
        ],
      },
    ];
    const removed = await removeFromWrangler(dir, { requiredBindings: everyKind.requiredBindings }, others);
    expect(removed).toEqual(["MEDIA", "MEDIA_BUCKET", "MEDIA_INDEX", "AI", "MEDIA_IMAGE_TO_TEXT", "MEDIA_SESSION"]);

    const after = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    // Byte for byte: any binding kind add can write and remove cannot strip shows up here.
    expect(after).toBe(before);
    // Named explicitly, because a filter-style strip would drop these silently and still parse.
    expect(after).toContain("// Sessions live here — auth owns this namespace.");
    expect(after).toContain("// auth's namespace, one per environment.");
  });
});

describe("removeCapability", () => {
  let dir: string;
  /** The Worker being unwired — `apps/<name>`, where its config and wrangler.jsonc live. */
  let worker: string;

  /** A capability object as the loaded project would carry it. */
  function cap(
    name: string,
    over: {
      requiredBindings?: Capability["requiredBindings"];
      databases?: Capability["databases"];
      dependsOn?: string[];
    } = {},
  ): Capability {
    return defineCapability({
      name,
      requiredBindings: over.requiredBindings ?? [],
      databases: over.databases,
      dependsOn: over.dependsOn,
    });
  }

  const withMigration = {
    app: {
      binding: "DB",
      tables: {},
      migrationOrder: 100,
      migrations: { "0001_init": { up: async () => {}, down: async () => {} } },
    },
  };

  /** Scaffold one Worker's config + wrangler.jsonc under `apps/<name>`, with the capability wired. */
  async function fixture(over: { ejected?: boolean; capName?: string; workerDir?: string } = {}): Promise<string> {
    const workerDir = over.workerDir ?? worker;
    await mkdir(workerDir, { recursive: true });
    const name = over.capName ?? "turnstile";
    const importLine = over.ejected
      ? `import { ${name} } from "./capabilities/${name}";`
      : `import { ${name} } from "@pithy-sh/${name}/src/index";`;
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      [
        importLine,
        "export default {",
        "  capabilities: [",
        `    ${name}(),`,
        "    // pithy:capabilities",
        "  ],",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      JSON.stringify(
        {
          d1_databases: [{ binding: "DB" }],
          kv_namespaces: [{ binding: "SESSIONS" }],
          env: { staging: { d1_databases: [{ binding: "DB" }], kv_namespaces: [{ binding: "SESSIONS" }] } },
        },
        null,
        2,
      ),
    );
    return workerDir;
  }

  /** Injectable steps recording their calls; the config/wrangler unwire runs for real on the fixture. */
  function steps(over: Partial<RemoveSteps> & { dropped?: DatabaseRun[] } = {}) {
    const calls = {
      dropTables: [] as string[],
      uninstall: [] as string[],
      deleteSource: [] as string[],
      workersUsingPackage: [] as string[],
    };
    const s: RemoveSteps = {
      loadCapabilities:
        over.loadCapabilities ??
        (async () => [cap("turnstile", { requiredBindings: [{ type: "kv", name: "SESSIONS", optional: false }] })]),
      dropTables: async (capability, env) => {
        calls.dropTables.push(`${capability.name}:${env}`);
        return over.dropped ?? [];
      },
      uninstall: async (pkg) => {
        calls.uninstall.push(pkg);
        return { packageManager: "bun", uninstalled: true };
      },
      deleteSource: async (d) => {
        calls.deleteSource.push(d);
      },
      packageInstalled: over.packageInstalled ?? (async () => true),
      workersUsingPackage: async (pkg) => {
        calls.workersUsingPackage.push(pkg);
        return over.workersUsingPackage ? over.workersUsingPackage(pkg) : [];
      },
    };
    return { s, calls };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-remove-"));
    worker = join(dir, "apps", "api");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("an absent capability is a no-op that reports not present", async () => {
    await fixture();
    const { s } = steps({ loadCapabilities: async () => [cap("turnstile")], packageInstalled: async () => false });
    const result = await removeCapability({ workerDir: worker, capability: "ghost", steps: s });
    expect(result.present).toBe(false);
  });

  test("refuses when another wired capability depends on it, naming the dependent", async () => {
    await fixture();
    const { s } = steps({
      loadCapabilities: async () => [cap("secrets"), cap("auth", { dependsOn: ["secrets"] })],
    });
    const failure = await removeCapability({ workerDir: worker, capability: "secrets", steps: s }).catch((e) => e);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toMatch(/auth/);
  });

  test("package-served: unwires config, removes its binding, uninstalls, and warns tables remain", async () => {
    await fixture();
    const { s, calls } = steps({
      loadCapabilities: async () => [
        cap("turnstile", {
          requiredBindings: [{ type: "kv", name: "SESSIONS", optional: false }],
          databases: withMigration,
        }),
      ],
    });

    const result = await removeCapability({ workerDir: worker, capability: "turnstile", steps: s });

    expect(calls.uninstall).toEqual(["@pithy-sh/turnstile"]);
    expect(calls.deleteSource).toEqual([]);
    expect(calls.dropTables).toEqual([]); // no --drop
    expect(result.tablesRemain).toBe(true);
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).not.toContain("turnstile()");
    const wrangler = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    expect(wrangler).not.toContain("SESSIONS"); // turnstile-only binding removed from every env
  });

  test("--drop reverses tables before uninstalling, and reports no tables remain", async () => {
    await fixture();
    const dropped: DatabaseRun[] = [
      {
        database: "app",
        binding: "DB",
        results: [{ migrationName: "0100_turnstile_0001_init", direction: "Down", status: "Success" }],
      },
    ];
    const { s, calls } = steps({
      loadCapabilities: async () => [cap("turnstile", { databases: withMigration })],
      dropped,
    });

    const result = await removeCapability({
      workerDir: worker,
      capability: "turnstile",
      drop: { env: "dev" },
      steps: s,
    });

    expect(calls.dropTables).toEqual(["turnstile:dev"]);
    expect(result.dropped).toEqual(dropped);
    expect(result.tablesRemain).toBe(false);
  });

  test("a declined --drop confirmation aborts with zero changes", async () => {
    await fixture();
    const { s, calls } = steps({ loadCapabilities: async () => [cap("turnstile", { databases: withMigration })] });

    const result = await removeCapability({
      workerDir: worker,
      capability: "turnstile",
      drop: { env: "staging", confirm: async () => false },
      steps: s,
    });

    expect(result.aborted).toBe(true);
    expect(calls.dropTables).toEqual([]);
    // The config still wires the capability — nothing was unwired.
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toContain("turnstile()");
  });

  test("ejected: deletes the local source instead of uninstalling", async () => {
    await fixture({ ejected: true });
    const { s, calls } = steps({ loadCapabilities: async () => [cap("turnstile")] });

    const result = await removeCapability({ workerDir: worker, capability: "turnstile", steps: s });

    expect(result.ejected).toBe(true);
    expect(calls.deleteSource).toEqual([join(worker, "capabilities", "turnstile")]);
    expect(calls.uninstall).toEqual([]);
  });

  test("unwires only the target worker — a sibling wiring the same capability is untouched", async () => {
    await fixture();
    const sibling = await fixture({ workerDir: join(dir, "apps", "edge") });
    const { s } = steps({
      loadCapabilities: async () => [
        cap("turnstile", { requiredBindings: [{ type: "kv", name: "SESSIONS", optional: false }] }),
      ],
    });

    await removeCapability({ workerDir: worker, capability: "turnstile", steps: s });

    expect(await readFile(join(sibling, "pithy.config.ts"), "utf8")).toContain("turnstile()");
    expect(await readFile(join(sibling, "wrangler.jsonc"), "utf8")).toContain("SESSIONS");
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).not.toContain("turnstile()");
  });

  test("keeps the shared package when a sibling worker still wires it", async () => {
    // The package is one install at the project root, shared by every Worker. Unwiring one Worker must
    // not uninstall it while another still imports it — that breaks the sibling's pithy.config.ts and
    // every command that loads it.
    await fixture();
    const { s, calls } = steps({
      loadCapabilities: async () => [cap("turnstile")],
      workersUsingPackage: async () => ["web"],
    });

    const result = await removeCapability({ workerDir: worker, capability: "turnstile", steps: s });

    expect(calls.workersUsingPackage).toEqual(["@pithy-sh/turnstile"]);
    expect(calls.uninstall).toEqual([]);
    expect(result.keptFor).toEqual(["web"]);
    expect(result.packageManager).toBeUndefined();
    // The target worker is still unwired — only the shared package survives.
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).not.toContain("turnstile()");
  });

  test("refuses --drop while a sibling worker still wires the capability — its tables are shared", async () => {
    // Two Workers composing one capability share its tables (same binding name → same D1). Reversing its
    // migrations for one Worker would delete data the other is still serving, so the drop is refused
    // before anything is written — and the refusal names who still needs it.
    await fixture();
    const { s, calls } = steps({
      loadCapabilities: async () => [cap("turnstile")],
      workersUsingPackage: async () => ["web"],
    });

    const failure = removeCapability({
      workerDir: worker,
      capability: "turnstile",
      drop: { env: "dev" },
      steps: s,
    });

    await expect(failure).rejects.toThrow(/still wires it/);
    // Nothing was dropped, nothing uninstalled, and the target worker is still wired — a refusal, not a
    // half-done removal.
    expect(calls.dropTables).toEqual([]);
    expect(calls.uninstall).toEqual([]);
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toContain("turnstile()");
  });

  test("allows --drop when this is the last worker wiring the capability", async () => {
    await fixture();
    const { s, calls } = steps({
      loadCapabilities: async () => [cap("turnstile")],
      workersUsingPackage: async () => [],
    });

    await removeCapability({ workerDir: worker, capability: "turnstile", drop: { env: "dev" }, steps: s });

    expect(calls.dropTables).toEqual(["turnstile:dev"]);
  });

  test("uninstalls the package when no other worker wires it", async () => {
    await fixture();
    const { s, calls } = steps({ loadCapabilities: async () => [cap("turnstile")] });

    const result = await removeCapability({ workerDir: worker, capability: "turnstile", steps: s });

    expect(calls.uninstall).toEqual(["@pithy-sh/turnstile"]);
    expect(result.keptFor).toEqual([]);
    expect(result.packageManager).toBe("bun");
  });

  test("an uninstall that declined is not reported as one — the linked package is still there", async () => {
    // `uninstallPackage` refuses to hand a linked checkout to npm, which would prune the whole scope.
    // The wiring still goes, so the removal is real; saying "Uninstalled @pithy-sh/turnstile" is not.
    await fixture();
    const { s } = steps({ loadCapabilities: async () => [cap("turnstile")] });

    const result = await removeCapability({
      workerDir: worker,
      capability: "turnstile",
      steps: { ...s, uninstall: async () => ({ packageManager: "npm", uninstalled: false }) },
    });

    expect(result.present).toBe(true);
    expect(result.packageManager).toBeUndefined();
    expect(result.keptLinked).toBe(true);
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).not.toContain("turnstile()");
  });

  test("with the real scan: two workers composing one capability keep the package installed", async () => {
    // The end-to-end shape of the defect: apps/api and apps/web both compose turnstile. Removing it from
    // api must leave @pithy-sh/turnstile installed, so apps/web/pithy.config.ts still loads.
    await fixture();
    const sibling = await fixture({ workerDir: join(dir, "apps", "web") });
    const uninstalled: string[] = [];
    const real = defaultRemoveSteps({
      projectDir: dir,
      workerDir: worker,
      loadCapabilities: async () => [cap("turnstile")],
      project: "acme",
    });

    const result = await removeCapability({
      workerDir: worker,
      capability: "turnstile",
      steps: {
        ...real,
        packageInstalled: async () => true,
        uninstall: async (pkg) => {
          uninstalled.push(pkg);
          return { packageManager: "bun", uninstalled: true };
        },
      },
    });

    expect(uninstalled).toEqual([]);
    expect(result.keptFor).toEqual(["web"]);
    expect(await readFile(join(sibling, "pithy.config.ts"), "utf8")).toContain(
      'import { turnstile } from "@pithy-sh/turnstile/src/index";',
    );
  });

  test("with the real scan: the last worker to drop it uninstalls the package", async () => {
    await fixture();
    const uninstalled: string[] = [];
    const real = defaultRemoveSteps({
      projectDir: dir,
      workerDir: worker,
      loadCapabilities: async () => [cap("turnstile")],
      project: "acme",
    });

    const result = await removeCapability({
      workerDir: worker,
      capability: "turnstile",
      steps: {
        ...real,
        packageInstalled: async () => true,
        uninstall: async (pkg) => {
          uninstalled.push(pkg);
          return { packageManager: "bun", uninstalled: true };
        },
      },
    });

    expect(uninstalled).toEqual(["@pithy-sh/turnstile"]);
    expect(result.keptFor).toEqual([]);
  });

  test("an ejected sibling does not hold the package", async () => {
    // An ejected Worker owns its copy under capabilities/, so it needs no package — the uninstall runs.
    await fixture();
    await fixture({ workerDir: join(dir, "apps", "web"), ejected: true });
    const real = defaultRemoveSteps({
      projectDir: dir,
      workerDir: worker,
      loadCapabilities: async () => [cap("turnstile")],
      project: "acme",
    });

    expect(await real.workersUsingPackage("@pithy-sh/turnstile")).toEqual([]);
  });

  test("keeps a binding a remaining capability still needs", async () => {
    await fixture();
    const { s } = steps({
      loadCapabilities: async () => [
        cap("turnstile", { requiredBindings: [{ type: "kv", name: "SESSIONS", optional: false }] }),
        cap("auth", { requiredBindings: [{ type: "kv", name: "SESSIONS", optional: false }] }),
      ],
    });

    await removeCapability({ workerDir: worker, capability: "turnstile", steps: s });
    const wrangler = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain("SESSIONS"); // auth still needs it
  });

  test("audits capability/removed at info severity, and records nothing for an absent capability", async () => {
    await fixture();
    const { s } = steps({ loadCapabilities: async () => [cap("turnstile")] });
    const events: CliAuditEvent[] = [];

    await removeCapability({
      workerDir: worker,
      capability: "turnstile",
      steps: s,
      audit: async (event) => void events.push(event),
    });
    expect(events).toEqual([
      expect.objectContaining({
        action: "capability/removed",
        outcome: "success",
        severity: "info",
        resourceType: "capability",
        resourceId: "turnstile",
      }),
    ]);

    events.length = 0;
    await removeCapability({
      workerDir: worker,
      capability: "ghost",
      steps: { ...s, loadCapabilities: async () => [cap("turnstile")], packageInstalled: async () => false },
      audit: async (event) => void events.push(event),
    });
    expect(events).toEqual([]);
  });

  test("audits --drop as capability/tables_dropped at warning severity", async () => {
    await fixture();
    const dropped: DatabaseRun[] = [
      { database: "app", binding: "DB", results: [{ migrationName: "0100_a", direction: "Down", status: "Success" }] },
    ];
    const { s } = steps({ loadCapabilities: async () => [cap("turnstile", { databases: withMigration })], dropped });
    const events: CliAuditEvent[] = [];

    await removeCapability({
      workerDir: worker,
      capability: "turnstile",
      drop: { env: "dev" },
      steps: s,
      audit: async (event) => void events.push(event),
    });

    expect(events).toEqual([
      expect.objectContaining({
        action: "capability/tables_dropped",
        outcome: "success",
        severity: "warning",
        metadata: { migrationsReverted: 1 },
      }),
      expect.objectContaining({ action: "capability/removed", outcome: "success", severity: "info" }),
    ]);
  });

  test("audits a declined --drop confirmation as denied, and nothing else", async () => {
    await fixture();
    const { s } = steps({ loadCapabilities: async () => [cap("turnstile", { databases: withMigration })] });
    const events: CliAuditEvent[] = [];

    await removeCapability({
      workerDir: worker,
      capability: "turnstile",
      drop: { env: "staging", confirm: async () => false },
      steps: s,
      audit: async (event) => void events.push(event),
    });

    expect(events).toEqual([
      expect.objectContaining({
        action: "capability/tables_dropped",
        outcome: "denied",
        severity: "warning",
      }),
    ]);
  });

  test("audits a failure when a dependent blocks removal", async () => {
    await fixture();
    const { s } = steps({
      loadCapabilities: async () => [cap("secrets"), cap("auth", { dependsOn: ["secrets"] })],
    });
    const events: CliAuditEvent[] = [];

    await removeCapability({
      workerDir: worker,
      capability: "secrets",
      steps: s,
      audit: async (event) => void events.push(event),
    }).catch(() => {});

    expect(events).toEqual([
      expect.objectContaining({ action: "capability/removed", outcome: "failure", severity: "warning" }),
    ]);
  });
});
