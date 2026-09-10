// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suppressionDatabaseName } from "@pithy-sh/email/src/provision/provisionEmail";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { supportBucketName } from "../capabilities/supportProvisioner";
import { linkKitPackages, materializeKitPackage } from "../test-utils/linkKit";
import { bindingScopeHealth } from "./bindingScope";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-binding-scope-"));
  // The namer this check reads is `@pithy-sh/email`'s own, resolved from the project since #533 — which
  // is the whole point of the check: under skew the *installed* package is the one with the answer.
  await linkKitPackages(dir, ["email"]);
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write one Worker under `apps/<name>/wrangler.jsonc` — the surface this check reads. */
async function writeWorker(name: string, config: Record<string, unknown>): Promise<void> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name, ...config }, null, 2));
}

/**
 * Install one capability's `pithy.manifest.json` under the project's own `node_modules`.
 *
 * The check's *finding* never reads this — it is keyed on the capability's own namer, deliberately, so
 * that a newer CLI beside an older package still answers. Its **remedy** does: `pithy provision` composes
 * the resource name from exactly this file, so whether it can repoint the binding is a fact about what is
 * installed. Every fixture below that expects `repointable: true` installs a current manifest, because a
 * project with none is the skew case and not the ordinary one.
 */
async function installManifest(name: string, bindings: Record<string, unknown>[]): Promise<void> {
  const packageDir = join(dir, "node_modules", "@pithy-sh", name);
  // **Never a bare `writeFile` here.** `beforeEach` links `@pithy-sh/email` to the repository's own
  // `packages/email`, so writing through that link truncated the shipped `pithy.manifest.json` to this
  // fixture's four fields — silently, because every assertion below still passed and the damage surfaced
  // in whatever suite next read the real file. `materializeKitPackage` swaps the link for a copy first.
  await materializeKitPackage(dir, name);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "pithy.manifest.json"),
    JSON.stringify({ name, package: `@pithy-sh/${name}`, requiredBindings: bindings }, null, 2),
  );
}

/** `@pithy-sh/email` as it ships since #513: the suppression database declared the project's. */
const CURRENT_EMAIL = async (): Promise<void> =>
  installManifest("email", [{ type: "d1", name: "EMAIL_SUPPRESSIONS", scope: "global" }]);

/** `@pithy-sh/email` before #513: the same binding, with no way to say the resource is one per project. */
const OLD_EMAIL = async (): Promise<void> => installManifest("email", [{ type: "d1", name: "EMAIL_SUPPRESSIONS" }]);

/** `@pithy-sh/support` as it ships since #513 — `scope` and `resource` both. */
const CURRENT_SUPPORT = async (): Promise<void> =>
  installManifest("support", [{ type: "r2", name: "SUPPORT_BUCKET", scope: "global", resource: "support" }]);

/** The one name every stanza must carry, taken from the capability rather than typed out here. */
const SUPPRESSIONS = suppressionDatabaseName("acme");

describe("bindingScopeHealth", () => {
  test("a project whose stanzas all name the project's one database is healthy", async () => {
    await writeWorker("api", {
      d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-1" }],
      env: {
        staging: {
          d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-1" }],
        },
        prod: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-1" }] },
      },
    });

    expect(await bindingScopeHealth(dir)).toEqual({ ok: true, split: [], divergent: [], partial: false });
  });

  test("the split #513 reported — three per-environment names where the capability creates one", async () => {
    // Exactly what `pithy add email` wrote before the manifest could say `scope: "global"`. This is the
    // only thing in the toolchain that will ever tell such a project it is split: `stanzaHasBinding` keys
    // on the binding name alone and `generatedFieldDrift` excludes a d1 `database_name` outright.
    await CURRENT_EMAIL();
    await writeWorker("api", {
      d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: "acme-dev-email-suppressions" }],
      env: {
        staging: {
          d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: "acme-staging-email-suppressions" }],
        },
        prod: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: "acme-prod-email-suppressions" }] },
      },
    });

    const health = await bindingScopeHealth(dir);
    expect(health.ok).toBe(false);
    expect(health.split).toEqual([
      {
        capability: "email",
        package: "@pithy-sh/email",
        binding: "EMAIL_SUPPRESSIONS",
        kind: "d1",
        expected: SUPPRESSIONS,
        // A D1 database is addressed through the binding and through nothing else, so there is no second
        // string carrying its name for a repoint to leave behind (#513 review).
        credential: null,
        stale: [
          { worker: "api", env: "dev", name: "acme-dev-email-suppressions" },
          { worker: "api", env: "staging", name: "acme-staging-email-suppressions" },
          { worker: "api", env: "prod", name: "acme-prod-email-suppressions" },
        ],
        // The installed manifest declares the binding project-wide, so `pithy provision --env <env>` is
        // a command that actually clears this.
        repointable: true,
      },
    ]);
  });

  test("a stale dev stanza is reported and does not fail the check — no command rewrites it", async () => {
    // `pithy provision` writes `config.env[<stanza>]` and `dev` is never a declared environment, so a red
    // here would be a red nothing clears. It is also inert: with no `database_id`, wrangler keys the local
    // database on the binding name and the stale `database_name` is decoration.
    await writeWorker("api", {
      d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: "acme-dev-email-suppressions" }],
      env: { prod: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS }] } },
    });

    const health = await bindingScopeHealth(dir);
    expect(health.ok).toBe(true);
    expect(health.split[0]?.stale).toEqual([{ worker: "api", env: "dev", name: "acme-dev-email-suppressions" }]);
  });

  test("two stanzas naming the right database and opening two different ones is the hostEnv requirement", async () => {
    // `workflows/hostEnv.ts`: one database, "bound identically in every environment". The names agree
    // here and the addresses do not, which is the half a name comparison cannot see.
    await CURRENT_EMAIL();
    await writeWorker("api", {
      env: {
        staging: {
          d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-1" }],
        },
        prod: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-2" }] },
      },
    });

    const health = await bindingScopeHealth(dir);
    expect(health.ok).toBe(false);
    expect(health.split).toEqual([]);
    expect(health.divergent).toEqual([
      {
        capability: "email",
        package: "@pithy-sh/email",
        binding: "EMAIL_SUPPRESSIONS",
        kind: "d1",
        expected: SUPPRESSIONS,
        credential: null,
        ids: [
          { id: "sup-1", at: [{ worker: "api", env: "staging" }] },
          { id: "sup-2", at: [{ worker: "api", env: "prod" }] },
        ],
        repointable: true,
      },
    ]);
  });

  /**
   * **The skew the check exists for, and the reason the remedy is not always one command (#513 review).**
   *
   * The finding is keyed on the capability's own namer precisely so a newer CLI beside an older
   * `@pithy-sh/email` still answers — that install is the one most likely to be split, and reading the
   * manifest for the finding would make the check go quiet on exactly it. But `pithy provision` composes
   * the name from that same older manifest, so the command the report used to print writes the
   * per-environment name straight back and the next `doctor` says the same thing. Printing a command that
   * cannot clear its own finding is #517's defect, and it took four rounds there.
   */
  describe("whether pithy provision can actually repoint the binding", () => {
    /** A project split exactly as #513 reported, so only the installed manifest varies below. */
    async function splitProject(): Promise<void> {
      await writeWorker("api", {
        env: {
          staging: {
            d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: "acme-staging-email-suppressions" }],
          },
        },
      });
    }

    test("an installed manifest that declares the binding project-wide makes the run the whole remedy", async () => {
      await CURRENT_EMAIL();
      await splitProject();

      const health = await bindingScopeHealth(dir);
      expect(health.split[0]?.repointable).toBe(true);
    });

    test("an older manifest is still a finding, and provisioning is no longer the whole remedy", async () => {
      await OLD_EMAIL();
      await splitProject();

      const health = await bindingScopeHealth(dir);
      // Still found — the namer, not the manifest, is what says the resource is one per project.
      expect(health.ok).toBe(false);
      expect(health.split[0]?.expected).toBe(SUPPRESSIONS);
      // And still not clearable by the command alone: the writer reads the manifest above.
      expect(health.split[0]?.repointable).toBe(false);
      expect(health.split[0]?.package).toBe("@pithy-sh/email");
    });

    test("a manifest reachable only from the Worker's own node_modules counts (#507)", async () => {
      // A capability declared only on the Worker composing it installs under `apps/<name>/node_modules`,
      // which is the shape the kit tells adopters to adopt. A root-only read would call this skew.
      await splitProject();
      const workerPackage = join(dir, "apps", "api", "node_modules", "@pithy-sh", "email");
      await mkdir(workerPackage, { recursive: true });
      await writeFile(
        join(workerPackage, "pithy.manifest.json"),
        JSON.stringify({
          name: "email",
          package: "@pithy-sh/email",
          requiredBindings: [{ type: "d1", name: "EMAIL_SUPPRESSIONS", scope: "global" }],
        }),
      );

      const health = await bindingScopeHealth(dir);
      expect(health.split[0]?.repointable).toBe(true);
    });

    test("a manifest that will not parse is the skew answer, not a silent pass", async () => {
      // `doctor`'s `manifests:` section reports the fault itself. Here it is the same fact with the same
      // remedy: the writer will compose a per-environment name, so the package has to move first.
      await splitProject();
      const packageDir = join(dir, "node_modules", "@pithy-sh", "email");
      // The same hazard as `installManifest`'s, and this one would have written `{ not json` into the
      // repository's own manifest.
      await materializeKitPackage(dir, "email");
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, "pithy.manifest.json"), "{ not json");

      const health = await bindingScopeHealth(dir);
      expect(health.split[0]?.repointable).toBe(false);
    });
  });

  test("two Workers sharing one project-global database are compared against each other", async () => {
    // The reason this check is project-wide rather than per Worker: neither Worker's own block can see a
    // disagreement that only exists between them.
    await writeWorker("api", {
      env: {
        prod: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-1" }] },
      },
    });
    await writeWorker("collab", {
      env: {
        prod: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-2" }] },
      },
    });

    const health = await bindingScopeHealth(dir);
    expect(health.divergent[0]?.ids.map((entry) => entry.id).sort()).toEqual(["sup-1", "sup-2"]);
  });

  test("the support bucket is compared by name, because an R2 bucket's name is its address", async () => {
    await CURRENT_SUPPORT();
    await writeWorker("api", {
      env: {
        staging: { r2_buckets: [{ binding: "SUPPORT_BUCKET", bucket_name: "acme-staging-support-bucket" }] },
        prod: { r2_buckets: [{ binding: "SUPPORT_BUCKET", bucket_name: supportBucketName("acme") }] },
      },
    });

    const health = await bindingScopeHealth(dir);
    expect(health.ok).toBe(false);
    expect(health.split).toEqual([
      {
        capability: "support",
        package: "@pithy-sh/support",
        binding: "SUPPORT_BUCKET",
        kind: "r2",
        expected: "acme-global-support",
        // The bucket is named twice: once by the binding the repoint moves, and once inside the credential
        // every presigned URL is signed against, which nothing in the kit writes (#513 review).
        credential: "support-r2-credentials",
        stale: [{ worker: "api", env: "staging", name: "acme-staging-support-bucket" }],
        repointable: true,
      },
    ]);
    // No `id` is ever read off an `r2_buckets` entry, so the divergence half has nothing to say about a
    // bucket — the name comparison above covers it whole.
    expect(health.divergent).toEqual([]);
  });

  /**
   * **A `<database_id>` stub is the state a scaffold leaves behind, not a second database (#513 review).**
   *
   * `docs/commands/env.md` states the rule for the whole toolchain — an empty value, a `<database_id>`
   * stub, or anything containing `placeholder` reads as not provisioned — and `project/envInventory.ts`
   * has implemented it all along. This check consulted nothing of the sort and took any non-empty
   * `database_id` as an address, so a freshly scaffolded `env.staging` beside a provisioned `env.prod`
   * was reported as "2 different resources" and the operator was told to copy its rows across. There is
   * nothing there to copy.
   */
  test("a placeholder database_id is not an address — a scaffolded stanza is not a second resource", async () => {
    await CURRENT_EMAIL();
    await writeWorker("api", {
      env: {
        staging: {
          d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "<database_id>" }],
        },
        prod: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-1" }] },
      },
    });

    expect(await bindingScopeHealth(dir)).toEqual({ ok: true, split: [], divergent: [], partial: false });
  });

  test("a placeholder name is not a claim either — the same predicate, on the other field", async () => {
    // The name half of the same rule. A stanza still carrying `<database_name>` has not been pointed at
    // anything, so calling it "stale" would send the operator to export rows out of nothing.
    await CURRENT_EMAIL();
    await writeWorker("api", {
      env: {
        staging: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: "<database_name>" }] },
        prod: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: "placeholder-suppressions" }] },
      },
    });

    expect(await bindingScopeHealth(dir)).toEqual({ ok: true, split: [], divergent: [], partial: false });
  });

  /**
   * **The `dev` exemption covers the divergence half too (#513 review).**
   *
   * The split branch has exempted `dev` from the start: `pithy provision` writes `config.env[…]` and
   * `dev` is never a declared environment, so a red there is a red nothing clears. The divergence half
   * had no such exemption, so a top-level stanza carrying its own `database_id` beside a managed one
   * carrying another failed the exit forever — the operator ran every printed line, `doctor` still exited
   * 1, and the same screen told them nothing would ever rewrite the dev id.
   */
  test("a divergence only the dev stanza is part of is reported and does not fail the check", async () => {
    await CURRENT_EMAIL();
    await writeWorker("api", {
      d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-local" }],
      env: {
        prod: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-1" }] },
      },
    });

    const health = await bindingScopeHealth(dir);
    // Reported — the two ids are a real fact and the report says so — and green, because the only command
    // that could act reaches neither of them.
    expect(health.ok).toBe(true);
    expect(health.divergent[0]?.ids.map(({ id }) => id)).toEqual(["sup-local", "sup-1"]);
  });

  test("two managed stanzas diverging still fails, dev stanza or no dev stanza", async () => {
    // The other side of the same rule: the exemption is about which stanzas a command can rewrite, never
    // about how many there are. Two managed ids is a red that `pithy provision` clears.
    await CURRENT_EMAIL();
    await writeWorker("api", {
      d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-local" }],
      env: {
        staging: {
          d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-1" }],
        },
        prod: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS, database_id: "sup-2" }] },
      },
    });

    expect((await bindingScopeHealth(dir)).ok).toBe(false);
  });

  test("an entry with no name yet is not a claim — a binding provisioning completes later is not a split", async () => {
    await writeWorker("api", { r2_buckets: [{ binding: "SUPPORT_BUCKET" }], d1_databases: [{ binding: "DB" }] });

    expect(await bindingScopeHealth(dir)).toEqual({ ok: true, split: [], divergent: [], partial: false });
  });

  test("a per-environment binding is never compared against a project-global name", async () => {
    // `SECRETS` sits one line from `EMAIL_SUPPRESSIONS` in `hostEnv.ts` and is genuinely per-environment.
    // The whole of #513 is that nothing told them apart; a check that guessed from the shape of a name
    // would report every correct `SECRETS` stanza as a split.
    await writeWorker("api", {
      env: {
        staging: { d1_databases: [{ binding: "SECRETS", database_name: "acme-staging-secrets", database_id: "s-1" }] },
        prod: { d1_databases: [{ binding: "SECRETS", database_name: "acme-prod-secrets", database_id: "s-2" }] },
      },
    });

    expect(await bindingScopeHealth(dir)).toEqual({ ok: true, split: [], divergent: [], partial: false });
  });

  test("a project that binds nothing project-global reaches no capability package at all", async () => {
    await writeWorker("api", { d1_databases: [{ binding: "DB", database_name: "acme-prod-db" }] });

    expect(await bindingScopeHealth(dir)).toEqual({ ok: true, split: [], divergent: [], partial: false });
  });

  test("an unparseable wrangler.jsonc is partial, not thrown — the other workers still answer", async () => {
    await writeWorker("api", {
      env: { prod: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: SUPPRESSIONS }] } },
    });
    const brokenDir = join(dir, "apps", "broken");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, "wrangler.jsonc"), "{ this is not json");

    const health = await bindingScopeHealth(dir);
    // A check that did not run is not a check that passed (#184) — even though everything it *did* read
    // agreed.
    expect(health).toEqual({ ok: false, split: [], divergent: [], partial: true });
  });

  test("no project name is not this check's question — it answers nothing rather than guessing", async () => {
    // `requireProjectName`, never `resolveProjectName`: that one's fallbacks differ between checkouts, so
    // a comparison built on one would call every correct name stale on somebody else's machine. The
    // missing `name` has its own doctor line.
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    await writeWorker("api", {
      env: { prod: { d1_databases: [{ binding: "EMAIL_SUPPRESSIONS", database_name: "whatever" }] } },
    });

    expect(await bindingScopeHealth(dir)).toEqual({ ok: true, split: [], divergent: [], partial: false });
  });
});
