"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthField } from "./AuthField";
import { SubmitButton } from "./SubmitButton";

type FieldErrors = Partial<
  Record<"name" | "email" | "password" | "confirmPassword", string>
>;

export function SignupForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    setFormError(null);

    if (password !== confirmPassword) {
      setFieldErrors({ confirmPassword: "Passwords do not match" });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      if (res.status === 201) {
        router.push("/dashboard");
        router.refresh();
        return;
      }

      const data = await res.json().catch(() => ({}));

      if (res.status === 400 && data.fieldErrors) {
        const fe: FieldErrors = {};
        for (const key of ["name", "email", "password"] as const) {
          const message = data.fieldErrors[key]?.[0];
          if (message) fe[key] = message;
        }
        setFieldErrors(fe);
      } else if (res.status === 409) {
        setFieldErrors({ email: data.error ?? "Email already registered" });
      } else {
        setFormError(data.error ?? "Something went wrong");
      }
    } catch {
      setFormError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      {formError ? (
        <p
          role="alert"
          className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {formError}
        </p>
      ) : null}

      <AuthField
        id="name"
        label="Name"
        value={name}
        onChange={setName}
        error={fieldErrors.name}
        autoComplete="name"
        required
      />
      <AuthField
        id="email"
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
        error={fieldErrors.email}
        autoComplete="email"
        required
      />
      <AuthField
        id="password"
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        error={fieldErrors.password}
        autoComplete="new-password"
        required
      />
      <AuthField
        id="confirmPassword"
        label="Confirm password"
        type="password"
        value={confirmPassword}
        onChange={setConfirmPassword}
        error={fieldErrors.confirmPassword}
        autoComplete="new-password"
        required
      />

      <SubmitButton loading={loading}>Create account</SubmitButton>

      <p className="text-center text-sm text-slate-300">
        Already have an account?{" "}
        <a href="/signin" className="font-medium text-brand underline-offset-2 hover:underline">
          Sign in
        </a>
      </p>
    </form>
  );
}
