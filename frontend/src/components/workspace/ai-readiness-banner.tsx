"use client";

import { useState } from "react";
import { KeyRound, RefreshCw, ScanText, ServerCrash, Terminal } from "lucide-react";
import type { HealthState } from "@/components/app-shell";
import { API_BASE_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

function apiPort(): string {
  const match = /:(\d+)\/?$/.exec(API_BASE_URL.trim());
  return match ? match[1] : "8000";
}

const BACKEND_COMMAND = String.raw`cd backend && .venv\Scripts\python -m uvicorn main:app --reload --port ` + apiPort();

function RetryButton({ onRetry, tone }: { onRetry: () => Promise<void>; tone: "rose" | "amber" }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onRetry();
        } finally {
          setBusy(false);
        }
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium ring-1 ring-inset transition-colors disabled:opacity-60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        tone === "rose"
          ? "bg-white text-rose-700 ring-rose-200 hover:bg-rose-100 focus-visible:ring-rose-500"
          : "bg-white text-amber-800 ring-amber-300 hover:bg-amber-100 focus-visible:ring-amber-500",
      )}
    >
      <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} aria-hidden />
      {busy ? "Checking…" : "Check again"}
    </button>
  );
}

/** API-unreachable (rose) or AI-keys-missing (amber) notice; renders nothing when all is well. */
export function AiReadinessBanner({ health, error, loading, refresh }: HealthState) {
  if (error) {
    return (
      <section
        role="alert"
        className="flex flex-col gap-4 rounded-2xl border border-rose-200 bg-rose-50 p-5 shadow-sm sm:flex-row sm:items-start"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-100 text-rose-600">
          <ServerCrash className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="font-semibold text-rose-900">The 3iLens API is not reachable</h2>
          <p className="text-sm text-rose-800">{error}</p>
          <p className="text-sm text-rose-800">
            Start both servers with <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-xs">start.bat</code>{" "}
            in the project root, or start the backend manually:
          </p>
          <pre className="flex items-center gap-2 overflow-x-auto rounded-xl bg-brand-navy px-3 py-2 font-mono text-xs text-slate-100">
            <Terminal className="h-3.5 w-3.5 shrink-0 text-brand-cyan" aria-hidden />
            <span>{BACKEND_COMMAND}</span>
          </pre>
          {health && (
            <p className="text-xs text-rose-700/80">Showing the last data received; the page reconnects automatically.</p>
          )}
        </div>
        <RetryButton onRetry={refresh} tone="rose" />
      </section>
    );
  }

  if (loading || !health) return null;

  const adapter = health.ocr_adapter?.trim();
  if (health.ai_ready) {
    return (
      <p
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-600 shadow-sm"
      >
        <span className="inline-flex items-center gap-1.5 font-medium text-brand-navy">
          <ScanText className="h-4 w-4 text-brand-cyan" aria-hidden />
          OCR adapter:
        </span>
        <span>{adapter || `${health.vision_provider || "anthropic"} vision`}</span>
        <span className="text-slate-300" aria-hidden>
          ·
        </span>
        <span>
          Review gate: any page below {Math.round((health.ocr_confidence_threshold ?? 0.7) * 100)}% confidence
        </span>
        {health.ocr_cache_enabled ? (
          <>
            <span className="text-slate-300" aria-hidden>
              ·
            </span>
            <span>OCR cache on (same file = no vision call, Rs 0.00)</span>
          </>
        ) : null}
      </p>
    );
  }

  const missing = health.missing_configuration.length
    ? health.missing_configuration
    : ["AI provider configuration"];

  return (
    <section
      role="status"
      className="flex flex-col gap-4 rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm sm:flex-row sm:items-start"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
        <KeyRound className="h-5 w-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <h2 className="font-semibold text-amber-900">AI providers are not configured yet</h2>
        <p className="text-sm text-amber-900/90">
          Live OCR and rubric evaluation need real AI keys (vision provider:{" "}
          <span className="font-medium">{health.vision_provider || "anthropic"}</span>). Missing:
        </p>
        <ul className="flex flex-wrap gap-2">
          {missing.map((item) => (
            <li
              key={item}
              className="rounded-lg bg-white px-2 py-1 font-mono text-xs text-amber-900 ring-1 ring-inset ring-amber-200"
            >
              {item}
            </li>
          ))}
        </ul>
        {adapter ? (
          <p className="text-sm text-amber-900/90">
            OCR adapter: <span className="font-medium">{adapter}</span>. The vision LLM is a PoC stand-in for the
            BRD&apos;s Google Vision OCR.
          </p>
        ) : null}
        <p className="text-sm text-amber-900/90">
          Add the keys to the project-root <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-xs">.env</code>{" "}
          file and restart the backend. Until then, live answer sheets cannot be read or graded.
        </p>
        <p className="text-sm text-amber-900/90">
          <span className="font-medium">Works without keys:</span> the{" "}
          <span className="font-medium">&ldquo;blurry&rdquo;</span> human-review demo (any file name containing
          &ldquo;blurry&rdquo;) and the synthetic demo cohort.
        </p>
      </div>
      <RetryButton onRetry={refresh} tone="amber" />
    </section>
  );
}
