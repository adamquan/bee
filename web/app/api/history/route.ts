import { NextResponse } from "next/server";
import { clearHistory } from "@/lib/history";
import { NotSignedInError, currentUserId } from "@/lib/users";

export const dynamic = "force-dynamic";

/** Erase the current profile's practice history. The bank is untouched. */
export async function DELETE() {
  try {
    return NextResponse.json(clearHistory(await currentUserId()));
  } catch (error) {
    if (error instanceof NotSignedInError) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    // `clearHistory` archives the journal before touching the database, so a
    // failure here means nothing was deleted.
    return NextResponse.json(
      { error: `could not clear history: ${String(error)}` },
      { status: 500 },
    );
  }
}
