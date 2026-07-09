import { eq } from "drizzle-orm";
import { db } from "../../db";
import { userProfiles } from "../../db/schema";
import type { ProfileInput } from "./validation";

// Drizzle data-access helpers for the `user_profiles` table. The unique
// constraint on `user_id` guarantees at most one profile per user, so we upsert
// on that column.

export async function getProfileByUserId(userId: string) {
  const rows = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return rows[0];
}

export async function upsertProfile(userId: string, input: ProfileInput) {
  const values = {
    userId,
    userType: input.userType,
    education: input.education,
    currentRole: input.currentRole,
    skills: input.skills,
    interests: input.interests,
    careerGoal: input.careerGoal,
    location: input.location,
  };

  const rows = await db
    .insert(userProfiles)
    .values(values)
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: {
        userType: values.userType,
        education: values.education,
        currentRole: values.currentRole,
        skills: values.skills,
        interests: values.interests,
        careerGoal: values.careerGoal,
        location: values.location,
        updatedAt: new Date(),
      },
    })
    .returning({ id: userProfiles.id, userId: userProfiles.userId });

  return rows[0];
}
