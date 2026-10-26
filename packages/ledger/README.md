# @pithy-sh/ledger

A per-user balance ledger for your app's economy — chips, gold, gems, credits, tokens — in your own D1. Currency-agnostic, and correct by construction.

Every game with an economy needs this, not just gambling. It is the primitive under in-game currency, rewards, buy-ins, prize pools and wagers.

```sh
pithy add ledger
```

**Documentation: [pithy.sh/docs/capabilities/ledger](https://pithy.sh/docs/capabilities/ledger).** Overview, adding it, using it, and the reference: currencies, holds, idempotency, the invariants.

A management client reads balances and entry logs over the control plane, and corrects an account with four writes behind `ledger:accounts:adjust`: credit, debit, reverse an entry, release a hold. Each takes an idempotency key and a required reason, and each that moves money is audited. [`docs/CONTROL-PLANE.md`](../../docs/CONTROL-PLANE.md) has the guarantees.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
