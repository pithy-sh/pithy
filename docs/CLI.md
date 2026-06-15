# Pithy CLI Specification

> The CLI is the brand's primary interface. Every command, every flag, every output line should feel like Pithy — short, deliberate, and confident. This document specifies behavior. For visual identity, voice, and color tokens, see `BRAND.md`.

---

## 1. Command structure

Pithy uses a verb-noun command pattern:

```
pithy <command> [subcommand] [args] [--flags]
```

Examples:

```
pithy init
pithy add auth
pithy add leaderboard
pithy remove leaderboard
pithy dev
pithy deploy
pithy upgrade
pithy alias
pithy doctor
```

The binary is always `pithy`. The alias system (Section 3) ships a shorter shortcut, but the canonical command name never changes.

### 1.1 Standard commands

| Command | Purpose |
|---|---|
| `pithy init` | Scaffold a new Pithy project in the current directory |
| `pithy add <capability>` | Install a capability (auth, leaderboard, storage, vector, jobs) — installs the package, wires it into `pithy.config.ts` and `wrangler.jsonc`, scaffolds its config options (you pick the mount path; handlers stay in the package), and runs its migrations |
| `pithy remove <capability>` | Inverse of `add` — uninstalls cleanly |
| `pithy worker <add\|list\|remove> [name]` | Manage the project's Workers under `apps/<name>/`; `apps/` is the registry `dev`/`deploy` discover (see Section 6) |
| `pithy dev` | Start the local development environment (multi-worker, per-feature ports — see Section 6) |
| `pithy migrate` | Run the migration registry against an `--env` (`--rollback` to downgrade) |
| `pithy seed` | Load seed/test data (same Zod schemas/codecs) for local dev or ephemeral CI |
| `pithy feature` | Worktree lifecycle: `create`/`destroy` a `feature/<issue>-<name>` branch + its ephemeral CF resources |
| `pithy env` | Switch or report the active deployment environment (`dev`/`staging`/`production`) |
| `pithy deploy` | Deploy to Cloudflare Workers |
| `pithy upgrade` | Reconcile scaffolded code with current capability manifests |
| `pithy alias` | Install or remove the shell shortcut (see Section 3) |
| `pithy doctor` | Diagnose environment, bindings, and config |
| `pithy --help` / `pithy -h` | Show help for any command |
| `pithy --version` / `pithy -v` | Print the installed version |

### 1.2 Flag conventions

- Long flags: `--flag-name` (kebab-case)
- Short flags: `-f` (single letter)
- Boolean flags default to `false`; pass to enable
- Values pass with `=` or space: `--env=production` or `--env production`
- `--help` and `--version` are global and work on any command

---

## 2. The alias system

The brand is built on concision. The CLI ships with an opt-in shortcut that's even more pithy than `pithy`.

### 2.1 The shortcut

```
p.   →   pithy
```

Two characters. Ends in the brand mark. Encodes the logo into shell muscle memory.

After installation, the user can substitute `p.` anywhere `pithy` would appear:

```bash
p. init
p. add auth
p. deploy
p. --help     # works identically to pithy --help
```

### 2.2 How users discover and install the alias

Three surfaces, each appropriate to a different moment.

**Surface 1: During `pithy init`**

After scaffolding completes, the installer asks once:

```
Done.

Want a shortcut? Type `p.` instead of `pithy`. [Y/n]
```

- Default response: `Y`
- If yes: writes alias to shell rc file, prints confirmation
- If no: never asks again in this project; user can still install later via `pithy alias`

**Surface 2: The `pithy alias` subcommand**

For users who skipped install, are on a second machine, or want to remove the alias:

```
pithy alias              # install (idempotent)
pithy alias --remove     # uninstall
pithy alias --status     # report whether installed
```

This is the documented, supported surface. Listed in `pithy --help`.

**Surface 3: The `--pithier` easter egg**

```
pithy --pithier
```

Hidden flag. Does the same thing as `pithy alias`. Not in `--help`. Mentioned only in the docs (in a sidebar callout) and in the launch blog post. The discovery moment is part of the brand experience.

### 2.3 The anti-feature: `--pithiest`

If a user reaches for more, the CLI declines:

```
$ pithy --pithiest
Pithy enough.
$
```

Exits 0. No alias is installed. No error. The refusal *is* the joke — the brand is honest about its limits.

This flag is also not in `--help`. Like `--pithier`, it's discovered.

### 2.4 Shell detection and file paths

The installer detects the user's shell and writes the appropriate syntax to the appropriate file:

| Shell | Detection | RC file | Alias syntax |
|---|---|---|---|
| bash | `basename "$SHELL"` ends with `bash` | `~/.bashrc` (or `~/.bash_profile` on macOS) | `alias p.='pithy'` |
| zsh | ends with `zsh` | `~/.zshrc` | `alias p.='pithy'` |
| fish | ends with `fish` | `~/.config/fish/config.fish` | `alias p. pithy` |
| PowerShell | platform = Windows + `$PSVersionTable` | `$PROFILE` (typically `~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1`) | `function p. { pithy @args }` (Set-Alias rejects `.` in names) |
| nushell | `basename "$SHELL"` ends with `nu` | `~/.config/nushell/config.nu` | `alias p. = pithy` |

**Unknown or unsupported shells:** Print the alias line and instruct the user to add it manually. Never silently fail; never write to an unrecognized rc file.

**macOS bash users:** macOS ships with bash 3.2 by default and the `.bash_profile` convention. Detect macOS via `uname` and prefer `.bash_profile` over `.bashrc`; fall back to `.bashrc` if `.bash_profile` doesn't exist.

### 2.5 Idempotency and safe edits

The installer must never duplicate the alias or corrupt existing config:

1. **Read before write.** Check whether `alias p.=` (or shell equivalent) already exists in the file.
2. **Wrap with markers.** Wrap the added line with a marker comment so `--remove` can find and delete exactly the block we added:
   ```bash
   # >>> pithy alias >>>
   alias p.='pithy'
   # <<< pithy alias <<<
   ```
3. **Append, never rewrite.** Open in append mode; never read-modify-write the entire file.
4. **Create the file if it doesn't exist.** Touch the rc file with appropriate permissions (e.g., `0644` on POSIX) if the user has no shell config yet.
5. **Permission check.** If the file is read-only or not writable, fail with a clear error pointing the user to manual install.
6. **No symlink traversal.** Refuse to write if the rc path is a symlink to outside the user's home directory.

### 2.6 Removal

```
pithy alias --remove
```

Locates the marker block from Section 2.5, removes those lines, leaves everything else untouched. If no marker is found, reports "No Pithy alias installed." and exits 0.

### 2.7 User interaction flow

**First-time install during init:**

```
$ pithy init

▸ Creating project structure...
▸ Initializing wrangler.jsonc...
▸ Installing @pithy-sh/core...

Done.

Want a shortcut? Type `p.` instead of `pithy`. [Y/n] y

Added `alias p.='pithy'` to ~/.zshrc
Reload your shell or run: source ~/.zshrc

$ source ~/.zshrc
$ p. --version
pithy 1.0.0
```

**Standalone install:**

```
$ pithy alias
Added `alias p.='pithy'` to ~/.zshrc
Reload your shell or run: source ~/.zshrc
```

**Already installed:**

```
$ pithy alias
Already pithy.
$
```

**Status check:**

```
$ pithy alias --status
Installed in ~/.zshrc
$
```

**Removal:**

```
$ pithy alias --remove
Removed `alias p.='pithy'` from ~/.zshrc
Reload your shell or run: source ~/.zshrc
```

**The hidden easter egg:**

```
$ pithy --pithier
Added `alias p.='pithy'` to ~/.zshrc
Reload your shell or run: source ~/.zshrc
```

**The anti-feature:**

```
$ pithy --pithiest
Pithy enough.
```

### 2.8 Implementation outline

```ts
// src/commands/alias.ts

import { detectShell } from '../platform/shell';
import { readRcFile, appendToRcFile, removeFromRcFile } from '../platform/rc';

const MARKER_OPEN = '# >>> pithy alias >>>';
const MARKER_CLOSE = '# <<< pithy alias <<<';

export async function installAlias(opts: { silent?: boolean } = {}) {
  const shell = await detectShell();
  if (!shell) {
    return logManualInstructions();
  }

  const contents = await readRcFile(shell.rcPath);
  if (contents.includes(MARKER_OPEN) || /\balias\s+p\.\s*=/.test(contents)) {
    if (!opts.silent) console.log('Already pithy.');
    return;
  }

  const block = [
    MARKER_OPEN,
    shell.aliasSyntax,
    MARKER_CLOSE,
  ].join('\n');

  await appendToRcFile(shell.rcPath, '\n' + block + '\n');
  console.log(`Added \`${shell.aliasSyntax}\` to ${shell.rcPath}`);
  console.log(`Reload your shell or run: source ${shell.rcPath}`);
}

export async function removeAlias() {
  const shell = await detectShell();
  if (!shell) return logManualInstructions();

  const removed = await removeFromRcFile(shell.rcPath, MARKER_OPEN, MARKER_CLOSE);
  if (!removed) {
    console.log('No Pithy alias installed.');
    return;
  }
  console.log(`Removed \`${shell.aliasSyntax}\` from ${shell.rcPath}`);
  console.log(`Reload your shell or run: source ${shell.rcPath}`);
}

export async function aliasStatus() {
  const shell = await detectShell();
  if (!shell) return console.log('Unable to detect shell.');

  const contents = await readRcFile(shell.rcPath);
  if (contents.includes(MARKER_OPEN)) {
    console.log(`Installed in ${shell.rcPath}`);
  } else {
    console.log('Not installed. Run `pithy alias` to install.');
  }
}

// The easter egg + anti-feature live as global flag handlers
// in the main CLI dispatch (src/cli.ts), not in any subcommand:

export function handleHiddenFlags(argv: string[]): boolean {
  if (argv.includes('--pithier')) {
    installAlias();
    return true;
  }
  if (argv.includes('--pithiest')) {
    console.log('Pithy enough.');
    return true;
  }
  return false;
}
```

### 2.9 Testing checklist

- [ ] Idempotency: running `pithy alias` twice doesn't duplicate the block
- [ ] Removal: `pithy alias --remove` removes only the marker block, leaves other config intact
- [ ] Permissions: read-only rc file produces a clean error message, not a stack trace
- [ ] Missing rc file: installer creates it with safe permissions (`0644`)
- [ ] Unknown shell: installer prints manual instructions, exits 0
- [ ] macOS bash detection: prefers `.bash_profile` if present
- [ ] PowerShell on Windows: uses `function p.` (not `Set-Alias`)
- [ ] Fish syntax: uses `alias p. pithy` (no `=`)
- [ ] `--pithiest` never modifies any file
- [ ] `--pithier` is functionally identical to `pithy alias`

---

## 3. Output styling

Pithy CLI output follows the brand voice (see `BRAND.md` Section 5). Concise lines, deliberate periods, restrained color use.

### 3.1 Status lines

Operations in progress prefix with a status arrow:

```
▸ Installing @pithy-sh/auth...
▸ Updating wrangler.jsonc...
▸ Running migration: auth_0001_create_users...
```

- Arrow `▸` (U+25B8) in the default terminal foreground (don't try to force a color — terminals vary)
- Body text in default foreground
- Trailing `...` indicates in-progress; never used for completed messages

### 3.2 Completion

Successful operations end with a single line:

```
Done.
```

That's it. No emoji, no celebration, no "successfully completed in 2.3s." If timing is genuinely useful (e.g., long deploys), append it minimally:

```
Done. (3.2s)
```

### 3.3 Errors

Errors lead with what went wrong, then what to do:

```
Couldn't connect to Cloudflare API.
Check your CLOUDFLARE_API_TOKEN and try again.
```

- No stack traces in user-facing output (debug mode enables them via `--verbose`)
- First line: the problem, sentence-length, no jargon
- Second line: the action the user should take
- Color: ANSI basic-16 red (terminal-themed) for the first line; default otherwise. See Section 3.4.

### 3.4 Color tiers

The CLI runs in many terminals — light themes, dark themes, custom themes, transparent backgrounds, CI logs. The color layer respects this by using three tiers, picked deliberately per element:

| Tier | ANSI mechanism | Behavior |
|---|---|---|
| Terminal-themed attributes | `\033[2m` (dim) | The user's terminal renders dim text against any theme correctly; no override of their colors |
| Terminal-themed basic-16 | `\033[31m`, `\033[33m`, etc. | The user's terminal defines what "red" looks like; works on light and dark themes equally |
| Truecolor (24-bit RGB) | `\033[38;2;R;G;Bm` | Exact color; used only when Pithy's brand color must remain constant |

Element-to-tier mapping:

| Element | Tier | Reason |
|---|---|---|
| Status arrow `▸`, primary text | None (default foreground) | Inherits terminal foreground; readable in any theme |
| Muted text (descriptions, paths, package names, section labels) | Dim attribute | Reads as secondary against any background |
| Error text | Basic-16 red | User's terminal defines red; respects their theme |
| Warning text | Basic-16 yellow | Same reasoning |
| Saffron brand accent | Truecolor `\033[38;2;212;160;23m` (#D4A017); fall back to 256-color 178; fall back to no color | Brand mark; must be the same color everywhere it renders |

Where saffron appears (and only here):

- The `.` in `Done.` after successful operations
- The period before `sh` in the docs URL footer of help output
- Loading spinner glyphs during long operations
- Update notification "available" indicator
- Nowhere else — saffron earns its place by carrying meaning

Color is automatically **disabled** when:

- `NO_COLOR` env var is set to any value ([no-color.org](https://no-color.org/) standard)
- `process.stdout.isTTY` is false (piped output, CI logs without override)
- The terminal reports zero color support

Color is **forced on** when:

- `FORCE_COLOR` env var is set
- The `--color` flag is passed to any command

Color is **forced off** when:

- The `--no-color` flag is passed (overrides everything else)

**Implementation:** Use `picocolors` for the color layer (zero-dep, ~1KB, handles detection and basic colors). The CLI never writes raw ANSI codes directly; all color flows through helper functions. For truecolor saffron (not exposed by `picocolors`), add a tiny helper:

```ts
import pc from 'picocolors';

const SAFFRON_TC = '\x1b[38;2;212;160;23m';
const SAFFRON_256 = '\x1b[38;5;178m';
const RESET = '\x1b[0m';

export function saffron(text: string): string {
  if (process.env.NO_COLOR || !pc.isColorSupported) return text;
  if (supportsTruecolor()) return SAFFRON_TC + text + RESET;
  return SAFFRON_256 + text + RESET;
}

function supportsTruecolor(): boolean {
  const c = process.env.COLORTERM;
  return c === 'truecolor' || c === '24bit';
}
```

### 3.5 Tables and lists

For multi-row output (e.g., `pithy add --list`), use clean aligned columns with two spaces between, no border characters:

```
auth          Authentication and session management
storage       R2-backed object storage with signed URLs
leaderboard   Multi-tenant ranking with Durable Objects
vector        Vectorize wrapper with metadata helpers
jobs          Scheduled and queued background work
```

No ASCII art boxes. No Unicode borders. The whitespace is the layout.

### 3.6 Prompts

Prompts follow the voice. Short question, default in brackets, period if it's a statement:

```
Use TypeScript? [Y/n]
Project name: [my-pithy-app]
```

Default values shown in brackets. `Y/n` means default yes; `y/N` means default no.

---

## 4. Help text

`pithy --help` (and any subcommand `--help`) follows the same brevity rules.

### 4.1 Top-level help

```
$ pithy --help

A backend kit for Cloudflare Workers.

Usage: pithy <command> [options]

Commands:
  init              Scaffold a new project
  add <capability>  Add a capability (auth, storage, leaderboard, vector, jobs)
  remove <capability>  Remove a capability
  dev               Start the local dev environment
  deploy            Deploy to Cloudflare Workers
  upgrade           Reconcile scaffolded code with current manifests
  alias             Install or remove the shell shortcut
  doctor            Diagnose environment and config

Options:
  -h, --help        Show help
  -v, --version     Print version

Docs: https://pithy.sh
```

### 4.2 Subcommand help

Subcommand help follows the same shape:

```
$ pithy add --help

Add a capability to your Pithy project.

Usage: pithy add <capability> [options]

Capabilities:
  auth          Authentication and session management
  storage       R2-backed object storage
  leaderboard   Multi-tenant ranking
  vector        Vectorize wrapper
  jobs          Scheduled and queued background work

Options:
  --dry-run     Show what would change; don't write
  -h, --help    Show help
```

### 4.3 Color in help

Help text follows the same restraint as the rest of the CLI. Two-tone — default and dim — with one small brand moment.

| Element | Tier |
|---|---|
| Section labels (`Usage:`, `Commands:`, `Options:`, `Capabilities:`) | Dim |
| Command names (left column) | Default foreground |
| Argument syntax (`<capability>`) | Default foreground |
| Descriptions (right column) | Dim |
| `Docs:` label | Dim |
| The URL `https://pithy.sh` | Default foreground, with the period before `sh` rendered in saffron |

The period in the docs URL is the one small brand moment in help output — subtle enough that most users won't consciously notice it, cohesive enough that it ties help back to the brand mark elsewhere.

No bold, no underline, no color highlighting of command names. The structure (two-column alignment, dim labels) does the scannability work without bright accents.

No banners. No ASCII logos. The wordmark belongs on the website, not in the terminal.

---

## 5. Update notifications

Pithy checks for new CLI versions in the background, notifies the user when one is available, and never auto-updates anything.

### 5.1 Cadence

- Background check at most once every 24 hours
- Result cached in `~/.config/pithy/state.json` (POSIX) or `%APPDATA%\pithy\state.json` (Windows)
- Cache contents: last-check timestamp, latest known version, detected installer, notifier opt-out state
- The check fires off-thread via `setImmediate` after the current command's primary work completes — it never blocks command execution

The registry query:

```
GET https://registry.npmjs.org/@pithy-sh%2Fcli/latest
```

If the request fails (offline, network issue, registry hiccup), Pithy silently keeps using the cached value. Update checks are non-essential; they must never break the actual CLI.

### 5.2 Notification output

Notifications are written to **stderr** (never stdout) at the end of any successful command, after `Done.`:

```
$ pithy add auth
▸ Installing @pithy-sh/auth...
▸ Updating wrangler.jsonc...

Done.

pithy 1.3.0 available. You have 1.2.0.
Update: bun update -g @pithy-sh/cli
```

The word `available` and the new version number render in saffron when color is supported. Everything else uses the dim/default conventions from Section 3.4.

Conditions for showing the notification:

- stderr is a TTY (don't pollute piped output or CI logs)
- `PITHY_NO_UPDATE_NOTIFIER` is unset
- A newer **minor or major** version exists (patch versions are suppressed unless flagged)

For **major** version bumps, the notification adds a changelog pointer:

```
pithy 2.0.0 available. You have 1.4.0. (Major release — see changelog.)
Update: brew upgrade pithy
Changelog: https://pithy.sh/changelog/2.0
```

For **patch** version bumps (`1.2.0` → `1.2.1`), notifications are **suppressed** unless the release is flagged with `pithy:security` in its release metadata. Patch noise trains users to ignore notifications; reserving the surface for meaningful updates keeps it useful.

### 5.3 Installer detection

Pithy detects which package manager installed the binary by inspecting `process.argv[1]`. The detection is path-based:

```ts
type Installer = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno' | 'brew' | 'unknown';

function detectInstaller(): Installer {
  const binPath = (process.argv[1] || '').replace(/\\/g, '/');

  if (binPath.includes('/.bun/')) return 'bun';
  if (binPath.includes('/.deno/')) return 'deno';
  if (/\/pnpm\/|\/\.pnpm\//.test(binPath)) return 'pnpm';
  if (/\/(?:home|linux)brew\/|\/Cellar\//.test(binPath)) return 'brew';
  if (/\/\.yarn\/|\/yarn\/global\//.test(binPath)) return 'yarn';
  if (/\/npm\/|\/node_modules\//.test(binPath)) return 'npm';

  return 'unknown';
}

function upgradeCommandFor(installer: Installer): string {
  switch (installer) {
    case 'bun':  return 'bun update -g @pithy-sh/cli';
    case 'pnpm': return 'pnpm update -g @pithy-sh/cli';
    case 'yarn': return 'yarn global upgrade @pithy-sh/cli';
    case 'deno': return 'deno install --reload -g -A -n pithy npm:@pithy-sh/cli';
    case 'brew': return 'brew upgrade pithy';
    case 'npm':
    case 'unknown':
    default:     return 'npm i -g @pithy-sh/cli';
  }
}
```

The detection runs once and is cached in the state file. Unknown installs default to `npm` — anyone with Node has npm, so the fallback is universal.

### 5.4 Homebrew tap

Homebrew users — a significant segment of macOS developers — install via a separate tap repo: **`pithy-sh/homebrew-tap`**.

The tap contains a single Ruby formula:

```ruby
# pithy-sh/homebrew-tap/Formula/pithy.rb
class Pithy < Formula
  desc "Cloudflare-native backend kit"
  homepage "https://pithy.sh"
  url "https://registry.npmjs.org/@pithy-sh/cli/-/cli-#{version}.tgz"
  sha256 "..."  # computed at release time
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", "-g", "--prefix", libexec, "@pithy-sh/cli"
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match(/pithy/, shell_output("#{bin}/pithy --version"))
  end
end
```

User-facing commands:

```
brew install pithy-sh/tap/pithy
brew upgrade pithy
brew uninstall pithy
```

The formula is updated automatically by a GitHub Actions workflow on every `@pithy-sh/cli` npm release:

1. Triggers on `release.published` for `pithy-sh/cli`
2. Computes the SHA-256 of the new npm tarball
3. Opens a PR on `pithy-sh/homebrew-tap` updating the formula's `url` and `sha256`
4. Auto-merges if `brew test` passes against the new formula

This keeps Homebrew users on the same release cadence as npm users with no manual formula maintenance.

### 5.5 Opt-out

Users can disable the update notifier in three ways:

| Method | Persistence |
|---|---|
| `PITHY_NO_UPDATE_NOTIFIER=1` env var | Per-shell, or persistent if added to rc file |
| `pithy doctor --disable-notifier` | Persisted in state file |
| Edit `~/.config/pithy/state.json` and set `"notifier": false` | Persisted in state file |

The corresponding `pithy doctor --enable-notifier` re-enables it.

### 5.6 The `pithy doctor` command

`pithy doctor` is the user-initiated health check. It bypasses the 24-hour cache, performs a fresh registry query, and reports the full environment state:

```
$ pithy doctor

pithy 1.2.0 (installed via bun)
Update available: 1.3.0
Run: bun update -g @pithy-sh/cli

Shell: zsh (~/.zshrc)
Alias: installed (`p.` → `pithy`)

Config dir: ~/.config/pithy
State file: ~/.config/pithy/state.json
Notifier:   enabled (PITHY_NO_UPDATE_NOTIFIER to disable)

Project: pithy.config.ts found
Project capabilities:
  @pithy-sh/core         1.2.0 ✓
  @pithy-sh/auth         1.1.8 (1.2.0 available — run `pithy upgrade`)
  @pithy-sh/leaderboard  1.2.0 ✓

OS:   macOS 14.5
Node: 22.10.0
```

When everything is up to date, the output is correspondingly terser:

```
$ pithy doctor

pithy 1.3.0 (installed via brew)
Up to date.

Shell: zsh
Alias: installed

Project: pithy.config.ts found
Project capabilities: all up to date

OS:   macOS 14.5
Node: 22.10.0
```

Outside a Pithy project directory, the `Project:` lines are omitted.

### 5.7 Project capability updates

Distinct from CLI updates. When run inside a Pithy project, the doctor command reports outdated capability packages alongside the CLI version. Two upgrade paths, two distinct commands:

| To update... | Run... |
|---|---|
| The Pithy CLI binary | The installer-specific command (e.g., `npm i -g @pithy-sh/cli`, `brew upgrade pithy`) |
| Project capabilities | `pithy upgrade` |

These are intentionally separate. The CLI binary version is one concept; a project's capability versions are another. Conflating them would confuse the upgrade story and produce ambiguous commands.

### 5.8 Testing checklist

- [ ] Update check never blocks command execution
- [ ] Network failure during check is silent; cached value continues to be used
- [ ] `NO_COLOR` disables the saffron accent on the notification
- [ ] `PITHY_NO_UPDATE_NOTIFIER` suppresses the notification entirely
- [ ] Non-TTY stderr (piped, CI) suppresses the notification
- [ ] Patch version bumps don't trigger notifications (unless flagged)
- [ ] Installer detection returns correct command for npm, pnpm, yarn, bun, deno, brew
- [ ] Unknown installer falls back to `npm i -g @pithy-sh/cli`
- [ ] `pithy doctor` always performs a fresh check, bypassing cache
- [ ] Homebrew tap formula updates automatically on npm release
- [ ] `pithy doctor --disable-notifier` persists across runs

---

## 6. Local dev orchestration (`pithy dev`)

`pithy dev` runs the whole backend — every Worker in `apps/`, plus any web frontend — under one supervising process, so a developer never hand-juggles terminals or ports. It ports the proven CMS `scripts/dev.ts` design.

### 6.1 What it does

- **Discovers workers from `apps/`.** `apps/` *is* the registry — `pithy dev` enumerates `apps/*` (no hand-maintained list) and reads each worker's co-located `dev` manifest block: `dev.autostart` (does this worker need to run for the local env to function?), `dev.readySignal` (regex marking "ready" in its output, default `/Ready on https?:\/\//`), and an optional `dev.preferredPort`. It starts exactly the `autostart` workers. Add or remove a worker with `pithy worker add|remove` and the dev set follows automatically.
- **Supervises N workers.** Spawns each autostart worker, labels and colorizes their interleaved output, and tees everything to the terminal *and* `logs/dev.log`. A single "ready" banner prints once every started worker matches its `dev.readySignal`.
- **Resolves ports safely.** Each worker's start port comes from the worktree's port block (Section 6.3). A port is only used if free on **both** `127.0.0.1` and `::1` (Vite binds IPv6-only, wrangler binds both); otherwise the orchestrator scans forward.
- **Wires workers to each other over localhost.** Resolved ports are exported as env and the cross-worker URLs are baked in as `*_ORIGIN` dev vars, so workers call each other directly — never relying on wrangler's flaky cross-`wrangler dev` service registry.

### 6.2 Session state and cleanup

- Writes a git-ignored `.dev-state.json` (pid, resolved ports, child pids).
- A re-run stops the previous session first, then **reaps orphaned `workerd`/`wrangler`** processes still holding the default ports (an `lsof` sweep) so a crashed session can't block startup.
- Children are spawned via `setsid` so one `kill(-pgid)` tears down the whole `wrangler → workerd` subtree. Teardown is graceful `SIGTERM`, then `SIGKILL` after a short grace window.

### 6.3 Per-feature ports (run many worktrees at once)

Port collisions are the one thing that stops two feature worktrees running simultaneously. The fix is a **central registry that every feature reads before it assigns** — so a new feature sees what's already taken and can't collide.

- **The registry** is a single git-ignored **`.dev-ports.json`** at the **main repo root** (the parent of `.worktrees/`). A worktree resolves it from anywhere via `git rev-parse --git-common-dir`. It's a map keyed by feature branch:

  ```json
  {
    "feature/12-auth":  { "backend": 8800, "frontend": 8801 },
    "feature/34-email": { "backend": 8820, "frontend": 8821 }
  }
  ```

- **`pithy feature create`** takes a short file lock, reads the registry (seeing every block already in use), assigns the **lowest free, non-overlapping block**, writes its key, and unlocks. One atomic read-modify-write — no two features can pick the same block.
- **`pithy feature destroy`** (and merge-to-`main` cleanup) deletes its key, returning the block to the pool. Add/remove is a single keyed mutation; no per-branch files to orphan.
- **Each worktree** also gets a git-ignored **`.dev.ports.json`** holding just its own block (projected from the registry entry); `pithy dev` reads it as its start ports, and the `*_PORT`/`*_ORIGIN` values are surfaced into the composed `.dev.vars`. (Distinct from `.dev-state.json`, the running session's pid/child-pids from Section 6.2.)
- `pithy dev` still verifies each assigned port is actually free (IPv4 + IPv6) and scans forward if something external grabbed it. Because blocks are disjoint and stable, multiple worktrees run in unison and each feature's workers reach each other on their assigned localhost ports.

> **Why one keyed registry, not a file per branch** (`.dev-ports.<branch>.json`)? A single file shows every allocation in one read, makes add/remove a one-key mutation, and leaves no stale per-branch files to garbage-collect. File-per-branch works but forces a glob-and-read-all to see what's taken.

### 6.4 Voice

All `pithy dev` output obeys the brand voice (Section 3 / `BRAND.md` §5): labeled lines, deliberate periods, no celebration. The ready banner is information, not confetti.

---

## 7. Cross-platform notes

- **Path handling:** Use `node:path` for all path joins; never concatenate strings. Windows paths must work.
- **Line endings:** Write `\n` on POSIX, `\r\n` on Windows. Detect via `os.EOL`.
- **File permissions:** Created rc files get `0644` on POSIX; on Windows, default ACLs.
- **Terminal width:** Detect via `process.stdout.columns`; fall back to 80 if undefined.
- **TTY detection:** Use `process.stdout.isTTY` to enable color and interactive prompts. Non-TTY (piped) output must be plain text and parseable.

---

## 8. Future expansions

This document covers v1, which ships the full alias system, update notifications with installer detection, the Homebrew tap, the `doctor` command, and the `dev` orchestrator. Areas to formalize in v1.1+:

- `pithy plugin` — third-party capability installation
- `pithy logs` — tail Workers logs via the customer-deployed admin Worker
- `pithy secrets` — cross-environment secret management
- Telemetry opt-in/out (mirroring the `pithy alias` install flow)
- Self-update command (`pithy self-update`) — currently we suggest the installer-specific command rather than running it

Each new command should be reviewed against this document's principles: verb-noun shape, concise output, deliberate periods, no jargon, never write to user files without consent.
