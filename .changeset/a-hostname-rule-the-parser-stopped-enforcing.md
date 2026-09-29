---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
---

`isPublicHostname` decides punycode itself, so `pithy seed --host` answers the same on Node 22 and Node 24.

`seedHostOrigin` validated a host by handing it to `new URL` and treating a throw as the answer. That covered two different questions at once. One is canonical spelling — the parser reads `127.1`, `0177.0.0.1`, `0x7f.0.0.1` and `2130706433` all as `127.0.0.1`, which is what stops loopback arriving in a spelling no pattern here would recognize. The other is whether an `xn--` label is valid punycode, and that one was never ours; it was the parser's, borrowed.

Node 24.20.0 stopped lending it. That release bumped Ada from 3.4.4 to 4.0.0 — ICU unchanged at 78.3, so this is the URL parser and not the IDNA tables — and Ada 4 no longer rejects a malformed A-label. `new URL("http://xn--a.test")` throws on Node 22.23.3 and on Node 24.19.0, and returns a URL on Node 24.20.0. So `pithy seed --host xn--a.test` was refused or accepted according to which Node the adopter had installed, from one command, with nothing in the repository having changed.

A rule borrowed from a parser changes underneath you, so this one is stated where it can be read: `isPublicHostname` refuses any label beginning `xn--`, on every runtime. Whole labels, so `myxn--a.test` is the ordinary name it looks like.

**Every A-label is refused, well-formed or not.** Telling a good one from a bad one is UTS-46, which needs IDNA mapping tables `@pithy-sh/core` is not carrying into a Worker to check a hostname — and `HOSTNAME_PATTERN` is ASCII-only, so a Unicode domain never reached this function to begin with. What closes is the hand-encoded spelling. Internationalized domains are a feature with a specification behind them, not a side effect of which parser shipped.

The parser is still asked the question it is good at. A host is taken only in the spelling `new URL` gives back, and a host no parser will take is still refused — the `catch` is for that, not for punycode.

The Node 24 leg of CI is a gate and stays one. Its comment claimed otherwise while `test-node` sat in the `ci` job's `needs`, which is how this was caught at all: the nightly on `main` runs both versions, the pull request runs the floor, and a kit that answers differently on two LTS runtimes is broken whichever one is nominally supported.
