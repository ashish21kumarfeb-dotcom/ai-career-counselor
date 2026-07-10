"use client";

import { useEffect, useRef, useState } from "react";

// Resume upload UI. Loads the user's current resume (if any) on mount, accepts a
// PDF / DOCX / TXT file, uploads it to /api/resume (parse + store + memory
// extraction happen server-side), and reflects the result. One active resume per
// user — a new upload replaces the previous one.

type Current = {
  filename: string;
  chars: number;
  preview: string;
  uploadedAt: string;
} | null;

const ACCEPT = ".pdf,.docx,.txt";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function ResumeUploader() {
  const [current, setCurrent] = useState<Current>(null);
  const [loadingCurrent, setLoadingCurrent] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/resume")
      .then((r) => r.json())
      .then((d) => {
        if (active) setCurrent(d.resume ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingCurrent(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function upload() {
    if (!file || uploading) return;
    setError(null);
    setSuccess(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/resume", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));

      if (res.status === 200 && data.ok) {
        setCurrent({
          filename: data.filename,
          chars: data.chars,
          preview: data.preview,
          uploadedAt: new Date().toISOString(),
        });
        setSuccess(`Uploaded ${data.filename} — ${data.chars.toLocaleString()} characters. Your career advice will now use it.`);
        setFile(null);
        if (inputRef.current) inputRef.current.value = "";
      } else if (res.status === 401) {
        setError("Your session expired. Please sign in again.");
      } else {
        setError(data.error ?? "Upload failed. Please try again.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setUploading(false);
    }
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
            <span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-[11px] font-medium text-mint-light">
              Active
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {current.chars.toLocaleString()} characters
            {current.uploadedAt ? ` · uploaded ${formatDate(current.uploadedAt)}` : ""}
          </p>
          <p className="mt-3 whitespace-pre-wrap rounded-xl border border-white/10 bg-white/5 p-3 text-xs leading-6 text-slate-300">
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
        <h3 className="text-sm font-semibold text-heading">{current ? "Replace resume" : "Upload resume"}</h3>
        <p className="mt-1 text-xs text-slate-400">PDF, DOCX, or TXT · up to 5 MB. It stays private to your account.</p>

        <label
          htmlFor="resume-file"
          className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-white/20 bg-white/5 px-4 py-8 text-center transition hover:border-accent/40 hover:bg-white/10"
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
            onChange={(e) => {
              setError(null);
              setSuccess(null);
              setFile(e.target.files?.[0] ?? null);
            }}
          />
        </label>

        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="mt-3 rounded-lg bg-accent/10 px-3 py-2 text-sm text-mint-light">{success}</p>
        ) : null}

        <button
          type="button"
          onClick={upload}
          disabled={!file || uploading}
          className="btn-primary mt-4 flex h-11 w-full items-center justify-center rounded-xl px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {uploading ? "Uploading…" : current ? "Replace resume" : "Upload resume"}
        </button>
      </div>
    </div>
  );
}
