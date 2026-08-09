---
"@pithy-sh/cli": patch
---

`pithy dashboard connect` grants every read the Worker declares, so connecting produces a working surface.

`connect` granted `SEAM_SCOPES` and nothing else. Every pane that reads a customer's data needs a scope that default did not include, so a freshly connected project opened to six panes each saying the credential does not cover this call. `pithy-sh/dashboard`'s own self-connection held `manifest:read` and `keys:rotate`, read `blocked` off the manifest, and never made a single call. Adding the reads by hand made the whole surface work with no other change.

The default is now derived from the Worker being registered: each capability already declares its admin routes with the scope each one needs — the same declaration `GET /control-plane/manifest` reports — and the CLI already resolves the composed set to find the seam's mount point. So a capability that lands a read route is offered on the next `connect` with no list here to keep in step, and no capability the project does not compose is ever mentioned.

**A read is a route, not a name.** A scope joins the default only when every declared route requiring it is a `GET`. `scopeCovers` matches exactly, with no prefix or wildcard rule, so holding a scope confers every route that requires it — one mutating route anywhere makes the whole scope a write however it is spelled. `keys:rotate` is exactly that shape: a key listing and two key writes behind one scope. It stays in the default, because it always was and because dropping it would break `pithy dashboard rotate` on every new connection. Nothing the derivation adds can write, and a test asserts that over the composed seam and a hostile synthetic surface rather than over a list of scope names.

The interactive prompt is read off the same declaration. It used to offer two hardcoded scopes, neither of which reads any of the adopter's data; it now lists every operation their Worker exposes, in each capability's own words, preselected to the default — because narrowing is the point of showing the list at all.

`--scope` still narrows to exactly what is passed, an explicitly empty selection is still empty rather than the default, an update with no `--scope` still leaves the grant alone, and enforcement is unchanged: the adopter's row is the authority, and a narrowed grant refuses every call it left out.
