---
"@pithy-sh/support": patch
---

Support declares `SUPPORT_BUCKET` only when something would write to it.

Three settings put bytes in that bucket — mail attachments, the raw MIME copy, and in-app uploads — and all three default on, so nothing changes for a project that has not turned one off. Turn all three off and the binding is not declared, so `pithy upgrade` writes no R2 stanza and `pithy doctor` reports none missing.

`pithy support provision` asks the same question now. It asked about two of the three, so a project that wanted uploads but no mail attachments got a binding pointing at a bucket nothing had created, and every submitted file was dropped with a warning.
