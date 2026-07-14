"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { SubmitButton } from "../auth/SubmitButton";
import {
  OnboardingChoiceCards,
  OnboardingInlineChoice,
  OnboardingText,
  OnboardingTextarea,
  type ChoiceOption,
} from "./OnboardingField";
import { OnboardingResumeStep } from "./OnboardingResumeStep";
import {
  ONBOARDING_FIELDS,
  USER_TYPE_CARDS,
  showsResumeStep,
  type OfferedUserType,
} from "../../lib/profile/fields";
import { useResumeUpload } from "../../lib/resume/useResumeUpload";

// Step-1 cards come straight from the shared config (same source the API and
// mapper use), so the offered types can't drift between UI and server.
const USER_TYPE_OPTIONS: ChoiceOption[] = USER_TYPE_CARDS.map((c) => ({
  value: c.value,
  title: c.title,
  description: c.description,
  emoji: c.emoji,
}));

// Freshers / working professionals get an extra optional resume step; students
// and parents don't (see showsResumeStep / RESUME_STEP_TYPES).
const BASE_STEPS = ["You", "Details"] as const;
const RESUME_STEPS = ["You", "Details", "Resume"] as const;

export function OnboardingForm() {
  const router = useRouter();
  const [step, setStep] = useState(0);

  const [userType, setUserType] = useState<OfferedUserType | null>(null);
  // Dynamic per-type answers, keyed by field.key. Reset when the type changes.
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const [userTypeError, setUserTypeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Shared resume-upload mechanics. loadCurrent:false — new users have no resume
  // to fetch. Only surfaced on the Resume step, but the hook must be called
  // unconditionally (rules of hooks); the mount GET is skipped anyway.
  const resume = useResumeUpload({ loadCurrent: false });

  const steps = userType && showsResumeStep(userType) ? RESUME_STEPS : BASE_STEPS;
  const isLastStep = step === steps.length - 1;
  const fields = userType ? ONBOARDING_FIELDS[userType] : [];

  function selectUserType(value: string) {
    const next = value as OfferedUserType;
    setUserType(next);
    setAnswers({}); // field set differs per type — start clean
    setUserTypeError(null);
  }

  function setAnswer(key: string, value: string) {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  }

  // Auto-upload the chosen resume immediately (Approach A). The step is
  // presentational; upload policy lives here.
  function onFileChosen(file: File | null) {
    resume.selectFile(file);
    if (file) void resume.upload(file);
  }

  function goNext() {
    if (step === 0 && !userType) {
      setUserTypeError("Please choose where you are right now");
      return;
    }
    setFormError(null);
    setStep((s) => Math.min(s + 1, steps.length - 1));
  }

  function goBack() {
    setFormError(null);
    setStep((s) => Math.max(s - 1, 0));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!isLastStep) {
      goNext();
      return;
    }

    // Don't finish while a resume upload is in flight — navigating away would
    // abort it. The Finish button is disabled in this state; this is a guard.
    if (resume.uploading) return;

    if (!userType) {
      setStep(0);
      setUserTypeError("Please choose where you are right now");
      return;
    }

    setFormError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userType, answers }),
      });

      if (res.status === 200) {
        router.push("/dashboard");
        router.refresh();
        return;
      }

      if (res.status === 401) {
        router.push("/signin");
        return;
      }

      const data = await res.json().catch(() => ({}));
      setFormError(data.error ?? "Something went wrong");
    } catch {
      setFormError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
      {/* Progress */}
      <div className="flex items-center gap-2" aria-hidden>
        {steps.map((label, i) => (
          <div key={label} className="flex flex-1 flex-col gap-1.5">
            <div
              className={`h-1.5 rounded-full transition-colors ${
                i <= step ? "bg-brand shadow-[0_0_10px_1px_rgba(86,197,150,0.55)]" : "bg-heading/10"
              }`}
            />
            <span
              className={`text-xs font-medium ${
                i <= step ? "text-heading" : "text-slate-400"
              }`}
            >
              {label}
            </span>
          </div>
        ))}
      </div>

      {formError ? (
        <p
          role="alert"
          className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {formError}
        </p>
      ) : null}

      {/* Step 1 — where are you right now */}
      {step === 0 ? (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-heading">
              Where are you right now?
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              This helps us tailor guidance to your stage.
            </p>
          </div>
          <OnboardingChoiceCards
            options={USER_TYPE_OPTIONS}
            value={userType}
            onChange={selectUserType}
            error={userTypeError ?? undefined}
          />
        </div>
      ) : null}

      {/* Step 2 — dynamic fields for the selected type */}
      {step === 1 ? (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-heading">Tell us more</h2>
            <p className="mt-1 text-sm text-slate-400">
              All optional — share whatever feels relevant.
            </p>
          </div>
          {fields.map((field) => {
            const value = answers[field.key] ?? "";
            if (field.kind === "choice") {
              return (
                <OnboardingInlineChoice
                  key={field.key}
                  id={field.key}
                  label={field.label}
                  hint={field.hint}
                  options={field.options ?? []}
                  value={answers[field.key] ?? null}
                  onChange={(v) => setAnswer(field.key, v)}
                />
              );
            }
            if (field.kind === "textarea") {
              return (
                <OnboardingTextarea
                  key={field.key}
                  id={field.key}
                  label={field.label}
                  hint={field.hint}
                  placeholder={field.placeholder}
                  value={value}
                  onChange={(v) => setAnswer(field.key, v)}
                />
              );
            }
            return (
              <OnboardingText
                key={field.key}
                id={field.key}
                label={field.label}
                hint={field.hint}
                placeholder={field.placeholder}
                type={field.kind === "number" ? "number" : "text"}
                value={value}
                onChange={(v) => setAnswer(field.key, v)}
              />
            );
          })}
        </div>
      ) : null}

      {/* Step 3 — optional resume upload (freshers / working professionals) */}
      {step === 2 ? (
        <OnboardingResumeStep
          current={resume.current}
          file={resume.file}
          uploading={resume.uploading}
          error={resume.error}
          success={resume.success}
          onFileChosen={onFileChosen}
        />
      ) : null}

      {/* Nav */}
      <div className="flex items-center gap-3">
        {step > 0 ? (
          <button
            type="button"
            onClick={goBack}
            className="btn-ghost flex h-11 items-center justify-center rounded-xl px-5 text-sm font-semibold"
          >
            Back
          </button>
        ) : null}
        <div className="flex-1">
          {isLastStep ? (
            <SubmitButton loading={loading || resume.uploading}>
              Finish &amp; continue
            </SubmitButton>
          ) : (
            <button
              type="submit"
              className="btn-primary mt-1 flex h-11 w-full items-center justify-center rounded-xl px-4 text-sm font-semibold"
            >
              Continue
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
