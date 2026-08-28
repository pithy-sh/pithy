// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT
//
// LOCALE es — an unreviewed first pass. Not American English by design.

import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";

/**
 * Every kit error code, in Spanish. **Keyed by the code itself** — for an error the catalog key *is*
 * the code, so there is no second identifier to keep in sync and `KitErrorCode` is the exhaustive
 * checklist this file has to cover.
 *
 * There is no English twin. A payload already carries its English `message` on the wire, and a
 * translating client renders `t.maybe(payload.code, payload.params) ?? payload.message` — so English is the
 * fallback by construction and a duplicate of it here would be a second place for one sentence to
 * drift.
 *
 * **These are the caller's words, not the operator's.** `message` is the only field on the wire;
 * `action` names `pithy` commands and repository files and never leaves the terminal, so nothing here
 * translates one. Placeholders match the `params` the throw sites pass.
 *
 * **Not one sentence below carries a placeholder, and that is a finding rather than a shortcut.** No
 * throw site in this repository passes `params` today — `git grep "params: {"` over every package's
 * `src` tree returns Workflow dispatch parameters and nothing else — so a `{name}` written here would
 * have no value to receive and `interpolate` leaves an unsupplied placeholder as written. `Sala {code}
 * llena.` on a caller's screen is worse than `Esa sala ya no admite más jugadores.`, which is why the
 * generic clause wins until the English side has a value to send. `./errors.test.ts` pins the absence,
 * and says there what would replace the pin the day a throw site starts naming one.
 *
 * Peninsular-neutral: one `es` serves es-ES, es-MX and es-AR, so a regionalism that reads as home to
 * one of them and as foreign to the other two is the wrong word even when it is the better word. Where
 * the English distinguishes an internal cause the Spanish states only the part a caller can act on —
 * a caller who cannot read our logs is not helped by learning that a binding was missing.
 */
export const esErrors: MessageCatalog = {
  // Core: the codes every capability throws, and the ones a caller meets most.
  "validation/invalid_input": "Los datos enviados no son válidos.",
  "auth/invalid_token": "Tu sesión no es válida o ha caducado. Vuelve a iniciar sesión.",
  "auth/forbidden": "No tienes permiso para hacer esto.",
  "auth/provider_unavailable": "Este método de acceso no está disponible ahora. Prueba con otro.",
  "core/not_found": "No existe el recurso solicitado.",
  "core/conflict": "La solicitud entra en conflicto con el estado actual.",
  "rate_limit/exceeded": "Demasiadas solicitudes. Inténtalo más tarde.",
  "core/internal": "Se ha producido un error inesperado.",
  "core/upstream_failed": "Un servicio externo ha fallado. Inténtalo de nuevo.",
  "core/upstream_timeout": "Un servicio externo no ha respondido a tiempo.",
  "core/invalid_workflow_params": "Los parámetros de la operación no son válidos.",
  // The three workflow-dispatch 500s say the same thing to a caller on purpose: the difference between
  // them is which part of the deployment is wrong, and that belongs to `action`, not here.
  "core/missing_workflow_binding": "Esta operación no está disponible ahora.",
  "core/unknown_workflow": "La operación solicitada no existe.",
  "core/workflow_failed": "La operación no se ha completado.",
  "core/webhook_unverified": "La firma de la notificación no es válida.",

  // Cloudflare REST. Naming the provider is safe — it is the adopter's own account, not our infrastructure.
  "cloudflare/not_configured": "Este servicio no está disponible ahora.",
  "cloudflare/request_failed": "No se ha podido completar la llamada a Cloudflare.",
  "cloudflare/invalid_response": "La respuesta de Cloudflare no tiene el formato esperado.",

  // Secrets.
  "secrets/not_found": "El secreto solicitado no existe.",
  "secrets/already_exists": "Ya existe un secreto con ese nombre.",
  "secrets/invalid_value": "El valor del secreto no es válido.",
  "secrets/crypto_failed": "No se ha podido procesar el secreto.",
  "secrets/rotation_unrecorded": "No se ha registrado la rotación del secreto.",
  "secrets/rotation_unsupported": "Este secreto no se puede rotar por esta vía.",

  // Email.
  "email/template_not_found": "Esa plantilla de correo no existe.",
  "email/invalid_payload": "Los datos de la plantilla no son válidos.",
  "email/invalid_token": "El enlace del correo no es válido o ha caducado.",
  "email/suppressed": "Ese destinatario ha dejado de recibir correos.",
  "email/rate_limited": "Se ha alcanzado el límite de envío. Inténtalo más tarde.",
  "email/send_failed": "No se ha podido enviar el correo.",

  // Turnstile. A caller never learns whether the check failed or the deployment misconfigured it.
  "turnstile/missing_token": "Falta la verificación de seguridad.",
  "turnstile/failed": "No se ha superado la verificación de seguridad. Inténtalo de nuevo.",
  "turnstile/config": "La verificación de seguridad no está disponible ahora.",

  // Audit.
  "audit/invalid_event": "El evento de auditoría no es válido.",
  "audit/write_failed": "No se ha podido registrar el evento de auditoría.",

  // Media.
  "media/not_found": "Ese archivo no existe.",
  "media/unsupported": "Ese tipo de archivo no es compatible con esta operación.",
  "media/storage_failed": "No se ha podido guardar el archivo.",
  "media/enrichment_failed": "No se ha podido analizar el archivo.",

  // Leaderboards.
  "leaderboard/board_not_found": "Esa clasificación no existe.",
  "leaderboard/entry_not_found": "No hay ninguna puntuación en esta clasificación.",
  "leaderboard/score_rejected": "La puntuación está fuera del rango permitido.",
  "leaderboard/submit_forbidden": "No puedes enviar puntuaciones a esta clasificación.",
  "leaderboard/board_immutable": "Esta clasificación ya no se puede modificar.",
  "leaderboard/invalid_schedule": "Esta clasificación no está disponible ahora.",

  // Multiplayer.
  "multiplayer/game_not_found": "Ese juego no existe.",
  "multiplayer/session_not_found": "Esa partida no existe.",
  "multiplayer/not_a_member": "No participas en esta partida.",
  "multiplayer/session_full": "La partida está completa.",
  "multiplayer/invalid_transition": "Esta acción no es posible en la fase actual de la partida.",
  "multiplayer/invalid_move": "Ese movimiento no es válido.",

  // Ledger.
  "ledger/currency_not_found": "Esa moneda no existe.",
  "ledger/account_not_found": "No tienes cuenta en esa moneda.",
  "ledger/hold_not_found": "Esa reserva de saldo no existe.",
  "ledger/insufficient_funds": "El saldo no es suficiente.",
  "ledger/hold_not_open": "Esa reserva de saldo ya está resuelta.",
  "ledger/invalid_amount": "El importe debe ser un número entero positivo.",

  // Rating.
  "rating/unknown_algorithm": "Ese algoritmo de valoración no existe.",
  "rating/unsupported_player_count": "Ese número de jugadores no es compatible con esta valoración.",
  "rating/invalid_params": "Los parámetros de valoración no son válidos.",
  "rating/game_not_found": "Ese juego no tiene valoración.",
  "rating/pool_not_found": "Ese grupo de valoración no existe.",
  "rating/record_forbidden": "No puedes registrar resultados valorados.",

  // Matchmaking.
  "matchmaking/room_not_found": "Ese código no corresponde a ninguna sala abierta.",
  "matchmaking/room_full": "Esa sala ya no admite más jugadores.",
  "matchmaking/invalid_code": "Ese código de sala no es válido.",
  "matchmaking/invite_not_found": "Esa invitación no existe.",
  "matchmaking/invite_forbidden": "No puedes actuar sobre esta invitación.",
  "matchmaking/user_not_found": "No se ha encontrado a esa persona.",
  "matchmaking/already_friends": "Ya hay una amistad o una solicitud con esa persona.",
  "matchmaking/friend_request_not_found": "No hay ninguna solicitud de amistad pendiente.",
  "matchmaking/not_queued": "No estás en la cola.",

  // Storage. The 404 keeps the English hedge, because telling a stranger that a file exists is the leak
  // the code was written to avoid, and a Spanish sentence that resolves the ambiguity undoes it.
  "storage/not_found": "Ese archivo no existe o no tienes acceso a él.",
  "storage/forbidden": "No tienes acceso a este archivo.",
  "storage/quota_exceeded": "La subida supera tu espacio disponible.",
  "storage/upload_incomplete": "La subida de este archivo no ha terminado.",
  "storage/multipart_failed": "No se ha podido completar la subida.",
  "storage/share_expired": "Este enlace compartido ha caducado.",
  "storage/share_revoked": "Este enlace compartido se ha revocado.",

  // Vector search.
  "vector/metadata_index_drift": "Esta búsqueda no está disponible ahora.",
  "vector/dimension_mismatch": "El vector no tiene las dimensiones del índice.",
  "vector/topk_exceeded": "Has pedido más resultados de los permitidos en esta consulta.",
  "vector/filter_too_large": "El filtro es demasiado grande.",
  "vector/metadata_too_large": "Los metadatos del vector superan el tamaño permitido.",
  "vector/index_not_found": "Ese índice no existe.",
  "vector/unfilterable_field": "Por ese campo no se puede filtrar.",

  // Payments.
  "payments/invalid_receipt": "Ese recibo no tiene un formato válido.",
  "payments/verification_failed": "La tienda ha rechazado el recibo.",
  "payments/webhook_unverified": "La firma de la notificación de pago no es válida.",
  "payments/rail_not_configured": "Ese método de pago no está disponible.",
  "payments/product_not_found": "Ese producto no está en el catálogo.",
  "payments/environment_mismatch": "Esa compra pertenece a otro entorno de la tienda.",
  "payments/subscription_change_refused": "El estado de esa suscripción no permite el cambio solicitado.",
  "payments/receipt_already_owned": "Esa compra ya pertenece a otra cuenta.",
  "payments/provider_unavailable": "No se ha podido contactar con la tienda. Inténtalo más tarde.",
  "payments/entitlement_required": "Necesitas una compra activa para esto.",
  "payments/clawback_failed": "No se ha podido recuperar el importe del reembolso.",
  "payments/discount_invalid": "Ese código de descuento no es válido.",
  "payments/entitlement_not_in_catalog": "Ese derecho de acceso no está en el catálogo.",
  "payments/subject_unresolved": "No se ha podido determinar en nombre de quién actúas.",

  // Control plane. The caller here is a management client, never an end user — the words stay caller-facing
  // all the same, because `clientError` strips `action` on this path exactly as it does on every other.
  "controlplane/not_connected": "No hay conexión de administración para este entorno.",
  "controlplane/invalid_credential": "La credencial de administración no es válida.",
  "controlplane/insufficient_scope": "La credencial de administración no tiene permiso para esta operación.",
  "controlplane/key_not_found": "Esa clave no existe.",
  "controlplane/key_conflict": "Esa operación entra en conflicto con el estado de la conexión.",

  // Support.
  "support/not_found": "Esa conversación de soporte no existe.",
  "support/invalid_category": "Esa categoría de soporte no es válida.",
  "support/unparseable_message": "No se ha podido leer el mensaje.",
  "support/rejected": "Has enviado demasiados mensajes. Inténtalo más tarde.",
  "support/classification_failed": "No se ha podido clasificar el mensaje.",
  "support/reply_failed": "No se ha podido enviar la respuesta.",

  // Testers.
  "testers/cohort_not_found": "Ese grupo de pruebas no existe.",
  "testers/member_not_found": "No hay ningún participante con esos datos.",
  "testers/invalid_token": "Ese enlace de invitación no es válido o ha caducado.",
  "testers/roster_full": "El grupo de pruebas está completo.",
  "testers/already_on_roster": "Esa dirección ya está en el grupo de pruebas.",
  "testers/cohort_closed": "Ese grupo de pruebas está cerrado.",
  "testers/withdrawn": "Esa dirección se ha dado de baja de este grupo de pruebas.",
  "testers/nudge_cooldown": "Se ha avisado a estas personas hace poco. Espera para volver a hacerlo.",
  "testers/copy_not_allowed": "No se admite un mensaje propio en los avisos.",
  "testers/not_configured": "Las pruebas no están disponibles ahora.",
};
