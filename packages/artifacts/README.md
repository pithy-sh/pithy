# @pithy-sh/artifacts

Git repositories for your own customers, backed by Cloudflare Artifacts. Owned by a person or an organization, read in the Worker or cloned over the wire, with short-lived tokens the kit mints against a grant you control.

```sh
pithy add artifacts
```

**Artifacts is Workers Paid only.** Cloudflare bills it from 14 October 2026. [`docs/plan-and-limits.md`](docs/plan-and-limits.md) has the prices and the caps.

**Documentation: [pithy.sh/docs/capabilities/artifacts](https://pithy.sh/docs/capabilities/artifacts).** Overview, adding it, using it, and the reference. The git side is [`docs/credential-helper.md`](docs/credential-helper.md).

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## A person's data

**Erased.** When an account is purged, artifacts deletes every repository the person owns, with its contents in the Artifacts namespace and every grant on it, and every grant they hold on somebody else's, and an export hands them back first. A repository an organization owns is the organization's. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
