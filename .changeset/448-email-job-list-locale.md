---
"@pithy-sh/email": minor
---

The send log can be scanned for the language it sent in.

`pithy_email_jobs.locale` is written on every row and was projected only on `EmailJobDetail` — so a pane listing a hundred jobs could answer "what language did this go out in?" only one row at a time, through the route that carries the whole address and is audited as a disclosure. A hundred audited disclosures to render a column, or no column.

`EmailJobListItem` carries `locale` now, projected from the row it was already stored on. It fits the schema's own rule — enough to scan, not enough to harvest. A BCP-47 tag is structural exactly as `template`, `category` and `mode` are: it names the kind of mail without carrying a character of its content or a character of the recipient.

Null means the recipient never chose one and it went out in the kit's English, which is what somebody diagnosing "why is half this account getting English" is scanning for.

Not `subject`. That is content, it routinely names the recipient's own things, and it stays where the address is.
