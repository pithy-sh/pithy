// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityManifest, type ConfigOption } from "@pithy-sh/core/src/capability/manifest";
import { DOMAIN_ENVIRONMENTS, LOCAL_ORIGIN, originFor, type WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addCapability } from "../capabilities/add";
import { writeDomains } from "./askDomains";
import { DEFAULT_WORKER, scaffoldProject } from "./scaffold";

/**
 * **No capability config carries an origin that a different environment would need to be different.**
 *
 * Stated over the composition rather than over a field list, because a field list is what let this
 * happen three times. The first adopter's one Worker config hardcoded `https://app.pithy.sh` in three
 * places — `auth.baseURL`, `email.baseUrl`, and the Stripe return URLs — each wrong for staging in its
 * own way, each found on a different day. Staging mailed its testers magic links **into production**; an
 * unsubscribe from a staging test would have unsubscribed that person **in production**; someone who
 * paid on staging landed in production on an account that had bought nothing. Fixing it inside one
 * capability does not stop the next capability asking the same question (#256).
 *
 * So the scaffold declares `DOMAINS` once, derives `PUBLIC_ORIGIN` from it, and every capability whose
 * manifest says its option is an origin takes that constant. This asserts both halves against a real
 * scaffolded project: what the writer puts in the config, and what the derivation answers per
 * environment.
 *
 * **The fallback is the load-bearing part**, and it is asserted here too. An environment absent from
 * `DOMAINS` is one that is not published, so it resolves to the local origin — links that go nowhere,
 * useless rather than harmful. The shape being replaced fell back to *production*, which is how a
 * staging deploy mails real users into prod.
 */

/** An origin option that would be hardcoded if nothing derived it — the planted violation's shape. */
const ORIGIN_OPTION = {
  key: "baseUrl",
  default: "https://api.example.com",
  describe: "The public base URL of this Worker.",
};

const PROJECT = "replay";

/** This repository's packages — where every shipped manifest lives. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..", "..", "packages");

let dir: string;
let worker: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-origin-"));
  await scaffoldProject({ targetDir: dir, appName: PROJECT });
  worker = join(dir, "apps", DEFAULT_WORKER);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The Worker's `pithy.config.ts` as it stands. */
function config(): Promise<string> {
  return readFile(join(worker, "pithy.config.ts"), "utf8");
}

test("the scaffold declares the origin once and derives it, so nothing has to write one", async () => {
  const source = await config();
  expect(source).toContain("const DOMAINS = {");
  expect(source).toContain("export const PUBLIC_ORIGIN = originFor(compositionEnvironment(), DOMAINS);");
  expect(source).toContain("domains: DOMAINS,");
  // And no origin is written down at all: the placeholders are commented out, so a fresh project carries
  // no URL a deploy could pick up by accident.
  expect(source).not.toMatch(/^\s*(?:staging|prod):/m);
});

test("a capability whose option is an origin takes the constant, unquoted, not a URL", async () => {
  const manifest = CapabilityManifest.parse({
    name: "email",
    package: "@pithy-sh/email",
    requiredBindings: [],
    configOptions: [{ ...ORIGIN_OPTION, constant: "publicOrigin" }],
  });
  await addCapability({ workerDir: worker, manifest, project: PROJECT });

  const source = await config();
  expect(source).toContain("baseUrl: PUBLIC_ORIGIN,");
  // The literal the manifest still carries — the fallback for a config with no such constant — is not
  // what landed here. A quoted origin is the defect.
  expect(source).not.toContain('"https://api.example.com"');
});

test("it bites — an option that names no constant is written as the URL the manifest states", async () => {
  // The planted violation, and it is the shape every capability had. Nothing about `pithy add` refuses a
  // hardcoded origin; what refuses it is the manifest naming `publicOrigin`, and this is what the config
  // looks like when it does not.
  const manifest = CapabilityManifest.parse({
    name: "email",
    package: "@pithy-sh/email",
    requiredBindings: [],
    configOptions: [ORIGIN_OPTION],
  });
  await addCapability({ workerDir: worker, manifest, project: PROJECT });
  expect(await config()).toContain('baseUrl: "https://api.example.com",');
});

test("a config that does not declare the constant keeps the literal, rather than an identifier nothing defines", async () => {
  // A project scaffolded before the constant existed. Writing `PUBLIC_ORIGIN` into it would trade a
  // hardcoded origin for a config that does not compile, which is not a trade worth making silently.
  const source = await config();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(worker, "pithy.config.ts"), source.replace(/^export const PUBLIC_ORIGIN.*$/m, ""));

  const manifest = CapabilityManifest.parse({
    name: "email",
    package: "@pithy-sh/email",
    requiredBindings: [],
    configOptions: [{ ...ORIGIN_OPTION, constant: "publicOrigin" }],
  });
  await addCapability({ workerDir: worker, manifest, project: PROJECT });
  expect(await config()).toContain('baseUrl: "https://api.example.com",');
});

test("declaring a domain fills the hoisted const, and does not add a second domains key", async () => {
  const domains: WorkerDomains = {
    staging: { pattern: "staging.api.example.com", zone: "example.com" },
    prod: { pattern: "api.example.com", zone: "example.com" },
  };
  const { declared } = await writeDomains(worker, domains);
  expect(declared).toBe(true);

  const source = await config();
  expect(source).toContain('staging: { pattern: "staging.api.example.com", zone: "example.com" },');
  expect(source).toContain('prod: { pattern: "api.example.com", zone: "example.com" },');
  // One `domains` key, and it is still the reference. The writer this replaced inserted a *second*
  // `domains: { … }` after `const config = {`, where the last one silently wins.
  expect(source.match(/^\s*domains\s*:/gm)).toEqual(["  domains:"]);
  expect(source).toContain("domains: DOMAINS,");
  // The derivation is untouched, which is what makes the fill worth anything.
  expect(source).toContain("export const PUBLIC_ORIGIN = originFor(compositionEnvironment(), DOMAINS);");
});

/**
 * The gate proper, repo-wide over the shipped manifests: **an option whose default is an origin names
 * the constant.**
 *
 * Stated over the shape of the value rather than over a list of field names, because a list is exactly
 * what missed `email.baseUrl` and the Stripe return URLs for days after `auth.baseURL` was fixed. Any
 * default that spells a scheme is an origin, whatever the option is called, and an origin a capability
 * asks the adopter to write down is the defect this closes.
 */
describe("no shipped manifest asks an adopter to write down an origin", () => {
  /** A default that is an absolute URL — the shape, not the field name. */
  const ORIGIN_SHAPED = /^https?:\/\//;

  /**
   * Origins that deliberately do **not** derive: `<package>: <option>` → why.
   *
   * A line here is a claim that a URL is not an address, and adding one is the reviewable act. There is
   * one, and the issue that produced this gate names it: `controlplane.issuer` is an **identity**. Each
   * connection stores the issuer it was made with and verification checks that stored value, so an issuer
   * that followed the environment would make a connection minted in staging unverifiable in production.
   * That may well be the better isolation, but it is a decision about trust rather than about
   * reachability, and a helper whose job is "where am I reachable" must not sweep it up.
   */
  const DOES_NOT_DERIVE: Record<string, string> = {
    "core: issuer":
      "An identity, not an address. A connection stores the issuer it was created with and verification checks that stored value, so deriving it per environment would make a staging-minted connection unverifiable in production.",
  };

  /** Every option any shipped capability declares, with the package it came from. */
  function shippedOptions(): { pkg: string; option: ConfigOption }[] {
    const found: { pkg: string; option: ConfigOption }[] = [];
    for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(PACKAGES, entry.name, "pithy.manifest.json");
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        continue; // not a capability package
      }
      const manifest = CapabilityManifest.parse(JSON.parse(raw));
      for (const option of manifest.configOptions) found.push({ pkg: entry.name, option });
    }
    return found;
  }

  test("every origin-shaped default names publicOrigin", () => {
    // It has already earned its place: it found `testers.baseUrl`, a fourth capability asking for an
    // origin that nobody had reported — the issue named three.
    const hardcoded = shippedOptions()
      .filter(({ option }) => typeof option.default === "string" && ORIGIN_SHAPED.test(option.default))
      .filter(({ pkg, option }) => !(`${pkg}: ${option.key}` in DOES_NOT_DERIVE))
      .filter(({ option }) => option.constant !== "publicOrigin")
      .map(({ pkg, option }) => `${pkg}: ${option.key} = ${String(option.default)}`);
    expect(
      hardcoded,
      'add `"constant": "publicOrigin"` to that option — an origin a capability asks an adopter to write down is production\'s origin written into staging',
    ).toEqual([]);
  });

  test("and the one exemption is still an option that exists, still stating an origin", () => {
    // An exemption list whose entries have quietly stopped matching anything is a list that reads as
    // vigilance and enforces nothing.
    const options = new Map(shippedOptions().map(({ pkg, option }) => [`${pkg}: ${option.key}`, option]));
    for (const key of Object.keys(DOES_NOT_DERIVE)) {
      const option = options.get(key);
      expect(option, `${key} is exempted and no longer exists`).toBeDefined();
      expect(typeof option?.default === "string" && ORIGIN_SHAPED.test(option.default)).toBe(true);
    }
  });

  test("it bites — a planted origin default with no constant is caught", () => {
    // The planted violation, in the shape every one of the three had: a URL as a manifest default, no
    // constant, and `pithy add` writing it into the config verbatim for every environment.
    const planted = CapabilityManifest.parse({
      name: "planted",
      package: "@pithy-sh/planted",
      requiredBindings: [],
      configOptions: [{ key: "webhookOrigin", default: "https://app.example.com", describe: "Where we call back." }],
    });
    const caught = planted.configOptions
      .filter((option) => typeof option.default === "string" && ORIGIN_SHAPED.test(option.default))
      .filter((option) => option.constant !== "publicOrigin");
    expect(caught.map((option) => option.key)).toEqual(["webhookOrigin"]);
  });
});

test("no two environments resolve to the same public origin, and an undeclared one is local", () => {
  const domains: WorkerDomains = {
    staging: { pattern: "staging.api.example.com", zone: "example.com" },
    prod: { pattern: "api.example.com", zone: "example.com" },
  };
  const origins = DOMAIN_ENVIRONMENTS.map((env) => originFor(env, domains));
  expect(new Set(origins).size).toBe(origins.length);

  // The fallback, and the whole reason it is what it is: an environment `DOMAINS` does not name resolves
  // to the local origin and never to another environment's. Falling back to production is what mailed
  // staging's testers into prod.
  expect(originFor("staging", { prod: domains.prod })).toBe(LOCAL_ORIGIN);
  expect(originFor("dev", domains)).toBe(LOCAL_ORIGIN);
  // And an unstamped composition — `compositionEnvironment()` answering `undefined` — is not a defaulted
  // `dev`; it is an environment nobody named, which has declared no domain either way.
  expect(originFor(undefined, domains)).toBe(LOCAL_ORIGIN);
});
