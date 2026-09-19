// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { afterEach, describe, expect, it } from "vitest";
import { featureConfigPath } from "../provision/featureConfig";
import {
  describeAddressSource,
  inheritAddressKeys,
  readAddressStanza,
  resolveWorkerAddress,
  workersDevAddress,
} from "./workerAddress";

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

  it("falls back to a hand-set BASE_URL last, and normalizes it to an absolute URL", () => {
    // Last because it is the input an adopter most easily leaves stale — it used to be the only one.
    // Normalized because `dashboard connect` validates the stored address with `z.url()`, and the old
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

/**
 * **A feature environment's address is derived, through this same resolver (#643).**
 *
 * A feature Worker's script name is its `workers.dev` prefix, so its address is
 * `https://<script>.<account subdomain>.workers.dev`. Project `replay` and Worker `board`, so the script
 * (`replay-f643-feature-address-board`) is neither name alone — a resolver reading the wrong one cannot pass.
 */
describe("resolveWorkerAddress for a feature environment", () => {
  const SCRIPT = "replay-f643-feature-address-board";
  const ORIGIN = `https://${SCRIPT}.acme.workers.dev`;

  it("derives the workers.dev address from the stanza's script name and the account's subdomain", () => {
    expect(resolveWorkerAddress({ environment: "feature", stanza: { name: SCRIPT }, subdomain: "acme" })).toEqual({
      url: ORIGIN,
      source: "workers.dev",
      hostname: `${SCRIPT}.acme.workers.dev`,
    });
  });

  it("prefers the derivation to a stale stamp", () => {
    const stale = "https://replay-f643-feature-address-board.old.workers.dev";
    expect(
      resolveWorkerAddress({
        environment: "feature",
        stanza: { name: SCRIPT, vars: { BASE_URL: stale } },
        subdomain: "acme",
      })?.url,
    ).toBe(ORIGIN);
  });

  it("reads the address provisioning stamped when no subdomain was looked up", () => {
    // Offline callers — `pithy env`, `dashboard connect` — have no account to ask, and need no account:
    // provisioning derived the address and wrote it down.
    expect(
      resolveWorkerAddress({ environment: "feature", stanza: { name: SCRIPT, vars: { BASE_URL: ORIGIN } } }),
    ).toEqual({ url: ORIGIN, source: "workers.dev", hostname: `${SCRIPT}.acme.workers.dev` });
  });

  it("never reads an inherited BASE_URL that is not a feature's own", () => {
    // The feature stanza is generated from the top level, so a hand-set production BASE_URL arrives with it.
    // Reading it would address a branch at production.
    expect(
      resolveWorkerAddress({
        environment: "feature",
        stanza: { name: SCRIPT, vars: { BASE_URL: "https://app.example.com" } },
      }),
    ).toBeNull();
  });

  /**
   * **Finding 3: a route on a feature is a domain another environment owns (#643).** wrangler inherits a top-level
   * `routes` into every environment that sets none, and with routes and no `workers_dev` it gives the Worker no
   * `workers.dev` address. So a feature never answers on a route, and gets a `workers.dev` address only when
   * wrangler would give it one.
   */
  it("never takes a route: with routes and no workers_dev, wrangler gives no workers.dev address, so none", () => {
    for (const stanza of [
      { name: SCRIPT, routes: ["app.example.com"] },
      { name: SCRIPT, routes: [{ pattern: "app.example.com", custom_domain: true }] },
      { name: SCRIPT, route: "app.example.com" },
      { name: SCRIPT, routes: ["app.example.com"], vars: { BASE_URL: ORIGIN } },
    ]) {
      expect(
        resolveWorkerAddress({ environment: "feature", stanza, subdomain: "acme" }),
        JSON.stringify(stanza),
      ).toBeNull();
    }
  });

  it("with routes and workers_dev on, answers on workers.dev — never the route", () => {
    expect(
      resolveWorkerAddress({
        environment: "feature",
        stanza: { name: SCRIPT, routes: ["app.example.com"], workers_dev: true },
        subdomain: "acme",
      }),
    ).toEqual({ url: ORIGIN, source: "workers.dev", hostname: new URL(ORIGIN).hostname });
  });

  it("an empty routes list is no routes: workers.dev is on by wrangler's default", () => {
    expect(
      resolveWorkerAddress({ environment: "feature", stanza: { name: SCRIPT, routes: [] }, subdomain: "acme" })?.url,
    ).toBe(ORIGIN);
  });

  it("reads a feature stanza's inherited routes, as wrangler deploys it", () => {
    const top = { routes: [{ pattern: "app.example.com", custom_domain: true }] };
    expect(inheritAddressKeys(top, { name: SCRIPT }, "feature").routes).toEqual(top.routes);
    // Its own list wins, as wrangler's does — including an empty one.
    expect(inheritAddressKeys(top, { name: SCRIPT, routes: [] }, "feature").routes).toEqual([]);
    // A declared environment's address is read from its own stanza, as it always was (#89).
    expect(inheritAddressKeys(top, { name: "replay-staging-board" }, "staging").routes).toBeUndefined();
  });

  it("derives nothing when workers.dev is turned off for the Worker", () => {
    expect(
      resolveWorkerAddress({ environment: "feature", stanza: { name: SCRIPT, workers_dev: false }, subdomain: "acme" }),
    ).toBeNull();
  });

  it("derives nothing for an account with no subdomain, or a stanza with no script name", () => {
    expect(resolveWorkerAddress({ environment: "feature", stanza: { name: SCRIPT }, subdomain: null })).toBeNull();
    expect(resolveWorkerAddress({ environment: "feature", stanza: {}, subdomain: "acme" })).toBeNull();
  });

  it("is never the fallback for a declared environment (#89)", () => {
    // `workers.dev` can be disabled per account and commonly is in production. A declared environment
    // resolves from its config or not at all.
    for (const environment of ["staging", "prod"]) {
      expect(resolveWorkerAddress({ environment, stanza: { name: SCRIPT }, subdomain: "acme" })).toBeNull();
    }
    expect(resolveWorkerAddress({ environment: "dev", stanza: { name: SCRIPT }, subdomain: "acme" })).toBeNull();
  });
});

describe("readAddressStanza", () => {
  const made: string[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reads a feature's stanza from the generated config, and a declared one's from the tracked file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-address-stanza-"));
    made.push(dir);
    await writeFile(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({ env: { staging: { name: "replay-staging-board" } } }),
    );
    await mkdir(join(dir, ".wrangler", "pithy"), { recursive: true });
    await writeFile(featureConfigPath(dir), JSON.stringify({ env: { feature: { name: "replay-f643-x-board" } } }));

    expect((await readAddressStanza(dir, "staging"))?.name).toBe("replay-staging-board");
    expect((await readAddressStanza(dir, "feature"))?.name).toBe("replay-f643-x-board");
    expect(await readAddressStanza(dir, "prod")).toBeUndefined();
  });

  /**
   * **wrangler inherits a top-level `workers_dev` into every environment (#643).** A generated feature stanza
   * never repeats it, so reading the stanza alone saw no `false`, derived a workers.dev address, and stamped one
   * nothing answers on.
   */
  it("carries a top-level workers_dev: false into the stanza it reads, so a feature has no workers.dev address", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-address-stanza-"));
    made.push(dir);
    await mkdir(join(dir, ".wrangler", "pithy"), { recursive: true });
    await writeFile(
      featureConfigPath(dir),
      JSON.stringify({ workers_dev: false, env: { feature: { name: "replay-f643-x-board" } } }),
    );

    const stanza = await readAddressStanza(dir, "feature");
    expect(stanza?.workers_dev).toBe(false);
    expect(resolveWorkerAddress({ environment: "feature", stanza, subdomain: "acme" })).toBeNull();
  });

  it("lets the stanza's own workers_dev win over the top level's, as wrangler does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-address-stanza-"));
    made.push(dir);
    await mkdir(join(dir, ".wrangler", "pithy"), { recursive: true });
    await writeFile(
      featureConfigPath(dir),
      JSON.stringify({ workers_dev: false, env: { feature: { name: "replay-f643-x-board", workers_dev: true } } }),
    );

    const stanza = await readAddressStanza(dir, "feature");
    expect(resolveWorkerAddress({ environment: "feature", stanza, subdomain: "acme" })?.url).toBe(
      "https://replay-f643-x-board.acme.workers.dev",
    );
  });

  it("is undefined, not a throw, where there is no config at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-address-stanza-"));
    made.push(dir);
    expect(await readAddressStanza(dir, "feature")).toBeUndefined();
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
