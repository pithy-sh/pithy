# A git credential helper

A git client needs a token for every clone, fetch and push. The tokens this capability mints live `tokenTtlSeconds` — fifteen minutes by default, an hour at most — so something has to mint a fresh one each time. That is a credential helper, and this page is one.

## Why the token is short

A token minted for somebody keeps working until it expires, whatever happens to their grant afterwards, so its life is the revocation window. The kit records every token it mints and who it was minted for, never its value, so the question *who can still push* has an answer: a management client lists a repository's tokens with their holders, and can revoke one, or all, with a reason ([`docs/CONTROL-PLANE.md`](../../../docs/CONTROL-PLANE.md)). The owner's way to end them sooner is the break-glass: `DELETE /artifacts/repos/<name>/credentials`, which only the owner may call, revokes every live token on the repository at once. Every git client holding one is refused on its next request and must mint again, and a person whose grant is gone cannot. The long-lived credential is your app's own — a session, a bearer token from `@pithy-sh/auth`, or an API key from Better Auth's `apiKey()` plugin ([below](#an-api-key-for-a-machine)) — and you revoke that in `auth`. The Artifacts token is a short derivative of it. This capability never issues anything longer.

## The helper

Save this as `git-credential-pithy` somewhere on your `PATH`, and make it executable.

```sh
#!/bin/sh
# git-credential-pithy: hands git a fresh Artifacts token, minted by your app.
#
# Needs PITHY_APP_URL (your Worker's origin), and one of PITHY_APP_TOKEN (a session or bearer token from your app)
# or PITHY_APP_KEY (an API key from Better Auth's apiKey() plugin).
set -eu

# git calls `get` for a credential, and `store` or `erase` afterwards. Only `get` has work to do.
[ "${1:-}" = "get" ] || exit 0

# Say why on stderr, then answer quit=1: git asks no other helper and prompts nobody, and the operation fails.
refuse() {
  printf 'git-credential-pithy: %s\n' "$1" >&2
  printf 'quit=1\n'
  exit 0
}

path=""
while IFS= read -r line && [ -n "$line" ]; do
  case "$line" in
    path=*) path="${line#path=}" ;;
  esac
done

[ -n "${PITHY_APP_URL:-}" ] || refuse "set PITHY_APP_URL."

# A token goes as a bearer token. A key goes as x-api-key, the header Better Auth's apiKey() plugin reads.
if [ -n "${PITHY_APP_TOKEN:-}" ] && [ -z "${PITHY_APP_KEY:-}" ]; then
  header="Authorization: Bearer ${PITHY_APP_TOKEN}"
elif [ -n "${PITHY_APP_KEY:-}" ] && [ -z "${PITHY_APP_TOKEN:-}" ]; then
  header="x-api-key: ${PITHY_APP_KEY}"
else
  refuse "set PITHY_APP_TOKEN or PITHY_APP_KEY, not both."
fi

# The remote is .../git/<namespace>/<repo>.git, so the repository is the last segment.
[ -n "$path" ] || refuse "git sent no repository path. Set credential.useHttpPath true."
repo=$(basename "$path" .git)

# The status goes on a line of its own after the body, so a refusal's body can be read too.
# The header reaches curl on stdin, never in its argv, where any local user can read it. printf is a shell builtin.
response=$(printf '%s\n' "$header" | curl -sS -X POST -w '\n%{http_code}' -H @- \
  "${PITHY_APP_URL}/artifacts/repos/${repo}/credentials") || refuse "could not reach ${PITHY_APP_URL}."
status=$(printf '%s' "$response" | tail -n 1)
body=$(printf '%s' "$response" | sed '$d')

# One string field of the JSON body. A refusal is {"error":{"code":"...","message":"..."}}.
field() { printf '%s' "$body" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n 1; }

case "$status" in
  2??) ;;
  *) refuse "the mint was refused, ${status} $(field code): $(field message)" ;;
esac

token=$(field token)
[ -n "$token" ] || refuse "the mint answered ${status} with no token."

# The token ends `?expires=<unix seconds>`. git 2.41 and later read password_expiry_utc and come back after it.
printf 'username=x\npassword=%s\npassword_expiry_utc=%s\n' "$token" "${token##*expires=}"
```

Then point git at it, for the Artifacts host only, and have git pass the repository path:

```sh
git config --global credential.https://<ACCOUNT_ID>.artifacts.cloudflare.net.helper pithy
git config --global credential.https://<ACCOUNT_ID>.artifacts.cloudflare.net.useHttpPath true
```

`useHttpPath` is not optional. Without it git sends the host and nothing else, and the helper cannot tell one repository from another.

## An API key, for a machine

A CI job has no session. Give it an API key from Better Auth's `apiKey()` plugin and set `PITHY_APP_KEY` instead of `PITHY_APP_TOKEN`. The helper sends a key as `x-api-key`, the header the plugin reads, and never as a bearer token, which Better Auth reads as a session token and refuses. Set one of the two, never both.

The plugin lets a key stand for its owner only when you say so, and it limits each key to ten requests a day by default. A git client mints once per operation, so the eleventh fetch of the day would be refused. Compose it like this:

```ts
import { apiKey } from "@better-auth/api-key";

auth({
  // ...
  plugins: [apiKey({ enableSessionForAPIKeys: true, rateLimit: { enabled: false } })],
});
```

Or keep the limit and size `rateLimit.maxRequests` to the job. Keep the plugin's default header: `@pithy-sh/auth` resolves a key sent as `x-api-key`, and a renamed header never reaches it. Both behaviors, the refusal and the limit, are pinned by `packages/auth/src/http/apiKeySession.workers.test.ts`.

## Which git

The helper answers with the token as the HTTP Basic password. Cloudflare documents that form: the token goes in the password slot, and the username is ignored, so any non-empty one will do ([Artifacts · Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)). Basic is the scheme every git's credential protocol speaks, so this needs no particular git.

A refused mint stops git where it is. The helper prints the mint's `code` and `message` on stderr, as `git-credential-pithy: the mint was refused, 404 artifacts/not_found: …`, and answers `quit=1`, so git consults no other helper and asks nobody for a username. git honors `quit` from 2.3. An app it cannot reach, and an answer with no token, are refused the same way.

`password_expiry_utc` is read by git 2.41 and later. An older git ignores it, which costs nothing: it asks the helper again on the next operation either way, and the helper mints again.

The bearer form, `git -c http.extraHeader="Authorization: Bearer $TOKEN"`, is Cloudflare's recommendation for a single command by hand. A credential helper cannot set a header on a git older than 2.46, which is the reason this one uses Basic.

## Use it

```sh
export PITHY_APP_URL=https://app.example.com
export PITHY_APP_TOKEN=...   # your app's credential for this person, or PITHY_APP_KEY for an API key
git clone "$(printf 'Authorization: Bearer %s\n' "$PITHY_APP_TOKEN" | curl -fsS -X POST -H @- \
  "$PITHY_APP_URL/artifacts/repos/<name>/credentials" | sed -n 's/.*"remote":"\([^"]*\)".*/\1/p')"
```

The app's credential goes to curl on stdin, as `-H @-`, and never on its command line. A process's arguments are readable by every user on the machine, through `ps` or `/proc/<pid>/cmdline`, and this credential is the one that mints write tokens. `-H @-` needs curl 7.55 or later.

Every fetch and push after that asks the helper, and the helper mints. A person with a `read` grant gets a read token, and a push is refused by Cloudflare. A person whose grant you removed is refused at the mint, and pushes with the token they hold until it expires. To stop them now, remove the grant and then revoke every token: `DELETE /artifacts/repos/<name>/credentials`. It reaches every token on the repository, past the 30 Cloudflare's listing shows at a time, and the live suite checks that with git on each release run. Everybody else's helper mints again on their next operation, and theirs is refused.

## Verify it

Run this against a live repository before you hand the helper to anybody, with `tokenTtlSeconds` at its floor of 60 so the last step does not take a quarter of an hour:

1. Clone the repository through the helper.
2. Commit a file and push it.
3. Wait past the token's expiry.
4. Commit again and push. git asks the helper, the helper mints, and the push lands.
5. Remove the person's grant. Push again: refused at the mint, with `artifacts/not_found`.
6. Mint with a second person's grant and push, then call `DELETE /artifacts/repos/<name>/credentials` as the owner. That person's next push asks the helper for a fresh token and lands, which is the break-glass costing them nothing.
