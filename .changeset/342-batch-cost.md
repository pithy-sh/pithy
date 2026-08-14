---
"@pithy-sh/email": patch
---

Make the send batch itself the claim, so its bookkeeping is linear and a batch in retry backoff is not re-driven.

Two defects, one cause. #340 answered "the scheduler re-drives a batch's own queue while it is still walking it" by having each send step renew the claim on every job behind it. It is correct about staleness and it did not count the writes: for a batch of N that is N(N-1)/2 row updates, **1,225 at the shipped `SCHEDULER_BATCH_SIZE` of 50**, on a setting with no ceiling. And it cannot cover the case beneath it — a step waiting out its retry backoff is running no body, so it renews nothing while being entirely alive, and past `stuckMs` a second send Workflow is dispatched for jobs the first will resume. Reproduced: claim three jobs, throw retryably on the first send, tick the scheduler twenty minutes later.

Liveness is a property of the batch, and a batch is a Workflow instance. So the scheduler mints the batch's id before it claims, writes it to every row in the claim it was already making, and creates the send Workflow *under that id*. A tick that then finds those rows stale asks the runtime whether the instance is still running instead of reading a timestamp as a verdict — one question per batch, however many of its rows look stale. A `queued`, `running`, `waiting` or `paused` instance holds its jobs; anything else, and anything unrecognised, does not.

Nothing is written on a job's behalf any more. A batch of fifty now writes what its fifty sends write and not one row more — 500 against 1,725, measured against D1's own `rows_written` and asserted, at two sizes, so the shape is gated and not just the number.

The safety net is unchanged in the direction that matters. **The new answer may only ever veto a re-drive, never cause one:** a stale row naming no batch, or one whose instance cannot be reached, is re-driven exactly as before. A batch that genuinely dies mid-queue still has its unreached jobs recovered — that is the criterion this was checked against first, because a scheduler that recovers nothing satisfies every test about not double-sending.

`stuckMs` was not widened, and should not be. A timeout tuned to outrun a queue is a race with a slower horse. It is now a filter over what is old enough to ask about, and the batch answers.

`pithy_email_jobs` gains a `batch_id` column. `renewClaim` is gone.
