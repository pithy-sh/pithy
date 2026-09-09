---
"@pithy-sh/cli": patch
---

`pithy provision` honors a declined binding, and says what it left out.

`declinedBindings` was read by the reader and ignored by the writer: `pithy doctor` reported the declaration correctly while `provision` created the resource and wrote the binding back into the file the adopter had removed it from. #440 fixed this for `pithy upgrade` and provision never got the same treatment.

The cause was not the filter — that shipped. Its input was empty. `provision` resolved manifests from `<root>/node_modules/@pithy-sh/*` while the plan had already moved to the Worker's own, so a capability declared where it is composed had no manifest, its decline resolved as `unrecognized` rather than `honored`, and nothing filtered it. One build, two answers, because two commands asked the question differently.

It now reports every decline rather than only the ones it acted on. A binding nothing composes, one a capability requires outright, one whose kind cannot be declined, and a `declinedBindings` block that will not parse each get a line — the last one mattering most, because an unreadable block silently provisioned everything. `Not created by this run` is stated exactly: a decline never deletes a resource an earlier run created.
