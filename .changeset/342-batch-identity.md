---
"@pithy-sh/email": patch
---

Give every dispatcher of a send Workflow the batch id its rows carry, so a retry is not mistaken for the batch that failed it.

`342-batch-cost` made the scheduler's re-drive a question about a Workflow instance rather than about a row's age: a job carries the id of the batch holding it, and a tick that finds the row stale asks the runtime whether that instance is still alive. The veto is only as good as the id it reads, and two of the three places that put a job into a state the scheduler queries were not maintaining it.

**`retryJob` left the failed batch's id on the row.** That is the one instance guaranteed not to be coming for it, and — because a batch of fifty that failed job seven walks on to job fifty — usually one that is still running. So the id was wrong in both directions at once. While the old batch ran, the tick that should have re-driven the operator's retry asked about it, was told "alive", and held: the click sent nothing. When the old batch ended, the same row read as stranded and the tick started a second Workflow behind the one the retry had already started: the click sent twice. A retry now mints its own id, writes it in the same statement that makes the row queryable again, and creates the instance under it — or writes null, where there is no binding to dispatch on.

**`enqueueEmail` minted no id at all.** Every immediate send was therefore born naming nobody, which the scheduler correctly reads as stranded, and it takes no crash to reach: the Email Service refuses once, `runSend` throws so the step backs off, and a backoff writes nothing — so within `stuckMs` the row is indistinguishable from a dead dispatch while its Workflow is alive and waiting. `runSend` short-circuits only a job already `sent`, so both instances render and both call the Email Service. This is the retry-backoff double-send the batch-id work was supposed to close, on the path it never reached. An immediate enqueue now stamps the row and creates the instance under that id; a `scheduled` or `timezone` job, and an enqueue with no binding, still name nobody, because nobody is coming.

The claim is written **before** the `create` in both, which is what makes a lost dispatch answer safe: the instance can never be alive before the row can name it. A `create` that fails outright leaves a row naming an instance the runtime disowns, which reads as dead and is re-driven exactly as it was before batch ids existed — a failed dispatch still never loses an email.

`send/batchIdentity.ts` states the invariant the three dispatchers keep and mints the ids they use. `batch_id` names *the instance coming for this row*, and never a record of which batch touched it last.

The vacuity check was written first and is paired with every case: a batch that genuinely died must still have its jobs recovered. Both halves are driven against a Workflows fake with the platform's own behavior — including `get` rejecting for an id nothing was created under — through `runSendBatch` and a real scheduler tick, so a live batch is one that is actually backed off rather than one a stub says is alive.
