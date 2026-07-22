"use client";

import { useRef, useState } from "react";
import { useResumeUpload } from "../../lib/resume/useResumeUpload";

// Resume upload UI for the dashboard. Loads the user's current resume (if any) on
// mount, accepts a PDF / DOCX / TXT file, uploads it to /api/resume (parse +
// store + memory extraction happen server-side), and reflects the result. One
// active resume per user — a new upload replaces the previous one. The upload
// mechanics live in the shared useResumeUpload hook (also used by onboarding).

const ACCEPT = ".pdf,.docx,.txt";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function ResumeUploader() {
  const { current, loadingCurrent, file, selectFile, upload, uploadText, uploading, error, success } =
    useResumeUpload();
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [pasted, setPasted] = useState("");

  async function handleUpload() {
    const ok = await upload();
    if (ok && inputRef.current) inputRef.current.value = "";
  }

  async function handlePaste() {
    const ok = await uploadText(pasted);
    if (ok) setPasted("");
  }

  return (
    <div className="space-y-5">
      {/* Current resume */}
      {loadingCurrent ? (
        <div className="glass-card rounded-2xl p-5 text-sm text-slate-400">Loading your resume…</div>
      ) : current ? (
        <div className="glass-card rounded-2xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-heading">
              <span aria-hidden>📄</span> {current.filename}
            </h3>
            <span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-[11px] font-semibold text-mint-light">
              Active
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {current.chars.toLocaleString()} characters
            {current.uploadedAt ? ` · uploaded ${formatDate(current.uploadedAt)}` : ""}
          </p>
          <p className="mt-3 whitespace-pre-wrap rounded-xl border border-slate-900/10 bg-slate-900/[0.03] p-3 text-xs leading-6 text-slate-300">
            {current.preview}
            {current.chars > current.preview.length ? "…" : ""}
          </p>
        </div>
      ) : (
        <div className="glass-card rounded-2xl p-5 text-sm text-slate-400">
          No resume yet. Upload one to personalize your career guidance.
        </div>
      )}

      {/* Uploader */}
      <div className="glass-card rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-heading">{current ? "Replace resume" : "Add resume"}</h3>
        <p className="mt-1 text-xs text-slate-400">
          Upload a PDF, DOCX, or TXT file (up to 5 MB) or paste the text. It stays private to your account.
        </p>

        {/* Mode toggle */}
        <div className="mt-4 inline-flex rounded-xl border border-slate-900/10 bg-slate-900/[0.03] p-1 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setMode("file")}
            className={`rounded-lg px-3 py-1.5 transition ${mode === "file" ? "bg-accent/15 text-mint-light" : "text-slate-400 hover:text-slate-200"}`}
          >
            Upload file
          </button>
          <button
            type="button"
            onClick={() => setMode("paste")}
            className={`rounded-lg px-3 py-1.5 transition ${mode === "paste" ? "bg-accent/15 text-mint-light" : "text-slate-400 hover:text-slate-200"}`}
          >
            Paste text
          </button>
        </div>

        {mode === "file" ? (
          <label
            htmlFor="resume-file"
            className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-slate-900/15 bg-slate-900/[0.03] px-4 py-8 text-center transition hover:border-accent/40 hover:bg-slate-900/[0.06]"
          >
            <span aria-hidden className="text-2xl">⬆️</span>
            <span className="text-sm font-medium text-slate-100">{file ? file.name : "Choose a file"}</span>
            <span className="text-xs text-slate-400">{file ? `${(file.size / 1024).toFixed(0)} KB` : "PDF · DOCX · TXT"}</span>
            <input
              id="resume-file"
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => selectFile(e.target.files?.[0] ?? null)}
            />
          </label>
        ) : (
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={10}
            placeholder="Paste your resume text here…"
            className="mt-4 w-full resize-y rounded-2xl border border-slate-900/15 bg-slate-900/[0.03] p-3 text-xs leading-6 text-slate-200 placeholder:text-slate-500 focus:border-accent/40 focus:outline-none"
          />
        )}

        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="mt-3 rounded-lg bg-accent/10 px-3 py-2 text-sm text-mint-light">{success}</p>
        ) : null}

        {mode === "file" ? (
          <button
            type="button"
            onClick={handleUpload}
            disabled={!file || uploading}
            className="btn-primary mt-4 flex h-11 w-full items-center justify-center rounded-xl px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? "Uploading…" : current ? "Replace resume" : "Upload resume"}
          </button>
        ) : (
          <button
            type="button"
            onClick={handlePaste}
            disabled={pasted.trim().length < 30 || uploading}
            className="btn-primary mt-4 flex h-11 w-full items-center justify-center rounded-xl px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? "Saving…" : current ? "Replace resume" : "Save resume"}
          </button>
        )}
      </div>
    </div>
  );
}
