// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StatePathOptions } from "../notifier/state";
import { bootstrapVarsPath, readBootstrapVars, removeBootstrapVars, writeBootstrapVars } from "./bootstrapVars";

let dir: string;
let config: string;

function paths(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-bootstrap-"));
  config = await mkdtemp(join(tmpdir(), "pithy-bootstrap-config-"));
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

describe("bootstrapVars", () => {
  test("it is dev.json's second tenant, not a second file beside it", async () => {
    // #131 already established `<config>/<project>/dev.json`. Inventing another location for "the
    // machine's dev values" would be a third convention for the same directory.
    expect(await bootstrapVarsPath(dir, paths())).toBe(join(config, "replay", "dev.json"));
  });

  test("a value written is a value read back", async () => {
    await writeBootstrapVars(dir, { SECRETS_ENCRYPTION_KEYS: "k" }, paths());
    expect(await readBootstrapVars(dir, paths())).toEqual({ SECRETS_ENCRYPTION_KEYS: "k" });
  });

  test("another tenant's key survives a write — the file is shared", async () => {
    // A dev-login preference sitting beside this set must not be deleted by a `pithy add secrets`.
    const path = join(config, "replay", "dev.json");
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ devLogin: { email: "me@example.com" } }));

    await writeBootstrapVars(dir, { K: "v" }, paths());

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      devLogin: { email: "me@example.com" },
      vars: { K: "v" },
    });
  });

  test("the file is 0600 and its directory 0700 — the dev master key is in it", async () => {
    await writeBootstrapVars(dir, { SECRETS_ENCRYPTION_KEYS: "k" }, paths());
    expect((await stat(join(config, "replay", "dev.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(config, "replay"))).mode & 0o777).toBe(0o700);
  });

  test("a file left world-readable by something else is narrowed on the next write", async () => {
    const path = join(config, "replay", "dev.json");
    await writeBootstrapVars(dir, { K: "v" }, paths());
    await chmod(path, 0o644);
    await writeBootstrapVars(dir, { K: "w" }, paths());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a present file that will not open refuses rather than being replaced", async () => {
    // Read-modify-write over a file with other tenants. `catch(() => ({}))` would silently delete a
    // developer's dev-login preference — the same shape that lost a `.dev.vars` twice.
    const path = join(config, "replay", "dev.json");
    await writeBootstrapVars(dir, { K: "v" }, paths());
    await chmod(path, 0o000);
    try {
      await expect(writeBootstrapVars(dir, { K: "w" }, paths())).rejects.toThrow(/could not read/);
    } finally {
      await chmod(path, 0o600);
    }
    expect(await readBootstrapVars(dir, paths())).toEqual({ K: "v" });
  });

  test("a write refuses a file that parsed to something that is not a document (#209)", async () => {
    // The read succeeded, which is why neither the errno gate nor `readOptionalFile` sees this. A hand
    // edit that wrapped `dev.json` in brackets leaves the dev-login preference and this module's own set
    // on disk — and `{}` as a merge base renames a document holding one key over both of them.
    const path = join(config, "replay", "dev.json");
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    const held = `${JSON.stringify([{ devLogin: { email: "me@example.com" }, vars: { K: "v" } }])}\n`;
    await writeFile(path, held, { mode: 0o600 });

    await expect(writeBootstrapVars(dir, { K: "w" }, paths())).rejects.toThrow(PithyError);

    // Byte for byte: the other tenant is still there, and so is every value this module had.
    expect(await readFile(path, "utf8")).toBe(held);
  });

  test("null, a string, a number and a boolean are each refused — a null check is not the rule", async () => {
    // `typeof null === "object"`, and comment-json boxes a top-level scalar, so neither a `null` check
    // nor a `typeof` closes this. Each of these parses, and each used to be an empty base to write from.
    const path = join(config, "replay", "dev.json");
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    for (const source of ["null", '"a-preference"', "12345", "true"]) {
      await writeFile(path, source, { mode: 0o600 });
      await expect(writeBootstrapVars(dir, { K: "w" }, paths()), source).rejects.toThrow(PithyError);
      await expect(removeBootstrapVars(dir, ["K"], paths()), source).rejects.toThrow(PithyError);
      expect(await readFile(path, "utf8"), source).toBe(source);
    }
  });

  /**
   * The two #209 left open, and the reason it left them (#219).
   *
   * Both were pinned by {@link readBootstrapVars}'s assertions below, which are right about the reader
   * and were being read as if they were about the file. They are not the same call: one hands a Worker
   * its bindings and rewrites nothing, the other merges into a file with another tenant in it and
   * renames the result. Absent is the only state that licenses starting from empty, **for a writer**.
   */
  test("a write refuses a file that will not parse, rather than replacing the tenant beside it", async () => {
    // The likelier hand edit by far: a stray brace after someone opened the file to look at it.
    const path = join(config, "replay", "dev.json");
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    const held = `{ not json\n${JSON.stringify({ devLogin: { email: "me@example.com" }, vars: { K: "v" } }, null, 2)}\n`;
    await writeFile(path, held, { mode: 0o600 });

    await expect(writeBootstrapVars(dir, { K: "w" }, paths())).rejects.toThrow(PithyError);
    await expect(removeBootstrapVars(dir, ["K"], paths())).rejects.toThrow(PithyError);

    // Byte for byte: the dev-login preference and every value this module had are still recoverable.
    expect(await readFile(path, "utf8")).toBe(held);
  });

  test("nor does that refusal carry a line of the file — the parser's own message quotes it", async () => {
    const path = join(config, "replay", "dev.json");
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(path, '{ "vars": { "SECRETS_ENCRYPTION_KEYS": "a-dev-master-key" }', { mode: 0o600 });

    const error = await writeBootstrapVars(dir, { K: "w" }, paths()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    const whole = `${payload.message} ${payload.action ?? ""} ${payload.detail ?? ""}`;
    expect(whole).toContain(path);
    expect(whole).not.toContain("a-dev-master-key");
  });

  test("a write refuses a record that is not this document either, and keeps every key in it", async () => {
    const path = join(config, "replay", "dev.json");
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    const held = `${JSON.stringify({ devLogin: { email: "me@example.com" }, vars: { K: 7 } }, null, 2)}\n`;
    await writeFile(path, held, { mode: 0o600 });

    await expect(writeBootstrapVars(dir, { K: "w" }, paths())).rejects.toThrow(PithyError);
    await expect(removeBootstrapVars(dir, ["K"], paths())).rejects.toThrow(PithyError);

    expect(await readFile(path, "utf8")).toBe(held);
  });

  test("and says where it broke, without saying what was there", async () => {
    const path = join(config, "replay", "dev.json");
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ vars: { SECRETS_ENCRYPTION_KEYS: 7, OTHER: "a-dev-master-key" } }), {
      mode: 0o600,
    });

    const error = await writeBootstrapVars(dir, { K: "w" }, paths()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    const whole = `${payload.message} ${payload.action ?? ""} ${payload.detail ?? ""}`;
    expect(whole).toContain(path);
    expect(whole).toContain("vars.SECRETS_ENCRYPTION_KEYS");
    expect(whole).not.toContain("a-dev-master-key");
  });

  test("the refusal names the file and what it found, and never what was in it", async () => {
    const path = join(config, "replay", "dev.json");
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(path, '"a-dev-master-key"', { mode: 0o600 });

    const error = await writeBootstrapVars(dir, { K: "w" }, paths()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    const whole = `${payload.message} ${payload.action ?? ""} ${payload.detail ?? ""}`;
    expect(whole).toContain(path);
    expect(whole).toContain("a string");
    expect(whole).not.toContain("a-dev-master-key");
  });

  test("the reader still answers empty for it — it rewrites nothing, and pithy dev must start", async () => {
    // The asymmetry `readBootstrapVars` argues at length, held to. The refusal belongs to the two calls
    // that merge into a file and rename the result, not to the one that hands a Worker its bindings.
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(join(config, "replay", "dev.json"), '"a-preference"');
    expect(await readBootstrapVars(dir, paths())).toEqual({});
  });

  test("a hand-edited file that will not parse reads as empty rather than stopping pithy dev", async () => {
    // The reader is not about to rewrite anything, so "absent" licenses nothing here. A half-typed
    // preference must not stop every Worker from starting; the Worker's own missing-binding error is the
    // louder, more accurate message anyway.
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(join(config, "replay", "dev.json"), "{ not json");
    expect(await readBootstrapVars(dir, paths())).toEqual({});
  });

  test("a non-string value is not carried into a binding", async () => {
    // It would reach the encoder as an object and be written as `[object Object]`.
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(join(config, "replay", "dev.json"), JSON.stringify({ vars: { K: 7 } }));
    expect(await readBootstrapVars(dir, paths())).toEqual({});
  });

  test("removal takes the name out, and a name that is not there is a no-op", async () => {
    await writeBootstrapVars(dir, { KEEP: "1", GO: "2" }, paths());
    expect(await removeBootstrapVars(dir, ["GO", "NEVER_THERE"], paths())).toEqual({ KEEP: "1" });
    expect(await readBootstrapVars(dir, paths())).toEqual({ KEEP: "1" });
  });

  test("a project with no name has nothing to key on and writes nothing", async () => {
    await rm(join(dir, "pithy.config.ts"));
    expect(await bootstrapVarsPath(dir, paths())).toBeNull();
    expect(await writeBootstrapVars(dir, { K: "v" }, paths())).toEqual({});
    expect(await readBootstrapVars(dir, paths())).toEqual({});
  });

  test("writing nothing creates no file", async () => {
    await writeBootstrapVars(dir, {}, paths());
    await expect(stat(join(config, "replay", "dev.json"))).rejects.toThrow();
  });
});

/**
 * **A write of nothing has a reader's power, and reads like one (#222).**
 *
 * The split in this module is by *power*, not by file: the refusal exists because a merge into an
 * invented `{}` gets renamed over a file with another tenant in it. A call that writes nothing performs
 * no merge and no rename, so there is nothing for the refusal to protect — and it was still refusing,
 * because the early return sat *after* the merge-base read.
 *
 * Where that is reached is the argument. `writeDevVars({ values: {} })` is the turnstile teardown's
 * regeneration (`../capabilities/turnstileProvisioner.ts`), and refusing there turns a regeneration into
 * a failure over a file the run was never going to touch — the same shape as a `doctor` that will not run
 * in the environment it exists to diagnose. So the early return moves ahead of the read, and the set it
 * answers is {@link readBootstrapVars}'s: the read this module already argues at length is the right one
 * for a caller that rewrites nothing. Not a third policy — the reporting read, reached by the call that
 * turns out to be a report.
 *
 * **`removeBootstrapVars` is the other half of the same rule, and it comes out differently.** The early
 * return goes before the read exactly when the *caller's own arguments* settle it. `writeBootstrapVars`
 * knows from `{}` that it will write nothing. A removal of names that are not there only learns that
 * *from the file* — and a file nothing could read establishes nothing, least of all "that name is not in
 * it". Its no-op is a claim about contents, so it keeps the strict read and keeps refusing; the one case
 * it does know in advance, an empty list of names, returns before the read like its sibling.
 */
describe("a write that writes nothing (#222)", () => {
  /** A `dev.json` no read can make sense of, with a second tenant's key still recoverable from it. */
  async function broken(): Promise<string> {
    const path = join(config, "replay", "dev.json");
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    const held = `{ not json\n${JSON.stringify({ devLogin: { email: "me@example.com" }, vars: { K: "v" } })}\n`;
    await writeFile(path, held, { mode: 0o600 });
    return held;
  }

  test("writing nothing does not read the file, so it cannot refuse over one it will not touch", async () => {
    const held = await broken();
    expect(await writeBootstrapVars(dir, {}, paths())).toEqual({});
    expect(await readFile(join(config, "replay", "dev.json"), "utf8")).toBe(held);
  });

  test("and it still answers the set that is there, so a regeneration keeps its bindings", async () => {
    await writeBootstrapVars(dir, { K: "v" }, paths());
    expect(await writeBootstrapVars(dir, {}, paths())).toEqual({ K: "v" });
  });

  test("removing no names does not read it either", async () => {
    const held = await broken();
    expect(await removeBootstrapVars(dir, [], paths())).toEqual({});
    expect(await readFile(join(config, "replay", "dev.json"), "utf8")).toBe(held);
  });

  test("but a removal that has to consult the file refuses, even for a name that is not in it", async () => {
    // The no-op here is a claim about what the file holds, and a file nothing read supports no claim.
    const held = await broken();
    await expect(removeBootstrapVars(dir, ["NEVER_THERE"], paths())).rejects.toThrow(PithyError);
    expect(await readFile(join(config, "replay", "dev.json"), "utf8")).toBe(held);
  });

  test("a write with values in it refuses exactly as it did — the power is the whole difference", async () => {
    const held = await broken();
    await expect(writeBootstrapVars(dir, { K: "w" }, paths())).rejects.toThrow(PithyError);
    expect(await readFile(join(config, "replay", "dev.json"), "utf8")).toBe(held);
  });
});
