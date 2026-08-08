# Accepted limits

Five rounds of adversarial review hardened the CLI's filesystem writes: exclusive temp creation, uid-ownership containment for symlinks, handle-based `fchmod`, gated recursive deletes, and tripwires that fail the build on a new producer. What remains is a short list of races Node gives no way to close, and one rule that lives in a test because no linter can express it.

They are written down here because a limit nobody recorded reads as a limit nobody saw.

Functions are named rather than lines. A line number in a document is wrong by the next commit.

## The threat model

Every item below needs an attacker who **can already write to the project directory**.

Someone with that access can add a `postinstall` to `package.json`, drop a `.git/hooks/pre-commit`, or edit `pithy.config.ts`. Each is arbitrary code execution as the developer, immediately, with no race to win. Against that adversary, hardening `.dev.vars` against a planted symlink is a lock on one door of a building with no walls.

So these are accepted, not ignored. The bar they fail is relevance, not severity.

## What is accepted

### The `lstat` → `readlink` window

`resolveWritePath` in `packages/cli/src/project/atomic.ts` walks a path one component at a time: it `lstat`s each one, hands the owner to `ensureOurs`, then reads it as a link. Two syscalls, one name, and the name is the attacker's to change between them. Closing it needs `openat(2)` against a directory descriptor, which Node does not expose for a relative walk.

### The inode check → `rename` window

`ensureUnswapped`, in the same module, compares the inode at the temp name against an `fstat` of the file the bytes actually went into, immediately before the rename. `rename` is path-based and Node ships no `renameat`, so a swap that lands inside that gap still wins. The check turns a reliable escape into a narrow race. It does not close it.

### A pre-positioned file we already own

`adoptableModeOf` carries an existing target's mode onto the temp file, so an adopter's deliberate `0600` survives a write, and it refuses a mode read off a file another uid owns. Someone with directory-write can still move a world-readable file **we** own into place. What holds there is the ceiling: a mode wider than the one the caller asked for is never adopted. The residue is exotic.

### Bind mounts and hard-linked directories

`removeScaffoldPath` in `packages/cli/src/project/scaffold.ts` resolves the target with `realpath` and requires the result to sit under the resolved project root. `realpath` resolves symlinks and nothing else. A bind mount at `apps/` presents a path that resolves *inside* the project while the bytes it covers live somewhere else entirely, and the recursive delete follows it. Detecting one means reading the mount table, which is platform-specific and not portable.

### Windows has no uid model

The rule separating a developer's symlink from a planted one is ownership: `symlink(2)` stamps the creating uid, and only root may `chown` it afterwards. Windows has nothing to compare, so `ensureOurs` returns early there and `adoptableModeOf` adopts from anyone. The mode ceiling still holds, and that is the half that stops a widening. The source says so at both sites.

### An editor we have nothing to say about

`resolveEditor` in `packages/cli/src/platform/editor.ts` refuses a **known** GUI editor given no wait flag — `code`, `subl`, `gvim` and the rest — and names the flag to add. There is no portable way to ask a program whether it will block, so an editor absent from that table is spawned and waited on, and one that returns immediately hands back a draft nobody has typed into yet.

What that costs is bounded on purpose. An untouched draft is byte-identical to the file it was copied from, so the run reports `unchanged` and writes nothing; it never overwrites the edit still in progress in the window. The adopter's later save lands in the draft file beside the real one, which is where the text stays until they move it. `pithy secrets edit` is not the command that loses an edit.

### Windows runs the editor through a shell

`runEditor` in the same module spawns with `shell: true` on Windows. Every GUI editor there is a `.cmd` shim, and Node refuses to spawn one directly. The whole command line then becomes one string `cmd.exe /d /s /c` re-splits, so anything carrying a space is quoted here — a `"` cannot appear in a Windows path, so there is nothing left to escape. What reaches that shell unquoted is the adopter's own `$EDITOR`, which is what `$EDITOR` means on every other tool too. Not verified on a Windows host: the branch is covered by an injected spawn, which is what a POSIX CI can prove.

### The tripwires read source text

`packages/cli/src/project/scaffold.test.ts` holds three rules that fail the build on a new producer: no writing module probes with something that follows a link, no module runs its own recursive delete, and every filesystem call on a path composed from an adopter's name goes through `ensureScaffoldPath`.

The import half is decidable and hard to evade. The rules read named import clauses and resolve a local alias back to the export it binds, and a separate rule bans namespace imports, default imports, `require`, and dynamic `import` of `fs` outright — which is what makes reading the clauses sufficient.

The rest is a heuristic over source text, and its blind spots are on record beside it:

- A path arriving as a function parameter is invisible. The gate at the call site covers that, not the rule.
- A fresh name appended to a cleared path reads as cleared.
- A path that never names `apps` or `capabilities` in the module that writes it is never examined.
- The recursive-delete rule matches the call text `rm(` and `rmSync(`, so an aliased import evades it. The alias-resolving rule catches such a call only where its path is scaffold-rooted.
- A mutating call's created path is read from its **first** argument, and `symlink(target, path)` creates its second. That is the gap #167 named.

**There is no better home for this today, and neither candidate is the one first assumed.**

Biome has `style/noRestrictedImports` and per-path `overrides`, so the capability exists. It is the wrong shape. The rule is a conjunction — a link-following probe is wrong in a module that *writes* and unremarkable in one that only reads — and Biome's grit plugins match expressions, not a module fact and a call together. Expressing it through `overrides` would mean hand-listing every writing module in `biome.jsonc`, which is one more place to forget.

TypeScript 7 ships no standalone parser. Verified against `typescript@7.0.2`: the package's main export is a version stub, and `typescript/unstable/ast` gives node types, predicates, a visitor and `createScanner`, but nothing that turns a string into a tree. An AST arrives only through `typescript/unstable/sync`, which spawns the compiler server, needs a resolved project, and says in its own specifier that it is unstable.

## What was not accepted

For the record, so this is not read as a shrug. Each of these was reproduced with the real CLI, closed, and pinned by a test.

- Exfiltration through a planted temp sibling — #151.
- Exfiltration through the target itself — #146, #151.
- Exfiltration through any parent component — #147, #152.
- An arbitrary-`chmod` primitive — #151.
- Recursive deletes escaping the project — #158. And a delete that removed nothing while reporting success — #165.
- A credential file left at whatever the umask allowed — #146, #150.
- A `.dev.vars` link planted inside a discovered worker directory — #167.
- A secret truncated at an unescaped `#`, silently, and read back afterwards as present.

## Revisit when

- Node exposes `openat`, `renameat`, or any handle-relative equivalent.
- A linter can express "this operation, in a module that does that". The rules leave the test suite the day one can.
- TypeScript's parser is reachable from a string, or `typescript/unstable/sync` stabilises.
- The threat model changes. A shared build agent whose project directory is writable by an account that cannot already run our code puts every item above back in scope.
