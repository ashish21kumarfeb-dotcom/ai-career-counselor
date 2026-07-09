import { NextResponse } from "next/server";
import { signupSchema } from "../../../../lib/auth/validation";
import { getUserByEmail, createUser } from "../../../../lib/auth/queries";
import { hashPassword } from "../../../../lib/auth/password";
import { createSession } from "../../../../lib/auth/session";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        fieldErrors: parsed.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  }

  const { name, email, password } = parsed.data;

  try {
    const existing = await getUserByEmail(email);
    if (existing) {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 409 }
      );
    }

    const passwordHash = await hashPassword(password);
    const user = await createUser({ name, email, passwordHash });

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
      { status: 201 }
    );
  } catch (error) {
    // Backstop for the rare race where a duplicate email slips past the
    // pre-check: Postgres unique-violation code is 23505.
    const code = (error as { code?: string })?.code;
    if (code === "23505") {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 409 }
      );
    }
    console.error("Signup error:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
