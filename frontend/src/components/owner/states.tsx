"use client";

import { AlertTriangle, FlaskConical, Loader2, RotateCw } from "lucide-react";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { errorCode, errorMessage, errorStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Plain-language next step for the coded wave-2 errors. */
const CODE_HINTS: Record<string, string> = {
  ai_not_configured: "Add ANTHROPIC_API_KEY to .env and restart the API.",
  fallback_unavailable: "Set OPENAI_API_KEY and LLM_FALLBACK=1 in .env, then restart the API.",
  ai_failed: "The provider call failed. Try again in a minute.",
  lms_disabled: "LMS export is switched off (LMS_API=0 in .env). Set LMS_API=1 and restart the API.",
  missing_api_key: "Send the key in the X-API-Key header.",
  invalid_api_key: "The key is wrong or has been revoked (HTTP 403).",
  invalid_since: "Use an ISO date such as 2026-11-01.",
  unknown_topic: "That topic has no results in this batch. Pick another topic.",
  no_results: "No completed results to project from. Load the sample data or pick another batch.",
  unknown_batch: "That batch no longer exists. Reload the page.",
  unknown_institution: "That institution no longer exists. Reload the page.",
  unknown_key: "That key no longer exists. Reload the list.",
};

/** errorMessage() plus a hint for coded errors, and a clear note when a wave-2 route is missing. */
export function describeError(err: unknown): { message: string; hint: string | null; code: string | null } {
  const code = errorCode(err);
  if (code === null && errorStatus(err) === 404) {
    return {
      message: "This panel's API route is not available on the running backend yet (HTTP 404).",
      hint: "The backend part may still be landing; it hot-reloads, so Retry in a moment.",
      code: null,
    };
  }
  return { message: errorMessage(err), hint: code ? (CODE_HINTS[code] ?? null) : null, code };
}

/** Inline error with an optional Retry button (role=alert). */
export function ErrorNote({
  error,
  onRetry,
  retrying = false,
  className,
  prefix,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
  prefix?: string;
}) {
  const { message, hint } = describeError(error);
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-900 ring-1 ring-inset ring-rose-200",
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium break-words">
          {prefix ? `${prefix}: ` : ""}
          {message}
        </p>
        {hint ? <p className="mt-0.5 text-rose-800">{hint}</p> : null}
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-rose-800 ring-1 ring-inset ring-rose-300 hover:bg-rose-100 focus-visible:outline-2 focus-visible:outline-brand-cyan disabled:cursor-wait disabled:opacity-70"
        >
          {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCw className="h-3.5 w-3.5" aria-hidden />}
          Retry
        </button>
      ) : null}
    </div>
  );
}

function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-slate-200/70", className)} />;
}

/** Card-shaped loading placeholder. */
export function CardSkeleton({ rows = 4, className, label }: { rows?: number; className?: string; label: string }) {
  return (
    <div
      aria-busy="true"
      className={cn("rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6", className)}
    >
      <span role="status" className="sr-only">
        {label}
      </span>
      <div aria-hidden>
        <Bone className="h-5 w-48" />
        <Bone className="mt-2 h-3 w-72 max-w-full" />
        <div className="mt-5 space-y-3">
          {Array.from({ length: rows }, (_, i) => (
            <Bone key={i} className="h-8 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** "Sample data" pill for is_demo rows (IllustrativePill with the sample label). */
export function SamplePill({ className, title }: { className?: string; title?: string }) {
  return (
    <IllustrativePill
      label="Sample data"
      title={title ?? "Synthetic sample records (is_demo), generated locally without AI calls - not real students."}
      className={className}
    />
  );
}

/** Small "DEMO" tag for a single sample row in a table. */
export function DemoTag() {
  return (
    <span
      title="Sample batch (is_demo) - synthetic records"
      className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 ring-1 ring-inset ring-violet-200"
    >
      <FlaskConical className="h-3 w-3" aria-hidden />
      Demo
    </span>
  );
}
