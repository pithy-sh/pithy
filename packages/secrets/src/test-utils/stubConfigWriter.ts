// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { EncryptionConfig } from "../crypto/envelope";
import type { ConfigReader } from "../manager/configReader";
import { type ConfigStamp, configStamp, type RotationPass } from "../manager/configStamp";
import type { ConfigEntryFacts, ConfigWriter } from "../manager/configWriter";

/**
 * **The master-key entry, from both ends, for every test that is not talking to a live Secrets Store.**
 *
 * One double rather than three, because three suites grew three ideas of what this seam does and none of
 * them could model the case `#647` is about. The two ends are deliberately distinct objects over one
 * piece of state: {@link writer} is the REST face (a write lands, and `inspect` shows the stamp
 * immediately, because REST is the address that was written), and {@link reader} is the binding (which
 * may lag, or may never show the write at all). That asymmetry *is* the defect: a write that returns 200
 * and a comment that reads back perfectly, over a value the binding never serves.
 *
 * ## `propagate` — the one knob, and the two halves it drives
 *
 * It is the number of binding reads a write must wait for before the binding serves it:
 *
 *   - `0` (the default) — the store is consistent and a write is visible to the next read;
 *   - a positive number — **absent, then present**: the first reads show the previous value, and the
 *     write appears afterwards. A rotation must ride that out and complete;
 *   - `Number.POSITIVE_INFINITY` — **absent throughout**: the write landed somewhere the binding does not
 *     read. A rotation must abort, and must abort before re-encrypting a single row.
 *
 * A stub that always reflects its own writes can prove neither half, which is why the ad-hoc doubles this
 * replaces could not.
 */
export interface StubConfigStoreOptions {
  /** What the binding serves before anything is written. */
  bound: EncryptionConfig;
  /** The composed entry name the writer claims to address. */
  entryName?: string;
  /** Binding reads a write waits for before it is served. See the class doc. Defaults to `0`. */
  propagate?: number;
  /** When set, every `write` throws this instead of landing — the CF API refusing, or being unreachable. */
  writeError?: unknown;
}

/** One write, as the double recorded it. */
export interface RecordedWrite {
  /** The config handed to `write`. */
  config: EncryptionConfig;
  /** The pass it belonged to. */
  pass: RotationPass;
}

export class StubConfigStore {
  /** Every write, in order. */
  readonly writes: RecordedWrite[] = [];
  /** How many times the binding has been read. */
  reads = 0;
  /** Binding reads a pending write still has to wait for. Mutable, so a test can change its mind. */
  propagate: number;

  readonly #entryName: string;
  readonly #writeError: unknown;
  #bound: EncryptionConfig;
  #pending: { config: EncryptionConfig; readsLeft: number } | null = null;
  #stamp: ConfigStamp | null = null;
  #modifiedAt = new Date(0);

  /** The REST face: the entry this pass is addressing, and what Cloudflare would say about it. */
  readonly writer: ConfigWriter;

  /** The binding: what a Worker would actually decrypt with, which may lag the write or never show it. */
  readonly reader: ConfigReader;

  constructor(options: StubConfigStoreOptions) {
    this.#bound = options.bound;
    this.#entryName = options.entryName ?? "acme-staging-secrets-encryption-keys";
    this.propagate = options.propagate ?? 0;
    this.#writeError = options.writeError;
    this.writer = this.#makeWriter();
    this.reader = this.#makeReader();
  }

  #makeWriter(): ConfigWriter {
    return {
      entryName: this.#entryName,
      write: async (config: EncryptionConfig, pass: RotationPass): Promise<void> => {
        if (this.#writeError !== undefined) throw this.#writeError;
        this.writes.push({ config, pass });
        // REST took the write, so REST can see it — including the stamp, whatever the binding does. This is
        // the shape of the failure: a perfect inspection over a value nothing reads.
        this.#stamp = configStamp(config, pass);
        this.#modifiedAt = new Date(this.#modifiedAt.getTime() + 1000);
        this.#pending = { config, readsLeft: this.propagate };
      },
      inspect: async (): Promise<ConfigEntryFacts | null> => ({
        name: this.#entryName,
        id: "stub-entry-id",
        modifiedAt: this.#modifiedAt,
        stamp: this.#stamp,
      }),
    };
  }

  #makeReader(): ConfigReader {
    return {
      read: async (): Promise<EncryptionConfig> => {
        this.reads++;
        const pending = this.#pending;
        if (pending !== null) {
          if (pending.readsLeft <= 0) {
            this.#bound = pending.config;
            this.#pending = null;
          } else {
            pending.readsLeft--;
          }
        }
        return this.#bound;
      },
    };
  }

  /** What the binding is serving right now, without spending a read. */
  get boundConfig(): EncryptionConfig {
    return this.#bound;
  }

  /** The config of the most recent write, for a test asserting what the pass persisted. */
  get lastWritten(): EncryptionConfig | undefined {
    return this.writes.at(-1)?.config;
  }
}
