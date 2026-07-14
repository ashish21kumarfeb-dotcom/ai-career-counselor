import type { ReactNode } from "react";

// Small presentational field components for the onboarding form. The auth flow's
// AuthField is input-only, so onboarding gets its own text input, textarea, and
// choice-card group — all sharing the existing brand palette.

type BaseProps = {
  id: string;
  label: string;
  hint?: string;
  error?: string;
};

function FieldShell({
  id,
  label,
  hint,
  error,
  children,
}: BaseProps & { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-slate-300">
        {label}
      </label>
      {hint ? <p className="text-xs text-slate-400">{hint}</p> : null}
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const inputClasses = "glass-input rounded-xl px-3.5 py-2.5 text-sm";

type TextFieldProps = BaseProps & {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  // Defaults to "text". Use "number" for numeric fields (e.g. years of
  // experience) — renders a numeric input with a min of 0.
  type?: "text" | "number";
};

export function OnboardingText({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  placeholder,
  autoComplete,
  type = "text",
}: TextFieldProps) {
  const numeric = type === "number";
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        name={id}
        type={type}
        inputMode={numeric ? "numeric" : undefined}
        min={numeric ? 0 : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={inputClasses}
      />
    </FieldShell>
  );
}

type TextAreaFieldProps = TextFieldProps & { rows?: number };

export function OnboardingTextarea({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  placeholder,
  rows = 3,
}: TextAreaFieldProps) {
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <textarea
        id={id}
        name={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`${inputClasses} resize-none`}
      />
    </FieldShell>
  );
}

// Inline single-select for a small set of options (e.g. grow vs. switch). Renders
// as a labelled row of pill buttons — distinct from the large step-1 cards.
type InlineChoiceProps = BaseProps & {
  options: { value: string; label: string }[];
  value: string | null;
  onChange: (value: string) => void;
};

export function OnboardingInlineChoice({
  id,
  label,
  hint,
  error,
  options,
  value,
  onChange,
}: InlineChoiceProps) {
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option.value)}
              className={`rounded-xl border px-4 py-2 text-sm font-medium transition-all ${
                selected
                  ? "border-brand/70 bg-mint/15 text-heading ring-2 ring-brand/35"
                  : "border-white/12 bg-white/5 text-slate-300 hover:border-brand/40 hover:bg-white/10"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </FieldShell>
  );
}

export type ChoiceOption = {
  value: string;
  title: string;
  description: string;
  emoji: string;
};

type ChoiceCardsProps = {
  options: ChoiceOption[];
  value: string | null;
  onChange: (value: string) => void;
  error?: string;
};

export function OnboardingChoiceCards({
  options,
  value,
  onChange,
  error,
}: ChoiceCardsProps) {
  return (
    <div className="flex flex-col gap-3">
      <div
        role="radiogroup"
        aria-label="Where you are right now"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option.value)}
              className={`flex items-start gap-3 rounded-2xl border p-4 text-left transition-all ${
                selected
                  ? "border-brand/70 bg-mint/15 ring-2 ring-brand/35"
                  : "border-white/12 bg-white/5 hover:border-brand/40 hover:bg-white/10"
              }`}
            >
              <span className="text-2xl" aria-hidden>
                {option.emoji}
              </span>
              <span className="flex flex-col">
                <span className="text-sm font-semibold text-heading">
                  {option.title}
                </span>
                <span className="mt-0.5 text-xs leading-5 text-slate-400">
                  {option.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
