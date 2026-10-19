# A git credential helper

A git client needs a token for every clone, fetch and push. The tokens this capability mints live `tokenTtlSeconds` — fifteen minutes by default, an hour at most — so something has to mint a fresh one each time. That is a credential helper, and this page is one.

## Why the token is short

There is no token table. A token minted for somebody keeps working until it expires, whatever happens to their grant afterwards, so its life is the revocation window. The long-lived credential is your app's own — a session, a bearer token from `@pithy-sh/auth`, an API key if you compose Better Auth's `apiKey()` plugin — and you revoke that in `auth`. The Artifacts token is a short derivative of it. This capability never issues anything longer.

## The helper

Save this as `git-credential-pithy` somewhere on your `PATH`, and make it executable.

```sh
#!/bin/sh
# git-credential-pithy: hands git a fresh Artifacts token, minted by your app.
#
# Needs PITHY_APP_URL (your Worker's origin) and PITHY_APP_TOKEN (your app's own credential for this person).
set -eu

# git calls `get` for a credential, and `store` or `erase` afterwards. Only `get` has work to do.
[ "${1:-}" = "get" ] || exit 0

path=""
while IFS= read -r line && [ -n "$line" ]; do
  case "$line" in
    path=*) path="${line#path=}" ;;
  esac
done

# The remote is .../git/<namespace>/<repo>.git, so the repository is the last segment.
repo=$(basename "$path" .git)
[ -n "$repo" ] || exit 1

response=$(curl -fsS -X POST \
  -H "Authorization: Bearer ${PITHY_APP_TOKEN}" \
  "${PITHY_APP_URL}/artifacts/repos/${repo}/credentials")

token=$(printf '%s' "$response" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || exit 1

# The token ends `?expires=<unix seconds>`. git 2.41 and later read password_expiry_utc and come back after it.
printf 'username=x\npassword=%s\npassword_expiry_utc=%s\n' "$token" "${token##*expires=}"
```

Then point git at it, for the Artifacts host only, and have git pass the repository path:

```sh
git config --global credential.https://<ACCOUNT_ID>.artifacts.cloudflare.net.helper pithy
git config --global credential.https://<ACCOUNT_ID>.artifacts.cloudflare.net.useHttpPath true
```

`useHttpPath` is not optional. Without it git sends the host and nothing else, and the helper cannot tell one repository from another.

## Which git

The helper answers with the token as the HTTP Basic password. Cloudflare documents that form: the token goes in the password slot, and the username is ignored, so any non-empty one will do ([Artifacts · Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)). Basic is the scheme every git's credential protocol speaks, so this needs no particular git.

`password_expiry_utc` is read by git 2.41 and later. An older git ignores it, which costs nothing: it asks the helper again on the next operation either way, and the helper mints again.

The bearer form, `git -c http.extraHeader="Authorization: Bearer $TOKEN"`, is Cloudflare's recommendation for a single command by hand. A credential helper cannot set a header on a git older than 2.46, which is the reason this one uses Basic.

## Use it

```sh
export PITHY_APP_URL=https://app.example.com
export PITHY_APP_TOKEN=...   # your app's credential for this person
git clone "$(curl -fsS -X POST -H "Authorization: Bearer $PITHY_APP_TOKEN" \
  "$PITHY_APP_URL/artifacts/repos/<name>/credentials" | sed -n 's/.*"remote":"\([^"]*\)".*/\1/p')"
```

Every fetch and push after that asks the helper, and the helper mints. A person with a `read` grant gets a read token, and a push is refused by Cloudflare. A person whose grant you removed is refused at the mint, and pushes with the token they hold until it expires.

## Verify it

Run this against a live repository before you hand the helper to anybody, with `tokenTtlSeconds` at its floor of 60 so the last step does not take a quarter of an hour:

1. Clone the repository through the helper.
2. Commit a file and push it.
3. Wait past the token's expiry.
4. Commit again and push. git asks the helper, the helper mints, and the push lands.
5. Remove the person's grant. Push again: refused at the mint, with `artifacts/not_found`.
