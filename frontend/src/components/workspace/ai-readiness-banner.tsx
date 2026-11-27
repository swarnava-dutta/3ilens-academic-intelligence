"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
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
        "inline-flex h-9 shrink-0 items-center gap-1.5 self-start rounded-md border border-slate-300 bg-white px-3 text-sm font-medium transition-colors duration-150 hover:bg-slate-50 disabled:opacity-60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2",
        tone === "rose" ? "text-rose-700" : "text-amber-800",
      )}
    >
      <RefreshCw className={cn("h-4 w-4", busy && "motion-safe:animate-spin")} aria-hidden />
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
        className="flex flex-col gap-4 rounded-md border border-slate-200 border-l-4 border-l-rose-600 bg-white p-4 sm:flex-row sm:items-start"
      >
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="text-[15px] font-semibold text-rose-800">API not reachable</h2>
          <p className="text-sm text-slate-700">{error}</p>
          <p className="text-sm text-slate-700">
            Run <code className="rounded-sm bg-slate-100 px-1 py-0.5 font-mono text-xs">start.bat</code> in the project
            root, or start the backend:
          </p>
          <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800">
            {BACKEND_COMMAND}
          </pre>
          {health && <p className="text-xs text-slate-500">Showing the last data received; reconnecting automatically.</p>}
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
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500"
      >
        <span className="font-medium text-slate-700">OCR adapter:</span>
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
      className="flex flex-col gap-4 rounded-md border border-slate-200 border-l-4 border-l-amber-500 bg-white p-4 sm:flex-row sm:items-start"
    >
      <div className="min-w-0 flex-1 space-y-2">
        <h2 className="text-[15px] font-semibold text-amber-900">AI providers not configured</h2>
        <p className="text-sm text-slate-700">
          Live OCR and rubric evaluation need real AI keys (vision provider:{" "}
          <span className="font-medium">{health.vision_provider || "anthropic"}</span>). Missing:
        </p>
        <ul className="flex flex-wrap gap-2">
          {missing.map((item) => (
            <li
              key={item}
              className="rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-800"
            >
              {item}
            </li>
          ))}
        </ul>
        {adapter ? (
          <p className="text-sm text-slate-700">
            OCR adapter: <span className="font-medium">{adapter}</span>. The vision LLM is a PoC stand-in for the
            BRD&apos;s Google Vision OCR.
          </p>
        ) : null}
        <p className="text-sm text-slate-700">
          Add the keys to the project-root <code className="rounded-sm bg-slate-100 px-1 py-0.5 font-mono text-xs">.env</code>{" "}
          file and restart the backend. Until then, live answer sheets cannot be read or graded.
        </p>
        <p className="text-sm text-slate-700">
          <span className="font-medium">Works without keys:</span> the{" "}
          <span className="font-medium">&ldquo;blurry&rdquo;</span> human-review demo (any file name containing
          &ldquo;blurry&rdquo;).
        </p>
      </div>
      <RetryButton onRetry={refresh} tone="amber" />
    </section>
  );
}
