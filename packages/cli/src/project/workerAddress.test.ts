// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { describe, expect, it } from "vitest";
import { describeAddressSource, resolveWorkerAddress, workersDevAddress } from "./workerAddress";

const DOMAINS = WorkerDomains.parse({
  staging: { pattern: "staging.api.example.com", zone: "example.com" },
  prod: { pattern: "api.example.com", zone: "example.com" },
});

describe("resolveWorkerAddress", () => {
  it("prefers the declaration, because everything else is generated from it", () => {
    // The `routes` entry and `vars.BASE_URL` below are exactly what the declaration generates. If they
    // ever disagree with it, the declaration is right and they are stale — which is the whole reason
    // the declaration exists.
    const resolved = resolveWorkerAddress({
      environment: "prod",
      domains: DOMAINS,
      stanza: { routes: ["stale.example.com"], vars: { BASE_URL: "https://also-stale.example.com" } },
    });

    expect(resolved).toEqual({
      url: "https://api.example.com",
      source: "declaration",
      hostname: "api.example.com",
    });
  });

  it("resolves per environment, not per Worker", () => {
    expect(resolveWorkerAddress({ environment: "staging", domains: DOMAINS })?.url).toBe(
      "https://staging.api.example.com",
    );
  });

  it("falls back to the first route, so a hand-edited wrangler keeps working", () => {
    // The non-breaking guarantee. An adopter who wrote their own route predates the declaration and must
    // never be told to migrate.
    const resolved = resolveWorkerAddress({ environment: "prod", stanza: { routes: ["api.acme.test/*"] } });
    expect(resolved).toEqual({ url: "https://api.acme.test", source: "route", hostname: "api.acme.test" });
  });

  it("accepts both route forms wrangler does", () => {
    expect(resolveWorkerAddress({ environment: "prod", stanza: { route: "api.acme.test" } })?.hostname).toBe(
      "api.acme.test",
    );
    expect(
      resolveWorkerAddress({ environment: "prod", stanza: { routes: [{ pattern: "api.acme.test" }] } })?.hostname,
    ).toBe("api.acme.test");
  });

  it("falls back to a hand-set BASE_URL last, and normalises it to an absolute URL", () => {
    // Last because it is the input an adopter most easily leaves stale — it used to be the only one.
    // Normalised because `dashboard connect` validates the stored address with `z.url()`, and the old
    // readers accepted a bare hostname that would fail there.
    expect(resolveWorkerAddress({ environment: "prod", stanza: { vars: { BASE_URL: "api.acme.test" } } })).toEqual({
      url: "https://api.acme.test",
      source: "var",
      hostname: "api.acme.test",
    });
    expect(
      resolveWorkerAddress({ environment: "prod", stanza: { vars: { BASE_URL: "https://api.acme.test/hooks" } } })?.url,
    ).toBe("https://api.acme.test");
  });

  it("never resolves a public address for dev", () => {
    // Local answers on `http://localhost:<port>` from the port pinned in `.dev.config.json`. A domain
    // here would be a second answer to a question the port allocator already answers.
    expect(resolveWorkerAddress({ environment: "dev", domains: DOMAINS, stanza: { routes: ["x.example.com"] } })).toBe(
      null,
    );
  });

  it("reports nothing rather than guessing when a project has no address at all", () => {
    expect(resolveWorkerAddress({ environment: "prod" })).toBeNull();
    expect(resolveWorkerAddress({ environment: "prod", stanza: {} })).toBeNull();
    expect(resolveWorkerAddress({ environment: "prod", domains: {} })).toBeNull();
  });

  it("treats an unparseable value as nothing found rather than throwing", () => {
    // The resolver reports what it found. A malformed value found is, for every caller, the same as
    // nothing found — and `pithy env` must keep exiting 0 whatever is in the config.
    expect(resolveWorkerAddress({ environment: "prod", stanza: { vars: { BASE_URL: "http://" } } })).toBeNull();
    expect(resolveWorkerAddress({ environment: "prod", stanza: { routes: [""] } })).toBeNull();
    expect(resolveWorkerAddress({ environment: "prod", stanza: { vars: { BASE_URL: 42 } } })).toBeNull();
  });

  it("skips a bad route and still reads the var behind it", () => {
    expect(
      resolveWorkerAddress({ environment: "prod", stanza: { routes: [""], vars: { BASE_URL: "api.acme.test" } } })
        ?.source,
    ).toBe("var");
  });
});

describe("workersDevAddress", () => {
  it("composes the subdomain address when the account has one", () => {
    expect(workersDevAddress("acme-api", "acme")).toEqual({
      url: "https://acme-api.acme.workers.dev",
      source: "workers.dev",
      hostname: "acme-api.acme.workers.dev",
    });
  });

  it("is null when the account has no subdomain — the production case this must not assume", () => {
    // `workers.dev` can be disabled per account and commonly is in production, where a live domain is
    // the only intended entry point. A fallback that is weakest exactly there is not one to depend on.
    expect(workersDevAddress("acme-api", null)).toBeNull();
    expect(workersDevAddress("", "acme")).toBeNull();
  });
});

describe("describeAddressSource", () => {
  it("says where an address came from, because that is the first question asked", () => {
    expect(describeAddressSource("declaration")).toBe("declared in pithy.config.ts");
    expect(describeAddressSource("route")).toBe("from the route in wrangler.jsonc");
    expect(describeAddressSource("var")).toBe("from vars.BASE_URL in wrangler.jsonc");
    expect(describeAddressSource("workers.dev")).toBe("your workers.dev subdomain");
  });
});
