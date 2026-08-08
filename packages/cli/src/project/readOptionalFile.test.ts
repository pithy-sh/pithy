// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "../ci/sourceFiles";
import { readFileOutcome, readOptionalFile } from "./readOptionalFile";

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
 * The gate. **A module that puts bytes on disk must not read a file and discard the failure.**
 *
 * Stated about any module that writes rather than about the three readers `readOptionalFile` was built
 * for: enumerating the known instances is exactly what produced the second and the third. A fourth
 * reader will be written by someone who has read none of them, and `.catch(() => null)` is shorter than
 * the correct version — so the rule has to be something a build fails on, not something a docstring asks
 * for.
 *
 * **Why the rule is about writing modules, and what that costs.** The invariant everyone would rather
 * state is the issue's own sentence — *no module reads a file with a catch that discards the error* — and
 * it is not shippable today: this tree has 32 of them, and a 32-entry allowlist is a muted tripwire with
 * extra steps. Worse, some of those discards are correct and permanent. The `doctor` surface throws six
 * read failures away on purpose: a diagnostic has to work in the broken environment it exists to
 * diagnose, and it writes nothing, so the worst its discard can cost is a line missing from a report the
 * adopter is already reading. That is the distinction this scope draws structurally rather than by
 * judgement — **reading a file you are about to act on, against reading one to report on.** A module that
 * cannot write cannot destroy what it failed to read.
 *
 * The cost is honest and it is written here so nobody has to rediscover it: the third producer,
 * `capabilities/manifests.ts`, is *not* a writing module. Its defect was a capability vanishing from
 * `pithy add --list`, which no rule below would have caught. The narrower rule that would — only
 * `readOptionalFile.ts` may name `ENOENT` — is not shippable either until the six readers that still
 * spell out the errno branch by hand (`devSecrets/file.ts`, `project/devVars.ts`, `platform/rc.ts`,
 * `feature/manifest.ts`, `feature/ports.ts`, `seed/media.ts`) are routed through the primitive. They are
 * all *correct*; they are just six copies. Routing them is the follow-up that makes that gate free.
 *
 * **It is a scan over source text, with the limits `atomic.test.ts` records**: TypeScript 7 ships no
 * parser API, so there is no AST to walk. It reads import clauses — so an alias, a namespace binding, a
 * `require` and a dynamic `import` all count — and then brace-matches the `catch` that would receive the
 * failure. What it cannot see is a read reached through a module that re-exports one, or a handler that
 * discards by calling something that swallows.
 *
 * **The walk is `ci/sourceFiles.ts`**, the one the rename, follower, recursive-delete, editor and
 * runtime-export tripwires already read this tree through (#185). A seventh traversal to enforce a rule
 * about not repeating yourself would be its own joke.
 */
describe("a module that writes must not read a file and discard the failure", () => {
  /** `packages/` — this file lives at `packages/cli/src/project/`. Asserted below, so a move fails loudly. */
  const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  /** A module's key in the map below: its path under `packages/`, in posix separators. */
  const named = (path: string): string => relative(PACKAGES, path).split(sep).join("/");

  /**
   * The reads that discard the failure and stay: path → what it reads, and why the discard is safe there.
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
      why: "`readBootstrapVars` argues it at length: every failure is an empty set because nothing is rewritten from this read — the result is merged into a file regenerated wholesale, and `writeBootstrapVars` does its own read through `readOptionalFile` and refuses. A `dev.json` half-typed by hand must not stop `pithy dev`.",
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
      reads: "readFile",
      why: "A config it cannot read yields no located registration, so no drift is reported and nothing is written from it. The cost is a report that under-reports for that Worker, and `doctor` reads the same file again.",
    },
  };

  /**
   * The discards that predate this rule and are **not** blessed by it: path → what it reads, and what the
   * discard costs when the file is there and will not open.
   *
   * A debt inventory, not an allowlist. Every one of these was written before the primitive existed, none
   * has been reviewed against it, and each `costs` is the sentence that says why it is worth an issue.
   * The count below is a ratchet: it may fall as these are routed through `readOptionalFile`, and a change
   * that raises it is a change adding a fourth instance of the defect this file exists to end.
   */
  const NOT_YET_ROUTED: Record<string, { reads: string; costs: string }> = {
    "cli/src/ui/workerUi.ts": {
      reads: "readFile",
      costs:
        "An unreadable-but-present `pithy.worker.jsonc` reads as `{}`, and `writeManifestDocument` then renames a document holding only the `dev` and `ui` blocks over it. Every other block the adopter wrote is gone. This is the `.dev.vars` defect with a different file name.",
    },
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
   */
  function stripComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, (line, lead: string) => lead + line.slice(lead.length).replace(/./g, " "));
  }

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

  /** Every `try` block in a module, with the body of the `catch` clause that would receive its failure. */
  function tryBlocks(text: string): { start: number; end: number; handler: string }[] {
    return [...text.matchAll(/\btry\s*\{/g)].map((match) => {
      const open = match.index + match[0].length - 1;
      const end = closing(text, open, "{}");
      const clause = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(text.slice(end + 1));
      if (clause === null) return { start: open, end, handler: "" };
      const handlerOpen = end + clause[0].length;
      return { start: open, end, handler: text.slice(handlerOpen, closing(text, handlerOpen, "{}") + 1) };
    });
  }

  /**
   * The reads in `source` whose failure is thrown away, by local name.
   *
   * A handler counts as discarding when it contains no `throw`: the error stops there and the caller is
   * handed a value it cannot tell from a successful read of an absent file. A handler that rethrows —
   * `if (code !== "ENOENT") throw …` — is the correct shape and is not reported, whatever else it does.
   */
  function discardedReads(source: string): string[] {
    const stripped = stripComments(source);
    const text = blankStrings(stripped);
    const names = readers(stripped);
    if (names.size === 0) return [];
    const callee = names.has("*")
      ? /(?:\.\s*)?\b(readFile|readFileSync)\s*\(/g
      : new RegExp(`\\b(${[...names].join("|")})\\s*\\(`, "g");
    const blocks = tryBlocks(text);
    const found = new Set<string>();

    for (const call of text.matchAll(callee)) {
      const open = call.index + call[0].length - 1;
      // The chain hanging off the call: `readFile(…).catch(…)`, `.then(…).catch(…)`.
      let after = closing(text, open, "()") + 1;
      let discarded = false;
      for (let member = /^\s*\.\s*(\w+)\s*\(/.exec(text.slice(after)); member !== null; ) {
        const memberOpen = after + member[0].length - 1;
        const memberEnd = closing(text, memberOpen, "()");
        if (member[1] === "catch" && !/\bthrow\b/.test(text.slice(memberOpen, memberEnd + 1))) discarded = true;
        after = memberEnd + 1;
        member = /^\s*\.\s*(\w+)\s*\(/.exec(text.slice(after));
      }
      // Otherwise the innermost `try` around it, if any.
      const enclosing = blocks
        .filter((block) => block.start < call.index && call.index < block.end)
        .sort((first, second) => second.start - first.start)[0];
      if (enclosing !== undefined && enclosing.handler !== "" && !/\bthrow\b/.test(enclosing.handler)) discarded = true;
      if (discarded) found.add(call[1] ?? "readFile");
    }
    return [...found].sort();
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

  test("the walk reaches every package, not one directory of the CLI", async () => {
    // A silent walk that finds nothing passes every rule below it. So the walk is asserted before the
    // rule is: this is the failure mode that turned `atomic.test.ts`'s tripwire into decoration (#185).
    const found = await modules();
    expect(found).toContain(join(PACKAGES, "core", "src", "error", "pithyError.ts"));
    expect(found).toContain(join(PACKAGES, "cli", "src", "project", "readOptionalFile.ts"));
    expect(new Set(found.map((path) => named(path).split("/")[0])).size).toBeGreaterThan(3);
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
    // Five when this rule landed. Lower this number as they are routed through the primitive; a change
    // that needs it raised is a change writing the fifth, sixth or seventh instance of the same defect.
    expect(Object.keys(NOT_YET_ROUTED).length).toBeLessThanOrEqual(5);
    // And nothing may sit in both lists — blessed and owed are different claims about the same read.
    for (const path of Object.keys(NOT_YET_ROUTED)) expect(DISCARDS_ON_PURPOSE[path]).toBeUndefined();
  });
});
