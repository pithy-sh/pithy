# @pithy-sh/storage

General file storage in your own R2 bucket, with an owner, a quota, and a link you can take back.

Uploads never proxy through your Worker — the client PUTs straight to a presigned URL, and anything past 100 MiB becomes resumable parts. Downloads deliberately do stream through it, because that is the only way a read can be authorized per request.

```sh
pithy add storage
```

**Documentation: [pithy.sh/docs/capabilities/storage](https://pithy.sh/docs/capabilities/storage).** Overview, adding it, using it, and the reference: the object model, provisioning, shares.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
