import { NextResponse } from "next/server";
import { profileSchema } from "../../../lib/profile/validation";
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

  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        fieldErrors: parsed.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  }

  try {
    const profile = await upsertProfile(session.userId, parsed.data);
    return NextResponse.json({ profile }, { status: 200 });
  } catch (error) {
    console.error("Profile save error:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
