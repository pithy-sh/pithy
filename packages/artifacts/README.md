# @pithy-sh/artifacts

Git repositories for your own customers, backed by Cloudflare Artifacts. Owned by a person or an organization, read in the Worker or cloned over the wire, with short-lived tokens the kit mints against a grant you control.

```sh
pithy add artifacts
```

**Artifacts is Workers Paid only.** Cloudflare bills it from 14 October 2026. [`docs/plan-and-limits.md`](docs/plan-and-limits.md) has the prices and the caps.

**Documentation: [pithy.sh/docs/capabilities/artifacts](https://pithy.sh/docs/capabilities/artifacts).** Overview, adding it, using it, and the reference. The git side is [`docs/credential-helper.md`](docs/credential-helper.md).

**A management client** reads every repository, its grants, history and tokens behind `artifacts:repos:read`, and revokes one token or every live one behind `artifacts:tokens:revoke`, with an idempotency key, a required reason and an audit event. The routes sit under `/artifacts/admin/`. Cloudflare names no token's holder, so the kit records every token it mints in `pithy_artifacts_tokens` — its id, repository, user, scope and expiry, never its value — and a listed token it did not mint is reported as minted outside Pithy. [`docs/CONTROL-PLANE.md`](../../docs/CONTROL-PLANE.md) §13 has the rest.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## A person's data

**Erased.** When an account is purged, artifacts deletes every repository the person owns, with its contents in the Artifacts namespace and every grant on it, and every grant they hold on somebody else's, and an export hands them back first, with the record of every token minted for them. That record keeps the token and loses the person's id, so a token still listed reads as the kit's. A repository an organization owns is the organization's. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
