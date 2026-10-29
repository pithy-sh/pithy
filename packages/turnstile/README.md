# @pithy-sh/turnstile

A Cloudflare Turnstile humanity check for Pithy. One piece of stackable middleware. No tables of its own.

It also mounts one public page, `GET /turnstile/widget`: the login widget on the Worker's own origin, which a phone renders in a WebView and which posts the solved token back to the app. The deployed Worker resolves the sitekey for its own environment on each request, so a phone build carries none.

It answers one question — *is this a human?* — and stacks on top of any route's real verification strategy. It is not one itself.

```sh
pithy add turnstile
```

**Documentation: [pithy.sh/docs/capabilities/turnstile](https://pithy.sh/docs/capabilities/turnstile).** Overview, adding it, using it, and the reference: provisioning, the widget rules, dev values.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
