import { NextResponse } from "next/server";
import { countAvailable, nextQuestion } from "@/lib/selection";
import { NotSignedInError, currentUserId } from "@/lib/users";
import type { QuizFilters } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { filters: QuizFilters; exclude?: number[] };
    const question = nextQuestion(await currentUserId(), body.filters, body.exclude ?? []);

    return NextResponse.json({
      question,
      remaining: Math.max(0, countAvailable(body.filters) - (body.exclude?.length ?? 0)),
    });
  } catch (error) {
    // A cookie for a revoked session gets past the middleware, which can only
    // see that one exists. Answer 401 rather than throwing a 500.
    if (error instanceof NotSignedInError) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    throw error;
  }
}
