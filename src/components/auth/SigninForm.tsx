"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthField } from "./AuthField";
import { SubmitButton } from "./SubmitButton";

type FieldErrors = Partial<Record<"email" | "password", string>>;

export function SigninForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    setFormError(null);

    setLoading(true);
    try {
      const res = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (res.status === 200) {
        router.push("/dashboard");
        router.refresh();
        return;
      }

      const data = await res.json().catch(() => ({}));

      if (res.status === 400 && data.fieldErrors) {
        const fe: FieldErrors = {};
        for (const key of ["email", "password"] as const) {
          const message = data.fieldErrors[key]?.[0];
          if (message) fe[key] = message;
        }
        setFieldErrors(fe);
      } else if (res.status === 401) {
        setFormError(data.error ?? "Invalid email or password");
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
        autoComplete="current-password"
        required
      />

      <SubmitButton loading={loading}>Sign in</SubmitButton>

      <p className="text-center text-sm text-slate-300">
        Don&apos;t have an account?{" "}
        <a href="/signup" className="font-medium text-brand underline-offset-2 hover:underline">
          Sign up
        </a>
      </p>
    </form>
  );
}
