// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { describe, expect, test } from "vitest";
import { HOST_WORKERS, hostTemplatePath, hostWorkerFor, readHostTemplate } from "./hostRegistry";

/**
 * The registry is the production answer to "which capability owns which host Worker" — the question
 * that previously had only a test-file answer, which is why no host Worker had ever run under
 * `pithy dev`. Two properties matter, and both are about the *set* rather than any one entry.
 */

/** `packages/` — the root every capability's template is discovered under. */
const PACKAGES_DIR = resolve(import.meta.dirname, "../../..");

/** Committed templates no resolver drives. One entry, and it is the same decision `hostTemplates.test.ts` records. */
const UNRESOLVED = ["leaderboard/src/rank/wrangler.jsonc"];

/** Every `wrangler.jsonc` committed under a package's `src/`, relative to `packages/`. */
async function committedTemplates(): Promise<string[]> {
  const found: string[] = [];
  for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const entries = await readdir(join(PACKAGES_DIR, pkg.name, "src"), { withFileTypes: true, recursive: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (entry.isFile() && entry.name === "wrangler.jsonc") {
        found.push(relative(PACKAGES_DIR, join(entry.parentPath, entry.name)));
      }
    }
  }
  return found.sort();
}

/** A dev context: the shape `pithy dev` builds, with the binding standing in for every database id. */
function devContext() {
  return {
    project: "acme",
    env: LOCAL_ENVIRONMENT,
    baseUrl: "http://localhost:8787",
    databaseId: (binding: string) => binding,
  };
}

describe("the host-worker registry", () => {
  test("names every committed host template, or records why not", async () => {
    const covered = HOST_WORKERS.map((spec) => relative(PACKAGES_DIR, hostTemplatePath(spec.entry))).sort();
    expect([...covered, ...UNRESOLVED].sort()).toEqual(await committedTemplates());
  });

  test("resolves a capability by name, and answers nothing for one that hosts no Workflows", () => {
    expect(hostWorkerFor("email")?.entry).toBe("@pithy-sh/email/src/workflows/worker");
    expect(hostWorkerFor("auth")).toBeUndefined();
  });

  describe.each(HOST_WORKERS)("$capability", (spec) => {
    test("resolves for dev under <project>-dev-<capability>", async () => {
      const config = await spec.resolve(await readHostTemplate(spec.entry), devContext());
      expect(config.name).toBe(`acme-dev-${spec.capability}`);
    });

    /**
     * The trap this test exists for. Local D1 identity is `database_id ?? binding` — wrangler's own
     * chain, and the one `pithy migrate --env dev` keys the Miniflare store by. A host resolved with
     * the template's `<filled-at-provision>` (or a real remote id) opens a *different* local database
     * from the app Worker's, and every query fails `no such table` for a reason that reads like a
     * code fault.
     */
    test("gives every D1 binding the binding itself as its local id", async () => {
      const config = await spec.resolve(await readHostTemplate(spec.entry), devContext());
      for (const entry of config.d1_databases ?? []) expect(entry.database_id).toBe(entry.binding);
    });

    /**
     * The other half of the same guarantee, and the reason a first `pithy dev` boots rather than
     * erroring on a missing table.
     *
     * `pithy migrate --env dev` migrates a database per binding an app Worker's capabilities declare,
     * keyed by binding in the shared Miniflare store. A host binds the *same* names, so its tables are
     * already there — but only for these three. A host that declared a fourth would open an empty
     * database and fail `no such table` on its first query, and nothing else in the tree would say so.
     * So the set is written down: a new one fails here, and the fix is `pithy migrate` coverage for it,
     * not a wider list.
     */
    test("binds only databases pithy migrate --env dev has already filled", async () => {
      const config = await spec.resolve(await readHostTemplate(spec.entry), devContext());
      const migrated = new Set(["DB", "SECRETS", "EMAIL_SUPPRESSIONS"]);
      for (const entry of config.d1_databases ?? []) expect(migrated.has(entry.binding), entry.binding).toBe(true);
    });
  });

  /**
   * The address a locally sent message points people at.
   *
   * `email({ baseUrl })` is the *deployed* app's public origin — a required key, so it is always set —
   * and a host resolved against it under `pithy dev` mints every tracked click, open pixel and
   * unsubscribe link at production, signed with the local signing key. The context's `baseUrl` is the
   * origin for the environment being resolved, which is what {@link HostResolveContext} says it is and
   * the only one that can be right in both.
   */
  test("email's local host builds its links against the app's local origin, not the deployed one", async () => {
    const spec = hostWorkerFor("email");
    const composed = {
      name: "email",
      emailConfig: { baseUrl: "https://api.acme.com", theme: undefined, devDelivery: "simulator" },
    } as unknown as Capability;
    const config = await spec?.resolve(await readHostTemplate("@pithy-sh/email/src/workflows/worker"), {
      ...devContext(),
      capability: composed,
    });
    expect(config?.vars?.BASE_URL).toBe("http://localhost:8787");
  });
});
