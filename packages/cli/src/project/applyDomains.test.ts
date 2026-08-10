// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { originFor, WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { parse } from "comment-json";
import { describe, expect, it } from "vitest";
import { applyDomains } from "./applyDomains";

const DOMAINS = WorkerDomains.parse({
  staging: { pattern: "staging.api.example.com", zone: "example.com" },
  prod: { pattern: "api.example.com", zone: "example.com" },
});

async function worker(wrangler = '{\n  "name": "acme-api"\n}\n'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pithy-domains-"));
  await writeFile(path.join(dir, "wrangler.jsonc"), wrangler, "utf8");
  return dir;
}

async function read(dir: string): Promise<Record<string, unknown>> {
  return parse(await readFile(path.join(dir, "wrangler.jsonc"), "utf8")) as unknown as Record<string, unknown>;
}

describe("applyDomains", () => {
  it("writes the route and BASE_URL per environment, from one declaration", async () => {
    const dir = await worker();
    const applied = await applyDomains(dir, DOMAINS);

    expect(applied).toEqual([
      { env: "staging", pattern: "staging.api.example.com", baseUrl: "https://staging.api.example.com" },
      { env: "prod", pattern: "api.example.com", baseUrl: "https://api.example.com" },
    ]);

    const config = (await read(dir)) as { env: Record<string, { routes: unknown[]; vars: Record<string, string> }> };
    expect(config.env.prod?.routes).toEqual([
      { pattern: "api.example.com", custom_domain: true, zone_name: "example.com" },
    ]);
    expect(config.env.prod?.vars.BASE_URL).toBe("https://api.example.com");
    expect(config.env.staging?.vars.BASE_URL).toBe("https://staging.api.example.com");
  });

  it("never writes the top-level stanza — dev has no domain", async () => {
    // `env.<name>` REPLACES the top level rather than merging, so a value written once at the top would
    // be invisible to staging and prod anyway. And local answers on `http://localhost:<port>` from the
    // pinned port, not on a domain.
    const dir = await worker();
    await applyDomains(dir, DOMAINS);
    const config = await read(dir);
    expect(config.routes).toBeUndefined();
    expect(config.vars).toBeUndefined();
  });

  it("is idempotent — a second run writes the same bytes", async () => {
    const dir = await worker();
    await applyDomains(dir, DOMAINS);
    const first = await readFile(path.join(dir, "wrangler.jsonc"), "utf8");
    await applyDomains(dir, DOMAINS);
    expect(await readFile(path.join(dir, "wrangler.jsonc"), "utf8")).toBe(first);
  });

  it("updates the one custom-domain route when the domain moves, rather than appending another", async () => {
    // Matching on `custom_domain: true` instead of on the pattern is what makes this work: the pattern is
    // exactly what changed, so matching on it would leave two entries and let wrangler serve whichever.
    const dir = await worker();
    await applyDomains(dir, DOMAINS);
    await applyDomains(dir, WorkerDomains.parse({ prod: { pattern: "www.example.com", zone: "example.com" } }));

    const config = (await read(dir)) as { env: Record<string, { routes: unknown[]; vars: Record<string, string> }> };
    expect(config.env.prod?.routes).toEqual([
      { pattern: "www.example.com", custom_domain: true, zone_name: "example.com" },
    ]);
    expect(config.env.prod?.vars.BASE_URL).toBe("https://www.example.com");
  });

  it("leaves an adopter's own route entries alone", async () => {
    // This owns the custom domain, not the route list. A pattern route an adopter wrote is theirs.
    const dir = await worker('{\n  "env": { "prod": { "routes": ["legacy.example.com/*"] } }\n}\n');
    await applyDomains(dir, WorkerDomains.parse({ prod: { pattern: "api.example.com", zone: "example.com" } }));

    const config = (await read(dir)) as { env: Record<string, { routes: unknown[] }> };
    expect(config.env.prod?.routes).toEqual([
      "legacy.example.com/*",
      { pattern: "api.example.com", custom_domain: true, zone_name: "example.com" },
    ]);
  });

  it("leaves an undeclared environment completely alone, never clearing it", async () => {
    // An adopter may have written a route by hand for an environment they have not declared yet.
    // Adopting the declaration for prod must not delete their staging route.
    const dir = await worker('{\n  "env": { "staging": { "routes": ["hand.example.com"] } }\n}\n');
    await applyDomains(dir, WorkerDomains.parse({ prod: { pattern: "api.example.com", zone: "example.com" } }));

    const config = (await read(dir)) as { env: Record<string, { routes: unknown[] }> };
    expect(config.env.staging?.routes).toEqual(["hand.example.com"]);
  });

  it("writes nothing at all when no environment declares a domain", async () => {
    const dir = await worker();
    const before = await readFile(path.join(dir, "wrangler.jsonc"), "utf8");
    expect(await applyDomains(dir, {})).toEqual([]);
    expect(await readFile(path.join(dir, "wrangler.jsonc"), "utf8")).toBe(before);
  });

  it("closes workers.dev for every environment it gives a domain", async () => {
    // The declared domain is the origin. `workers_dev` defaults to true and routes do not change it, so
    // without this the Worker also answers on its workers.dev subdomain — with `BASE_URL` naming the
    // other host, and `preview_urls` following `workers_dev` for every deployed version.
    const dir = await worker();
    await applyDomains(dir, DOMAINS);
    const config = (await read(dir)) as { env: Record<string, { workers_dev?: boolean }> };
    expect(config.env.prod?.workers_dev).toBe(false);
    expect(config.env.staging?.workers_dev).toBe(false);
  });

  it("leaves an adopter's own workers_dev decision exactly as they wrote it", async () => {
    // Unlike the route and BASE_URL beside it, this is not derived from the declaration — an explicit
    // `true` is a team saying they want the workers.dev URL for staging until DNS is cut over, and that
    // is a named origin rather than an unnamed one.
    const dir = await worker('{\n  "env": { "staging": { "workers_dev": true } }\n}\n');
    await applyDomains(dir, DOMAINS);
    const config = (await read(dir)) as { env: Record<string, { workers_dev?: boolean }> };
    expect(config.env.staging?.workers_dev).toBe(true);
    expect(config.env.prod?.workers_dev).toBe(false);
  });

  /**
   * **The gate for #256: `vars.BASE_URL` and the origin an adopter's config composes are one value.**
   *
   * Not "both are `https://<pattern>`", which is a restatement of today's formula and would keep passing
   * if one side grew a port, a path, or a trailing slash. What is asserted is that the string this writes
   * *is* `originFor`'s answer for that environment — the same call `pithy.config.ts` makes to hand a
   * capability its origin. So the Worker's runtime `BASE_URL` and its `auth.baseURL`, `email.baseUrl` and
   * Checkout return URL cannot drift apart, because there is one function between them.
   */
  it("writes the origin an adopter's own config would derive, for every environment", async () => {
    const dir = await worker();
    const applied = await applyDomains(dir, DOMAINS);
    expect(applied.length).toBe(2);
    for (const entry of applied) {
      expect(entry.baseUrl).toBe(originFor(entry.env, DOMAINS));
    }
    const config = (await read(dir)) as { env: Record<string, { vars: Record<string, string> }> };
    for (const env of ["staging", "prod"]) {
      expect(config.env[env]?.vars.BASE_URL).toBe(originFor(env, DOMAINS));
    }
  });

  /** And it never writes the fallback: an environment with no domain is skipped, not defaulted. */
  it("never writes the local-origin fallback into a deployed stanza", async () => {
    const dir = await worker();
    await applyDomains(dir, WorkerDomains.parse({ prod: { pattern: "api.example.com", zone: "example.com" } }));
    const config = (await read(dir)) as { env: Record<string, { vars?: Record<string, string> }> };
    expect(config.env.staging).toBeUndefined();
    expect(config.env.prod?.vars?.BASE_URL).toBe(originFor("prod", DOMAINS));
  });

  it("preserves the adopter's comments", async () => {
    const dir = await worker('{\n  // keep me\n  "name": "acme-api"\n}\n');
    await applyDomains(dir, DOMAINS);
    expect(await readFile(path.join(dir, "wrangler.jsonc"), "utf8")).toContain("// keep me");
  });
});
