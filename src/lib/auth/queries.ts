import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";

// Drizzle data-access helpers for the `users` table used by the auth flow.
// Callers pass an already-normalized (trimmed/lowercased) email.

export type NewUserInput = {
  name: string;
  email: string;
  passwordHash: string;
};

export async function getUserByEmail(email: string) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return rows[0];
}

export async function createUser(input: NewUserInput) {
  const rows = await db
    .insert(users)
    .values({
      name: input.name,
      email: input.email,
      passwordHash: input.passwordHash,
    })
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
    });
  return rows[0];
}
