---
"@pithy-sh/cli": patch
---

`pithy dashboard connect` offers to open the approval page.

The device-code flow printed a URL and a code and left the operator to select, copy and paste. It now states a key while it waits:

```
Open https://app.pithy.sh/cli and enter ABCD-EFGH.
Press o to open the link in the browser.
▸ Waiting for approval...
```

A stated key, not a prompt. The command is already polling and must finish whether or not anybody touches the keyboard, so a blocking yes/no confirm could not work here — `pithy dev`'s `l` is the precedent and the reason. `connect`, `rotate`, `disconnect` and `status --verify` all offer it. The URL-and-code line is unconditional: a browser on another machine still gets both halves.

The offer appears only at a real terminal — stdin and stderr, which is where these lines go. `--json`, a pipe on either of those, the new `--no-open`, and `PITHY_NO_OPEN` at any value each suppress the line as well as the open. **Windows offers nothing**: `cmd /c start` hands a URL to a command interpreter that re-parses it, `rundll32` strips the query string and `explorer.exe` refuses a URL with arguments, so the URL is printed and you open it yourself. The terminal is given back on every exit path — a normal return, a throw, `process.exit`, and Ctrl-C, which raw mode has turned into a byte.

`DeviceAuthorization` carries an optional `verificationUriComplete`, the same page with the code already in it. It is opened when a client sends one and never printed, because it carries the code. Both URIs are now `http(s)` only, and both must name the origin the CLI was told to call: they arrive over the wire, a bare `z.url()` accepts `javascript:`, `file:` and `vscode:` alike, and an https URL anywhere on the web satisfied the scheme alone.

One opener, one raw-mode reader. The platform dispatch moved to `platform/browser.ts` and the key reader to `terminal/keys.ts`, out of `dev/`, where `pithy dashboard` could not reach either and a second opener was one edit away. The URL is passed as an argument, never through a shell, and an opener that is missing or exits non-zero prints one line and never fails the sign-in. `ci/opener.test.ts` holds all three counts, and names every child process the CLI starts — a second opener has to start something, and a name list only catches the names somebody thought of.
