// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { NAMESPACE_LIMITS } from "@pithy-sh/core/src/naming/limits";
import { MAX_PROJECT_NAME } from "@pithy-sh/core/src/naming/resource";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { incompleteBindings } from "../project/appBindings";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { addCapability } from "./add";

/** The wrangler stanza shape these tests read back. */
interface RichWrangler {
  d1_databases?: { binding: string; database_name?: string }[];
  kv_namespaces?: { binding: string }[];
  r2_buckets?: { binding: string; remote?: boolean }[];
  vectorize?: { binding: string; index_name?: string }[];
  ai?: { binding: string; remote?: boolean };
  workflows?: { binding: string; name?: string; class_name?: string }[];
  env: Record<string, RichWrangler | undefined>;
}

const manifest = CapabilityManifest.parse({
  name: "auth",
  package: "@pithy-sh/auth",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "kv", name: "SESSIONS" },
  ],
});

interface WranglerBindings {
  d1_databases: { binding: string }[];
  kv_namespaces: { binding: string }[];
  env: Record<string, { d1_databases: { binding: string }[]; kv_namespaces: { binding: string }[] }>;
}

let dir: string;
/** The Worker `pithy add` wires into. Capabilities are per-Worker, so this — never the project root. */
let worker: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-add-"));
  await scaffoldProject({ targetDir: dir, appName: "add-test" });
  worker = join(dir, "apps", DEFAULT_WORKER);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("addCapability", () => {
  test("registers the capability import and call in pithy.config.ts, keeping the marker", async () => {
    await addCapability({ workerDir: worker, manifest });

    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).toContain('import { auth } from "@pithy-sh/auth/src/index";');
    expect(config).toContain("auth(),");
    // The marker survives for the next add, after the new registration.
    expect(config.indexOf("auth(),")).toBeLessThan(config.indexOf("// pithy:capabilities"));
  });

  test("adds required bindings to every wrangler.jsonc environment, preserving comments", async () => {
    await addCapability({ workerDir: worker, manifest });

    const raw = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    expect(raw).toContain("The top level is the dev environment");

    const wrangler = parse(raw) as unknown as WranglerBindings;
    for (const stanza of [wrangler, wrangler.env.staging, wrangler.env.prod]) {
      expect(stanza?.d1_databases).toEqual([{ binding: "DB" }]);
      expect(stanza?.kv_namespaces).toEqual([{ binding: "SESSIONS" }]);
    }
  });

  test("running it twice changes nothing", async () => {
    await addCapability({ workerDir: worker, manifest });
    const configOnce = await readFile(join(worker, "pithy.config.ts"), "utf8");
    const wranglerOnce = await readFile(join(worker, "wrangler.jsonc"), "utf8");

    await addCapability({ workerDir: worker, manifest });
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toBe(configOnce);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(wranglerOnce);
  });

  test("a hand-edited import specifier is left alone — presence is keyed on the binding", async () => {
    // The follow-on to the broken `secrets` specifier: `add` was idempotent on the registration call
    // but matched the import on its exact text, so an adopter who corrected the specifier by hand got
    // the wrong one added straight back on the next run — two imports of the same binding, which is a
    // TypeScript redeclaration error and a config that no longer loads at all.
    await addCapability({ workerDir: worker, manifest });
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    await writeFile(
      join(worker, "pithy.config.ts"),
      config.replace('"@pithy-sh/auth/src/index"', '"@pithy-sh/auth/src/capability"'),
    );

    await addCapability({ workerDir: worker, manifest });

    const after = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(after.match(/^import\s*\{\s*auth\s*\}/gm)).toHaveLength(1);
    expect(after).toContain('import { auth } from "@pithy-sh/auth/src/capability";');
  });

  test("recognises an existing import that does not start at column zero", async () => {
    await addCapability({ workerDir: worker, manifest });
    const path = join(worker, "pithy.config.ts");
    await writeFile(path, (await readFile(path, "utf8")).replace("import { auth }", "  import { auth }"));

    await addCapability({ workerDir: worker, manifest });

    // Indentation is cosmetic. Not seeing the import writes a second one, and two bindings of one name
    // is a TypeScript redeclaration — the config stops loading.
    expect((await readFile(path, "utf8")).match(/import\s*\{\s*auth\s*\}/g)).toHaveLength(1);
  });

  test("a commented-out import is not an import", async () => {
    // The decoy that made the guard answer for a binding it never bound: a block comment above the
    // managed region read as the capability already being imported, so `add` wrote the registration and
    // no import at all — `auth()` against nothing, a config that fails to load.
    const path = join(worker, "pithy.config.ts");
    const commented = ["/*", 'import { auth } from "@pithy-sh/auth/src/index";', "*/", ""].join("\n");
    await writeFile(path, `${commented}${await readFile(path, "utf8")}`);

    await addCapability({ workerDir: worker, manifest });

    // Two lines read as an import now: the adopter's comment, untouched, and the real one above it.
    const after = await readFile(path, "utf8");
    expect(after.match(/^import\s*\{\s*auth\s*\}/gm)).toHaveLength(2);
    expect(after.slice(0, after.indexOf("/*"))).toContain('import { auth } from "@pithy-sh/auth/src/index";');
    expect(after).toContain("auth(),");
  });

  test("refuses an import of the bare package — it resolves to nothing", async () => {
    // `@pithy-sh/auth` declares no "." export, so this line throws at load. Read as wiring, it made
    // `add` write the registration against an import that could never bind, and exit 0 saying so.
    const path = join(worker, "pithy.config.ts");
    const before = `import { auth } from "@pithy-sh/auth";\n${await readFile(path, "utf8")}`;
    await writeFile(path, before);

    await expect(addCapability({ workerDir: worker, manifest })).rejects.toThrow(PithyError);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("refuses when the name is already bound to something that is not the capability", async () => {
    // Keying idempotency on the binding alone was wrong in the other direction: an adopter's own
    // `auth` suppressed the capability's import while the registration went in anyway, so
    // `capabilities: [auth()]` composed their middleware and the capability never loaded. Silently.
    const path = join(worker, "pithy.config.ts");
    const before = `import { auth } from "./lib/myAuth";\n${await readFile(path, "utf8")}`;
    await writeFile(path, before);

    await expect(addCapability({ workerDir: worker, manifest })).rejects.toThrow(PithyError);

    // Refused before anything was written — the config is exactly as the adopter left it.
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("a config without the managed-region marker fails with an action line", async () => {
    await writeFile(join(worker, "pithy.config.ts"), "export default { capabilities: [] };\n");
    await expect(addCapability({ workerDir: worker, manifest })).rejects.toThrow(PithyError);
  });

  test("a durable_object capability wires the DO binding per env and the class migration tag top-level", async () => {
    const doManifest = CapabilityManifest.parse({
      name: "multiplayer",
      package: "@pithy-sh/multiplayer",
      requiredBindings: [
        { type: "durable_object", name: "SESSIONS", className: "MultiplayerSession" },
        { type: "d1", name: "DB" },
      ],
    });
    await addCapability({ workerDir: worker, manifest: doManifest });

    interface DoWrangler {
      d1_databases: { binding: string }[];
      durable_objects?: { bindings: { name: string; class_name: string }[] };
      migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
      env: Record<
        string,
        { durable_objects?: { bindings: { name: string; class_name: string }[] }; migrations?: unknown }
      >;
    }
    const wrangler = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as DoWrangler;

    // The DO binding is emitted into every environment (each gets its own namespace).
    for (const stanza of [wrangler, wrangler.env.staging, wrangler.env.prod]) {
      expect(stanza?.durable_objects?.bindings).toEqual([{ name: "SESSIONS", class_name: "MultiplayerSession" }]);
    }
    // The D1 binding still rides the normal path.
    expect(wrangler.d1_databases).toEqual([{ binding: "DB" }]);

    // The class migration tag is top-level ONLY, and uses new_sqlite_classes (not new_classes).
    expect(wrangler.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["MultiplayerSession"] }]);
    expect(wrangler.env.staging?.migrations).toBeUndefined();
    expect(wrangler.env.prod?.migrations).toBeUndefined();

    // Idempotent: a second add changes nothing.
    const once = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    await addCapability({ workerDir: worker, manifest: doManifest });
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(once);
  });

  /**
   * **A second DO capability gets its own tag, because the first one's may already be deployed.**
   *
   * A wrangler class migration tag is applied once and remembered by Cloudflare: on the next deploy
   * wrangler sends only the tags *after* the last one applied. So appending a class into a tag that has
   * already been applied sends nothing at all — the namespace is never created, and the deploy then fails
   * on a binding to a class with no migration behind it.
   *
   * `appendDurableObjectMigrations` merged every class into `v1` for as long as it existed, and its own
   * comment said why that was safe: multiplayer was the only capability shipping a Durable Object, so
   * every add was a first add. #415 made `@pithy-sh/matchmaking` addable — two more classes — and its
   * README pairs it with multiplayer, so `pithy add multiplayer` → `pithy deploy` → `pithy add
   * matchmaking` is the ordinary path rather than an exotic one.
   */
  test("a second DO capability lands in a new tag, never inside the one already deployed", async () => {
    const multiplayerManifest = CapabilityManifest.parse({
      name: "multiplayer",
      package: "@pithy-sh/multiplayer",
      requiredBindings: [{ type: "durable_object", name: "SESSIONS", className: "MultiplayerSession" }],
    });
    const matchmakingManifest = CapabilityManifest.parse({
      name: "matchmaking",
      package: "@pithy-sh/matchmaking",
      requiredBindings: [
        { type: "durable_object", name: "QUEUE", className: "MatchmakingQueue" },
        { type: "durable_object", name: "PRESENCE", className: "MatchmakingPresence" },
      ],
    });

    await addCapability({ workerDir: worker, manifest: multiplayerManifest });
    await addCapability({ workerDir: worker, manifest: matchmakingManifest });

    const wrangler = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as {
      migrations?: { tag: string; new_sqlite_classes?: string[] }[];
    };
    expect(wrangler.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["MultiplayerSession"] },
      { tag: "v2", new_sqlite_classes: ["MatchmakingQueue", "MatchmakingPresence"] },
    ]);

    // And still idempotent across the split: re-adding either allocates nothing.
    const once = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    await addCapability({ workerDir: worker, manifest: multiplayerManifest });
    await addCapability({ workerDir: worker, manifest: matchmakingManifest });
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(once);
  });

  test("wires only the target worker — a sibling's config and bindings are untouched", async () => {
    // A second worker, copied from the scaffolded one: same shape, different directory.
    const sibling = join(dir, "apps", "edge");
    await cp(worker, sibling, { recursive: true });

    await addCapability({ workerDir: worker, manifest });

    const siblingConfig = await readFile(join(sibling, "pithy.config.ts"), "utf8");
    expect(siblingConfig).not.toContain("@pithy-sh/auth");
    expect(siblingConfig).toContain("// pithy:capabilities");

    const siblingWrangler = parse(
      await readFile(join(sibling, "wrangler.jsonc"), "utf8"),
    ) as unknown as WranglerBindings;
    expect(siblingWrangler.d1_databases).toEqual([]);
    expect(siblingWrangler.kv_namespaces).toEqual([]);
    // And the target really was wired — the isolation isn't a no-op.
    const target = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as WranglerBindings;
    expect(target.d1_databases).toEqual([{ binding: "DB" }]);
  });

  test("writes r2 and ai bindings into every env, threading remote", async () => {
    const richManifest = CapabilityManifest.parse({
      name: "media",
      package: "@pithy-sh/media",
      requiredBindings: [
        { type: "r2", name: "MEDIA_BUCKET" },
        { type: "vectorize", name: "MEDIA_INDEX", remote: true },
        { type: "ai", name: "AI", remote: true },
        { type: "workflow", name: "MEDIA_IMAGE_TO_TEXT", className: "ImageToTextWorkflow", optional: true },
        { type: "workflow", name: "MEDIA_DOC_EXTRACT", optional: true },
      ],
    });
    await addCapability({ workerDir: worker, manifest: richManifest });

    const wrangler = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as RichWrangler;

    for (const stanza of [wrangler, wrangler.env.staging, wrangler.env.prod]) {
      // No `remote` key at all when the spec doesn't set one — an explicit false would pin the
      // binding to local emulation.
      expect(stanza?.r2_buckets).toEqual([{ binding: "MEDIA_BUCKET" }]);
      // `ai` is a single object, not an array.
      expect(stanza?.ai).toEqual({ binding: "AI", remote: true });
    }

    // Idempotent: a second add changes nothing, including the singular `ai` key.
    const once = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    await addCapability({ workerDir: worker, manifest: richManifest });
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(once);
  });

  test("writes no vectorize or workflows entry at all — wrangler would refuse a partial one", async () => {
    // The regression: an entry carrying only `binding` fails wrangler's config validation, which
    // requires `index_name` on vectorize and `name` + `class_name` on workflows. `add` is offline and
    // knows neither, so it writes nothing and the capability's provisioner writes the whole entry.
    const richManifest = CapabilityManifest.parse({
      name: "media",
      package: "@pithy-sh/media",
      requiredBindings: [
        { type: "vectorize", name: "MEDIA_INDEX", remote: true },
        { type: "workflow", name: "MEDIA_IMAGE_TO_TEXT", className: "ImageToTextWorkflow", optional: true },
        { type: "workflow", name: "MEDIA_DOC_EXTRACT", optional: true },
      ],
    });
    await addCapability({ workerDir: worker, manifest: richManifest });

    const wrangler = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as RichWrangler;
    for (const stanza of [wrangler, wrangler.env.staging, wrangler.env.prod]) {
      expect(stanza?.vectorize ?? []).toEqual([]);
      expect(stanza?.workflows ?? []).toEqual([]);
      // And the config wrangler would load carries no incomplete entry anywhere.
      expect(incompleteBindings(stanza)).toEqual([]);
    }
  });

  test("a capability whose name is a substring of an existing registration is still added", async () => {
    // Register `myauth` first; its `myauth(),` line must not satisfy the
    // idempotency check for `auth` (whose `auth(),` is a substring of it).
    await addCapability({
      workerDir: worker,
      manifest: CapabilityManifest.parse({ name: "myauth", package: "@pithy-sh/myauth", requiredBindings: [] }),
    });
    await addCapability({ workerDir: worker, manifest });

    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).toContain('import { auth } from "@pithy-sh/auth/src/index";');
    expect(config).toMatch(/^\s*auth\(\),$/m); // a real auth() line, not just the myauth() substring
  });

  describe("proposed resource names", () => {
    /** The stanza shape these read back — D1 carries a name, KV cannot. */
    interface NamedWrangler {
      d1_databases?: { binding: string; database_name?: string }[];
      kv_namespaces?: { binding: string; title?: string }[];
      r2_buckets?: { binding: string; bucket_name?: string }[];
      env: Record<string, NamedWrangler | undefined>;
    }

    const read = async (): Promise<NamedWrangler> =>
      parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as NamedWrangler;

    test("writes database_name as <project>-<env>-<binding>, per environment", async () => {
      await addCapability({ workerDir: worker, manifest, project: "acme" });

      const wrangler = await read();
      // The environment segment comes from the stanza the entry lands in — the top-level one is dev.
      expect(wrangler.d1_databases).toEqual([{ binding: "DB", database_name: "acme-dev-db" }]);
      expect(wrangler.env.staging?.d1_databases).toEqual([{ binding: "DB", database_name: "acme-staging-db" }]);
      expect(wrangler.env.prod?.d1_databases).toEqual([{ binding: "DB", database_name: "acme-prod-db" }]);
    });

    test("reports the KV title instead of writing one — a kv_namespaces entry has no name field", async () => {
      const result = await addCapability({ workerDir: worker, manifest, project: "acme" });

      const wrangler = await read();
      for (const stanza of [wrangler, wrangler.env.staging, wrangler.env.prod]) {
        expect(stanza?.kv_namespaces).toEqual([{ binding: "SESSIONS" }]);
      }
      expect(result.kvNamespaces).toEqual([
        { binding: "SESSIONS", env: "dev", name: "acme-dev-sessions" },
        { binding: "SESSIONS", env: "staging", name: "acme-staging-sessions" },
        { binding: "SESSIONS", env: "prod", name: "acme-prod-sessions" },
      ]);
    });

    test("leaves R2 alone — the storage and media provisioners write bucket_name themselves", async () => {
      const r2Manifest = CapabilityManifest.parse({
        name: "storage",
        package: "@pithy-sh/storage",
        requiredBindings: [{ type: "r2", name: "MEDIA_BUCKET" }],
      });
      await addCapability({ workerDir: worker, manifest: r2Manifest, project: "acme" });

      const wrangler = await read();
      for (const stanza of [wrangler, wrangler.env.staging, wrangler.env.prod]) {
        expect(stanza?.r2_buckets).toEqual([{ binding: "MEDIA_BUCKET" }]);
      }
    });

    test("no project name proposes nothing, rather than guessing a prefix", async () => {
      const result = await addCapability({ workerDir: worker, manifest });

      expect((await read()).d1_databases).toEqual([{ binding: "DB" }]);
      expect(result.kvNamespaces).toEqual([]);
    });

    test("a second run changes nothing and proposes nothing", async () => {
      await addCapability({ workerDir: worker, manifest, project: "acme" });
      const once = await readFile(join(worker, "wrangler.jsonc"), "utf8");

      const again = await addCapability({ workerDir: worker, manifest, project: "acme" });
      expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(once);
      expect(again.kvNamespaces).toEqual([]);
    });

    test("a renamed database is left alone — presence is keyed on the binding, never the name", async () => {
      await addCapability({ workerDir: worker, manifest, project: "acme" });
      const wrangler = await read();
      // The adopter renames the database by hand.
      const [entry] = wrangler.d1_databases ?? [];
      if (entry) entry.database_name = "the-one-we-already-had";
      await writeFile(join(worker, "wrangler.jsonc"), JSON.stringify(wrangler, null, 2));

      await addCapability({ workerDir: worker, manifest, project: "acme" });

      // One entry still, carrying their name — not a second entry for a binding wrangler already has.
      expect((await read()).d1_databases).toEqual([{ binding: "DB", database_name: "the-one-we-already-had" }]);
    });

    test("a D1 name is composed against D1's budget, not R2's — the longest binding survives whole", async () => {
      // 25 + `-prod-` + 33 = 64: over the 63 this used to be truncated at, and nowhere near a D1 cap,
      // because Cloudflare publishes none. The binding is the thing an operator recognises in
      // `wrangler d1 list`, so hashing it away to satisfy another namespace's limit bought nothing.
      const project = "a".repeat(MAX_PROJECT_NAME);
      const longBinding = CapabilityManifest.parse({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [{ type: "d1", name: "ANALYTICS_EVENTS_ARCHIVE_DATABASE" }],
      });
      await addCapability({ workerDir: worker, manifest: longBinding, project });

      const name = (await read()).env.prod?.d1_databases?.[0]?.database_name ?? "";
      expect(name).toBe(`${project}-prod-analytics-events-archive-database`);
      expect(name.length).toBeGreaterThan(NAMESPACE_LIMITS.r2.maxLength);
      expect(name.length).toBeLessThanOrEqual(NAMESPACE_LIMITS.d1.maxLength);
    });

    test("a KV title is composed against KV's 512, not the 63 it used to be hashed at", async () => {
      const project = "a".repeat(MAX_PROJECT_NAME);
      const longBinding = CapabilityManifest.parse({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [{ type: "kv", name: "SESSION_REVOCATION_BROADCAST_INDEX" }],
      });
      const result = await addCapability({ workerDir: worker, manifest: longBinding, project });

      const prod = result.kvNamespaces.find((entry) => entry.env === "prod");
      expect(prod?.name).toBe(`${project}-prod-session-revocation-broadcast-index`);
    });

    test("an environment stanza the naming scheme cannot compose against proposes nothing", async () => {
      // `pithy add` is a writer and `pithy doctor` a reader, and both walk whatever `env.*` keys the
      // adopter's wrangler.jsonc carries. An eleven-character environment blows the budget every
      // project name was accepted under, so no name is proposed for it — but the binding is still
      // wired, because refusing to add a capability over a stanza key would be a worse answer.
      const wrangler = await read();
      wrangler.env.integration = { d1_databases: [], kv_namespaces: [] } as never;
      await writeFile(join(worker, "wrangler.jsonc"), JSON.stringify(wrangler, null, 2));

      const result = await addCapability({ workerDir: worker, manifest, project: "acme" });

      const written = await read();
      expect(written.env.integration?.d1_databases).toEqual([{ binding: "DB" }]);
      expect(result.kvNamespaces.map((entry) => entry.env)).toEqual(["dev", "staging", "prod"]);
    });

    test("a project name past the cap is refused here too, not silently truncated", async () => {
      // The refusal belongs at `pithy init`, but `add` composes names as well — so a project that
      // somehow got past creation must not quietly produce a name no host deploy could match.
      const project = "a".repeat(MAX_PROJECT_NAME + 1);
      await expect(addCapability({ workerDir: worker, manifest, project })).rejects.toThrowError(PithyError);
    });
  });

  describe("config options", () => {
    const withOptions = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
      configOptions: [
        { key: "basePath", default: "/auth", describe: "Where the auth routes mount." },
        { key: "sessionDays", default: 30, describe: "Refresh-token lifetime in days." },
      ],
    });

    test("renders each option as key: default with its describe as a comment", async () => {
      await addCapability({ workerDir: worker, manifest: withOptions });

      const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
      expect(config).toContain("auth({");
      expect(config).toContain("// Where the auth routes mount.");
      expect(config).toContain('basePath: "/auth",');
      expect(config).toContain("// Refresh-token lifetime in days.");
      expect(config).toContain("sessionDays: 30,");
      expect(config).toContain("}),");
    });

    test("an override replaces the rendered default", async () => {
      await addCapability({
        workerDir: worker,
        manifest: withOptions,
        configValues: { basePath: "/authentication" },
      });

      const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
      expect(config).toContain('basePath: "/authentication",');
      expect(config).not.toContain('basePath: "/auth",');
      // Un-overridden options keep their default.
      expect(config).toContain("sessionDays: 30,");
    });

    test("running it twice with options changes nothing", async () => {
      await addCapability({ workerDir: worker, manifest: withOptions });
      const once = await readFile(join(worker, "pithy.config.ts"), "utf8");

      await addCapability({ workerDir: worker, manifest: withOptions });
      expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toBe(once);
    });

    /**
     * The writer's own precondition.
     *
     * `runAdd` refuses a required option before it ever calls this, so reaching here with no value is a
     * bug one step upstream — and `addCapability` is reachable from more than one place. It fails loudly
     * rather than rendering the word `undefined` into an adopter's config, which is the failure they
     * would find later and somewhere else (#412).
     */
    const withRequired = CapabilityManifest.parse({
      name: "payments",
      package: "@pithy-sh/payments",
      requiredBindings: [],
      configOptions: [
        { key: "basePath", default: "/payments", describe: "Where the payments routes mount." },
        { key: "billingSubject", choices: ["user", "organization"], describe: "Who holds a subscription." },
      ],
    });

    test("a required option with no value is refused, not rendered as undefined", async () => {
      const before = await readFile(join(worker, "pithy.config.ts"), "utf8");
      const error = (await addCapability({ workerDir: worker, manifest: withRequired }).catch(
        (thrown: unknown) => thrown,
      )) as PithyError;

      expect(error).toBeInstanceOf(PithyError);
      expect(error.message).toContain("billingSubject");
      expect(error.payload.action).toContain("--set billingSubject=user");
      expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toBe(before);
    });

    test("given a value, the required option renders like any other", async () => {
      await addCapability({
        workerDir: worker,
        manifest: withRequired,
        configValues: { billingSubject: "organization" },
      });

      const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
      expect(config).toContain('billingSubject: "organization",');
      expect(config).toContain('basePath: "/payments",');
    });

    test("seeds an empty object or array for an option whose value is the adopter's to write", async () => {
      // The option a manifest cannot fill in. `@pithy-sh/secrets` requires a `registry` and `add` cannot
      // invent one, so it wrote every option but that — and left a `pithy.config.ts` that does not
      // typecheck (#161). The empty literal is what makes the config compile before the adopter has been
      // told the option exists; `describe` above it is what tells them.
      const seeded = CapabilityManifest.parse({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [],
        configOptions: [
          { key: "registry", default: {}, describe: "Your secrets. Declare each one here." },
          { key: "boards", default: [], describe: "Every board this app ranks." },
        ],
      });
      await addCapability({ workerDir: worker, manifest: seeded });

      const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
      expect(config).toContain("// Your secrets. Declare each one here.");
      expect(config).toContain("registry: {},");
      expect(config).toContain("// Every board this app ranks.");
      expect(config).toContain("boards: [],");
    });
  });
});

describe("no hand-rolled comment-json round-trips in capabilities/", () => {
  test("no non-test file imports stringify from comment-json", async () => {
    const capDir = new URL(".", import.meta.url).pathname;
    const files = (await readdir(capDir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const file of files) {
      const content = await readFile(join(capDir, file), "utf8");
      // stringify from comment-json is only needed for the hand-rolled wrangler.jsonc round-trip.
      // All wrangler.jsonc writes go through writeWranglerConfig; no capabilities/ file needs stringify.
      expect(content, `${file} imports stringify from comment-json`).not.toMatch(
        /import\s*\{[^}]*\bstringify\b[^}]*\}\s*from\s*["']comment-json["']/,
      );
    }
  });
});
