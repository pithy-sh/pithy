---
"@pithy-sh/cli": patch
---

`pithy email provision` half-configured mail routing and reported success.

Inbound routing was wired only when all three of `--routing-zone`, `--inbound-address` and `--app-worker` were present. With one or two it set nothing and carried on — no refusal, no warning, exit 0. Two flags of three looks like success, and nobody discovers otherwise until somebody replies to a message and the mail goes nowhere.

It refuses now, naming the flags that are missing, and it refuses *first* — before the project name, the credentials, and every Cloudflare call, so a typo costs nothing and provisions nothing. `pithy support` has made this decision correctly all along; this is one command adopting its sibling's rule.

`pithy testers` swallowed loader failures. `buildEnqueue` and the provisioner's sending-identity block both ended in a bare `catch { … undefined }`, so an `@pithy-sh/email` that was installed and broken was indistinguishable from one that was absent: the run reported `sends: false` and printed *"no email capability is configured in this project"* about a capability the adopter had installed. That sentence is right for one of the four failures the catch admitted and wrong for the three that mean the package is right there — a dependency that will not resolve, an export map that does not, and source that will not parse.

Both now go through `classifyCapabilityLoadFailure`, per `docs/CONVENTIONS.md` §Refusals. Absent is still the quiet answer, because email really is optional to a roster run; everything else refuses and says which it was. The classifier is exercised as a pure function against both Node's and Bun's cause shapes, since the `bin` runs on Bun and Bun's resolver errors are not `instanceof Error`.
