---
"@pithy-sh/support": minor
---

Answer an app-submitted thread on a project with no mail.

A project can compose support, leave `inboundAddresses` empty, never enable Email Routing, and still collect reports from signed-in users. Nobody could answer them: `sendReply` treated storing the answer and sending it as one step, so with no address to reply from it refused before writing anything.

The destination was already built. `readOwnThread` hands the submitter every message on their own conversation, outbound rows included — so a reply can be **stored rather than sent**, and the outbound row, the thread counters and the `support/reply_sent` audit event land exactly as they do for mail. Only the enqueue is skipped.

`reply.deliverInApp` makes that **a choice, not only a fallback**. Turning on Email Routing takes over the zone's MX, so a project already running mail on that domain cannot receive support replies without disturbing everything else on it — and a behaviour conditioned on mail being *impossible* is unreachable by exactly the adopter who most wants it. With the setting off it still happens automatically when there is no address to reply from and no email capability composed, because storing the answer beats refusing it. An `email` thread never takes the path: its sender has no read-back, so a stored answer there is one nobody would see. `reply.enabled: false` still refuses on both.

`POST /support/threads/:id/reply` now answers a union discriminated on `channel` — `{ channel: "email", messageId, jobId }` or `{ channel: "app", messageId }`. Two different promises about when the customer reads the answer, so they are two different shapes rather than one with an optional `jobId` that a console would render "sent" over both of them.

On the row, `channel` is how the answer was delivered, and `emailJobId` carries no information of its own: the schema now refuses any message where it is present and the row is not outbound mail, or absent and it is. Ask `channel` whether an answer went out — never the absence of a job id, which would otherwise mean both *this arrived* and *this is waiting in the app*. `pithy_support_messages.from_address` becomes nullable for the same reason: an answer that was never sent left no envelope.
