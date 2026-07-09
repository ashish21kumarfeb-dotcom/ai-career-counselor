import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "./lib/auth/jwt";

// Protects the dashboard. Runs on the edge runtime, so it uses the pure
// `verifySessionToken` (jose only) and reads the cookie off the request.
export async function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    const signinUrl = new URL("/signin", request.url);
    signinUrl.searchParams.set("from", request.nextUrl.pathname);
    return NextResponse.redirect(signinUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard", "/dashboard/:path*"],
};
