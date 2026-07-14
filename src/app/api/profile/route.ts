import { NextResponse } from "next/server";
import { profileRequestSchema } from "../../../lib/profile/validation";
import { mapAnswersToProfile } from "../../../lib/profile/fields";
import { upsertProfile } from "../../../lib/profile/queries";
import { getSession } from "../../../lib/auth/session";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = profileRequestSchema.safeParse(body);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    return NextResponse.json(
      {
        error: "Validation failed",
        formErrors: flat.formErrors,
        fieldErrors: flat.fieldErrors,
      },
      { status: 400 }
    );
  }

  try {
    const mapped = mapAnswersToProfile(parsed.data.userType, parsed.data.answers);
    const profile = await upsertProfile(session.userId, mapped);
    return NextResponse.json({ profile }, { status: 200 });
  } catch (error) {
    console.error("Profile save error:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
