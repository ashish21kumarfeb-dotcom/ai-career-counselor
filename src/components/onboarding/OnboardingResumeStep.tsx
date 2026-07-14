"use client";

import { useEffect, useRef } from "react";
import type { CurrentResume } from "../../lib/resume/useResumeUpload";

// Compact, optional resume-upload step shown in onboarding for freshers and
// working professionals. Presentational: the parent form owns the shared
// useResumeUpload hook and passes state in, plus an `onFileChosen` handler that
// auto-uploads the selected file. Uploading is optional — the form's nav provides
// Finish, and the dashboard remains the place to manage the resume later.

const ACCEPT = ".pdf,.docx,.txt";

type Props = {
  current: CurrentResume;
  file: File | null;
  uploading: boolean;
  error: string | null;
  success: string | null;
  // Fires on file selection; the form uses this to auto-upload immediately.
  onFileChosen: (file: File | null) => void;
};

export function OnboardingResumeStep({
  current,
  file,
  uploading,
  error,
  success,
  onFileChosen,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  // After a successful upload the hook clears `file`; reset the native input too
  // so the same file can be re-selected if the user wants to replace it.
  useEffect(() => {
    if (success && inputRef.current) inputRef.current.value = "";
  }, [success]);

  const uploaded = !uploading && !!current;
  const zoneLabel = uploading
    ? `Uploading ${file?.name ?? "resume"}…`
    : uploaded
      ? `${current!.filename} added`
      : file
        ? file.name
        : "Choose a file";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-heading">Add your resume</h2>
        <p className="mt-1 text-sm text-slate-400">
          Optional — upload your CV so your guidance is personalized from the very
          first conversation. You can add or replace it anytime from your dashboard.
        </p>
      </div>

      <label
        htmlFor="onboarding-resume-file"
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border border-dashed px-4 py-8 text-center transition ${
          uploaded
            ? "border-accent/40 bg-accent/5"
            : "border-white/20 bg-white/5 hover:border-accent/40 hover:bg-white/10"
        }`}
      >
        <span aria-hidden className="text-2xl">
          {uploading ? "⏳" : uploaded ? "✅" : "⬆️"}
        </span>
        <span className="text-sm font-medium text-slate-100">{zoneLabel}</span>
        <span className="text-xs text-slate-400">
          {uploaded
            ? `${current!.chars.toLocaleString()} characters · uploaded`
            : "PDF · DOCX · TXT · up to 5 MB"}
        </span>
        <input
          id="onboarding-resume-file"
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          disabled={uploading}
          className="sr-only"
          onChange={(e) => onFileChosen(e.target.files?.[0] ?? null)}
        />
      </label>

      {error ? (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="rounded-lg bg-accent/10 px-3 py-2 text-sm text-mint-light">{success}</p>
      ) : null}
    </div>
  );
}
