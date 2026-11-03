// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ForwardableEmailMessage } from "@cloudflare/workers-types";

/** What workerd's native accessors throw when called on anything but their own object. */
const ILLEGAL = "Illegal invocation: function called with incorrect this reference.";

/**
 * A `ForwardableEmailMessage` double whose accessors and methods refuse a foreign `this`, as workerd's native ones do.
 *
 * A plain-object double has no accessors, so it passes a wrapper that reads them with the wrong `this`. This one
 * throws workerd's own `Illegal invocation`, and its `raw` is single use like the real stream.
 */
export class NativeLikeMessage {
  readonly #to: string;
  readonly #from: string;
  readonly #headers: Headers;
  readonly #body: string;
  #raw: ReadableStream<Uint8Array> | null;
  #annotation: string | undefined;
  rejected: string | undefined;
  forwardedTo: string[] = [];

  constructor(options: { to: string; from: string; headers: Headers; body: string }) {
    this.#to = options.to;
    this.#from = options.from;
    this.#headers = options.headers;
    this.#body = options.body;
    this.#raw = new Response(options.body).body;
  }

  /** The brand check a native accessor makes: is `self` the object this accessor belongs to? */
  static #own(self: unknown): NativeLikeMessage {
    if (!(typeof self === "object" && self !== null && #to in self)) throw new TypeError(ILLEGAL);
    return self as NativeLikeMessage;
  }

  get to(): string {
    return NativeLikeMessage.#own(this).#to;
  }
  get from(): string {
    return NativeLikeMessage.#own(this).#from;
  }
  get headers(): Headers {
    return NativeLikeMessage.#own(this).#headers;
  }
  get rawSize(): number {
    return new TextEncoder().encode(NativeLikeMessage.#own(this).#body).byteLength;
  }
  /** Single use, like the real stream: a second read gets a locked, drained stream. */
  get raw(): ReadableStream<Uint8Array> {
    const self = NativeLikeMessage.#own(this);
    if (!self.#raw) throw new TypeError("raw already taken");
    const stream = self.#raw;
    self.#raw = null;
    return stream;
  }
  /** A native setter, standing for any the runtime adds: like the getters, it refuses a foreign `this`. */
  get annotation(): string | undefined {
    return NativeLikeMessage.#own(this).#annotation;
  }
  set annotation(value: string | undefined) {
    NativeLikeMessage.#own(this).#annotation = value;
  }
  setReject(reason: string): void {
    NativeLikeMessage.#own(this).rejected = reason;
  }
  async forward(rcptTo: string): Promise<void> {
    NativeLikeMessage.#own(this).forwardedTo.push(rcptTo);
  }
  async reply(): Promise<void> {
    NativeLikeMessage.#own(this);
  }
}

/** The double as the handler type sees it. */
export function asForwardable(message: NativeLikeMessage): ForwardableEmailMessage {
  return message as unknown as ForwardableEmailMessage;
}
