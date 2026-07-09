import { z } from "zod";

// Shared client + server validation schemas for auth forms.
// Email is trimmed and lowercased so lookups/storage are normalized.

export const signupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be at most 100 characters"),
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")),
  // bcrypt only uses the first 72 bytes; cap length to match that limit.
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(72, "Password must be at most 72 characters"),
});

export const signinSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")),
  password: z.string().min(1, "Password is required"),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type SigninInput = z.infer<typeof signinSchema>;
