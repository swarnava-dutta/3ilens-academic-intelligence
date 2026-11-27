"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { btnPrimary } from "@/components/cohort/dialog";
import { fmtDateTime } from "@/components/owner/format";
import { CardSkeleton, ErrorNote, focusRing, Panel, tagCls, theadCls, thCls } from "@/components/owner/states";
import { stageLabel } from "@/components/report/llm-route";
import { getLlmChain, runLlmDrill } from "@/lib/api";
import { inr } from "@/lib/format";
import type { LlmDrillResult, LlmRoute, ModelInvocation } from "@/lib/types";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";

/** "anthropic" + "claude-sonnet-5-5" -> "Claude"; "openai" + "gpt-4o" -> "GPT-4o". */
function providerLabel(provider: string | null, model: string | null): string {
  const p = (provider ?? "").toLowerCase();
  const m = model ?? "";
  if (p.includes("anthropic") || /^claude/i.test(m)) return "Claude";
  if (/^gpt-4o/i.test(m)) return `GPT-4o${m.length > 6 ? ` (${m})` : ""}`;
  if (p.includes("openai")) return m || "OpenAI";
  if (p.includes("gemini") || p.includes("google")) return "Gemini";
  return m || provider || "unknown";
}

/** Route chip, e.g. "Claude -> GPT-4o (simulated_outage)". */
function RouteChip({ route }: { route: LlmRoute }) {
  const primary = providerLabel(route.primary_provider, route.primary_model);
  const served = route.served_provider ? providerLabel(route.served_provider, route.served_model) : "no answer";
  return (
    <span
      className={cn(
        tagCls,
        "flex-wrap text-sm",
        route.fell_back ? "bg-amber-50 text-amber-900" : "bg-brand-lime-50 text-lime-800",
      )}
      title={`${route.attempts} attempt(s)${route.cross_vendor ? " · cross-vendor fallback (not residency-approved)" : ""}`}
    >
      {primary}
      {route.fell_back ? (
        <>
          <span aria-hidden>&rarr;</span>
          <span className="sr-only">fell back to</span>
          {served}
          {route.reason ? <span className="font-normal">({route.reason})</span> : null}
        </>
      ) : (
        <span className="font-normal">(served directly)</span>
      )}
    </span>
  );
}

function CallsTable({ calls }: { calls: ModelInvocation[] }) {
  if (!calls.length) return null;
  return (
    <div className="relative overflow-x-auto rounded-md border border-slate-200">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <caption className="sr-only">Provider calls made by the drill</caption>
        <thead className={theadCls}>
          <tr>
            <th scope="col" className={thCls}>Provider</th>
            <th scope="col" className={thCls}>Model</th>
            <th scope="col" className={thCls}>Status</th>
            <th scope="col" className={thCls}>Error code</th>
            <th scope="col" className={cn(thCls, "text-right")}>Latency</th>
            <th scope="col" className={cn(thCls, "text-right")}>Tokens in / out</th>
            <th scope="col" className={cn(thCls, "text-right")}>Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {calls.map((c) => (
            <tr key={c.id}>
              <td className="px-3 py-1.5 text-slate-800">{c.provider}</td>
              <td className="px-3 py-1.5 font-mono text-xs text-slate-700">{c.model_served ?? c.model_requested}</td>
              <td className="px-3 py-1.5">
                <span className={cn("font-mono text-xs", c.status === "ok" || c.status === "cache_hit" ? "text-lime-800" : "text-rose-700")}>
                  {c.status}
                </span>
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-slate-700">{c.error_code ?? "—"}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{c.latency_ms} ms</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                {c.input_tokens} / {c.output_tokens}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{c.cost_inr === null ? "unknown" : inr(c.cost_inr, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Drill({ onDone }: { onDone: () => void }) {
  const [simulate, setSimulate] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LlmDrillResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await runLlmDrill({ simulate_outage: simulate }));
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="border-t border-slate-200 pt-4">
      <h3 className="text-sm font-semibold text-brand-navy">Fallback drill</h3>
      <p className="mt-0.5 text-[13px] text-slate-500">
        Grades one built-in sample answer through the chain. Makes real provider calls (about Rs 1-2 per run).
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="inline-flex min-h-10 items-center gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            checked={simulate}
            onChange={(e) => setSimulate(e.target.checked)}
            className="h-4 w-4 accent-brand-cyan"
          />
          Simulate Claude outage
        </label>
        <button type="button" className={btnPrimary} onClick={() => void run()} disabled={running}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {running ? "Running drill…" : "Run fallback drill"}
        </button>
      </div>
      <div className="mt-3 space-y-3" aria-live="polite">
        {error ? <ErrorNote error={error} prefix="Drill failed" /> : null}
        {result ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <RouteChip route={result.route} />
              <span className={cn("text-sm font-medium", result.ok ? "text-lime-800" : "text-rose-700")}>
                {result.ok ? "Answer graded" : "No answer"}
              </span>
              <span className="text-xs tabular-nums text-slate-500">
                {result.sample_marks === null ? "—" : result.sample_marks} / {result.sample_max_marks} marks ·{" "}
                {(result.latency_ms / 1000).toFixed(1)} s total
              </span>
            </div>
            <p className="text-sm text-slate-800">{result.message}</p>
            <CallsTable calls={result.calls ?? []} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** What happened to one call in the fallback log: served by the fallback, skipped (simulated outage) or failed. */
function FallbackOutcome({ call }: { call: ModelInvocation }) {
  const look =
    call.status === "ok"
      ? call.fell_back
        ? { text: "served by fallback", cls: "bg-amber-50 text-amber-800" }
        : { text: "ok", cls: "bg-brand-lime-50 text-lime-800" }
      : call.error_code === "simulated_outage"
        ? { text: "primary skipped (simulated outage)", cls: "bg-slate-100 text-slate-700" }
        : { text: `failed${call.error_code ? `: ${call.error_code}` : ""}`, cls: "bg-rose-50 text-rose-700" };
  return <span className={cn(tagCls, look.cls)}>{look.text}</span>;
}

/** AI provider chain (FR-3.10): providers, fallback switches, trigger codes, drill and recent fallbacks. */
export function AiProvidersCard() {
  const fetcher = useCallback(() => getLlmChain(), []);
  const { data, error, loading, reload } = useAsync(fetcher);

  if (!data && loading) return <CardSkeleton rows={4} label="Loading the AI provider chain…" />;

  return (
    <Panel
      id="ai-chain-title"
      title="AI providers and fallback"
      subtitle="Claude is primary. When it fails with a trigger code, OCR, grading and voice mapping retry on the fallback model."
    >
      {error ? <ErrorNote error={error} onRetry={() => void reload()} retrying={loading} /> : null}
      {data ? (
        <div className="space-y-4">
          <div className="relative -mx-4 -mt-4 overflow-x-auto sm:-mx-5">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <caption className="sr-only">AI providers</caption>
              <thead className={theadCls}>
                <tr>
                  <th scope="col" className={cn(thCls, "pl-4 sm:pl-5")}>Role</th>
                  <th scope="col" className={thCls}>Provider · model</th>
                  <th scope="col" className={thCls}>Configured</th>
                  <th scope="col" className={thCls}>Stages</th>
                  <th scope="col" className={cn(thCls, "pr-4 sm:pr-5")}>Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 border-b border-slate-200">
                {data.providers.map((p) => (
                  <tr key={`${p.role}-${p.provider}-${p.model}`} className="align-top">
                    <td className="px-3 py-2 pl-4 font-medium capitalize text-slate-900 sm:pl-5">{p.role}</td>
                    <td className="px-3 py-2">
                      <span className="text-slate-800">{p.provider}</span>
                      <span className="block whitespace-nowrap font-mono text-xs text-slate-700">{p.model}</span>
                    </td>
                    <td className="px-3 py-2">
                      {p.configured ? (
                        <span className={cn(tagCls, "bg-brand-lime-50 text-lime-800")}>Configured</span>
                      ) : (
                        <span className={cn(tagCls, "bg-slate-100 text-slate-600")}>Not configured</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-700">{p.stages.length ? p.stages.join(", ") : "—"}</td>
                    <td className="px-3 py-2 pr-4 text-xs sm:pr-5">
                      {p.deprecation ? (
                        <p className="mb-1 font-medium text-amber-800">
                          <span>
                            {p.model}: {p.deprecation}
                            {p.role === "fallback" ? " - set LLM_FALLBACK_MODEL in .env before then." : ""}
                          </span>
                        </p>
                      ) : null}
                      <p className="text-slate-700">{p.residency_note}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
            <dt className="pt-2 text-[13px] text-slate-500 sm:border-b sm:border-slate-200 sm:pb-2">
              Fallback <code className="font-mono text-xs">LLM_FALLBACK</code>
            </dt>
            <dd className={cn("border-b border-slate-200 pb-2 sm:pt-2", data.fallback_enabled ? "text-lime-800" : "text-slate-700")}>
              {data.fallback_enabled ? "Enabled" : "Disabled"}
            </dd>
            <dt className="pt-2 text-[13px] text-slate-500 sm:border-b sm:border-slate-200 sm:pb-2">
              Simulated outage <code className="font-mono text-xs break-all">LLM_SIMULATE_PRIMARY_OUTAGE</code> (read-only)
            </dt>
            <dd className={cn("border-b border-slate-200 pb-2 sm:pt-2", data.simulate_outage ? "text-amber-800" : "text-slate-700")}>
              {data.simulate_outage ? "On: every Claude call is skipped" : "Off"}
            </dd>
            <dt className="pt-2 text-[13px] text-slate-500">Trigger codes</dt>
            <dd className="flex flex-wrap gap-1 pt-2">
              {data.trigger_codes.length
                ? data.trigger_codes.map((c) => (
                    <code key={c} className="rounded-sm bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800">
                      {c}
                    </code>
                  ))
                : "—"}
            </dd>
          </dl>
          {data.note ? <p className="text-xs text-slate-500">{data.note}</p> : null}

          <Drill onDone={() => void reload()} />

          <div className="border-t border-slate-200 pt-4">
            <h3 className="text-sm font-semibold text-brand-navy">Recent fallbacks</h3>
            {data.recent_fallbacks.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">No call has fallen back yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-200 border-y border-slate-200">
                {data.recent_fallbacks.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                    <span className="whitespace-nowrap text-xs tabular-nums text-slate-500">{fmtDateTime(c.created_at)}</span>
                    <span className="text-slate-800">{stageLabel(c.purpose)}</span>
                    <span className="font-mono text-xs text-slate-700">
                      {c.provider} · {c.model_served ?? c.model_requested}
                    </span>
                    <FallbackOutcome call={c} />
                    {c.submission_id ? (
                      <Link href={`/report/${c.submission_id}`} className={cn("text-xs text-brand-cyan-600 hover:underline", focusRing)}>
                        Submission #{c.submission_id}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
