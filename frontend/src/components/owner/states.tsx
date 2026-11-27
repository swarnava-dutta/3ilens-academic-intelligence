"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { errorCode, errorMessage, errorStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Focus ring shared by every control on the owner / integrations / journey pages (cyan-600: 3.8:1 on white). */
export const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan-600";

/** Secondary button (white, slate border). */
export const btnQuiet = `inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-[13px] font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;

/** Table header cell and thead row. */
export const thCls = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-slate-500";
export const theadCls = "border-b border-slate-200 bg-slate-50";

/** Small rectangular status tag; pair with a tone such as "bg-amber-50 text-amber-800". */
export const tagCls = "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium";

/** Page header: title, one-line description, actions on the right. */
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight text-brand-navy sm:text-2xl">{title}</h1>
        {description ? <div className="mt-1 text-sm text-slate-600">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** White panel with a header row and a hairline divider. */
export function Panel({
  id,
  title,
  subtitle,
  action,
  className,
  children,
}: {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={cn("min-w-0 rounded-md border border-slate-200 bg-white", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 id={id} className="text-[15px] font-semibold text-brand-navy">
            {title}
          </h2>
          {subtitle ? <p className="mt-0.5 text-[13px] text-slate-500">{subtitle}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      <div className="space-y-4 px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

/** Empty-state line inside a panel. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="py-4 text-center text-sm text-slate-500">{children}</p>;
}

/** Plain-language next step for the coded API errors. */
const CODE_HINTS: Record<string, string> = {
  ai_not_configured: "Add ANTHROPIC_API_KEY to .env and restart the API.",
  fallback_unavailable: "Set OPENAI_API_KEY and LLM_FALLBACK=1 in .env, then restart the API.",
  ai_failed: "The provider call failed. Try again in a minute.",
  lms_disabled: "LMS export is switched off (LMS_API=0 in .env). Set LMS_API=1 and restart the API.",
  missing_api_key: "Send the key in the X-API-Key header.",
  invalid_api_key: "The key is wrong or has been revoked (HTTP 403).",
  invalid_since: "Use an ISO date such as 2026-11-01.",
  unknown_topic: "That topic has no results in this batch. Pick another topic.",
  no_results: "No completed results in this batch yet - grade sheets on the Intake page or pick another batch.",
  unknown_batch: "That batch no longer exists. Reload the page.",
  unknown_institution: "That institution no longer exists. Reload the page.",
  unknown_key: "That key no longer exists. Reload the list.",
};

/** errorMessage() plus a hint for coded errors, and a clear note when a route is missing on an older API. */
function describeError(err: unknown): { message: string; hint: string | null; code: string | null } {
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
        "flex flex-wrap items-start gap-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900",
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-700" aria-hidden />
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
          className={btnQuiet}
        >
          {retrying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Retry
        </button>
      ) : null}
    </div>
  );
}

function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-sm bg-slate-100 motion-reduce:animate-none", className)} />;
}

/** Card-shaped loading placeholder. */
export function CardSkeleton({ rows = 4, className, label }: { rows?: number; className?: string; label: string }) {
  return (
    <div
      aria-busy="true"
      className={cn("rounded-md border border-slate-200 bg-white p-4 sm:p-5", className)}
    >
      <span role="status" className="sr-only">
        {label}
      </span>
      <div aria-hidden>
        <Bone className="h-4 w-48" />
        <Bone className="mt-2 h-3 w-72 max-w-full" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: rows }, (_, i) => (
            <Bone key={i} className="h-7 w-full" />
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

/** Quiet "sample" tag for a single sample row in a table. */
export function DemoTag() {
  return (
    <span title="Sample batch (is_demo) - synthetic records" className={cn(tagCls, "bg-slate-100 text-slate-600")}>
      sample
    </span>
  );
}
