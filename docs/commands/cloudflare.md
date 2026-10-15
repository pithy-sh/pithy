# pithy cloudflare

_The site renders this for readers: [pithy.sh/docs/cli/commands/cloudflare](https://pithy.sh/docs/cli/commands/cloudflare). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Sign in to Cloudflare in a browser, and choose which session each directory uses.

## Synopsis

```bash
pithy cloudflare connect [--profile <name>] [--account <id>] [--no-open] [--json]
pithy cloudflare disconnect [--profile <name>] [--unbind] [--json]
pithy cloudflare use <profile> [dir] [--default] [--json]
```

## Flags

| Subcommand | Flag | Meaning |
|---|---|---|
| `connect`, `disconnect` | `--profile <name>` | The profile to sign in or out. Defaults to the profile bound here, then the project's `cloudflare.accountName`, then `default`. |
| `connect` | `--account <id>` | The account to use when the sign-in can see several and the project pins none. |
| `connect` | `--no-open` | Print the sign-in address without opening a browser. `PITHY_NO_OPEN` says the same. |
| `disconnect` | `--unbind` | Also remove the binding that applies here — this directory's, a parent's, or the default. |
| `use` | `<profile>` (positional, required) | The profile to bind. |
| `use` | `[dir]` (positional) | The directory to bind. Defaults to this one. |
| `use` | `--default` | Make the profile the one used where no directory is bound. |
| all | `--json` | Machine-readable output. Default `false`. |

## What it does

**`connect` signs you in to Cloudflare and keeps a session, so no API token is made by hand.** It asks Cloudflare for exactly the permissions this project's tokens carry — `ci-system` and every capability's profile, in every environment — and nothing beyond them. A project that composes no vector capability never asks for a Vectorize permission, and the consent screen you read says so. Outside a project, it asks for what a project with no capabilities would need.

It prints the sign-in address first, every time, then opens it in your browser. It waits for whichever comes back first: the browser's redirect to `http://127.0.0.1:<port>/callback`, on a port the system chooses, or the address you paste. **Paste the address when the browser runs on another machine**, as it does over SSH. The redirect lands on that machine, where nothing is listening, so the browser shows a page that can't be reached. That is expected, and the sign-in has worked: copy the page's whole address from the address bar and paste it at the prompt. `connect` says so before the browser opens. Without a terminal there is nothing to paste into, so only the redirect is waited for.

**Cloudflare lists one permission under "Sensitive scopes", switched off: Account API Tokens Write.** Turn it on before you approve. With it off, Cloudflare does not grant the rest — it shows *"We could not complete the authorization. Please check your network connection and try again."* and never redirects. `connect` names the switch before it opens the browser, and again if it times out. A grant that comes back missing any permission it asked for is refused, naming the permission.

**A sign-in does not quietly move a profile to another account.** With no `--profile` named, `connect` refuses to replace a profile's session for one account with a session for another, because every directory bound to that profile would move with it. Name the profile to make that choice.

The account is discovered, not typed: the project's `cloudflare.accountId` decides when it pins one, then `--account`, then the only account the sign-in can see. When it can see several and nothing decides, an interactive run asks; a run that cannot ask is refused, naming `--account` and the ids.

The session is written to `<config>/session.<profile>.json`, mode `0600`. The profile is bound to this directory in `<config>/profiles.json`, mode `0664`, which holds directory names and nothing secret. A repository is bound by its main checkout, so its worktrees use the same session. Both files live in the config directory, never in a checkout.

**A profile bound to a directory is used by every command run there**, and it wins over `<config>/cloudflare.json`. An exported `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` that differs from the session is refused, naming both, rather than quietly preferring either. A directory nothing is bound to resolves credentials exactly as before, so CI is unaffected. Under a session, the store id and R2 credentials come from `cloudflare.json` only when that file is about the same account, or names none.

The access token lasts an hour and renews without a browser. Every command renews it first when it has less than five minutes left, under a lock, so two `pithy` processes never renew one profile at once. A session that cannot be renewed is refused at the first command that needs Cloudflare, with the `connect` that fixes it. A command that needs no Cloudflare call never stops over it. Offline (`PITHY_OFFLINE`) nothing is renewed and nothing is refused for it: an expired session resolves the token it has, and a profile bound but signed out resolves no credentials.

`disconnect` revokes the session at Cloudflare and deletes the file. If Cloudflare does not confirm the revocation, the file is deleted anyway and the command fails, saying so, because the grant may still be live. The binding stays, so the next command run there asks you to sign in again rather than falling back to an exported token. `--unbind` removes the binding that applies here too — this directory's, a parent directory's, or the default — so the directory resolves credentials as if no profile had been bound.

`use` binds a profile to a directory, or with `--default`, makes it the profile used where nothing is bound. It does not sign in; it says when the profile has no session yet.

## `--json`

One line on stdout. A failure is one `{"error": …}` line on stderr and a non-zero exit. Under `connect --json` the sign-in address and every instruction go to stderr, so stdout stays one document.

### `cloudflare connect`

| key | type | meaning |
|---|---|---|
| `command` | string | `"cloudflare connect"`. |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `profile` | string | The profile signed in. |
| `email` | string or null | Who signed in. Every audit row the CLI writes under this session names them. |
| `account` | object | The account the session acts on: `account.id` and `account.name`. |
| `boundTo` | string | The directory the profile is bound to — a repository's main checkout. |
| `scopes` | string[] | The permissions granted. |
| `expiresAt` | string | When the access token expires, ISO-8601. It renews without a browser. |

### `cloudflare disconnect`

| key | type | meaning |
|---|---|---|
| `command` | string | `"cloudflare disconnect"`. |
| `schemaVersion` | integer | As above. |
| `profile` | string | The profile signed out. |
| `revoked` | boolean | Whether Cloudflare revoked a session. `false` when there was none. |
| `sessionDeleted` | boolean | Whether a session file was deleted from this machine. |
| `unbound` | boolean | Whether this directory's binding was removed, with `--unbind`. |

### `cloudflare use`

| key | type | meaning |
|---|---|---|
| `command` | string | `"cloudflare use"`. |
| `schemaVersion` | integer | As above. |
| `profile` | string | The profile bound. |
| `boundTo` | string or null | The directory bound, or `null` when `--default` set it as the default. |
| `signedIn` | boolean | Whether the profile has a session on this machine yet. |
