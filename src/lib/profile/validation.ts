import { z } from "zod";

// Validation for the profile onboarding form. Only `userType` is required
// (it is NOT NULL in `user_profiles`); every other field is optional and
// normalized to `null` when left blank so we store clean data.

export const userTypeValues = [
  "student",
  "fresher",
  "working_professional",
  "job_switcher",
] as const;

// Trim, then treat empty strings as "not provided" (null).
const optionalText = z
  .string()
  .trim()
  .max(2000, "Please keep this under 2000 characters")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

export const profileSchema = z.object({
  userType: z.enum(userTypeValues, {
    message: "Please choose where you are right now",
  }),
  education: optionalText,
  currentRole: optionalText,
  skills: optionalText,
  interests: optionalText,
  careerGoal: optionalText,
  location: optionalText,
});

export type ProfileInput = z.infer<typeof profileSchema>;
