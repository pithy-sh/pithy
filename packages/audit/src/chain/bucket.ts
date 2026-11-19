// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

/** The binding the checkpoint bucket is bound as, in the app Worker and in the checkpoint host. */
export const AUDIT_CHECKPOINT_BINDING = "AUDIT_CHECKPOINTS";

/** Every checkpoint object lives under this prefix, and the lock rule names it. */
export const AUDIT_CHECKPOINT_LOCK_PREFIX = "checkpoints/";
