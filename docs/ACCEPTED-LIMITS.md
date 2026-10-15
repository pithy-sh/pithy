# Accepted limits

_The reader's version of this page is [pithy.sh/docs/reference/accepted-limits](https://pithy.sh/docs/reference/accepted-limits). This copy stays in the kit because `packages/cli/src/project/scaffold.ts` sends an adopter to it by name._

Five rounds of adversarial review hardened the CLI's filesystem writes: exclusive temp creation, uid-ownership containment for symlinks, handle-based `fchmod`, gated recursive deletes, and tripwires that fail the build on a new producer. What remains is a short list of races Node gives no way to close, and one rule that lives in a test because no linter can express it.

One further limit is here for the same reason and is not a race at all: a thing the platform underneath will not do. It is kept separate below, because it has no attacker and the threat model's claim is about its own list.

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

### Windows runs `.cmd` files through a shell

Every `.cmd` the CLI runs — the package managers and their runners, wrangler, the editor — goes through `platform/command.ts`'s resolution, and a `.cmd` there spawns as `cmd.exe /d /s /c "<line>"` with verbatim arguments, the shape cross-spawn ships. Node refuses to spawn a `.cmd` directly (it has since the argument-injection fix), and its own `shell: true` concatenation (DEP0190) re-quotes a line the caller already quoted, so the CLI builds the command line itself: the command word caret-escaped and unquoted, every argument quoted whole with its metacharacters escaped. The editor is why the quoting is not optional — the file lives under `%APPDATA%\pithy\<project>\`, and a Windows home directory with a space in it is the common case, not the exotic one — and `pithy eject` is why the escapes are: a registry range like `zod@^3.23.8` and a path like `C:\work\R&D\app` are ordinary strings that `cmd.exe` re-splitting reads as syntax. What reaches that shell unescaped is the adopter's own `$EDITOR`, which is what `$EDITOR` means on every other tool too. So an unquoted `EDITOR` whose path contains a space is split there: `C:\Users\me\edit test\myedit.cmd` runs `C:\Users\me\edit`, which `cmd.exe` does not recognize. Quoting it is the adopter's half, as it is for `$EDITOR` anywhere. Measured on Windows 11 (#701, item 5), where the file argument arrived whole and only the unquoted variable split. On a Windows host since #702: `platform/cmdShims.windows.test.ts` runs a `.cmd` from a directory with a space in its name through `runEditor`, on the Windows CI job, and checks the file path arrives whole; `platform/command.windows.test.ts` runs a package-manager spawn through the resolution and checks hostile arguments arrive at the child byte for byte.

### Rebuilding `pithy dev`'s screen erases the shell output on it

The live roster is the one region `pithy dev` redraws, and ink redraws it by erasing the rows of the frame it last drew, counted up from the cursor. A terminal that rewraps on resize — ConPTY does — moves those rows, so the count goes stale and the erase lands on the wrong ones. Three repairs on #741 tried to make the count right, measured on Windows 11: erasing the recomputed layout, erasing the frame's post-rewrap footprint, rebuilding the viewport from the store. Each moved the artifact; none removed it, because the count is a value the terminal does not disclose. #736 stopped counting: the frame is scrolled away into scrollback and drawn fresh. #760 replaced that with what ships now — an **anchored erase**: the cursor rests on the live region's first cell, every resize event erases from there down (an erase writes no rows and scrolls nothing), ink's resize paint is muted for the length of a burst at the subscription seam (the stdout proxy wraps the `resize` listener; Node's `emit` iterates a copy of the listener array, so a handler cannot mute a sibling from inside the event, only before it), and the burst's repaint happens once, at the settle, at the final geometry. A drag that carried more than one event gets the viewport rebuilt at the settle: erase from the viewport's first row to the anchor, home, restate the visible tail of the committed stream **measured in rows at the new width** (a 150-column line is three rows at 60; one line per row is the arithmetic that duplicated restatements), budgeted so the restatement plus the footer fit the screen with a row to spare.

What the rebuild's erase costs is on-screen history: `ESC[1J` erases visible rows, and the shell output visible above `pithy dev`'s first committed line — the command that started it, what it printed — is not in scrollback and does not come back. Lines the session wrote that had already scrolled up are untouched, one copy each; the restatement replaces what it erases. The rebuild stays because sweeping from the anchor alone provably misses: the rebuild was removed for #760 and five identical runs of `devTui.windows.test.ts` left a wrapped frame tail — a rule fragment — on the emulator's whole buffer in one of them, and ConPTY's reflow re-emits copy a boundary line or two on the rest. The alternative that reaches everything, erasing scrollback (`\x1b[3J`) and replaying the session into it, takes the shell history above `pithy dev` with it and grows with every line the session wrote. A screen that is right, and on-screen shell output sacrificed at the first rebuild, is the trade this records.

What the suites hold: `dev/tui/devTui.windows.test.ts` runs on the Windows CI job against a real ConPTY dragged wide to narrow to wide from the host side, read through a terminal emulator, and counts the **whole buffer** — scrollback plus viewport: one header, two rules, each committed marker exactly once, every stream line in order with the fan bounded at three copies (the restatement writes one, and a repaint racing ConPTY's reflow re-emits at the erase boundary can re-deliver a line; a mechanism restating the whole store fans seven copies per line, so the bound binds). `dev/tui/devTui.pty.test.ts` holds the byte-stream half on Linux: ink's resize repaint is muted for a burst's length — the clock tick and mid-drag commits still paint, and the bound (measured seventeen frames per drag window) fails a repaint per resize event — markers arrive in order, and the settled screen the last rebuild leaves holds each visible line exactly once. The staircase the replaced mechanism measured — four headers and twelve rules on the settled screen — is on record in #736. Measured on Windows 11 (#701, item 4; #736; #760).

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

## Limits that are not ours

**Nothing in this section has an attacker.** These are things Cloudflare will not do, which the kit refuses rather than pretends to support. They are recorded here so a refusal reads as a platform limit rather than as something Pithy could not manage — and so the condition that would lift it is written down beside it.

### Internationalized domain names

A Worker cannot answer on an internationalized domain, so `pithy.config.ts` refuses one. `müller-shop.de` is refused, and so is `xn--mller-shop-9db.de`, which is the same name encoded — the form DNS actually carries.

**The limit is Cloudflare Workers', not ours.** Tested against a live zone on 2026-10-03: adding `tëst.pithy-sh.com` as a Worker **Custom Domain** returns **"Internationalized Domain Names not supported"** in Cloudflare's own dialog. Not a timeout, not a misconfiguration — a stated refusal.

Two things are **not** the cause, and both were checked so nobody looks for the fix in the wrong place. Cloudflare **DNS** accepts an internationalized record; `xn--tst-jma.pithy-sh.com` went into the zone proxied and resolving. And Cloudflare **issues a valid certificate** for a punycode hostname — `curl` to both spellings returned a verified chain. The address resolves and the certificate is good. It is the routing to a Worker that does not exist.

So the kit refuses at the point an adopter declares the domain, where the message can name the reason, rather than letting a `routes` entry reach a deploy that would never answer. `pithy seed --host` refused the same string already; `pithy-sh/pithy#665` is what made the configured domain agree with it.

**If Cloudflare starts routing them, Pithy can support them.** The work is scoped and costed in `pithy-sh/pithy#691`, which closed as *not deliverable* rather than as wrong: the rule to validate an A-label without trusting the runtime is `tr46`, a pure-JavaScript UTS-46 implementation with its own tables, and the issue records why neither `new URL()` nor `url.domainToASCII` can be the foundation — Bun validates nothing with the latter while Node does, and the former changed behavior under this kit once already.

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
- TypeScript's parser is reachable from a string, or `typescript/unstable/sync` stabilizes.
- The threat model changes. A shared build agent whose project directory is writable by an account that cannot already run our code puts every item above back in scope.
- **Cloudflare Workers supports internationalized custom domains.** `pithy-sh/pithy#691` holds the scoped work, and it is the whole trigger — the kit's side is a validator change, not a redesign.
