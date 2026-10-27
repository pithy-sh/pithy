# @pithy-sh/media

Store, track, and enrich media on your own Cloudflare account. Images, video, audio, documents. Config picks the backend; the package does the rest.

Bytes never proxy through your Worker — the client uploads straight to Cloudflare.

```sh
pithy add media
```

**Documentation: [pithy.sh/docs/capabilities/media](https://pithy.sh/docs/capabilities/media).** Overview, adding it, using it, and the reference: the backends, provisioning, AI enrichment.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## A person's data

**Erased.** When an account is purged, media deletes every record the person holds as themselves, with its bytes in R2, Cloudflare Images or Stream and its dedup hashes, and an export hands the records back first. A record made while acting for an organization is the organization's, and that organization's purge erases it. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
