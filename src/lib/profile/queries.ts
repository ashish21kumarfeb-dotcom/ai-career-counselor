import { eq } from "drizzle-orm";
import { db } from "../../db";
import { userProfiles } from "../../db/schema";
import type { MappedProfile } from "./fields";

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

// Persist a profile mapped from dynamic onboarding answers (see
// mapAnswersToProfile). The 6 common columns are written directly; type-specific
// extras live in the `details` jsonb column (null when none were provided).
export async function upsertProfile(userId: string, input: MappedProfile) {
  const values = {
    userId,
    userType: input.userType,
    education: input.education,
    currentRole: input.currentRole,
    skills: input.skills,
    interests: input.interests,
    careerGoal: input.careerGoal,
    location: input.location,
    yearsExperience: input.yearsExperience,
    details: input.details,
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
        yearsExperience: values.yearsExperience,
        details: values.details,
        updatedAt: new Date(),
      },
    })
    .returning({ id: userProfiles.id, userId: userProfiles.userId });

  return rows[0];
}
