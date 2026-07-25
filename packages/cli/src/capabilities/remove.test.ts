import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import type { DatabaseRun } from "../migrations/run";
import { type RemoveSteps, removableBindings, removeCapability, removeFromWrangler, unwireConfig } from "./remove";

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
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-remove-do-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
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
    await writeFile(join(dir, "wrangler.jsonc"), `${JSON.stringify(wrangler, null, 2)}\n`);

    const target = {
      requiredBindings: [
        BindingSpec.parse({ type: "durable_object", name: "SESSIONS", className: "MultiplayerSession" }),
        BindingSpec.parse({ type: "d1", name: "DB" }),
      ],
    };
    // `DB` is shared with another capability and must survive.
    const others = [{ requiredBindings: [BindingSpec.parse({ type: "d1", name: "DB" })] }];

    const removed = await removeFromWrangler(dir, target, others);
    expect(removed).toEqual(["SESSIONS"]);

    const result = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as typeof wrangler;
    expect(result.durable_objects.bindings).toEqual([]);
    expect(result.env.staging.durable_objects.bindings).toEqual([]);
    // The migration tag is emptied of the class and dropped entirely — the clean inverse of add.
    expect(result.migrations).toBeUndefined();
    // The shared D1 binding stays.
    expect(result.d1_databases).toEqual([{ binding: "DB" }]);
  });
});

describe("removeCapability", () => {
  let dir: string;

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

  async function fixture(over: { ejected?: boolean; capName?: string } = {}): Promise<void> {
    const name = over.capName ?? "turnstile";
    const importLine = over.ejected
      ? `import { ${name} } from "./capabilities/${name}";`
      : `import { ${name} } from "@pithy-sh/${name}/src/index";`;
    await writeFile(
      join(dir, "pithy.config.ts"),
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
      join(dir, "wrangler.jsonc"),
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
  }

  /** Injectable steps recording their calls; the config/wrangler unwire runs for real on the fixture. */
  function steps(over: Partial<RemoveSteps> & { dropped?: DatabaseRun[] } = {}) {
    const calls = { dropTables: [] as string[], uninstall: [] as string[], deleteSource: [] as string[] };
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
        return { packageManager: "bun" };
      },
      deleteSource: async (d) => {
        calls.deleteSource.push(d);
      },
      packageInstalled: over.packageInstalled ?? (async () => true),
    };
    return { s, calls };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-remove-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("an absent capability is a no-op that reports not present", async () => {
    await fixture();
    const { s } = steps({ loadCapabilities: async () => [cap("turnstile")], packageInstalled: async () => false });
    const result = await removeCapability({ projectDir: dir, capability: "ghost", steps: s });
    expect(result.present).toBe(false);
  });

  test("refuses when another wired capability depends on it, naming the dependent", async () => {
    await fixture();
    const { s } = steps({
      loadCapabilities: async () => [cap("secrets"), cap("auth", { dependsOn: ["secrets"] })],
    });
    const failure = await removeCapability({ projectDir: dir, capability: "secrets", steps: s }).catch((e) => e);
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

    const result = await removeCapability({ projectDir: dir, capability: "turnstile", steps: s });

    expect(calls.uninstall).toEqual(["@pithy-sh/turnstile"]);
    expect(calls.deleteSource).toEqual([]);
    expect(calls.dropTables).toEqual([]); // no --drop
    expect(result.tablesRemain).toBe(true);
    const config = await readFile(join(dir, "pithy.config.ts"), "utf8");
    expect(config).not.toContain("turnstile()");
    const wrangler = await readFile(join(dir, "wrangler.jsonc"), "utf8");
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

    const result = await removeCapability({ projectDir: dir, capability: "turnstile", drop: { env: "dev" }, steps: s });

    expect(calls.dropTables).toEqual(["turnstile:dev"]);
    expect(result.dropped).toEqual(dropped);
    expect(result.tablesRemain).toBe(false);
  });

  test("a declined --drop confirmation aborts with zero changes", async () => {
    await fixture();
    const { s, calls } = steps({ loadCapabilities: async () => [cap("turnstile", { databases: withMigration })] });

    const result = await removeCapability({
      projectDir: dir,
      capability: "turnstile",
      drop: { env: "staging", confirm: async () => false },
      steps: s,
    });

    expect(result.aborted).toBe(true);
    expect(calls.dropTables).toEqual([]);
    // The config still wires the capability — nothing was unwired.
    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toContain("turnstile()");
  });

  test("ejected: deletes the local source instead of uninstalling", async () => {
    await fixture({ ejected: true });
    const { s, calls } = steps({ loadCapabilities: async () => [cap("turnstile")] });

    const result = await removeCapability({ projectDir: dir, capability: "turnstile", steps: s });

    expect(result.ejected).toBe(true);
    expect(calls.deleteSource).toEqual([join(dir, "capabilities", "turnstile")]);
    expect(calls.uninstall).toEqual([]);
  });

  test("keeps a binding a remaining capability still needs", async () => {
    await fixture();
    const { s } = steps({
      loadCapabilities: async () => [
        cap("turnstile", { requiredBindings: [{ type: "kv", name: "SESSIONS", optional: false }] }),
        cap("auth", { requiredBindings: [{ type: "kv", name: "SESSIONS", optional: false }] }),
      ],
    });

    await removeCapability({ projectDir: dir, capability: "turnstile", steps: s });
    const wrangler = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain("SESSIONS"); // auth still needs it
  });

  test("audits capability/removed at info severity, and records nothing for an absent capability", async () => {
    await fixture();
    const { s } = steps({ loadCapabilities: async () => [cap("turnstile")] });
    const events: CliAuditEvent[] = [];

    await removeCapability({
      projectDir: dir,
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
      projectDir: dir,
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
      projectDir: dir,
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
        metadata: { env: "dev", migrationsReverted: 1 },
      }),
      expect.objectContaining({ action: "capability/removed", outcome: "success", severity: "info" }),
    ]);
  });

  test("audits a declined --drop confirmation as denied, and nothing else", async () => {
    await fixture();
    const { s } = steps({ loadCapabilities: async () => [cap("turnstile", { databases: withMigration })] });
    const events: CliAuditEvent[] = [];

    await removeCapability({
      projectDir: dir,
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
        metadata: { env: "staging" },
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
      projectDir: dir,
      capability: "secrets",
      steps: s,
      audit: async (event) => void events.push(event),
    }).catch(() => {});

    expect(events).toEqual([
      expect.objectContaining({ action: "capability/removed", outcome: "failure", severity: "warning" }),
    ]);
  });
});
