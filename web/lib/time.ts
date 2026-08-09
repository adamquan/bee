/**
 * SQLite stores timestamps as `datetime('now')` — `YYYY-MM-DD HH:MM:SS`, in
 * UTC, with nothing in the string saying so.
 *
 * Two things go wrong if that is handed straight to `new Date()`:
 *
 * 1. Without a zone marker it is read as *local* time, which silently shifts
 *    every timestamp by the viewer's offset.
 * 2. Appending `Z` alone leaves `2026-08-01 12:00:00Z`, which is not ISO 8601.
 *    V8 accepts it; Safari has historically returned `Invalid Date`.
 *
 * So the separator has to become `T` as well.
 */
export function utcToDate(stamp: string | null | undefined): Date | null {
  if (!stamp) return null;

  const trimmed = stamp.trim();
  if (!trimmed) return null;

  // Already carries a zone (`Z` or `+05:30`)? Leave it alone beyond the
  // separator, which Safari still needs as `T`.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const iso = trimmed.replace(" ", "T") + (zoned ? "" : "Z");

  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
