---
"@pithy-sh/payments": patch
---

The catalogue shape gate was blind to two JSON types, and read its own subject.

`GET {base}/admin/catalog` is policed by an invariant rather than a list of banned field names: *nothing but the published facts can cross it, whatever a field is called.* The assertion did not hold that, in two independent ways.

**It swept strings and numbers and returned nothing for everything else.** Booleans and nulls were never compared against the published set at all — a whole JSON type exempted by a fallthrough. The sweep now covers every leaf, and the branch it cannot name throws instead of returning nothing, because returning nothing *was* the defect.

**And the permitted key set was `Object.keys(PaymentsAdminCatalogProduct.shape)`.** The gate read the schema it exists to police, so adding a field to the schema and to `adminCatalogView` in one edit widened the gate by the same edit. `{ apple: true, google: true, stripe: false }` — the shape a "which stores is this product on" field would take — crossed with `crossed: []`, `undeclared: []`, and the test passed. So did `clawback: true`. Nothing forbidden in `PaymentsConfig` happens to be a boolean today, which is what kept it from being a live leak rather than what made it safe. The seven permitted keys are now written out in the test, and a second assertion holds the schema to that list, so a widening fails on the schema edit before a view exists to fill the field.

Both halves are needed and neither is redundant: `true`, `false` and `null` are in every JSON document's vocabulary, so the value half can never police a boolean on its own, and the key half is what does.

**Two docs stated the opposite of the behaviour.** `EntitlementGrantRequest.entitlement` still told an integrator a key outside the catalogue was fine; it has been a 400 since the check landed. And `entitlement/manual.ts` named the route in the same sentence as the two shapes that "both work" — still true of `grantEntitlement`, which takes any key it is handed, and no longer true of `POST {base}/entitlements/grant`, which does not. The distinction is now the doc: the function is the mechanism, the route is the gate, and `manualEntitlements` is how an adopter declares the keys they comp but do not sell.
