"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { SubmitButton } from "../auth/SubmitButton";
import {
  OnboardingChoiceCards,
  OnboardingText,
  OnboardingTextarea,
  type ChoiceOption,
} from "./OnboardingField";

const USER_TYPE_OPTIONS: ChoiceOption[] = [
  {
    value: "student",
    title: "Student",
    description: "Still studying and exploring where to head next.",
    emoji: "🎓",
  },
  {
    value: "fresher",
    title: "Fresher",
    description: "Recently graduated and ready to start out.",
    emoji: "🌱",
  },
  {
    value: "working_professional",
    title: "Working professional",
    description: "Employed and growing in my current field.",
    emoji: "💼",
  },
  {
    value: "job_switcher",
    title: "Job switcher",
    description: "Looking to move into a different career.",
    emoji: "🧭",
  },
];

const STEPS = ["You", "Background", "Goals"] as const;

type FieldErrors = Partial<
  Record<
    | "userType"
    | "education"
    | "currentRole"
    | "skills"
    | "interests"
    | "careerGoal"
    | "location",
    string
  >
>;

export function OnboardingForm() {
  const router = useRouter();
  const [step, setStep] = useState(0);

  const [userType, setUserType] = useState<string | null>(null);
  const [education, setEducation] = useState("");
  const [currentRole, setCurrentRole] = useState("");
  const [location, setLocation] = useState("");
  const [skills, setSkills] = useState("");
  const [interests, setInterests] = useState("");
  const [careerGoal, setCareerGoal] = useState("");

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isLastStep = step === STEPS.length - 1;

  function goNext() {
    // Only the first step gates progress — user_type is the one required field.
    if (step === 0 && !userType) {
      setFieldErrors({ userType: "Please choose where you are right now" });
      return;
    }
    setFieldErrors({});
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function goBack() {
    setFieldErrors({});
    setFormError(null);
    setStep((s) => Math.max(s - 1, 0));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!isLastStep) {
      goNext();
      return;
    }

    if (!userType) {
      setStep(0);
      setFieldErrors({ userType: "Please choose where you are right now" });
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userType,
          education,
          currentRole,
          location,
          skills,
          interests,
          careerGoal,
        }),
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

      if (res.status === 400 && data.fieldErrors) {
        const fe: FieldErrors = {};
        for (const key of [
          "userType",
          "education",
          "currentRole",
          "skills",
          "interests",
          "careerGoal",
          "location",
        ] as const) {
          const message = data.fieldErrors[key]?.[0];
          if (message) fe[key] = message;
        }
        setFieldErrors(fe);
        // Surface the required-field error on its own step.
        if (fe.userType) setStep(0);
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
      {/* Progress */}
      <div className="flex items-center gap-2" aria-hidden>
        {STEPS.map((label, i) => (
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
            onChange={(v) => {
              setUserType(v);
              setFieldErrors((prev) => ({ ...prev, userType: undefined }));
            }}
            error={fieldErrors.userType}
          />
        </div>
      ) : null}

      {/* Step 2 — background */}
      {step === 1 ? (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-heading">Tell us about you</h2>
            <p className="mt-1 text-sm text-slate-400">
              All optional — share whatever feels relevant.
            </p>
          </div>
          <OnboardingText
            id="education"
            label="Education"
            placeholder="e.g. B.Com, final year"
            value={education}
            onChange={setEducation}
            error={fieldErrors.education}
          />
          <OnboardingText
            id="currentRole"
            label="Current role"
            placeholder="e.g. Sales associate (or leave blank)"
            value={currentRole}
            onChange={setCurrentRole}
            error={fieldErrors.currentRole}
          />
          <OnboardingText
            id="location"
            label="Location"
            placeholder="e.g. Delhi, India"
            value={location}
            onChange={setLocation}
            error={fieldErrors.location}
          />
        </div>
      ) : null}

      {/* Step 3 — skills & goals */}
      {step === 2 ? (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-heading">Skills & goals</h2>
            <p className="mt-1 text-sm text-slate-400">
              The more you share, the more personalized your guidance.
            </p>
          </div>
          <OnboardingTextarea
            id="skills"
            label="Skills"
            hint="Comma-separated is fine."
            placeholder="e.g. communication, Excel, basic SQL"
            value={skills}
            onChange={setSkills}
            error={fieldErrors.skills}
          />
          <OnboardingTextarea
            id="interests"
            label="Interests"
            placeholder="e.g. data, marketing, working with people"
            value={interests}
            onChange={setInterests}
            error={fieldErrors.interests}
          />
          <OnboardingTextarea
            id="careerGoal"
            label="Career goal"
            placeholder="e.g. Move into business analytics within a year"
            value={careerGoal}
            onChange={setCareerGoal}
            error={fieldErrors.careerGoal}
          />
        </div>
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
            <SubmitButton loading={loading}>Finish & continue</SubmitButton>
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
