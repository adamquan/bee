"use client";

import { useEffect, useState } from "react";
import { utcToDate } from "@/lib/time";

/**
 * A UTC timestamp shown in the viewer's own timezone.
 *
 * The pages that use this are server components, so anything formatted during
 * render is formatted in the *container's* timezone — which is UTC, and which
 * is why "recent sessions" read hours out. Only the browser knows where the
 * student actually is, so the formatting has to happen after hydration.
 *
 * Nothing is rendered on the server rather than a UTC value that would be
 * replaced a frame later: briefly showing the wrong time is worse than briefly
 * showing none, and it avoids a hydration mismatch. `<time dateTime>` still
 * carries the machine-readable instant for anything reading the markup.
 */

interface Props {
  /** `YYYY-MM-DD HH:MM:SS` as stored by SQLite, in UTC. */
  utc: string;
  /** `datetime` (default) shows the time too; `date` is the day alone. */
  mode?: "datetime" | "date";
}

export default function LocalTime({ utc, mode = "datetime" }: Props) {
  const [text, setText] = useState<string | null>(null);
  const date = utcToDate(utc);

  useEffect(() => {
    const parsed = utcToDate(utc);
    if (!parsed) return;
    setText(
      mode === "date"
        ? parsed.toLocaleDateString()
        : parsed.toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
    );
  }, [utc, mode]);

  if (!date) return <span className="text-ink-500">—</span>;

  return (
    <time
      dateTime={date.toISOString()}
      title={`${date.toISOString()} (UTC)`}
      // Reserve a little width so the surrounding row does not jump when the
      // text arrives on hydration.
      className="inline-block min-w-[7ch]"
    >
      {text}
    </time>
  );
}
