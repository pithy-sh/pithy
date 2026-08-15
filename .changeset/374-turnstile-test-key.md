---
"@pithy-sh/turnstile": minor
"@pithy-sh/auth": patch
---

Let dev and staging sign in with the test key, without relaxing the action binding anywhere.

`provisionTurnstile` wires Cloudflare's always-pass test secret into dev and staging, `@pithy-sh/auth` stacks its gate as `turnstile({ action: "login" })`, and — verified live against real siteverify — that secret answers `success: true` with **no `action` field at all**. So the binding compared `"login"` against nothing and denied every passwordless sign-in in both environments. The token was valid, siteverify said so, and the refusal came from a field the key never populates.

The binding is unchanged. One exception is added, and it needs all three of: Cloudflare's own `metadata.result_with_testing_key` flag on the answer, **no** action returned, and the Worker's stamped `ENVIRONMENT` being `dev` or `staging`. An action that comes back and *differs* is still refused — that is the replay the binding exists to stop, and dev is not a place it becomes acceptable. A real widget's answer never carries the flag, so no production deployment can reach the branch however its secret is spelled.

The same flag now runs the other way outside those two environments. A test key answering for a `prod` — or unstamped — Worker raises `turnstile/config` rather than passing: a secret that passes everybody on a production login page is a door, and it should be the loudest line in the log rather than a quiet 200. Production is strictly stricter than it was.

**And a wrong secret stops reading as a failed challenge.** siteverify answers HTTP 400 `invalid-input-secret` for a secret it has never issued, which the fail-closed branch rendered as `turnstile/failed` (403) — an operator told that a user failed a challenge, when in truth nobody could ever pass one there. Secret-side error codes now raise `turnstile/config` (500) with an `action` line naming `pithy turnstile provision`. Both directions still deny.
