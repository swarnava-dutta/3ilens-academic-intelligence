"use client";

import { Check, Loader2, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { BloomBadge } from "@/components/shared/bloom-badge";
import { detectBloomLevels, errorCode, errorMessage, errorStatus } from "@/lib/api";
import type { BloomDetection, BloomDetectMode, RubricContent } from "@/lib/types";
import { cn } from "@/lib/utils";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: BloomDetection; fallback: boolean; selected: Set<number> }
  | { kind: "error"; message: string };

/**
 * "Suggest Bloom levels (AI)" for a saved rubric (FR-3.9). The suggestion never changes the
 * rubric: "Apply selected" writes the levels into the draft, saved through the version flow.
 * Without an Anthropic key (503 ai_not_configured) it falls back to the verb heuristic.
 */
export function BloomSuggestions({
  rubricId,
  content,
  onApply,
  disabled,
}: {
  rubricId: number;
  content: RubricContent;
  onApply: (next: RubricContent, mode: BloomDetectMode) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function run() {
    setState({ kind: "loading" });
    let fallback = false;
    let data: BloomDetection;
    try {
      try {
        data = await detectBloomLevels(rubricId, { mode: "ai" });
      } catch (err) {
        if (errorCode(err) !== "ai_not_configured" && errorStatus(err) !== 503) throw err;
        fallback = true;
        data = await detectBloomLevels(rubricId, { mode: "heuristic" });
      }
    } catch (err) {
      const status = errorStatus(err);
      setState({
        kind: "error",
        message:
          !errorCode(err) && (status === 404 || status === 405)
            ? "Bloom suggestions are not available on this API build yet."
            : errorCode(err) === "unknown_rubric"
              ? "This rubric is no longer stored - reload the page."
              : errorMessage(err),
      });
      return;
    }
    // Pre-select the rows whose suggestion differs from the current level.
    const current = new Map(content.questions.map((q) => [q.question, q.bloom_level ?? null]));
    const selected = new Set(data.levels.filter((t) => current.get(t.question) !== t.level).map((t) => t.question));
    setState({ kind: "ready", data, fallback: fallback || data.mode === "heuristic", selected });
  }

  function toggle(question: number) {
    if (state.kind !== "ready") return;
    const selected = new Set(state.selected);
    if (selected.has(question)) selected.delete(question);
    else selected.add(question);
    setState({ ...state, selected });
  }

  function apply() {
    if (state.kind !== "ready") return;
    const byQuestion = new Map(state.data.levels.map((t) => [t.question, t]));
    const source = state.data.mode === "ai" ? "ai" : "heuristic";
    onApply(
      {
        ...content,
        questions: content.questions.map((q) => {
          const tag = byQuestion.get(q.question);
          return tag && state.selected.has(q.question) ? { ...q, bloom_level: tag.level, bloom_source: source } : q;
        }),
      },
      state.data.mode,
    );
    setState({ kind: "idle" });
  }

  const current = new Map(content.questions.map((q) => [q.question, q]));

  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-700">
          <span className="font-semibold text-brand-navy">Bloom levels (K1-K5)</span> · suggestions never change the
          rubric until you apply them and save a version.
        </p>
        <button
          type="button"
          onClick={() => void run()}
          disabled={disabled || state.kind === "loading"}
          className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-sm font-medium text-violet-800 ring-1 ring-inset ring-violet-300 hover:bg-violet-50 focus-visible:outline-2 focus-visible:outline-brand-cyan disabled:opacity-60"
        >
          {state.kind === "loading" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
          {state.kind === "loading" ? "Analysing questions… (~10-30 s)" : "Suggest Bloom levels (AI)"}
        </button>
      </div>

      <div aria-live="polite">
        {state.kind === "error" ? (
          <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-inset ring-rose-200">
            {state.message}
          </p>
        ) : null}

        {state.kind === "ready" ? (
          <div className="mt-3 space-y-2">
            <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 font-semibold ring-1 ring-inset",
                  state.fallback ? "bg-amber-50 text-amber-900 ring-amber-300" : "bg-white text-violet-800 ring-violet-200",
                )}
              >
                {state.fallback ? "heuristic - no AI key" : "AI suggestion"}
              </span>
              {state.data.warnings.map((w, i) => (
                <span key={i} className="text-amber-800">
                  {w}
                </span>
              ))}
            </p>
            <div className="overflow-x-auto rounded-lg bg-white ring-1 ring-inset ring-slate-200">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <caption className="sr-only">Suggested Bloom levels per question</caption>
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="w-12 px-3 py-2">
                      <span className="sr-only">Apply</span>
                    </th>
                    <th scope="col" className="px-2 py-2">Q</th>
                    <th scope="col" className="px-2 py-2">Current</th>
                    <th scope="col" className="px-2 py-2">Suggested</th>
                    <th scope="col" className="px-3 py-2">Rationale</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.levels.map((tag) => {
                    const q = current.get(tag.question);
                    return (
                      <tr key={tag.question} className="border-t border-slate-100 align-top">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={state.selected.has(tag.question)}
                            onChange={() => toggle(tag.question)}
                            disabled={!q}
                            aria-label={`Apply ${tag.level} to Q${tag.question}`}
                            className="h-4 w-4 rounded border-slate-300 text-brand-cyan focus:ring-brand-cyan"
                          />
                        </td>
                        <td className="px-2 py-2 font-medium text-slate-800">Q{tag.question}</td>
                        <td className="px-2 py-2">
                          {q?.bloom_level ? (
                            <BloomBadge level={q.bloom_level} source={q.bloom_source} size="sm" />
                          ) : (
                            <span className="text-xs text-slate-500">Auto</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <BloomBadge level={tag.level} source={tag.source} size="sm" />
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-700">{tag.rationale || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setState({ kind: "idle" })}
                className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-white focus-visible:outline-2 focus-visible:outline-brand-cyan"
              >
                <X className="h-4 w-4" aria-hidden />
                Dismiss
              </button>
              <button
                type="button"
                onClick={apply}
                disabled={state.selected.size === 0}
                className="inline-flex items-center gap-1 rounded-full bg-brand-navy px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-navy-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan disabled:opacity-50"
              >
                <Check className="h-4 w-4" aria-hidden />
                Apply selected ({state.selected.size})
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
