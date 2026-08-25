/**
 * Timestamp comparison helpers.
 *
 * Every timestamp column on this platform is declared `mode: "string"`, so
 * Postgres hands back its own textual form — `2026-08-25 23:00:00.142+00` —
 * while anything the application produces comes from `toISOString()`:
 * `2026-08-25T23:00:00.142Z`. Comparing those two as strings is wrong in a way
 * that hides: the date halves compare correctly, so the bug is invisible on
 * every day except the one that matters. On the expiry day itself the
 * separator decides it — a space (0x20) sorts before `T` (0x54) — so a
 * credential valid until 23:00 reads as already expired at 10:00.
 *
 * Compare instants, never their spellings.
 */
export function epochMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when `value` is a timestamp at or before `nowMs`. Null never expires. */
export function isExpired(value: string | null | undefined, nowMs: number = Date.now()): boolean {
  const at = epochMs(value);
  return at !== null && at <= nowMs;
}

/** True when `value` is a timestamp strictly after `nowMs`. Null is not future-dated. */
export function isFuture(value: string | null | undefined, nowMs: number = Date.now()): boolean {
  const at = epochMs(value);
  return at !== null && at > nowMs;
}
