import type { ReactNode } from "react";

type SubmitButtonProps = {
  loading?: boolean;
  children: ReactNode;
};

export function SubmitButton({ loading, children }: SubmitButtonProps) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="btn-primary mt-1 flex h-11 w-full items-center justify-center rounded-xl px-4 text-sm font-semibold"
    >
      {loading ? "Please wait…" : children}
    </button>
  );
}
