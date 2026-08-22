// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { readSource, sourcePaths } from "../ci/sourceFiles";
import { type MergeBase, readFileOutcome, readMergeBase, readOptionalFile, requireRecord } from "./readOptionalFile";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-read-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readOptionalFile", () => {
  test("a file that is there comes back as its bytes", async () => {
    const path = join(dir, "present.txt");
    await writeFile(path, "KEY=value\n");
    expect(await readOptionalFile(path)).toBe("KEY=value\n");
  });

  test("a file that is not there is null — that is what ENOENT means", async () => {
    expect(await readOptionalFile(join(dir, "never-written.txt"))).toBeNull();
  });

  test("a file that is there and will not open is a refusal, never null", async () => {
    // A directory where the file should be. Every uid gets EISDIR from `readFile`, so this says the same
    // thing on a laptop and in a container running as root — unlike a chmod, which root ignores.
    const path = join(dir, "unreadable.txt");
    await mkdir(path);

    const thrown = (await readOptionalFile(path).catch((error: unknown) => error)) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    // The path, so the operator knows which file. The errno, so they know what to fix.
    expect(thrown.payload.message).toContain(path);
    expect(thrown.payload.detail).toContain("EISDIR");
    // The node error is kept, so a caller that classifies further still can.
    expect((thrown.cause as { code?: string } | undefined)?.code).toBe("EISDIR");
  });

  test("the refusal carries no byte of the file it could not read", async () => {
    // The files this exists for hold credentials. A failure that quotes them is the leak the read avoided.
    const path = join(dir, "secret.txt");
    await writeFile(path, "CLOUDFLARE_API_TOKEN=super-secret-value\n", { mode: 0o600 });
    await chmod(path, 0o000);

    const thrown = await readOptionalFile(path).catch((error: unknown) => error);
    if (thrown === undefined) return; // root reads a 0o000 file; there is nothing to assert on this box.
    expect(JSON.stringify((thrown as PithyError).payload)).not.toContain("super-secret-value");
  });

  test("a call site may write its own refusal, and is handed the path and the errno", async () => {
    const path = join(dir, "unreadable.txt");
    await mkdir(path);

    const thrown = (await readOptionalFile(path, {
      unreadable: ({ code, cause }) =>
        new ConflictError(
          {
            message: `Cannot update ${path}: Pithy could not read what is already in it.`,
            action: "Fix the file's permissions, or move it aside, and run the command again.",
            detail: `${code ?? "unknown error"} while reading ${path}`,
          },
          { cause },
        ),
    }).catch((error: unknown) => error)) as ConflictError;

    expect(thrown).toBeInstanceOf(ConflictError);
    expect(thrown.payload.message).toContain("could not read what is already in it");
    expect(thrown.payload.detail).toContain("EISDIR");
    expect((thrown.cause as { code?: string } | undefined)?.code).toBe("EISDIR");
  });

  test("the refusal is not asked for when the file is simply absent", async () => {
    let asked = false;
    const value = await readOptionalFile(join(dir, "never-written.txt"), {
      unreadable: () => {
        asked = true;
        return new ConflictError({ message: "no", action: "no" });
      },
    });
    expect(value).toBeNull();
    expect(asked).toBe(false);
  });
});

describe("readFileOutcome", () => {
  test("three answers, and the two that are not the file are different answers", async () => {
    const present = join(dir, "present.txt");
    await writeFile(present, "text");
    const unreadable = join(dir, "unreadable.txt");
    await mkdir(unreadable);

    expect(await readFileOutcome(present)).toEqual({ state: "read", text: "text" });
    expect(await readFileOutcome(join(dir, "gone.txt"))).toEqual({ state: "absent" });

    const read = await readFileOutcome(unreadable);
    expect(read.state).toBe("unreadable");
    if (read.state !== "unreadable") return;
    expect(read.code).toBe("EISDIR");
    expect((read.cause as { code?: string } | undefined)?.code).toBe("EISDIR");
  });

  test("nothing is thrown, so a caller that must answer for the rest still can", async () => {
    // `availableManifests` reads sixteen packages and must report the broken one without losing the
    // other fifteen. A read that threw would take the listing with it.
    await expect(readFileOutcome(join(dir, "gone.txt"))).resolves.toBeDefined();
  });
});

/**
 * The second half of the same sentence: a read that **succeeded** and produced something that is not a
 * document. Three readers decided independently that such a value was an empty base to write from —
 * `pithy.worker.jsonc` (#204), `tokens.json` and `dev.json` (#209) — which is this repository's count for
 * a rule that belongs at the thing being called.
 */
describe("requireRecord", () => {
  const path = "/config/pithy/replay/tokens.json";

  test("a record is handed straight back", () => {
    const document = { dev: { CF_TOKEN: "v" } };
    expect(requireRecord(path, document)).toBe(document);
  });

  test("null, a string, a number and a boolean are each refused — a null check alone is not the rule", () => {
    // `typeof null === "object"` is the first half of why. Each of these is what a hand-edited credential
    // file has parsed to at least once, and every one of them used to be an empty base to write from.
    for (const value of [null, "react", 12345, true, false, []]) {
      expect(() => requireRecord(path, value), JSON.stringify(value)).toThrow(PithyError);
    }
  });

  test("a top-level scalar boxed by comment-json is refused — the second half of why", () => {
    // `parse('"react"')` is a `String` *object*, so it has somewhere to hang the file's comments. It
    // passes `typeof x === "object"` and it is not `null`, which is exactly the gap the tag closes.
    const boxed = parse('"react"');
    expect(typeof boxed).toBe("object");
    expect(boxed).not.toBeNull();
    expect(() => requireRecord(path, boxed)).toThrow(PithyError);
    expect(() => requireRecord(path, parse("42"))).toThrow(PithyError);
    expect(() => requireRecord(path, parse("true"))).toThrow(PithyError);
  });

  test("the refusal names the path and the shape, and never a byte of the value", () => {
    const thrown = (() => {
      try {
        requireRecord(path, "CLOUDFLARE_API_TOKEN=super-secret-value");
      } catch (error) {
        return error as PithyError;
      }
      return null;
    })();

    expect(thrown).toBeInstanceOf(PithyError);
    const payload = (thrown as PithyError).payload;
    const whole = `${payload.message} ${payload.action ?? ""} ${payload.detail ?? ""}`;
    expect(whole).toContain(path);
    expect(whole).toContain("a string");
    expect(whole).not.toContain("super-secret-value");
  });

  test("a call site may write its own refusal, and is handed the shape in words", () => {
    const thrown = (() => {
      try {
        requireRecord(path, [1, 2], {
          notARecord: ({ found }) =>
            new ConflictError({ message: `Cannot update ${path}: it holds ${found}.`, action: "Fix it." }),
        });
      } catch (error) {
        return error as ConflictError;
      }
      return null;
    })();

    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as ConflictError).payload.message).toContain("it holds an array");
  });
});

/**
 * The whole sentence, for the read whose answer is about to be written back (#219).
 *
 * `readOptionalFile` closes "the file would not open" and `requireRecord` closes "it opened and is not a
 * document". Two doors were left: a file that will not **parse**, and a record that fails its **schema**.
 * Both answered `{}`, both were merged into and renamed over — and both were pinned by reader assertions
 * that are correct about the reader and were being read as if they were about the file.
 *
 * So the split is a type. A reader may still answer `{}`; only this can answer a {@link MergeBase}, and
 * every writer takes one.
 */
describe("readMergeBase", () => {
  /** A document with one required tenant, so "fails its schema" is a thing this fixture can be. */
  const Doc = z
    .record(
      z.string().describe("An environment name."),
      z.record(z.string().describe("A variable name."), z.string().describe("Its value.")).describe("One environment."),
    )
    .describe("A document keyed by environment, standing in for `tokens.json` and `dev.json` alike.");

  test("a file that is not there is the empty document, and the path travels with it", async () => {
    const path = join(dir, "absent.json");
    expect(await readMergeBase(path, Doc)).toEqual({ path, document: {} });
  });

  test("a file that is there is exactly what is in it", async () => {
    const path = join(dir, "present.json");
    await writeFile(path, JSON.stringify({ dev: { CF_TOKEN: "v" } }));
    expect(await readMergeBase(path, Doc)).toEqual({ path, document: { dev: { CF_TOKEN: "v" } } });
  });

  test("a file that will not parse is a refusal — the likelier of the two hand edits", async () => {
    // A stray brace after someone opened the file is ordinary; a file that parses to a bare array is not.
    // #209 closed the exotic one and left this, where `{}` was merged into and renamed over everything.
    const path = join(dir, "broken.json");
    await writeFile(path, "{ not json");
    await expect(readMergeBase(path, Doc)).rejects.toThrow(PithyError);
  });

  test("and that refusal carries no line of the file, because the parser's own message would", async () => {
    // `JSON.parse` quotes what it choked on: `Unexpected token 'n', "{ not json" is not valid JSON`.
    // Every file this was written for is credentials, so node's error is dropped rather than carried.
    const path = join(dir, "secret.json");
    await writeFile(path, '{ "dev": { "CF_TOKEN": "super-secret-value" }');

    const thrown = (await readMergeBase(path, Doc).catch((error: unknown) => error)) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    expect(JSON.stringify(thrown.payload)).toContain(path);
    expect(JSON.stringify(thrown.payload)).not.toContain("super-secret-value");
  });

  test("a record that fails its schema is a refusal too, named by key path and never by value", async () => {
    const path = join(dir, "invalid.json");
    await writeFile(path, JSON.stringify({ dev: { CF_TOKEN: 12345 }, staging: "super-secret-value" }));

    const thrown = (await readMergeBase(path, Doc).catch((error: unknown) => error)) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    const whole = JSON.stringify(thrown.payload);
    expect(whole).toContain("dev.CF_TOKEN");
    expect(whole).not.toContain("super-secret-value");
  });

  test("so are the two the primitives beneath it already refused", async () => {
    const notARecord = join(dir, "array.json");
    await writeFile(notARecord, JSON.stringify([{ dev: {} }]));
    await expect(readMergeBase(notARecord, Doc)).rejects.toThrow(PithyError);

    const unreadable = join(dir, "unreadable.json");
    await mkdir(unreadable);
    await expect(readMergeBase(unreadable, Doc)).rejects.toThrow(PithyError);
  });

  test("each of the four is a call site's own sentence, in its own error class", async () => {
    const words = (message: string) => () => new ConflictError({ message, action: "Fix it." });
    const options = {
      unreadable: words("unreadable"),
      unparseable: words("unparseable"),
      notARecord: words("not a record"),
      invalid: words("invalid"),
    };
    const said = async (name: string, contents: string | null): Promise<string> => {
      const path = join(dir, name);
      if (contents === null) await mkdir(path);
      else await writeFile(path, contents);
      const thrown = (await readMergeBase(path, Doc, options).catch((error: unknown) => error)) as ConflictError;
      expect(thrown).toBeInstanceOf(ConflictError);
      return thrown.payload.message;
    };

    expect(await said("a.json", null)).toBe("unreadable");
    expect(await said("b.json", "{ not json")).toBe("unparseable");
    expect(await said("c.json", "[]")).toBe("not a record");
    expect(await said("d.json", JSON.stringify({ dev: { K: 1 } }))).toBe("invalid");
  });

  /**
   * The one thing about a file that is neither a refusal nor the schema: how its bytes become a value.
   *
   * `pithy.worker.jsonc` is JSONC, and `JSON.parse` refuses a file with a comment in it — which for that
   * manifest is not a malformed file, it is the ordinary one (#222). That is a property of the file, not
   * a decision about what a failure means, so it is the caller's to supply and nothing else moves with
   * it: the four refusals are the same four, and the parser's own error is dropped the same way.
   *
   * **Whether the parsed object itself survives is the schema's business, not this seam's** — an object
   * schema rebuilds what it validates, and comment-json hangs the file's notes off the object as
   * symbol-keyed properties. `../ui/workerUi.ts` is where that is decided and where it is asserted.
   */
  test("a caller may bring its own parser, and the four refusals are unchanged by it", async () => {
    const jsonc = { parse: (source: string) => parse(source) };
    const path = join(dir, "manifest.jsonc");
    await writeFile(path, '{\n  // a note\n  "dev": { "autostart": "yes" }\n}\n');

    // The default parser cannot read this file at all, which is the whole reason the seam exists.
    await expect(readMergeBase(path, Doc)).rejects.toThrow(PithyError);
    expect((await readMergeBase(path, Doc, jsonc)).document).toEqual({ dev: { autostart: "yes" } });

    await writeFile(path, "{ not json");
    await expect(readMergeBase(path, Doc, jsonc)).rejects.toThrow(PithyError);
  });

  test("and the borrowed parser's own error is dropped exactly as JSON.parse's is", async () => {
    // comment-json quotes the line it choked on too. The seam is which parser, never which leak.
    const path = join(dir, "manifest.jsonc");
    await writeFile(path, '{ "dev": { "CF_TOKEN": "super-secret-value" }');

    const thrown = (await readMergeBase(path, Doc, { parse: (source: string) => parse(source) }).catch(
      (error: unknown) => error,
    )) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    expect(JSON.stringify(thrown.payload)).not.toContain("super-secret-value");
  });

  test("a schema that cannot read `{}` as a document says so rather than inventing one", async () => {
    // Absent licenses starting from empty, and what "empty" is belongs to the schema, not to this module.
    const closed = z.object({ required: z.string().describe("A key with no default.") }).catchall(z.unknown());
    await expect(readMergeBase(join(dir, "absent.json"), closed)).rejects.toThrow(PithyError);
  });

  /**
   * **The constraint that matters, and the reason this is a type.**
   *
   * All five instances happened the same way: a call site picked the lenient read of two, and nothing
   * said so until a file had been replaced. A rule in a docstring is what those five had.
   */
  test("a lenient read's document cannot reach a merge — the accident is a compile error", async () => {
    const path = join(dir, "tokens.json");
    await writeFile(path, JSON.stringify({ dev: { CF_TOKEN: "v" } }));
    // What a writer does: it takes the base, never a bare document, and it writes back to `base.path`.
    const merge = (base: MergeBase<Record<string, unknown>>): Record<string, unknown> => ({
      ...base.document,
      staging: {},
    });

    expect(merge(await readMergeBase(path, Doc))).toEqual({ dev: { CF_TOKEN: "v" }, staging: {} });

    // And what a reader answers, which is `{}` for a file nothing can be made of — correct for a reader,
    // and the empty base that cost four files when a writer got hold of it.
    const reported: Record<string, unknown> = {};
    // @ts-expect-error a document that did not come from readMergeBase is not a merge base
    merge(reported);
  });
});

/**
 * The gate — **two rules over one walk**, because the defect has two spellings.
 *
 * 1. **Only `readOptionalFile.ts` may name `ENOENT` where a file's contents were read.** No allowlist,
 *    no judgment about which modules write, no per-entry reasoning: a hand-written errno branch on a
 *    read is a copy of the primitive, and there is exactly one place that decision is allowed to live.
 * 2. **A module that puts bytes on disk must not read a file and discard the failure.** The shape that
 *    names no errno at all — `.catch(() => null)` — which rule 1 cannot see and which is *shorter* than
 *    the correct version, so it is the thing that gets typed.
 *
 * Rule 1 landed with #197, once the six readers that still spelled the branch out by hand
 * (`devSecrets/file.ts`, `project/devVars.ts`, `platform/rc.ts`, `feature/manifest.ts`,
 * `feature/ports.ts`, `seed/media.ts`) were routed through the primitive. All six were *correct*; they
 * were six copies of one sentence, and a copy is what a seventh author reads instead of the original.
 * Both call-site errors and both call-site error *classes* survived the routing — that is what
 * `options.unreadable` and `readFileOutcome` are for.
 *
 * **What rule 1 is scoped to, and why it is not scoped tighter or looser.** Not "no module but this one
 * may contain the string `ENOENT`": `atomic.ts` maps the errno of a *write* onto a message, and
 * `scaffold.ts`'s `probe` keeps the same three answers about a path's *existence* — both are the rule
 * applied, not evaded, and exempting them by name would put an allowlist back. Scoping to the handler
 * that receives a content read draws that line structurally instead. It is not scoped to writing
 * modules either, which is the axis rule 2 could never reach: `capabilities/manifests.ts`, the third
 * producer, writes nothing, and its defect was a capability vanishing from `pithy add --list`.
 *
 * **Why rule 2 stays, and why its two lists stay with it.** Rule 1 does not subsume it. A module can
 * still answer "no file" for every failure without typing an errno, and that is precisely the form the
 * first three defects took. The invariant everyone would rather state — *no module reads a file with a
 * catch that discards the error* — is still not shippable: this tree has 32 of them, and a 32-entry
 * allowlist is a muted tripwire with extra steps. Some are correct and permanent: the `doctor` surface
 * throws six read failures away on purpose, because a diagnostic has to work in the broken environment
 * it exists to diagnose, and it writes nothing. That is the distinction rule 2's scope draws
 * structurally rather than by judgment — **reading a file you are about to act on, against reading one
 * to report on.** A module that cannot write cannot destroy what it failed to read. So the two lists
 * below belong to rule 2 alone; rule 1 has none and must never grow one.
 *
 * **It is a scan over source text, with the limits `atomic.test.ts` records**: TypeScript 7 ships no
 * parser API, so there is no AST to walk. It reads import clauses — so an alias, a namespace binding, a
 * `require` and a dynamic `import` all count — and then brace-matches the `catch` that would receive the
 * failure. **What it cannot see is a read behind a wrapper.** A module calling `readWranglerConfig` is
 * reading a file; this scan knows the leaf calls that hand bytes back, and nothing about who wraps them.
 *
 * That limit is now a measurement rather than a sentence (#204). Seventy-four exported functions across
 * sixty modules perform a content read, and forty modules call one — so "a read behind a wrapper" is the
 * ordinary case in this tree, not the exception. The population that takes either rule's *shape*, though,
 * is nine call sites: nine handlers that discard a wrapped read's failure, eight of them reads of a
 * `wrangler.jsonc`. Seven are the read-only `doctor`, `deploy` and inventory surfaces rule 2 is scoped
 * away from on purpose. The two that both discard and write are in `capabilities/reconcile.ts`, already
 * on the list below for its own `readFile`. Rule 1 has none: `project/envInventory.ts` was the one, and
 * `readWranglerConfig` goes through the primitive now, so the branch it spelled out by hand is gone.
 *
 * **So the gate is not extended to recognize wrappers, and that is a decision rather than an omission.**
 * Doing it means a second pass resolving every local import to the function it names and asking whether
 * that function reads — writable, but a whole-tree symbol resolution living inside a test, and what it
 * would have found is one site that was already correct and one module already declared. What the survey
 * buys instead is the number. If it moves — if writing modules discarding a wrapped read stop being one
 * file's two lines — the answer changes, and re-running the survey is how that gets noticed.
 *
 * **The walk is `ci/sourceFiles.ts`**, the one the rename, follower, recursive-delete, editor and
 * runtime-export tripwires already read this tree through (#185). A seventh traversal to enforce a rule
 * about not repeating yourself would be its own joke.
 */
describe("only readOptionalFile.ts decides what a failed read means", () => {
  /** `packages/` — this file lives at `packages/cli/src/project/`. Asserted below, so a move fails loudly. */
  const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  /** A module's key in the map below: its path under `packages/`, in posix separators. */
  const named = (path: string): string => relative(PACKAGES, path).split(sep).join("/");

  /**
   * **Rule 2's list, and rule 2's alone.** The reads that discard the failure and stay: path → what it
   * reads, and why the discard is safe there.
   *
   * It survived #197 because rule 1 has nothing to say about any line in it. Not one of these modules
   * names an errno — that is the whole shape: `.catch(() => null)` decides that every failure is an
   * absence without ever writing down which one it means. Rule 1 reads what a handler says; these say
   * nothing, and a rule about a string cannot see a silence. So the list is re-earned rather than
   * carried: each entry is an argument that this particular silence costs nothing.
   *
   * An entry is a claim, and the test holds it to both halves — an undeclared discard fails, and a
   * declared one that has since been fixed or moved fails too, so the list cannot go stale. Adding a line
   * is the reviewable act; that is the whole point of it.
   *
   * The question every `why` has to answer is the one the three defects failed: **what does this write
   * over, having decided the file it could not read was not there?** An answer of "nothing" is what makes
   * a discard safe. Anything else belongs in {@link readOptionalFile}.
   */
  const DISCARDS_ON_PURPOSE: Record<string, { reads: string; why: string }> = {
    "cli/src/devSecrets/bootstrapVars.ts": {
      reads: "readFile",
      why: "`readBootstrapVars` argues it at length, and the argument is about that call rather than about the file (#219): every failure is an empty set because nothing is rewritten from this read — the result is merged into a file regenerated wholesale — and a `dev.json` half-typed by hand must not stop `pithy dev`. The two writers beside it read their own base through `readMergeBase`, which refuses in every state but absence, and they take a `MergeBase` so this lenient answer cannot be handed to them by accident. The split is by *power*, not by file, which is why both writers now return through this read when their own arguments say they will write nothing (#222) — an empty `values`, an empty `names` — rather than refusing over a file they were never going to touch.",
    },
    "cli/src/cloudflare/config.ts": {
      reads: "readFileSync",
      why: "`readCloudflareConfigSync` hands its answer to a Cloudflare client and rewrites nothing, so a `cloudflare.json` that will not open costs a set of credentials and is reported by `pithy doctor` as `Cloudflare: unconfigured` — every command in the CLI resolves these, and refusing them all over one permission bit would break the command that fixes it. `writeCloudflareConfig` does its own read through `readOptionalFile` and refuses, because it is the one that could destroy what it could not read.",
    },
    "cli/src/devSecrets/edit.ts": {
      reads: "readFile",
      why: "`readDraft` asks what the editor left behind. A draft it cannot read abandons the edit, which writes nothing: the draft stays where the message says it is, and the secrets file is untouched. The discard prevents a write rather than licensing one.",
    },
    "cli/src/dev/state.ts": {
      reads: "readFile, readFileSync",
      why: "`.dev-state.json` is this run's own disposable artifact and this run overwrites it regardless, so an unreadable one is genuinely 'no previous session'. The sync teardown unlinks only a file that names our own pid, and a read that failed names nothing.",
    },
    "cli/src/project/askDomains.ts": {
      reads: "readFile",
      why: "A `pithy.config.ts` it cannot read is one it declines to edit: it answers false, and the caller prints the declaration for the adopter to paste. Editing a config blind is exactly what the false is there to prevent.",
    },
    "cli/src/project/workerCommand.ts": {
      reads: "readFile",
      why: "`renamePackage` returns without writing. A worker with no readable `package.json` keeps the name it had — the rename is skipped, never rebuilt from an empty document, and a process in the dev set may have no package at all.",
    },
    "cli/src/seed/prepare.ts": {
      reads: "readFile",
      why: "Dev preferences are hand-edited and nothing is rewritten from them: absent and unparseable both mean 'seed nothing extra'. A half-typed preference failing a whole seed run would be the worse answer, and the set rejects a file that parses and says the wrong thing.",
    },
    "cli/src/ui/wire.ts": {
      reads: "readFile",
      why: "`wireSolution` extends, never creates. No readable `tsconfig.json` means no references are added and nothing is written — inventing a solution file for a project that predates it would break that adopter's typecheck.",
    },
    "cli/src/capabilities/reconcile.ts": {
      reads: "readFile, readOptionalFile",
      why: "A config it cannot read yields no located registration, so no drift is reported and nothing is written from it. An entry it cannot read is the same trade one file over: no Durable Object export drift is established, where naming every class the Worker binds would be a guess. The cost is a report that under-reports for that Worker, and `doctor` reads the same files again.",
    },
  };

  /**
   * The discards that predate rule 2 and are **not** blessed by it: path → what it reads, and what the
   * discard costs when the file is there and will not open.
   *
   * A debt inventory, not an allowlist — the distinction being that every line here is meant to leave.
   * Every one was written before the primitive existed, none has been reviewed against it, and each
   * `costs` is the sentence that says why it is worth an issue. Rule 1 sees none of them for the reason
   * above: they name no errno, they simply answer "no file" for everything.
   *
   * The count below is a ratchet: it falls as these are routed through `readOptionalFile`, and a change
   * that raises it is a change adding a fourth instance of the defect this file exists to end.
   */
  const NOT_YET_ROUTED: Record<string, { reads: string; costs: string }> = {
    "cli/src/capabilities/remove.ts": {
      reads: "readFile",
      costs:
        "A sibling Worker's `pithy.config.ts` that will not open reads as 'does not import the package', so the guard on uninstalling a project-wide dependency never fires and that Worker's config stops loading — the failure mode its own comment calls the dangerous one.",
    },
    "cli/src/capabilities/eject.ts": {
      reads: "readFile",
      costs:
        "An unreadable config answers 'nothing is ejected here', which is what `remove.ts` gates a delete on and what `reconcile` reports drift from. Absence and unreadable are the two this module cannot tell apart.",
    },
    "cli/src/notifier/state.ts": {
      reads: "readFile",
      costs:
        'An unreadable state file becomes the default state, and the next `writeState` renames that over it. A hand-edited `"notifier": false` — which the docstring promises is honored — would be silently undone.',
    },
    "cli/src/feature/devConfig.ts": {
      reads: "readFile",
      costs:
        "A worktree whose `.dev.config.json` will not open drops out of the pinned-block scan, so `pithy feature create` can hand a new branch a port block another worktree is already running on.",
    },
  };

  /** Anything that puts bytes on disk. A module importing one of these is a module that writes. */
  const WRITES = new Set([
    "appendFile",
    "appendFileSync",
    "chmod",
    "chmodSync",
    "copyFile",
    "copyFileSync",
    "cp",
    "cpSync",
    "link",
    "linkSync",
    "mkdir",
    "mkdirSync",
    "rename",
    "renameSync",
    "rm",
    "rmdir",
    "rmdirSync",
    "rmSync",
    "symlink",
    "symlinkSync",
    "truncate",
    "truncateSync",
    "unlink",
    "unlinkSync",
    "writeFile",
    "writeFileSync",
  ]);

  /** This package's own writers. A module reaching one of these puts bytes on disk just as surely. */
  const LOCAL_WRITES = new Set(["removeScaffoldPath", "scaffoldFiles", "writeFileAtomic"]);

  /** The reads this rule is about: the calls that hand back a file's contents. */
  const READS = new Set(["readFile", "readFileSync", "readOptionalFile", "readFileOutcome"]);

  /**
   * Comments blanked, length preserved, so prose about a `catch` is never read as one and every index
   * below still points at the same character of the original.
   *
   * The shared walk (#439). Excluding a `//` preceded by a colon or a quote dodged the URL in a string
   * and left the other hole open: an unbalanced `/*` inside a glob opens a block that runs to the next
   * `*\/` in the file, blanking every read and write between the two.
   */
  const stripComments = blankComments;

  /** String and template bodies blanked, so a brace inside one cannot end a block early. */
  function blankStrings(text: string): string {
    return text.replace(
      /(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g,
      (quoted) => quoted[0] + quoted.slice(1, -1).replace(/[^\n]/g, " ") + quoted[0],
    );
  }

  /** Every `import … from "…"` in a module: the specifier, and the clause before it. */
  function imports(source: string): { specifier: string; clause: string }[] {
    return [...source.matchAll(/\bimport\s+(?:type\s+)?([^;"']*?)\s*from\s*["']([^"']+)["']/g)].map((statement) => ({
      specifier: statement[2] ?? "",
      clause: (statement[1] ?? "").trim(),
    }));
  }

  /** The names a clause binds, each resolved to its local name — `readFile as rf` binds `rf`. */
  function bound(clause: string): { exported: string; local: string }[] {
    if (!clause.startsWith("{")) return [];
    return clause
      .slice(1, -1)
      .split(",")
      .map((binding) => binding.trim().replace(/^type\s+/, ""))
      .filter((binding) => binding.length > 0)
      .map((binding) => {
        const [exported, alias] = binding.split(/\s+as\s+/).map((part) => part.trim());
        return { exported: exported ?? "", local: alias ?? exported ?? "" };
      });
  }

  /** Whether a module puts bytes on disk — through `node:fs`, or through one of this package's writers. */
  function writes(source: string): boolean {
    for (const { specifier, clause } of imports(source)) {
      const names = bound(clause).map(({ exported }) => exported);
      if (/^(?:node:)?fs(?:\/promises)?$/.test(specifier)) {
        // A namespace or default binding carries the whole module, writers included.
        if (!clause.startsWith("{")) return true;
        if (names.some((name) => WRITES.has(name))) return true;
      }
      if (specifier.startsWith(".") && names.some((name) => LOCAL_WRITES.has(name))) return true;
    }
    return /\b(?:require|import)\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/.test(source);
  }

  /**
   * The local names in this module that read a file's contents, or `*` when it took the whole `fs`
   * namespace and any member call could be one.
   */
  function readers(source: string): Set<string> {
    const names = new Set<string>();
    for (const { specifier, clause } of imports(source)) {
      const fs = /^(?:node:)?fs(?:\/promises)?$/.test(specifier);
      if (fs && !clause.startsWith("{")) names.add("*");
      const local = specifier.startsWith(".") || fs;
      if (!local) continue;
      for (const { exported, local: name } of bound(clause)) if (READS.has(exported)) names.add(name);
    }
    if (/\b(?:require|import)\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/.test(source)) names.add("*");
    return names;
  }

  /** The index of the bracket closing the one at `open`, or the end of the text. */
  function closing(text: string, open: number, pair: "()" | "{}"): number {
    let depth = 0;
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === pair[0]) depth += 1;
      else if (text[index] === pair[1]) {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return text.length - 1;
  }

  /** Every `try` block in a module, with the span of the `catch` clause body that receives its failure. */
  function tryBlocks(text: string): { start: number; end: number; handler: [number, number] | null }[] {
    return [...text.matchAll(/\btry\s*\{/g)].map((match) => {
      const open = match.index + match[0].length - 1;
      const end = closing(text, open, "{}");
      const clause = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(text.slice(end + 1));
      if (clause === null) return { start: open, end, handler: null };
      const handlerOpen = end + clause[0].length;
      return { start: open, end, handler: [handlerOpen, closing(text, handlerOpen, "{}") + 1] as [number, number] };
    });
  }

  /**
   * Every file-content read in a module, paired with the handler that receives its failure.
   *
   * The one walk both rules ask their question of. Each handler comes back twice over the same span:
   * `code` has strings blanked, so a brace or the word `throw` inside a quote cannot be read as one;
   * `quoted` keeps them, because `code === "ENOENT"` *is* a string and rule 1 is about exactly that
   * string. `stripComments` and `blankStrings` both preserve length, so one span indexes both.
   */
  function readFailures(source: string): { read: string; code: string; quoted: string }[] {
    const stripped = stripComments(source);
    const text = blankStrings(stripped);
    const names = readers(stripped);
    if (names.size === 0) return [];
    const callee = names.has("*")
      ? /(?:\.\s*)?\b(readFile|readFileSync)\s*\(/g
      : new RegExp(`\\b(${[...names].join("|")})\\s*\\(`, "g");
    const blocks = tryBlocks(text);
    const found: { read: string; code: string; quoted: string }[] = [];
    const at = (read: string, [from, to]: [number, number]): void => {
      found.push({ read, code: text.slice(from, to), quoted: stripped.slice(from, to) });
    };

    for (const call of text.matchAll(callee)) {
      const read = call[1] ?? "readFile";
      const open = call.index + call[0].length - 1;
      // The chain hanging off the call: `readFile(…).catch(…)`, `.then(…).catch(…)`.
      let after = closing(text, open, "()") + 1;
      for (let member = /^\s*\.\s*(\w+)\s*\(/.exec(text.slice(after)); member !== null; ) {
        const memberOpen = after + member[0].length - 1;
        const memberEnd = closing(text, memberOpen, "()");
        if (member[1] === "catch") at(read, [memberOpen, memberEnd + 1]);
        after = memberEnd + 1;
        member = /^\s*\.\s*(\w+)\s*\(/.exec(text.slice(after));
      }
      // And the innermost `try` around it, if any.
      const enclosing = blocks
        .filter((block) => block.start < call.index && call.index < block.end)
        .sort((first, second) => second.start - first.start)[0];
      if (enclosing?.handler != null) at(read, enclosing.handler);
    }
    return found;
  }

  /**
   * Rule 1: the reads in `source` whose handler decides for itself that `ENOENT` means absence.
   *
   * A `probe`'s errno is not a read's, and a write's errno is not either — only a handler that receives
   * a call handing back a file's *contents* is asked. That is what keeps this rule free of an allowlist.
   */
  function enoentReads(source: string): string[] {
    const named = readFailures(source)
      .filter(({ quoted }) => /\bENOENT\b/.test(quoted))
      .map(({ read }) => read);
    return [...new Set(named)].sort();
  }

  /**
   * Rule 2: the reads in `source` whose failure is thrown away, by local name.
   *
   * A handler counts as discarding when it contains no `throw`: the error stops there and the caller is
   * handed a value it cannot tell from a successful read of an absent file. A handler that rethrows —
   * `if (code !== "ENOENT") throw …` — is the correct shape and is not reported by this rule, whatever
   * else it does. Rule 1 is the one that has something to say about it.
   */
  function discardedReads(source: string): string[] {
    const discarding = readFailures(source)
      .filter(({ code }) => !/\bthrow\b/.test(code))
      .map(({ read }) => read);
    return [...new Set(discarding)].sort();
  }

  /**
   * Every module this rule covers: every package's shipped source, tests and their harnesses excluded.
   *
   * Each package's `src` is walked rather than the package directory, so the repository's own `scripts/`
   * and `tooling/` stay outside — the same boundary `scaffold.test.ts` draws and for the same reason.
   * None of that ever runs against an adopter's project, and what it writes over is a temp checkout or a
   * directory this repository made.
   */
  async function modules(): Promise<string[]> {
    const found: string[] = [];
    for (const pkg of await readdir(PACKAGES, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      found.push(...sourcePaths(join(PACKAGES, pkg.name, "src"), { skip: ["test-utils"] }));
    }
    return found.sort();
  }

  /** Every writing module that discards a read failure: path → the reads, sorted. */
  async function discarding(): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    for (const path of await modules()) {
      const source = readSource(path);
      if (source === null || !writes(stripComments(source))) continue;
      const reads = discardedReads(source);
      if (reads.length > 0) found[named(path)] = reads.join(", ");
    }
    return found;
  }

  /** The one module the errno decision belongs to. Everything else asks it. */
  const PRIMITIVE = "cli/src/project/readOptionalFile.ts";

  /** Every module but the primitive that decides `ENOENT` for itself on a read: path → the reads. */
  async function decidingEnoent(): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    for (const path of await modules()) {
      if (named(path) === PRIMITIVE) continue;
      const source = readSource(path);
      if (source === null) continue;
      const reads = enoentReads(source);
      if (reads.length > 0) found[named(path)] = reads.join(", ");
    }
    return found;
  }

  test("the walk reaches every package, not one directory of the CLI", async () => {
    // A silent walk that finds nothing passes every rule below it. So the walk is asserted before the
    // rule is: this is the failure mode that turned `atomic.test.ts`'s tripwire into decoration (#185).
    const found = await modules();
    expect(found).toContain(join(PACKAGES, "core", "src", "error", "pithyError.ts"));
    expect(found).toContain(join(PACKAGES, "cli", "src", "project", "readOptionalFile.ts"));
    expect(new Set(found.map((path) => named(path).split("/")[0])).size).toBeGreaterThan(3);
  });

  test("no module but readOptionalFile.ts names ENOENT about a file it read", async () => {
    // Rule 1, and it has no allowlist by construction — there is nowhere to write an exemption. A hit
    // here is a module that has copied the primitive's one sentence into itself, correct today and one
    // edit from the fourth instance of the defect the primitive exists to end.
    expect(
      await decidingEnoent(),
      "route the read through readOptionalFile — the errno decision has one home and this is not it",
    ).toEqual({});
  });

  test("the ENOENT rule sees a read's handler, and not an errno that is about anything else", () => {
    const reader = 'import { readFile } from "node:fs/promises";\n';
    // The two shapes the six were written in: the `try` form and the `.catch` form.
    expect(
      enoentReads(
        `${reader}try { return await readFile(p); } catch (e) { if (e.code === "ENOENT") return null; throw e; }`,
      ),
    ).toEqual(["readFile"]);
    expect(
      enoentReads(`${reader}await readFile(p).catch((e) => { if (errnoOf(e) === "ENOENT") return null; throw e; });`),
    ).toEqual(["readFile"]);
    // An alias hides nothing here either — the same import walk both rules share.
    expect(
      enoentReads(
        `import { readFile as rf } from "fs/promises";\ntry { rf(p); } catch (e) { if (x === "ENOENT") return ""; }`,
      ),
    ).toEqual(["rf"]);
    // A probe's errno is not a read's. `scaffold.ts` keeps three answers about whether a path is there,
    // which is this rule applied rather than evaded, and a gate that fired on it would need an allowlist.
    expect(
      enoentReads(
        `import { lstat, readFile } from "node:fs/promises";\ntry { await lstat(p); } catch (e) { if (e.code === "ENOENT") return null; }\nawait readFile(p);`,
      ),
    ).toEqual([]);
    // Nor is a write's. `atomic.ts` maps the errno of a failed rename onto a sentence, and reads nothing.
    expect(
      enoentReads(
        `import { rename } from "node:fs/promises";\ntry { await rename(a, b); } catch (e) { if (e.code === "ENOENT") throw new NotFoundError({}); }`,
      ),
    ).toEqual([]);
    // Prose about the rule is not the rule. Every docstring in this tree names the errno on purpose.
    expect(enoentReads(`${reader}// only ENOENT means absent\ntry { readFile(p); } catch { return null; }`)).toEqual(
      [],
    );
  });

  test("the scan sees both shapes, and neither of the two that are not defects", () => {
    const writer = 'import { readFile, writeFile } from "node:fs/promises";\n';
    // The `.catch` form and the `try` form — the two the three defects were written in.
    expect(discardedReads(`${writer}const a = await readFile(p, "utf8").catch(() => null);`)).toEqual(["readFile"]);
    expect(discardedReads(`${writer}try { x = await readFile(p, "utf8"); } catch { return {}; }`)).toEqual([
      "readFile",
    ]);
    // An alias hides nothing, and neither does taking the whole namespace.
    expect(discardedReads(`import { readFile as rf, rm } from "fs/promises";\nrf(p).catch(() => "");`)).toEqual(["rf"]);
    expect(
      discardedReads(`import fs from "node:fs";\nfs.readFileSync(p);\ntry { fs.readFileSync(p); } catch {}`),
    ).toEqual(["readFileSync"]);
    // The correct shape: the errno decides, and anything but ENOENT is rethrown.
    expect(
      discardedReads(
        `${writer}try { x = await readFile(p); } catch (e) { if (code(e) === "E") return null; throw e; }`,
      ),
    ).toEqual([]);
    // A probe is not a read. `bootstrapVarsPath` answers "is there a project name to key on" and
    // discards on purpose; a rule that fired on it is a rule somebody mutes.
    expect(discardedReads(`${writer}try { return path(await load(dir)); } catch { return null; }`)).toEqual([]);
  });

  test("only the reads written down here discard the failure", async () => {
    const found = await discarding();
    const declared = Object.fromEntries([
      ...Object.entries(DISCARDS_ON_PURPOSE).map(([path, { reads }]) => [path, reads]),
      ...Object.entries(NOT_YET_ROUTED).map(([path, { reads }]) => [path, reads]),
    ]);

    // One equality, failing from both sides. A writing module that starts discarding is not in `declared`
    // and shows up; a declared one that was fixed no longer matches and shows up too, so the list cannot
    // rot. The message is for the first case, which is the one that ships the bug.
    expect(found, "route it through readOptionalFile, or say why the discard costs nothing here").toEqual(declared);
  });

  test("and every discard that stays says why, in a sentence somebody has to disagree with", () => {
    // A reason nobody wrote is a reason nobody reviewed, and these lists are only worth having if adding
    // to either costs an argument.
    for (const [path, { why }] of Object.entries(DISCARDS_ON_PURPOSE)) {
      expect(why.trim().length, path).toBeGreaterThan(40);
    }
    for (const [path, { costs }] of Object.entries(NOT_YET_ROUTED)) {
      expect(costs.trim().length, path).toBeGreaterThan(40);
    }
  });

  test("the debt list only shrinks", () => {
    // Five when this rule landed; four since `ui/workerUi.ts` was routed (#196), which was the one on
    // the list that lost data rather than answered wrongly. Lower this number as the rest are routed; a
    // change that needs it raised is a change writing the fifth, sixth or seventh instance of the defect.
    expect(Object.keys(NOT_YET_ROUTED).length).toBeLessThanOrEqual(4);
    // And nothing may sit in both lists — blessed and owed are different claims about the same read.
    for (const path of Object.keys(NOT_YET_ROUTED)) expect(DISCARDS_ON_PURPOSE[path]).toBeUndefined();
  });
});
