import { z } from "zod";
import {
  ONBOARDING_FIELDS,
  OFFERED_USER_TYPES,
  type OfferedUserType,
  type OnboardingFieldDef,
} from "./fields";

// Validation for the dynamic profile onboarding. The request shape is
// `{ userType, answers }`, where `answers` is a flat map of the SELECTED type's
// field keys. The per-type answer schema is built from the same ONBOARDING_FIELDS
// config the UI renders from, so validation can never drift from the form.
//
// `job_switcher` is intentionally NOT accepted here (it stays valid in the DB
// enum for legacy rows, but new onboarding folds switching into
// working_professional). Only OFFERED_USER_TYPES are valid on submission.

// The offered types, re-exported for callers that need the list (kept in sync
// with fields.ts — the single source of truth).
export const userTypeValues = OFFERED_USER_TYPES;

// Trim, then treat empty strings as "not provided" (null).
const optionalText = z
  .string()
  .trim()
  .max(2000, "Please keep this under 2000 characters")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

// A single-choice field: must be one of the declared option values, or null when
// nothing was selected. Empty string / null are normalized to "not selected".
function choiceField(field: OnboardingFieldDef) {
  const values = (field.options ?? []).map((o) => o.value);
  return z
    .preprocess(
      (v) => (v === "" || v == null ? undefined : v),
      z.enum(values as [string, ...string[]]).optional()
    )
    .transform((v) => v ?? null);
}

// Build the answers object schema for one user type from its field defs. Unknown
// keys are stripped (zod object default), so stray input can't reach the mapper.
function buildAnswersSchema(type: OfferedUserType) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of ONBOARDING_FIELDS[type]) {
    shape[field.key] = field.kind === "choice" ? choiceField(field) : optionalText;
  }
  return z.object(shape);
}

// One request-schema branch per offered type, discriminated on `userType`.
// Written out explicitly (not mapped) so zod keeps each literal discriminator and
// infers a proper tagged union for `parsed.data`.
export const profileRequestSchema = z.discriminatedUnion("userType", [
  z.object({ userType: z.literal("student"), answers: buildAnswersSchema("student") }),
  z.object({ userType: z.literal("fresher"), answers: buildAnswersSchema("fresher") }),
  z.object({ userType: z.literal("working_professional"), answers: buildAnswersSchema("working_professional") }),
  z.object({ userType: z.literal("parent_guardian"), answers: buildAnswersSchema("parent_guardian") }),
]);

export type ProfileRequest = z.infer<typeof profileRequestSchema>;
