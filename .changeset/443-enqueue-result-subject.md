---
"@pithy-sh/email": minor
---

`enqueueEmail` answers with the subject it wrote.

The sentence is already in hand when the row is built — rendered in the recipient's language, two lines above the insert. Returning it means a caller keeping an audit trail records the string the job row was written with, instead of re-rendering the same catalog key and hoping the two agree. They agreed by coincidence for as long as everything was English; pass a locale and they part.

It is the **enqueue-time** render, and that boundary is stated rather than implied. `runSend` renders again in the send Worker at the moment the message leaves, and rewrites `pithy_email_jobs.subject` from that render — because a template corrected, a theme renamed, or a catalog sentence retranslated in between would otherwise leave the send log describing a message nobody received. So record the returned value as what you *queued*. A trail that has to reflect what was *delivered* reads the row back after the send.

Not the body. A body is large, it is the thing the kit is careful never to log, and no caller has a reason to hold one.
