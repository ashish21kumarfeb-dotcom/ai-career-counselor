"use client";

import { useEffect, useState } from "react";

// Shared client-side resume-upload mechanics, used by both the dashboard
// ResumeUploader and the onboarding resume step so the fetch/parse-call logic
// lives in exactly one place. Loads the user's current resume on mount, and
// uploads a file to /api/resume (parse + store + memory extraction happen
// server-side). One active resume per user — a new upload replaces the previous.

export type CurrentResume = {
  filename: string;
  chars: number;
  preview: string;
  uploadedAt: string;
} | null;

export type UseResumeUpload = {
  current: CurrentResume;
  loadingCurrent: boolean;
  file: File | null;
  selectFile: (file: File | null) => void;
  // Uploads `target` (or the currently selected file). Resolves true on success.
  upload: (target?: File) => Promise<boolean>;
  // Submits pasted resume text (JSON path). Resolves true on success.
  uploadText: (text: string) => Promise<boolean>;
  uploading: boolean;
  error: string | null;
  success: string | null;
};

// `loadCurrent` (default true) controls the mount fetch of the user's existing
// resume. Onboarding passes false: new users have no resume to show, so the GET
// is skipped.
export function useResumeUpload(
  options: { loadCurrent?: boolean } = {}
): UseResumeUpload {
  const { loadCurrent = true } = options;
  const [current, setCurrent] = useState<CurrentResume>(null);
  const [loadingCurrent, setLoadingCurrent] = useState(loadCurrent);
  const [file, setFileState] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!loadCurrent) return;
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
  }, [loadCurrent]);

  function selectFile(f: File | null) {
    setError(null);
    setSuccess(null);
    setFileState(f);
  }

  // Shared POST + result handling for both the file and pasted-text paths. The
  // caller supplies the request init; success/error state and `current` are
  // updated the same way regardless of how the resume arrived.
  async function submit(init: RequestInit): Promise<boolean> {
    if (uploading) return false;
    setError(null);
    setSuccess(null);
    setUploading(true);
    try {
      const res = await fetch("/api/resume", { method: "POST", ...init });
      const data = await res.json().catch(() => ({}));

      if (res.status === 200 && data.ok) {
        setCurrent({
          filename: data.filename,
          chars: data.chars,
          preview: data.preview,
          uploadedAt: new Date().toISOString(),
        });
        setSuccess(
          `Saved ${data.filename} — ${data.chars.toLocaleString()} characters. Your career advice will now use it.`
        );
        setFileState(null);
        return true;
      }
      if (res.status === 401) {
        setError("Your session expired. Please sign in again.");
        return false;
      }
      setError(data.error ?? "Upload failed. Please try again.");
      return false;
    } catch {
      setError("Network error. Please try again.");
      return false;
    } finally {
      setUploading(false);
    }
  }

  async function upload(target?: File): Promise<boolean> {
    const f = target ?? file;
    if (!f) return false;
    const fd = new FormData();
    fd.append("file", f);
    return submit({ body: fd });
  }

  async function uploadText(text: string): Promise<boolean> {
    if (!text.trim()) return false;
    return submit({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  return { current, loadingCurrent, file, selectFile, upload, uploadText, uploading, error, success };
}
