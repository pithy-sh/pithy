---
"@pithy-sh/email": patch
"@pithy-sh/cli": patch
---

A resumed email batch dates its work by the pass, and its heartbeat still beats.

`EmailSendWorkflow.run` read one clock in the driver body and gave it two jobs. A Workflow does not resume inside the step it died in — it re-executes the body from the top and serves every completed step from the journal — so a batch that backed off and resumed dated its remaining jobs, and the expiry of every tracked link in them, by the resume. A batch interrupted overnight promised half its recipients a link a day shorter than the other half.

`SendDeps.now` is two fields now, because it was answering two questions with opposite lifetimes.

`passStartedAt` is journalled in a `pass-instant` step and stable across a resume. It dates the work: `sentAt`, the redaction stamp, the events, and every link expiry. A link minted on the resumed half expires from the pass rather than from the mint — two people in one batch are promised the same window, and which attempt happened to render their message is not something they can see.

`heartbeatAt` is a thunk, read fresh on every patch, and never journalled. **This is the half that had to be got right.** `updatedAt` is not a stamp: it is the scheduler's only evidence that a `sending` job is still being worked on, and `runScheduler` claims and re-drives anything older than `stuckMs` on the assumption its dispatch died. Journalling it makes a batch that resumes past that window report the job it is actively retrying as stranded — so the next tick starts a second send Workflow against it, and since `runSend` short-circuits only a job already `sent`, both attempts render and both call `send`. One person, two emails. A sweep journalled the single `now` and was reverted for exactly that; the test suite now drives it, with a real scheduler tick over a real resume, and a vacuity check that the detector still catches a batch that really did die.

The Workflow's body moved to `workflows/sendBatch.ts` as `runSendBatch`, taking a structural step runner the way `reconcilePayments` and `runAtRestKeyRotation` take theirs. `worker.ts` imports `cloudflare:workers`, so nothing inside it could be exercised without deploying it — and every property worth proving here is a property of a resume.

With this the driver-determinism gate's known-exceptions list is empty. It held three sites; #327, #328 and #329 are all closed, and the gate now asserts against an empty set.
