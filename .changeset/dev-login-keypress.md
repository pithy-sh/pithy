---
"@pithy-sh/core": minor
"@pithy-sh/auth": minor
"@pithy-sh/cli": minor
---

Press `l` to open a signed-in browser, instead of pasting a cookie

`pithy dev` no longer prints a session cookie. The ready banner used to hand over a live credential as text —
`document.cookie = "better-auth.session_token=…"` — to paste into a browser console. A working session token
rendered on a terminal is a working session token at rest, in a scrollback, in `logs/dev.log`, and in every
screenshot of either. The seed already flagged that artifact as sensitive; printing it was the one place the
rule was suspended by design.

Now the banner names the user and offers a keypress: `Dev login: ada@example.com — press l to open a signed-in
browser.` Pressing `l` opens `http://localhost:<port>/__pithy/dev-login` in whatever browser is default. The
Worker sets the cookie and redirects to `/`. The value travels from the Worker to the browser and lands
nowhere else.

`@pithy-sh/auth` registers that route behind **two independent gates, both at registration**: the composition's
`ENVIRONMENT` must be `dev`, and `CI` must be unset or blank. A route that mints an authenticated session with
no credential presented cannot be allowed to reach staging or production, and CI runs `dev` compositions
constantly, so neither gate implies the other and neither is folded into the other. A `staging` composition, a
`prod` composition, and a `dev` composition under CI each carry no such route at all.

`CI` is now read in one place, `@pithy-sh/core`'s `env/ci.ts`, with `PITHY_OFFLINE`'s rule: any non-blank value
is set, blank is no override. `pithy dev` forwards it into each Worker as a var, because the host environment
does not otherwise cross into workerd.

A non-TTY `pithy dev` — CI, a pipe, `--json` — never enters raw mode and never waits for input; the banner
prints the URL instead. `l` with no seeded session says so and names `pithy seed` rather than opening a URL
that 404s. A project where several Workers compose auth prints the choices instead of guessing which origin
to sign in on.
