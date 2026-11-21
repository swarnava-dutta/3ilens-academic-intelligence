import { AlertCircle, CheckCircle2, Lightbulb, Sparkles, Target } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionCard } from "./primitives";

const STRENGTH_ICONS = [CheckCircle2, Sparkles] as const;
const GAP_STYLES = [
  { Icon: Target, card: "border-amber-200 bg-amber-50/70", icon: "bg-amber-100 text-amber-700" },
  { Icon: AlertCircle, card: "border-rose-200 bg-rose-50/70", icon: "bg-rose-100 text-rose-700" },
] as const;

export function InsightsCard({
  strengths,
  gaps,
  className,
}: {
  strengths: string[];
  gaps: string[];
  className?: string;
}) {
  return (
    <SectionCard
      id="insights"
      title="AI insights"
      description="What the evaluator saw across the whole answer sheet."
      icon={Lightbulb}
      className={className}
    >
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-1">
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-lime-800">
            <span aria-hidden className="h-2 w-2 rounded-full bg-brand-lime [print-color-adjust:exact]" />
            Strengths
          </h3>
          {strengths.length === 0 ? (
            <p className="text-sm text-slate-500">No specific strengths were recorded.</p>
          ) : (
            <ul className="space-y-2.5">
              {strengths.map((s, i) => {
                const Icon = STRENGTH_ICONS[i % STRENGTH_ICONS.length];
                return (
                  <li
                    key={`s-${i}`}
                    className="flex gap-3 rounded-xl border border-lime-200 bg-brand-lime-50 p-3 [print-color-adjust:exact] print:break-inside-avoid"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-lime-100 text-lime-700">
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    <p className="self-center text-sm leading-relaxed text-slate-700">{s}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-800">
            <span aria-hidden className="h-2 w-2 rounded-full bg-amber-400 [print-color-adjust:exact]" />
            Gaps to close
          </h3>
          {gaps.length === 0 ? (
            <p className="text-sm text-slate-500">No gaps were flagged.</p>
          ) : (
            <ul className="space-y-2.5">
              {gaps.map((g, i) => {
                const style = GAP_STYLES[i % GAP_STYLES.length];
                return (
                  <li key={`g-${i}`} className={cn("flex gap-3 rounded-xl border p-3 [print-color-adjust:exact] print:break-inside-avoid", style.card)}>
                    <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", style.icon)}>
                      <style.Icon className="h-4 w-4" aria-hidden />
                    </span>
                    <p className="self-center text-sm leading-relaxed text-slate-700">{g}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
