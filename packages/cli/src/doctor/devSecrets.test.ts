// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLOUDFLARE_ENV_KEYS } from "@pithy-sh/cloudflare/src/env/devVars";
import { loadDevSecrets } from "@pithy-sh/secrets/src/dev/loadDevSecrets";
import { type DevSecretsStore, seedDevSecrets } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import { defineSecretRegistry, SecretBackend, type SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { devSecretsFile } from "../devSecrets/location";
import type { DevSecretsTarget } from "../devSecrets/targets";
import type { StatePathOptions } from "../notifier/state";
import {
  checkDevSecrets,
  checkDevSecretsLocation,
  describeDevSecrets,
  describeDevSecretsLocation,
  devSecretsHealthy,
} from "./devSecrets";

const registry = defineSecretRegistry({
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
  CLOUDFLARE_API_TOKEN: {
    backend: "cf-secrets-store",
    scope: "global",
    rotatable: false,
    valueType: "text",
  },
  // A `cf-secrets-store` secret that is **not** a CLI credential — the dashboard's own shape (#178).
  // Its dev value is stated in the secrets file exactly as a `d1` one's is; the seeder is what puts it
  // in a binding. A copy in the root `.dev.vars` is read by nothing.
  CONNECTION_KEY_ENCRYPTION_KEY: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "text",
    devValue: "random",
  },
  // A `json` secret with a real schema — the only kind whose *stated* value can be wrong in a way
  // presence cannot see, which is the whole of #323's second defect.
  "auth-google-credentials": {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: z.object({
      clientId: z.string().describe("The OAuth client id."),
      clientSecret: z.string().describe("The OAuth client secret."),
    }),
  },
  // A keyspace — an unbounded set of members the app writes at runtime, one per key. It has no single
  // value, and `pithy seed` hard-fails on a file that gives it one (#325).
  CONNECTION_SIGNING_KEY: {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    keyed: true,
  },
});

let dir: string;
let config: string;
/** The resolved secrets file for this test's project. Outside `dir` — that is the point of #156. */
let path: string;

/** The config seams. Fresh per test, so nothing here can read or write the operator's own file. */
function paths(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-doctor-secrets-"));
  config = await mkdtemp(join(tmpdir(), "pithy-doctor-config-"));
  // The check resolves the file from the project's name, so the project needs a `pithy.config.ts`.
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "clinic" };\n');
  path = devSecretsFile("clinic", paths());
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

/** One Worker composing `secrets`, resolved against the per-test directory. */
function board(): DevSecretsTarget {
  return { name: "board", dir: join(dir, "apps", "board"), registry };
}

function check() {
  return checkDevSecrets({ projectDir: dir, targets: [board()], paths: paths() });
}

describe("checkDevSecrets", () => {
  test("a project no Worker composes secrets in has no question to answer", async () => {
    expect(await checkDevSecrets({ projectDir: dir, targets: [], paths: paths() })).toBeNull();
  });

  test("names a d1-backed secret found in .dev.vars — this is the whole migration notice", async () => {
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=abc\nauth-session-secret=old\n");
    const result = await check();
    expect(result?.misplaced.map((m) => m.name)).toEqual(["auth-session-secret"]);
  });

  test("an env binding in .dev.vars is not misplaced — that is the file it belongs in", async () => {
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=abc\nSECRETS_ENCRYPTION_KEYS={}\n");
    expect((await check())?.misplaced).toEqual([]);
  });

  test("a CLI credential in .dev.vars is where it belongs — that file is what the CLI reads", async () => {
    // `CLOUDFLARE_API_TOKEN` is silent because it is a {@link CLOUDFLARE_ENV_KEYS} credential, not
    // because of its backend. Naming it misplaced would send an adopter to break their own CLI.
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_API_TOKEN=tok\n");
    expect((await check())?.misplaced).toEqual([]);
  });

  /**
   * #178: the check reached `backend: "d1"` only, so the dashboard's `cf-secrets-store` registry
   * secrets sat in its root `.dev.vars` unflagged while the `d1` ones beside them were named. Backend
   * decides where a *seeded* value lands; it never decided whether the root `.dev.vars` is the file a
   * value belongs in. That question has one answer for every backend.
   */
  test("a cf-secrets-store secret in .dev.vars is misplaced too — the root file is nobody's source", async () => {
    await writeFile(join(dir, ".dev.vars"), "CONNECTION_KEY_ENCRYPTION_KEY=k\n");
    expect((await check())?.misplaced).toEqual([{ name: "CONNECTION_KEY_ENCRYPTION_KEY", state: "unmoved" }]);
  });

  test("every backend the registry can declare is reported, so a third one cannot arrive unchecked", async () => {
    // The gate, stated as the invariant rather than as a list of backends this file happens to know:
    // a registry secret in the root `.dev.vars` is misplaced, whatever `backend` says. Add a backend to
    // {@link SecretBackend} and this fails until a fixture declares it and the check names it.
    //
    // A keyspace is excluded, and that is the rule rather than an exemption: "misplaced" says this value
    // belongs in the secrets file, and a keyspace belongs in neither file — a line for one is inert in
    // `.dev.vars` and refused outright in `secrets.jsonc`. Naming it here would send an adopter to move a
    // value the next `pithy seed` throws on (#325).
    // Widened once, to the type the check itself reads: the narrow literal `defineSecretRegistry`
    // returns has no `keyed` on the entries that do not declare one.
    const declared = (Object.entries(registry) as [string, SecretRegistryEntry][])
      .filter(([name]) => !CLOUDFLARE_ENV_KEYS.includes(name as (typeof CLOUDFLARE_ENV_KEYS)[number]))
      .filter(([, entry]) => !entry.keyed)
      .map(([name, entry]) => [name, entry.backend] as const);
    expect(new Set(declared.map(([, backend]) => backend))).toEqual(new Set(SecretBackend.options));

    await writeFile(join(dir, ".dev.vars"), declared.map(([name]) => `${name}=x`).join("\n"));

    expect(new Set((await check())?.misplaced.map((entry) => entry.name))).toEqual(
      new Set(declared.map(([name]) => name)),
    );
  });

  test("a name in both files is a duplicate — the move is done and the old line was left", async () => {
    // It made no difference whether the two agreed. They used to be told apart, because one of them was
    // the copy pithy injected on every `pithy dev` and deleting it broke dev. Nothing is injected now
    // and nothing reads the line, so both shapes have the same one-word fix.
    await writeFile(path, '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "n" } } }');
    await chmod(path, 0o600);
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=old\n");

    const result = await check();

    expect(result?.misplaced).toEqual([{ name: "auth-session-secret", state: "duplicate" }]);
    expect(devSecretsHealthy(result as NonNullable<typeof result>)).toBe(false);
  });

  test("a secret only in .dev.vars is the migration case, and is still named as one", async () => {
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=old\n");
    const result = await check();
    expect(result?.misplaced).toEqual([{ name: "auth-session-secret", state: "unmoved" }]);
  });

  test("reports the file's mode, so a world-readable secrets file is caught before it matters", async () => {
    await writeFile(path, "{}");
    await chmod(path, 0o644);
    expect((await check())?.mode).toBe(0o644);
  });

  test("no file is no mode, and no fault — a project has none until a capability needs one", async () => {
    const result = await check();
    expect(result?.mode).toBeNull();
    expect(result?.misplaced).toEqual([]);
  });

  test("never throws on a malformed file — a diagnostic runs in the environment it diagnoses", async () => {
    await writeFile(path, "{ nope");
    await chmod(path, 0o600);
    const result = await check();
    expect(result?.unreadable).toBeTruthy();
  });

  test("a secret nothing can mint, with no value anywhere, is listed once here instead of on every run", async () => {
    // CLOUDFLARE_API_TOKEN is Cloudflare's to issue. `auth-session-secret` is not listed: it is
    // `devValue: "random"`, so the next seed supplies it and there is nothing for anyone to do.
    expect((await check())?.missing).toEqual(["CLOUDFLARE_API_TOKEN", "auth-google-credentials"]);
  });

  test("a value in either file is not missing — the file is dev's source of truth, .dev.vars still resolves", async () => {
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_API_TOKEN=tok\n");
    expect((await check())?.missing).toEqual(["auth-google-credentials"]);
  });

  test("a name no capability declares is reported here, where the config is loaded fresh", async () => {
    await writeFile(path, '{ "gone-capability-key": { "currentVersion": "1", "versions": { "1": "x" } } }');
    expect((await check())?.undeclared).toEqual(["gone-capability-key"]);
  });

  test("an undeclared name is not a fault — a stale line must not turn a green report red", async () => {
    await writeFile(path, '{ "gone-capability-key": { "currentVersion": "1", "versions": { "1": "x" } } }');
    await chmod(path, 0o600);
    const result = await check();
    expect(result && devSecretsHealthy(result)).toBe(true);
  });

  test("a malformed file reports nothing missing — it would name every declared secret, over one fault", async () => {
    await writeFile(path, "{ nope");
    const result = await check();
    expect(result?.unreadable).toBeTruthy();
    expect(result?.missing).toEqual([]);
  });

  test("a malformed file reports nothing misplaced either — it cannot say which of the two states it is", async () => {
    // Both states are decided against what the file states. A file that will not parse states nothing,
    // so a value already moved fell through to `unmoved` and doctor told the adopter to go move it
    // again. A broken file is its own diagnosis; every other sentence it produces is a guess.
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=old\n");
    await writeFile(path, "{ nope");

    const result = await check();

    expect(result?.unreadable).toBeTruthy();
    expect(result?.misplaced).toEqual([]);
    expect(describeDevSecrets(result as NonNullable<typeof result>).join("\n")).not.toContain("belongs in");
  });
});

/**
 * **The invariant: doctor judges what a stated value *is*, not merely that it is there.**
 *
 * `Object.hasOwn(stated, name)` was the entire check, so a value violating its own registry schema
 * passed `pithy doctor` and failed `pithy seed` — and doctor is the command whose job is catching that
 * first. Both `stated` and `entry.schema` were already in hand on that line (#323).
 */
describe("checkDevSecrets — a stated value is judged, not counted", () => {
  test("a stated value that violates its schema is named, with the version and the file", async () => {
    await writeFile(
      path,
      JSON.stringify({ "auth-google-credentials": { currentVersion: "1", versions: { "1": { clientId: "id" } } } }),
    );
    await chmod(path, 0o600);

    const result = await check();

    expect(result?.malformed.map((m) => m.name)).toEqual(["auth-google-credentials"]);
    expect(result?.malformed[0]?.reason).toContain("auth-google-credentials");
    expect(result?.missing).not.toContain("auth-google-credentials");
  });

  test("a malformed value is a fault — the next seed fails on it, and doctor exists to say so first", async () => {
    await writeFile(
      path,
      JSON.stringify({ "auth-google-credentials": { currentVersion: "1", versions: { "1": { clientId: "id" } } } }),
    );
    await chmod(path, 0o600);

    const result = await check();

    expect(result && devSecretsHealthy(result)).toBe(false);
    expect(describeDevSecrets(result as NonNullable<typeof result>).join("\n")).toContain("auth-google-credentials");
  });

  test("a stated value that reads is not malformed — silence stays the healthy answer", async () => {
    await writeFile(
      path,
      JSON.stringify({
        "auth-google-credentials": { currentVersion: "1", versions: { "1": { clientId: "id", clientSecret: "s" } } },
      }),
    );
    await chmod(path, 0o600);

    const result = await check();

    expect(result?.malformed).toEqual([]);
    expect(result && devSecretsHealthy(result)).toBe(true);
  });

  test("nothing about a malformed value is echoed — the reason is a shape, and the file holds secrets", async () => {
    await writeFile(
      path,
      JSON.stringify({
        "auth-google-credentials": { currentVersion: "1", versions: { "1": { clientId: "s3cr3t-material" } } },
      }),
    );
    await chmod(path, 0o600);

    const result = await check();

    expect(JSON.stringify(result)).not.toContain("s3cr3t-material");
    expect(describeDevSecrets(result as NonNullable<typeof result>).join("\n")).not.toContain("s3cr3t-material");
  });

  test("a value in the wrong shape names the secret it belongs to, not just the file", async () => {
    // "will not parse. Run pithy seed to see which secret and why" sent the reader to a second command
    // to learn something this run already knew. The reader names the secret; doctor was throwing it away.
    //
    // **And it is one secret's fault, not the file's (#323).** Which payload a slot takes is the
    // registry's answer, so this is judged per secret, beside the registry entry that decides it — the
    // rest of the file still reports. `unreadable` is for a file that states nothing readable at all.
    await writeFile(path, JSON.stringify({ "auth-session-secret": "bare-value-no-envelope" }));
    await chmod(path, 0o600);

    const result = await check();

    expect(result?.unreadable).toBeNull();
    expect(result?.malformed.map((entry) => entry.name)).toContain("auth-session-secret");
    expect(describeDevSecrets(result as NonNullable<typeof result>).join("\n")).toContain("auth-session-secret");
    expect(JSON.stringify(result)).not.toContain("bare-value-no-envelope");
  });
});

describe("devSecretsHealthy", () => {
  const clean = {
    path: "/home/u/.config/pithy/acme/secrets.jsonc",
    misplaced: [],
    missing: [],
    bootstrapMissing: [],
    undeclared: [],
    mode: 0o600,
    unreadable: null,
    malformed: [],
    unresolvable: [],
  };

  test("a master key nobody has minted yet is named with the command that mints it", () => {
    // Not "issued by somebody else, fine to leave until you need it" — that is the one sentence that
    // sends an adopter past the thing actually stopping their local `SECRETS` store from opening.
    const lines = describeDevSecrets({ ...clean, bootstrapMissing: ["SECRETS_ENCRYPTION_KEYS"] }).join("\n");
    expect(lines).toContain("pithy add secrets");
    expect(lines).not.toContain("issued by somebody else");
  });

  test("a missing secret is not a fault — four unset OAuth pairs must not drag every report verbose", () => {
    expect(devSecretsHealthy({ ...clean, missing: ["auth-google-credentials"] })).toBe(true);
  });

  test("a misplaced secret, a wide mode, and a broken file each are", () => {
    expect(devSecretsHealthy({ ...clean, misplaced: [{ name: "a-b", state: "unmoved" }] })).toBe(false);
    expect(devSecretsHealthy({ ...clean, misplaced: [{ name: "a-b", state: "duplicate" }] })).toBe(false);
    expect(devSecretsHealthy({ ...clean, mode: 0o644 })).toBe(false);
    expect(devSecretsHealthy({ ...clean, unreadable: "broken" })).toBe(false);
  });

  test("no file at all is healthy — a project has none until a capability needs one", () => {
    expect(devSecretsHealthy({ ...clean, mode: null })).toBe(true);
  });
});

describe("describeDevSecrets", () => {
  test("a healthy project says one line and asks nothing", () => {
    const lines = describeDevSecrets({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      misplaced: [],
      missing: [],
      bootstrapMissing: [],
      undeclared: [],
      mode: 0o600,
      unresolvable: [],
      unreadable: null,
      malformed: [],
    });
    expect(lines).toEqual([]);
  });

  test("a misplaced secret is told where it belongs and that nothing was moved for them", () => {
    const lines = describeDevSecrets({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      misplaced: [{ name: "auth-session-secret", state: "unmoved" }],
      missing: [],
      bootstrapMissing: [],
      undeclared: [],
      unresolvable: [],
      mode: null,
      unreadable: null,
      malformed: [],
    });
    expect(lines.join("\n")).toContain("auth-session-secret");
    expect(lines.join("\n")).toContain(".dev.vars");
    expect(lines.join("\n")).toContain("/home/u/.config/pithy/acme/secrets.jsonc");
  });

  test("a duplicate is told to delete the line, and is not told to move a value that already moved", () => {
    const lines = describeDevSecrets({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      misplaced: [{ name: "auth-session-secret", state: "duplicate" }],
      missing: [],
      bootstrapMissing: [],
      undeclared: [],
      unresolvable: [],
      mode: 0o600,
      unreadable: null,
      malformed: [],
    });
    expect(lines.join("\n")).toContain("auth-session-secret");
    expect(lines.join("\n")).toContain("delete that line");
    expect(lines.join("\n")).not.toContain("Move it");
  });

  test("a mode wider than 0600 is named in the mode people write it in", () => {
    const lines = describeDevSecrets({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      misplaced: [],
      missing: [],
      bootstrapMissing: [],
      undeclared: [],
      mode: 0o644,
      unresolvable: [],
      unreadable: null,
      malformed: [],
    });
    expect(lines.join("\n")).toContain("644");
    expect(lines.join("\n")).toContain("600");
  });

  test("an unreadable file says so rather than reporting a clean project", () => {
    const lines = describeDevSecrets({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      misplaced: [],
      missing: [],
      bootstrapMissing: [],
      undeclared: [],
      mode: 0o600,
      unresolvable: [],
      unreadable: "the file will not parse",
      malformed: [],
    });
    expect(lines.join("\n")).toMatch(/will not parse|unreadable/i);
  });
});

describe("checkDevSecretsLocation", () => {
  test("reports the resolved path even when there is no file — nothing else in the run names it", async () => {
    // Not a fault, and that is why it is a separate check: the path is the answer to "where do my dev
    // secrets go", and since #156 there is no file in the checkout to find it by.
    const check = await checkDevSecretsLocation(dir, paths());
    expect(check).toEqual({ path, present: false, orphans: [] });
    expect(describeDevSecretsLocation(check as NonNullable<typeof check>)).toContain("no file yet");
  });

  test("a file that is there needs no sentence — the path is the whole answer", async () => {
    await writeFile(path, "{}\n");
    const check = await checkDevSecretsLocation(dir, paths());
    expect(check).toEqual({ path, present: true, orphans: [] });
    expect(describeDevSecretsLocation(check as NonNullable<typeof check>)).toBeNull();
  });

  test("a project with no file names the directories that do have one — a rename leaves a trail", async () => {
    // The directory is keyed on the project's `name`, so renaming a project silently changes which
    // file every command reads and leaves the old one behind with every value in it. Nothing else
    // could ever mention it: the old name is in no file this checkout still has.
    await mkdir(join(config, "clinic-old"), { recursive: true, mode: 0o700 });
    await writeFile(join(config, "clinic-old", "secrets.jsonc"), "{}\n");
    await mkdir(join(config, "no-secrets-here"), { recursive: true, mode: 0o700 });

    const check = await checkDevSecretsLocation(dir, paths());

    expect(check?.orphans).toEqual(["clinic-old"]);
    expect(describeDevSecretsLocation(check as NonNullable<typeof check>)).toContain("clinic-old");
  });

  test("a project that has its own file hears about nobody else's", async () => {
    // A machine with six projects on it must not hear about five of them on every run. The list is
    // for the one shape it diagnoses — this project has no file, and one of those is probably why.
    await mkdir(join(config, "clinic-old"), { recursive: true, mode: 0o700 });
    await writeFile(join(config, "clinic-old", "secrets.jsonc"), "{}\n");
    await writeFile(path, "{}\n");

    expect((await checkDevSecretsLocation(dir, paths()))?.orphans).toEqual([]);
  });

  test("no project name is no question — it declines rather than guessing a directory", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    expect(await checkDevSecretsLocation(dir, paths())).toBeNull();
  });
});

/**
 * `null` means no Worker composes `secrets` — and until #208 it also meant every Worker's config failed
 * to import.
 *
 * `checkDevSecrets` took the lossy target list, so an unresolvable project answered `[]` exactly as a
 * project with no secrets does, and the whole `Dev secrets:` block disappeared. That is the least useful
 * behavior available to a diagnostic: the report goes quiet in the one state it was written for (#166 was
 * the same shape). The two states are now different values, and neither is an exception.
 */
describe("a Worker nobody could ask (#208)", () => {
  const broken = [{ name: "board", dir: join("/p", "apps", "board"), reason: "pithy.config.ts would not import." }];

  test("a project whose every config failed is not a project with no secrets", async () => {
    const result = await checkDevSecrets({ projectDir: dir, targets: [], unresolvable: broken, paths: paths() });

    expect(result).not.toBeNull();
    expect(result?.unresolvable).toEqual(broken);
    // The path is still resolved, which is most of what this check is for.
    expect(result?.path).toBe(path);
  });

  test("no Worker composes secrets, and nothing failed — that is still null", async () => {
    expect(await checkDevSecrets({ projectDir: dir, targets: [], unresolvable: [], paths: paths() })).toBeNull();
  });

  test("a name the file states is not called undeclared on a registry nobody could read", async () => {
    // `undeclared` is the negative claim — "no capability declares this" — and it is exactly the claim a
    // registry that would not load cannot support. The stated name may be the broken Worker's own.
    await writeFile(path, JSON.stringify({ "mystery-key": { currentVersion: "1", versions: { "1": "v" } } }));

    const withBroken = await checkDevSecrets({
      projectDir: dir,
      targets: [board()],
      unresolvable: broken,
      paths: paths(),
    });
    expect(withBroken?.undeclared).toEqual([]);

    // With every config readable, the same file says the same thing and the claim is sound.
    const clean = await checkDevSecrets({ projectDir: dir, targets: [board()], paths: paths() });
    expect(clean?.undeclared).toEqual(["mystery-key"]);
  });

  test("what a readable registry declares is still judged — a partial read is not no read", async () => {
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=old\n");
    const result = await checkDevSecrets({
      projectDir: dir,
      targets: [board()],
      unresolvable: broken,
      paths: paths(),
    });
    expect(result?.misplaced).toEqual([{ name: "auth-session-secret", state: "unmoved" }]);
  });
});

/**
 * **The promise, asserted as the promise (#325).**
 *
 * #323 made `pithy doctor` judge every stated value through the seeder's own `storedSecretValue`, and
 * wrote down what that buys: *a green report means the next `pithy seed` works*. It was asserted case by
 * case — one test per fault the wave happened to think of — and a promise checked that way is only ever
 * as true as the list. A keyspace given a single value was not on the list, so doctor passed a file
 * `seedDevSecrets` throws `Secret '<name>' in <path> is a keyspace, not a single value.` on.
 *
 * So the gate below states the implication instead: **for every file here, a healthy check means a seed
 * that does not throw.** A new fault class arriving in the registry or the loader is caught by this
 * without anybody adding a case for it — which is the only kind of gate a promise about the *future* can
 * have. The corpus is what an adopter's file can be; the assertion is the same for all of it.
 */
describe("a green report means the next seed works (#325)", () => {
  /** The in-memory store double. Seeding's failure mode here is a throw, never a write that misses. */
  function store(): DevSecretsStore {
    return { getValue: async () => undefined, put: async () => {} };
  }

  const good = { currentVersion: "1", versions: { "1": "value" } };

  /** Every shape an adopter's secrets file can be. Healthy or not, the implication is the same for each. */
  const files: Record<string, string> = {
    "an empty file": "{}",
    "a file with nothing but comments": "// where these came from\n{\n  // nothing yet\n}",
    "every declared secret stated soundly": JSON.stringify({
      "auth-session-secret": good,
      CONNECTION_KEY_ENCRYPTION_KEY: good,
      "auth-google-credentials": {
        currentVersion: "1",
        versions: { "1": { clientId: "id", clientSecret: "shh" } },
      },
    }),
    // The counterexample this describe exists for. Doctor skipped it before the file was consulted at
    // all, so it was neither judged nor even reported as undeclared.
    "a keyspace given a single value": JSON.stringify({ CONNECTION_SIGNING_KEY: good }),
    "a keyspace given a single value beside a sound one": JSON.stringify({
      "auth-session-secret": good,
      CONNECTION_SIGNING_KEY: good,
    }),
    "a json value that violates its schema": JSON.stringify({
      "auth-google-credentials": { currentVersion: "1", versions: { "1": { clientId: "id" } } },
    }),
    "a text value written as a number": JSON.stringify({
      "auth-session-secret": { currentVersion: "1", versions: { "1": 7 } },
    }),
    "an envelope pointing at a version it does not carry": JSON.stringify({
      "auth-session-secret": { currentVersion: "2", versions: { "1": "value" } },
    }),
    "a name no capability declares": JSON.stringify({ "auth-session-secret": good, "stripe-webhook-secret": good }),
    "a name that looks like an Object.prototype key": JSON.stringify({ constructor: good, toString: good }),
  };

  for (const [shape, source] of Object.entries(files)) {
    test(`${shape}: healthy implies a seed that does not throw`, async () => {
      await writeFile(path, source, { mode: 0o600 });
      const result = await check();
      if (!result) throw new Error("expected a check — this project has a Worker composing secrets");
      if (!devSecretsHealthy(result)) return;

      // The same file, through the seeder. `loadDevSecrets` is what doctor read it with, so a divergence
      // here is a divergence in judgment and not in parsing.
      await expect(
        seedDevSecrets({ file: loadDevSecrets(source, { path }), registry, store: store(), path }),
      ).resolves.toBeDefined();
    });
  }

  /**
   * The gate is worth nothing if every case is unhealthy — an implication with a false antecedent is
   * true and says nothing. This is what stops that from happening silently: the corpus must hold both
   * kinds, and the keyspace case must be on the unhealthy side of the line by name.
   */
  test("the corpus holds both kinds, so the implication above is never vacuous", async () => {
    const verdicts: Record<string, boolean> = {};
    for (const [shape, source] of Object.entries(files)) {
      await writeFile(path, source, { mode: 0o600 });
      const result = await check();
      verdicts[shape] = result !== null && devSecretsHealthy(result);
    }

    expect(Object.values(verdicts).filter(Boolean).length).toBeGreaterThanOrEqual(4);
    expect(Object.values(verdicts).filter((healthy) => !healthy).length).toBeGreaterThanOrEqual(4);
    expect(verdicts["a keyspace given a single value"]).toBe(false);
  });

  /** And the report says which secret and why, rather than leaving the reader to run the seed to find out. */
  test("the keyspace is named, with the sentence the seed would have thrown", async () => {
    await writeFile(path, JSON.stringify({ CONNECTION_SIGNING_KEY: good }), { mode: 0o600 });
    const result = await check();

    expect(result?.malformed.map((one) => one.name)).toEqual(["CONNECTION_SIGNING_KEY"]);
    expect(describeDevSecrets(result as NonNullable<typeof result>).join("\n")).toContain(
      "is a keyspace, not a single value",
    );
  });
});
