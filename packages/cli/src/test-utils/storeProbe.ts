// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { narrate } from "../terminal/progress";

/**
 * **A remote store that reports what the run had last said when it was reached (#583).**
 *
 * `pithy migrate` and `pithy seed` are slow on a remote environment because every statement is a REST
 * round trip, not because anything spawns — so the gate `ci/narration.test.ts` states over captured
 * subprocesses passes them while they say nothing at all. This is the other half. A test hands these
 * handles to a run through its own store seams (`remoteD1`, `remoteKv`, `remoteR2`), runs it inside a
 * narrated span, and every round trip is recorded next to the most recent step raised before it.
 *
 * The round trip is recorded where it happens, not where it is prepared: a statement's `first`, `all`,
 * `run` and `raw`, a `batch`, an `exec`, a KV `get`/`set`, an R2 presigned fetch.
 */

/** One round trip to a store, and the step the run had most recently raised when it left. */
export interface StoreTrip {
  /** The binding the round trip went to — what a step has to name. */
  readonly store: string;
  /** The method that made it. */
  readonly call: string;
  /** The latest `▸` step raised before the call, or `undefined` when the run had said nothing yet. */
  readonly step: string | undefined;
}

/** A narrated span that records its steps, and the stores that report into it. */
export interface StoreProbe {
  /** Every step raised, in order. */
  readonly steps: string[];
  /** Every round trip, in order. */
  readonly trips: StoreTrip[];
  /** Run `work` inside a narrated span whose sink is this probe. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** A D1 that records each round trip against `store`. */
  d1(store: string, database: D1Database): D1Database;
  /** A trip recorded by hand, for a store whose surface is a fake the test wrote. */
  trip(store: string, call: string): void;
  /**
   * The trips whose latest step does not name their store as a whole word — the defect. `DB` does not
   * match inside `COLLAB_DB`, so a step about one database is not credit for another. A trip against the
   * store the latest step *does* name is credited to it however long after that step it comes.
   */
  unnarrated(): StoreTrip[];
}

/** The statement methods that send a query. `bind` only returns another statement. */
const SENDS = new Set(["first", "all", "run", "raw"]);

/** Whether `text` names `store` as a whole word: no letter, digit or underscore on either side. */
function names(text: string, store: string): boolean {
  const escaped = store.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`).test(text);
}

/** Build a probe. One per test: its steps and trips are the test's evidence. */
export function storeProbe(): StoreProbe {
  const steps: string[] = [];
  const trips: StoreTrip[] = [];
  const trip = (store: string, call: string): void => {
    trips.push({ store, call, step: steps.at(-1) });
  };

  // A `batch` is handed the proxies; the store it forwards to has to be handed what it prepared.
  const inners = new WeakMap<object, D1PreparedStatement>();
  const unwrap = (candidate: D1PreparedStatement): D1PreparedStatement => inners.get(candidate) ?? candidate;
  const statement = (store: string, inner: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(inner, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== "function") return value;
        if (property === "bind") {
          return (...args: unknown[]) =>
            statement(store, (value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
        }
        if (typeof property === "string" && SENDS.has(property)) {
          return (...args: unknown[]) => {
            trip(store, property);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
    inners.set(proxy, inner);
    return proxy;
  };

  return {
    steps,
    trips,
    run: (work) =>
      narrate((event) => {
        if (event.phase === "start") steps.push(event.what);
      }, work),
    d1: (store, database) =>
      new Proxy(database, {
        get(target, property) {
          const value = Reflect.get(target, property) as unknown;
          if (typeof value !== "function") return value;
          if (property === "prepare") {
            return (query: string) => statement(store, target.prepare(query));
          }
          if (property === "batch") {
            return (statements: D1PreparedStatement[]) => {
              trip(store, property);
              return target.batch(statements.map(unwrap));
            };
          }
          if (property === "exec" || property === "dump") {
            return (...args: unknown[]) => {
              trip(store, property);
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return (value as (...a: unknown[]) => unknown).bind(target);
        },
      }),
    trip,
    unnarrated: () => trips.filter((entry) => entry.step === undefined || !names(entry.step, entry.store)),
  };
}
