// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "rolldown/parseAst";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "./sourceFiles";
import { analyzeStoreWrites, type Node, type StoreWriteSite, siteKey } from "./storeWriteNames";

/**
 * **No Cloudflare Secrets Store write is addressed by a name that was not composed through the naming
 * facade.** (#647)
 *
 * The rule and its argument live in `storeWriteNames.ts`; this is what holds the kit to it. The short
 * version: the account's Secrets Store is one flat namespace, so the entry name is the only partition
 * there is, and `putSecret` upserts — a name spelled at the call site finds nothing, creates an entry,
 * and answers 200 while the binding goes on serving the old value.
 *
 * ## Why this file is both of the shapes the repository already had
 *
 * `migrations/orders.test.ts` and `ci/bindingResourceNames.test.ts` are hand-maintained tables: the
 * property is only true *as a set*, so the set is written down and a new member fails until a human adds
 * a row. `ci/workflowDeterminism.test.ts` is the other shape: an analyzer over the whole tree, with an
 * exact-population tripwire so a gate can never be green over nothing.
 *
 * This rule needs both, because it asks two questions with two different kinds of answer.
 *
 * **Is the set complete?** That is mechanical. A call to a store-write verb is a syntactic fact, and a
 * table of call sites maintained by hand would be exactly the failure mode #326 finding 4 describes — the
 * draft of this gate shipped one, hand-written from grep, and it was already stale against the tree it
 * was written for. So the population is discovered, every run, by {@link analyzeStoreWrites}.
 *
 * **Is each member right?** That is not mechanical, and pretending otherwise is what killed the draft's
 * analyzer. Fourteen of the seventeen sites below pass a name that *arrived* — a parameter, a field, a
 * destructured local. Deciding whether `this.entryName` was composed through the facade means reading a
 * constructor in another module and a builder in a third. The draft tried to chase that by fixed point
 * over bare function names across the whole tree, and two defects fell out of it: its member-path walker
 * could not express `this.getClient().secretsStore.stores.secrets.edit(…)`, so the seam, the verbs and
 * every call site came back empty; and it discovered write verbs by "first parameter named `name`", which
 * cannot see an id-addressed edit. A gate green over an empty population is worse than no gate.
 *
 * So the verdict is a **row**, in {@link DECLARED}, written by a human who followed the name back. Adding
 * a store write means adding a row that names the composer; a row for a call that no longer exists fails
 * too, so a row cannot outlive its site.
 *
 * **One part of the verdict stays mechanical, and it is the part that matters most.** A literal, a
 * template or a concatenation passed as the name is the defect itself, and no row may excuse it — see the
 * last block, which holds that set at empty.
 *
 * ## What this gate does not see
 *
 * A manager verb reached through an alias — `const write = store.putSecret.bind(store)` — is a call this
 * walker does not resolve back to the manager. Nothing in the tree does that, and the exact-population
 * assertions below are what would surface the first module that did, because such a module would have to
 * stop calling the verb by name somewhere this can read.
 *
 * It is also a gate at the **store boundary** and deliberately not one step behind it. `mintSecrets.ts`
 * writes through a caller-supplied `MintDestination`, one hop further from the store; every wiring of it
 * resolves to one of the sites below, so the name is still caught where it reaches Cloudflare.
 */

/** `packages/cli/src/ci` → the repository. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * The parser, supplied here rather than imported by the analyzer.
 *
 * Rolldown's, which is oxc: ESTree-shaped and TypeScript-aware, and already a direct devDependency for
 * `workflowDeterminism.test.ts`. The fixture cases below run through exactly the code path the tree scan
 * does, which is the whole reason the analyzer takes a parser rather than importing one.
 */
const parseModule = (text: string): Node => parseAst(text, { lang: "ts" }, "source.ts") as unknown as Node;

/** Every shipped `.ts` under `packages/`, repo-relative and POSIX, so a row names a path a human can open. */
const analysis = analyzeStoreWrites(
  sourceFiles(join(REPO_ROOT, "packages")).map((file) => ({
    path: relative(REPO_ROOT, file.path).split(sep).join("/"),
    text: file.text,
  })),
  parseModule,
);

/** One store write, and where the name it passes came from. */
interface Declared {
  /** `<file> <verb>(<args>)`, exactly as {@link siteKey} renders the discovered call. */
  site: string;
  /**
   * The facade call that produced the name, and — for a name that arrived rather than being composed at
   * the call — the path it arrived by. This is the fact a human checked and a machine cannot.
   */
  via: string;
}

/**
 * **Every Cloudflare Secrets Store write in the tree, and the composer behind each one's name.**
 *
 * *Adding one?* Run the suite: it names the site with the key to paste here, and fails until the row
 * exists. Then follow the name back to a `resourceNames(…)` call — `ProvisionScope.secretEntry`,
 * `masterKeySecretName`, `managerCfApiTokenSecretName` and `tokenStoreEntryName` are the four helpers the
 * kit composes store entry names with today — and say in `via` which one, and by what path it reached the
 * call. If the answer is "nothing composed it", the row is not the fix.
 *
 * **These rows were generated from a run of the analyzer against the finished tree, not from grep.** The
 * draft's were the other way round — its own risk note said so — and named twelve files where a real run
 * finds eight.
 */
const DECLARED: readonly Declared[] = [
  {
    site: "packages/cli/src/capabilities/secretsProvisioner.ts createSecretIfAbsent(name, JSON.stringify(await initialMasterKeyConfig()))",
    via: "`masterKeySecretName(this.#project, env, this.#feature)` three lines above — `resourceNames(project).env(env).secretEntry(…)`, or the feature scope's",
  },
  {
    site: "packages/cli/src/capabilities/secretsProvisioner.ts putSecret(managerCfApiTokenSecretName(target.project), encodeVersionedValue(initialVersionedValue(apiToken)))",
    via: "`managerCfApiTokenSecretName` — `resourceNames(project).global.secretEntry(…)`, composed in the argument",
  },
  {
    site: "packages/cli/src/capabilities/secretsProvisioner.ts deleteSecret(name)",
    via: "`masterKeySecretName(this.#project, env)` two lines above — teardown recomputes the name it provisioned",
  },
  {
    site: "packages/cli/src/capabilities/secretsProvisioner.ts deleteSecret(entry)",
    via: "`managerCfApiTokenSecretName(this.#project)` three lines above — the same recomputation for the manager's token entry",
  },
  {
    site: "packages/cli/src/capabilities/storeSecretWrites.ts remove(entry)",
    via: "`open()` in the same module: `options.scope(request.env).secretEntry(request.name, request.scope)` — the provisioning scope, so `pithy secrets rm` addresses what `pithy secrets provision` created",
  },
  {
    site: "packages/cli/src/capabilities/storeSecretWrites.ts put(entry, storeEntryText(request, request.value))",
    via: "the same `open()` — one composition serves the write and the preflight, so they cannot disagree",
  },
  {
    site: "packages/cli/src/commands/token.ts putSecret(name, value)",
    via: "the `putSecret` seam's own parameter, handed `context.storeEntryName` by `tokens/sinks.ts` — see that row",
  },
  {
    site: "packages/cli/src/feature/provision.ts create(name, value)",
    via: "`MintDestination.put`'s parameter, handed `secretName` by `storeSecretMinter`, which `secretsStoreBindings` composes through the feature scope's `secretEntry`",
  },
  {
    site: "packages/cli/src/feature/provision.ts remove(scope.secretEntry(binding, entry.scope))",
    via: "`ProvisionScope.secretEntry` — the feature scope, composed in the argument",
  },
  {
    site: "packages/cli/src/feature/provision.ts remove(masterKeySecretName(options.identity.project, FEATURE_ENVIRONMENT, options.identity))",
    via: "`masterKeySecretName` with the feature identity — composed in the argument, and the same call `ensureMasterKey` created it with",
  },
  {
    site: "packages/cli/src/provision/store.ts putSecret(name, value)",
    via: "the `SecretsStore` adapter's own parameter. It composes nothing by design — every name reaching it is composed by the caller, and those callers are the rows above",
  },
  {
    site: "packages/cli/src/provision/store.ts createSecretIfAbsent(name, value)",
    via: "the same adapter parameter",
  },
  {
    site: "packages/cli/src/provision/store.ts deleteSecretIfPresent(name)",
    via: "the same adapter parameter",
  },
  {
    site: "packages/cli/src/tokens/sinks.ts putSecret(context.storeEntryName, value)",
    via: "`SinkContext.storeEntryName`, set by `tokens/engine.ts` to `tokenStoreEntryName(project, env, profile)` — `resourceNames(project).global|env(env).secretEntry(profile.secret)`. Deliberately not `secretName`, which is the `.dev.vars` variable key and is never scoped",
  },
  {
    site: "packages/cloudflare/src/test-utils/reap.ts deleteSecretIfPresent(name)",
    via: "nothing — and that is correct here. The reaper deletes names it *listed* from the store, filtered to the reserved `pithy-int-` namespace; a composed name would be a name it had not found",
  },
  {
    site: "packages/secrets/src/manager/secretsConfigWriter.ts updateExistingSecret(this.entryName, serialized)",
    via: "`SecretsStoreConfigWriter.entryName`, set only by `rotationConfigWriter` from `masterKeySecretName(project, environment)` — the constructor has no default, so there is no unscoped name to fall back to",
  },
  {
    site: "packages/secrets/src/manager/secretsConfigWriter.ts updateExistingSecret(this.entryName, serialized, comment)",
    via: "the same field, on the branch that carries the pass's stamp in the entry comment",
  },
];

/** A finding, rendered with everything somebody needs to fix it. */
function render(site: StoreWriteSite): string {
  return `${site.file}:${site.line} ${site.verb} — ${site.kind} name ${site.argument}`;
}

describe("the population this gate ranges over", () => {
  test("is one module: nothing but the manager reaches the Secrets Store SDK", () => {
    // The chokepoint the rest of this file rests on. Every store write in the kit passes through this
    // module, so a gate over its verbs is a gate over every write — and a second module appearing here
    // means that stopped being true.
    expect(analysis.sdkModules).toEqual(["packages/cloudflare/src/secrets/secretsStoreManager.ts"]);
    expect(analysis.sdkSites).toHaveLength(7);
    expect([...new Set(analysis.sdkSites.map((site) => site.verb))].sort()).toEqual([
      "create",
      "delete",
      "edit",
      "list",
    ]);
  });

  test("and the write verbs it exposes, discovered from its own body", () => {
    // Not a list this gate carries: each verb is here because its body — or a private method of the same
    // class that it calls — reaches a mutating SDK call. `putSecret` is why that transitivity matters; its
    // create branch is one `this.createSecret(…)` away, and it is the upsert #647 is about.
    //
    // `addressedBy` is asserted with the rest. A write verb addressed by anything but a name is outside
    // the reach of a rule about names (D1), so one appearing here changes what this gate covers and has to
    // stop a build rather than be filtered out quietly.
    expect(analysis.verbs).toEqual([
      { name: "createSecretIfAbsent", addressedBy: "name", sdkVerbs: ["create", "delete"] },
      { name: "deleteSecret", addressedBy: "name", sdkVerbs: ["delete"] },
      { name: "deleteSecretIfPresent", addressedBy: "name", sdkVerbs: ["delete"] },
      { name: "putSecret", addressedBy: "name", sdkVerbs: ["create", "edit"] },
      { name: "updateExistingSecret", addressedBy: "name", sdkVerbs: ["edit"] },
    ]);
  });

  test("and the adapter members that forward to them, discovered from the forwarding", () => {
    // `SecretsStore.exists` is absent, and nothing had to say so: it forwards to a read. `ReapPlanEntry`
    // and `TokenEngine` are here because they genuinely carry a store write behind a member of their own.
    expect(analysis.seamVerbs).toEqual([
      { name: "remove", type: "ReapPlanEntry", forwardsTo: ["deleteSecretIfPresent"] },
      { name: "create", type: "SecretsStore", forwardsTo: ["createSecretIfAbsent"] },
      { name: "put", type: "SecretsStore", forwardsTo: ["putSecret"] },
      { name: "remove", type: "SecretsStore", forwardsTo: ["deleteSecretIfPresent"] },
      { name: "putSecret", type: "TokenEngine", forwardsTo: ["putSecret"] },
    ]);
  });

  test("is exactly what the table declares — a write with no row fails, and a row with no write fails", () => {
    expect(analysis.sites.map(siteKey)).toEqual(DECLARED.map((row) => row.site));
  });

  test("was read from real files, not from an empty walk", () => {
    // A tripwire whose input silently became empty passes every assertion about findings. This is the
    // exact-count assertion the draft's analyzer could not have made: it found nothing at all.
    expect(analysis.parsed).toBeGreaterThan(500);
    expect(analysis.sites).toHaveLength(17);
  });
});

describe("the rule, proved against fixtures before it is trusted against the tree", () => {
  /** Analyze one module's text as though it were a file in the tree. */
  function analyze(text: string) {
    return analyzeStoreWrites([{ path: "fixture.ts", text }], parseModule);
  }

  /**
   * A manager in the shape of the real one, and in particular with the real one's member chain.
   *
   * `this.getClient().secretsStore.stores.secrets.edit(…)` — a call in the middle of the path — is what
   * the draft's dotted-path walker bailed on, which is why its seam, its verbs and its call sites all came
   * back empty. Every assertion in this block runs against this text.
   */
  const MANAGER = `
    class FixtureSecretsStoreManager {
      async updateThing(name: string, value: string): Promise<string> {
        const target = await this.findByName(name);
        await this.getClient().secretsStore.stores.secrets.edit(target.id, { value });
        return target.id;
      }
      async putThing(name: string, value: string): Promise<void> {
        const existing = await this.findByName(name);
        if (!existing) return this.createThing(name, value);
        await this.getClient().secretsStore.stores.secrets.edit(existing.id, { value });
      }
      async listThings(prefix: string): Promise<string[]> {
        return this.getClient().secretsStore.stores.secrets.list(this.storeId, {});
      }
      private async createThing(name: string, value: string): Promise<void> {
        await this.getClient().secretsStore.stores.secrets.create(this.storeId, { body: [{ name, value }] });
      }
      private async findByName(name: string) {
        return undefined;
      }
    }
  `;

  test("the SDK seam is found through a call in the middle of the chain", () => {
    // Revert `propertyChain` to a dotted-path walk that stops at a CallExpression and this is zero.
    const { sdkModules, sdkSites } = analyze(MANAGER);
    expect(sdkModules).toEqual(["fixture.ts"]);
    expect(sdkSites.map((site) => `${site.verb}:${site.writes}`)).toEqual([
      "edit:true",
      "edit:true",
      "list:false",
      "create:true",
    ]);
  });

  test("a write verb is one that reaches a mutation — through a private helper if that is where it is", () => {
    // `putThing` reaches `create` only via `this.createThing`, and `listThings` reaches nothing that
    // mutates. Drop the transitive resolve and `putThing` loses `create`; drop `SDK_READ_VERBS` and
    // `listThings` joins the table.
    expect(analyze(MANAGER).verbs).toEqual([
      { name: "putThing", addressedBy: "name", sdkVerbs: ["create", "edit"] },
      { name: "updateThing", addressedBy: "name", sdkVerbs: ["edit"] },
    ]);
  });

  test("an id-addressed write verb is reported, not skipped — which is what the draft could not do", () => {
    // The draft discovered verbs *by* "first parameter named `name`", so this verb was invisible to it and
    // so was every call to it. Here it is in the table, marked `other`, which fails the population
    // assertion above until somebody reads it. Filter `addressedBy === "name"` anywhere and this is red.
    const { verbs } = analyze(`
      class FixtureManager {
        async editById(id: string, value: string): Promise<void> {
          await this.getClient().secretsStore.stores.secrets.edit(id, { value });
        }
      }
    `);
    expect(verbs).toEqual([{ name: "editById", addressedBy: "other", sdkVerbs: ["edit"] }]);
  });

  test("a name spelled at the call site is a finding, however it is spelled", () => {
    // The defect itself, in its three shapes. Nothing in `DECLARED` can excuse any of them.
    const { sites } = analyze(`
      ${MANAGER}
      export async function go(manager: FixtureSecretsStoreManager, project: string, value: string) {
        await manager.updateThing(\`\${project}-prod-secrets-encryption-keys\`, value);
        await manager.updateThing("secrets-encryption-keys", value);
        await manager.updateThing(project + "-prod-secrets", value);
      }
    `);
    expect(sites.map((site) => `${site.kind} ${site.argument}`)).toEqual([
      `made-here \`\${project}-prod-secrets-encryption-keys\``,
      'made-here "secrets-encryption-keys"',
      'made-here project + "-prod-secrets"',
    ]);
  });

  test("and the same write composed through the facade is not — which is the whole distinction", () => {
    // The moved half of the pair. One edit to the argument turns three findings into none, so the
    // assertion above cannot be passing for some other reason.
    const { sites } = analyze(`
      ${MANAGER}
      export async function go(manager: FixtureSecretsStoreManager, project: string, value: string) {
        await manager.updateThing(resourceNames(project).env("prod").secretEntry("secrets-encryption-keys"), value);
      }
    `);
    expect(sites.map((site) => site.kind)).toEqual(["composed"]);
  });

  test("a name this walker cannot read is a finding too, not silence", () => {
    // Fail-closed. A conditional could be composed on one branch and a literal on the other, and a gate
    // that shrugged at what it could not classify would be the draft's emptiness in miniature.
    const { sites } = analyze(`
      ${MANAGER}
      export async function go(manager: FixtureSecretsStoreManager, a: string, b: string, value: string) {
        await manager.updateThing(Math.random() > 0.5 ? a : b, value);
      }
    `);
    expect(sites.map((site) => site.kind)).toEqual(["unclassified"]);
  });

  test("a write reached through a `#private` field is in the population", () => {
    // `secretsConfigWriter.ts` holds its manager as `this.#manager`, and a walker blind to
    // `PrivateIdentifier` bails on the first link of the chain — losing the one call site #647 was opened
    // for, silently. Strip the `PrivateIdentifier` branch from `memberName` and this is an empty array.
    const { sites } = analyze(`
      ${MANAGER}
      class FixtureWriter {
        readonly #manager: FixtureSecretsStoreManager;
        readonly entryName: string;
        async write(serialized: string): Promise<void> {
          await this.#manager.updateThing(this.entryName, serialized);
        }
      }
    `);
    expect(sites.map((site) => `${site.kind} ${site.argument}`)).toEqual(["forwarded this.entryName"]);
  });

  test("an adapter's write members are found from what they forward to, and its reads are not", () => {
    // `exists` forwards to nothing that mutates, so it is not a seam verb and nothing had to say so.
    // Point `put` at a read and it leaves the table with it.
    const { seamVerbs } = analyze(`
      ${MANAGER}
      export interface FixtureStore { put(name: string, value: string): Promise<void>; }
      export function fixtureStore(manager: FixtureSecretsStoreManager): FixtureStore {
        return {
          put: (name, value) => manager.putThing(name, value),
          exists: (name) => manager.listThings(name),
        };
      }
    `);
    expect(seamVerbs).toEqual([{ name: "put", type: "FixtureStore", forwardsTo: ["putThing"] }]);
  });

  test("and a call on the adapter counts only when the receiver is one", () => {
    // The receiver rule, both ways at once. `options.store` is typed `FixtureStore`; `options.indexes` is
    // not, and its `remove` is a Vectorize index — `feature/provision.ts` holds exactly that pair, so a
    // rule keyed on the verb alone would report a name that never goes near the Secrets Store.
    const { sites } = analyze(`
      ${MANAGER}
      export interface FixtureStore { put(name: string, value: string): Promise<void>; }
      export interface Indexes { put(name: string, value: string): Promise<void>; }
      export function fixtureStore(manager: FixtureSecretsStoreManager): FixtureStore {
        return { put: (name, value) => manager.putThing(name, value) };
      }
      export async function go(options: { store: FixtureStore; indexes: Indexes }, value: string) {
        await options.store.put("hand-written", value);
        await options.indexes.put("hand-written", value);
      }
    `);
    expect(sites.map((site) => `${site.tier} ${site.verb} ${site.kind}`)).toEqual([
      "manager putThing forwarded",
      "seam put made-here",
    ]);
  });
});

/**
 * Store writes addressed by a name this repository spelled itself, each with an issue.
 *
 * **The list is empty, and it stays a list.** `toEqual` against an empty expectation is the strongest
 * form this gate has: a literal, a template, a concatenation or an argument the walker cannot read, passed
 * as the name of any Secrets Store write anywhere under `packages/`, fails on the line below with its
 * file, its line and the expression that did it.
 *
 * **A site listed here would be listed, not excused**, and no row in {@link DECLARED} may stand in for an
 * entry here — the two blocks answer different questions, and a hand-written name is refused whatever a
 * row says about where it came from.
 */
const KNOWN: readonly string[] = [];

describe("the kit", () => {
  test("composes the name of every Secrets Store write it makes", () => {
    expect(
      analysis.sites
        .filter((site) => site.kind === "made-here" || site.kind === "unclassified")
        .map(render)
        .sort(),
    ).toEqual([...KNOWN].sort());
  });
});
