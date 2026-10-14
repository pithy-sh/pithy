// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "../error/pithyError";

/**
 * **A socket's version is negotiated at the upgrade, and the Worker serves two.**
 *
 * An app store client lags its Worker by months — the same version boundary an admin response crosses
 * (CLAUDE.md §HTTP). So a socket's frames change the way a response does: a field added to a frame is
 * optional, and a client ignores a `type` and a key it does not know. A change no client could ignore is a
 * new subprotocol, offered in `Sec-WebSocket-Protocol` (`pithy.multiplayer.v1`), and the Worker keeps
 * serving the one before it, so a client released before the change keeps playing.
 *
 * The first versioned protocol's previous version is the unversioned one: a client that offers no
 * subprotocol at all, which is every client written before versions existed. `previous: null` names it.
 */

/** The header a client offers subprotocols in, and the server answers with the one it chose. */
export const SUBPROTOCOL_HEADER = "Sec-WebSocket-Protocol";

/** The versions one socket serves: the current one, and the one before it — `null` when that is unversioned. */
export interface SocketVersions {
  readonly current: string;
  readonly previous: string | null;
}

/**
 * The version this upgrade speaks: the current one when the client offers it, else the previous one when
 * the client offers that, else `null` for an unversioned client where the previous version is unversioned.
 * A client that offers only versions this Worker does not serve is refused with a 400 naming the ones it
 * does — a socket that opened anyway would speak frames the client cannot read.
 */
export function negotiateSubprotocol(offered: string | null | undefined, versions: SocketVersions): string | null {
  const asked = (offered ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
  if (asked.length === 0 && versions.previous === null) return null;
  if (asked.includes(versions.current)) return versions.current;
  if (versions.previous !== null && asked.includes(versions.previous)) return versions.previous;
  const served = [versions.current, ...(versions.previous === null ? [] : [versions.previous])].join(", ");
  throw new ValidationError({
    message: `This socket speaks ${served}${versions.previous === null ? ", or no subprotocol" : ""}. The client offered ${asked.length === 0 ? "none" : asked.join(", ")}.`,
    action: `Offer ${versions.current} in ${SUBPROTOCOL_HEADER}.`,
  });
}
