import { NextResponse } from "next/server";
import { signinSchema } from "../../../../lib/auth/validation";
import { getUserByEmail } from "../../../../lib/auth/queries";
import { verifyPassword } from "../../../../lib/auth/password";
import { createSession } from "../../../../lib/auth/session";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = signinSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        fieldErrors: parsed.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  }

  const { email, password } = parsed.data;

  try {
    const user = await getUserByEmail(email);
    // Single generic message for both "no such user" and "wrong password" to
    // avoid revealing which emails are registered (user enumeration).
    if (!user || !user.passwordHash) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    await createSession({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    return NextResponse.json(
      {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Signin error:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
