import { AlertTriangle, Database, ShieldAlert, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { InvocationPurpose, LlmRoute } from "@/lib/types";
import { cn } from "@/lib/utils";

const STAGE_LABELS: Record<InvocationPurpose, string> = {
  ocr: "OCR",
  evaluation: "Evaluation",
  consistency: "Consistency check",
  rubric_parse: "Rubric parse",
  transcription: "Transcription",
  voice_mapping: "Voice mapping",
  bloom_detect: "Bloom detection",
  llm_drill: "Fallback drill",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage as InvocationPurpose] ?? stage.replace(/_/g, " ");
}

/** "anthropic" -> "Claude", "openai" -> "OpenAI". */
function providerName(provider: string | null | undefined): string {
  const p = (provider ?? "").toLowerCase();
  if (p.includes("anthropic") || p.includes("claude")) return "Claude";
  if (p.includes("openai") || p.includes("gpt")) return "OpenAI";
  if (p.includes("gemini") || p.includes("google")) return "Gemini";
  return provider || "unknown";
}

/** "gpt-4o" -> "GPT-4o". */
function modelName(model: string | null | undefined): string {
  const m = (model ?? "").trim();
  return /^gpt/i.test(m) ? m.replace(/^gpt/i, "GPT") : m;
}

interface ChipLook {
  text: string;
  title: string;
  Icon: LucideIcon | null;
  tone: string;
}

/** One chip per stage: primary, cross-vendor fallback, server-side fallback, cache hit or failed. */
export function routeLook(route: LlmRoute): ChipLook {
  const stage = stageLabel(route.stage);
  const attempts = `attempts ${route.attempts}`;
  if ((route.served_provider ?? "").toLowerCase() === "cache") {
    return {
      text: `${stage} · cache hit`,
      title: `${stage} reused a cached result - no model call (Rs 0.00).`,
      Icon: Database,
      tone: "bg-slate-100 text-slate-700",
    };
  }
  if (!route.served_provider) {
    return {
      text: `${stage} · failed`,
      title: `${stage}: no provider served this stage${route.reason ? ` (${route.reason})` : ""}; ${attempts}.`,
      Icon: XCircle,
      tone: "bg-rose-50 text-rose-700 ring-rose-200",
    };
  }
  if (route.cross_vendor) {
    const primary = providerName(route.primary_provider);
    return {
      text: `${stage} · ${modelName(route.served_model) || providerName(route.served_provider)} fallback - ${primary} ${route.reason ?? "unavailable"}`,
      title: `${attempts}; fallback is not residency-approved (PoC).`,
      Icon: ShieldAlert,
      tone: "bg-amber-50 text-amber-900 ring-amber-300",
    };
  }
  if (route.fell_back) {
    return {
      text: `${stage} · ${providerName(route.served_provider)} server-side fallback model`,
      title: `${route.primary_model} was not used; ${route.served_model ?? "a fallback model"} served it (same vendor)${
        route.reason ? ` - ${route.reason}` : ""
      }; ${attempts}.`,
      Icon: AlertTriangle,
      tone: "bg-amber-50 text-amber-900 ring-amber-300",
    };
  }
  return {
    text: `${stage} · ${providerName(route.served_provider)} (${route.served_model ?? route.primary_model})`,
    title: `Served by the primary model; ${attempts}.`,
    Icon: null,
    tone: "bg-slate-100 text-slate-700",
  };
}

/**
 * Which model chain served each AI stage of this result (FR-3.10). Demo rows made no AI call;
 * older rows have no recorded route.
 */
export function LlmRouteChips({
  routes,
  isDemo,
  className,
}: {
  routes: LlmRoute[] | null | undefined;
  isDemo: boolean;
  className?: string;
}) {
  const list = Array.isArray(routes) ? routes : [];
  if (list.length === 0) {
    return isDemo ? (
      <span
        className={cn(
          "inline-flex items-center gap-1 whitespace-nowrap rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700",
          className,
        )}
      >
        Synthetic sample, no AI call
      </span>
    ) : (
      <span className={cn("text-xs text-slate-500", className)}>Route not recorded for this run</span>
    );
  }
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {list.map((route, i) => {
        const look = routeLook(route);
        return (
          <span
            key={`${route.stage}-${i}`}
            title={look.title}
            className={cn(
              "inline-flex max-w-full items-start gap-1 rounded-sm px-1.5 py-0.5 text-xs",
              look.tone,
            )}
          >
            {look.Icon ? <look.Icon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> : null}
            <span className="min-w-0 break-words">{look.text}</span>
            <span className="sr-only">. {look.title}</span>
          </span>
        );
      })}
    </span>
  );
}
