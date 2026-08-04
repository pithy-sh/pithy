// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
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

  it("preserves the adopter's comments", async () => {
    const dir = await worker('{\n  // keep me\n  "name": "acme-api"\n}\n');
    await applyDomains(dir, DOMAINS);
    expect(await readFile(path.join(dir, "wrangler.jsonc"), "utf8")).toContain("// keep me");
  });
});
