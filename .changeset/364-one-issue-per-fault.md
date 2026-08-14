---
"@pithy-sh/payments": patch
---

Report one issue for one fault. `PaymentsConfig` was reporting the Paddle rail's six times.

The Paddle rail-on/rail-off pair was declared twice: once beside Stripe's and Lemon Squeezy's, where it belongs, and once again inside the `for (const rail of PAYMENTS_RAILS)` loop that finds duplicate SKUs — comment and all. The loop body runs once per rail, so a project with the rail on and no `paddle` block was refused with six identical lines about one missing block, and the reasonable reading of a repeated error is that six things are wrong. The second copy is gone.

Nothing was charged wrong; this is a config-time error path. What it cost was legibility at the moment an adopter can least spare it, and it was getting worse: the copy sat inside a loop over rails, so a sixth rail would have made it seven.

Nothing caught it because every assertion asked *whether* the config was refused and *what* the refusal said, and both stayed true six times over. So the tests now count. Each of the three rails that demands a settings block asserts exactly one issue in both directions — block missing while the rail is on, block present while it is off — and one more asserts the count holds however many rails and however many products the config has, which is the property a rule pasted into either loop breaks.
