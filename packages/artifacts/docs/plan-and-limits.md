# Plan, prices and limits

## Workers Paid only

Cloudflare Artifacts runs on the Workers Paid plan and nowhere else. On a Free plan the binding composes, the Worker deploys, and the first `create` is refused at runtime, in production. Check the plan before you ship.

## Billing begins 14 October 2026

Cloudflare bills Artifacts on two dimensions, each past a monthly allowance:

| Dimension | Included | Then |
|---|---|---|
| Operations | 10,000 a month | $0.15 per 1,000 |
| Storage | 1 GB-month | $0.50 per GB-month |

Cloudflare counts repository operations, "such as `create`, `push`, `pull`, and `clone`", and does not publish a complete list. So estimate from what each route calls, and treat the calls it does not name as possible operations. The routes that list repositories, `GET /repos` and `GET /organization/repos`, and the routes that set or remove a grant read and write D1 only. They never reach Cloudflare. Every other route opens the repository first, which is one call into the binding, and then makes its own. Reading a repository is two: open, then its info. A mint is three: open, the token, and the repository's remote. A create is three: the repository, then open it and revoke the token Cloudflare made with it. Each `git` clone, fetch or push is Cloudflare's own operation, and a git client mints once for each one it runs, by design, so a busy repository costs operations rather than standing credentials.

Source: [Artifacts · Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/).

## Limits

| Limit | Value |
|---|---|
| Storage per repository | 1 GB |
| Storage per account | 1 TB, raised on request |
| Largest file or blob | 32 MB |
| Control-plane requests | 2,000 per 10 seconds, per namespace |
| Git requests | 2,000 per 10 seconds, per repository |
| Namespace name | 2 to 63 characters |
| Repository name | A letter or digit, then letters, digits, `.`, `_` and `-`. Pithy holds it to 63 characters |

The kit does not meter a customer's storage against either cap. `GET /artifacts/repos/:name` reports what Cloudflare holds, and what to do about a large repository is your decision.

Each environment has its own namespace, `<project>-<env>`, so production's rate limit is production's alone. A feature's is `<project>-f<issue>-<slug>--artifacts`, and `pithy feature destroy` deletes every repository in it, because a repository nobody deletes counts against the account's terabyte forever. Then it deletes the namespace.

Source: [Artifacts · Limits](https://developers.cloudflare.com/artifacts/platform/limits/).
