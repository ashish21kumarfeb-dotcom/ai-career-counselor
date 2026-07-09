import { SignJWT, jwtVerify } from "jose";

// Pure JWT helpers with no `next/headers` dependency, so this module is safe to
// import from edge middleware (Step 6) as well as from Node route handlers.

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not set");
}

const secret = new TextEncoder().encode(process.env.JWT_SECRET);

export const SESSION_COOKIE_NAME = "session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export type SessionPayload = {
  userId: string;
  email: string;
  role: string;
};

export async function signSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ email: payload.email, role: payload.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
}

export async function verifySessionToken(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.role !== "string"
    ) {
      return null;
    }
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
    };
  } catch {
    return null;
  }
}
