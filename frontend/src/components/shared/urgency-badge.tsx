import { AlertOctagon, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The one urgency rule used everywhere (backend analytics.classify_urgency). */
export const URGENCY_RULE =
  ">=70% on track, 55-70% needs attention, <55% at risk; one level worse when 2+ topics are below 40%";

export const URGENCY_LABELS: Record<Urgency, string> = {
  on_track: "On track",
  needs_attention: "Needs attention",
  at_risk: "At risk",
};

/** Sort order for lists: most urgent first. */
export const URGENCY_ORDER: Record<Urgency, number> = { at_risk: 0, needs_attention: 1, on_track: 2 };

const STYLES: Record<Urgency, { className: string; Icon: typeof CheckCircle2 }> = {
  on_track: { className: "bg-brand-lime-50 text-brand-lime-600 ring-brand-lime/40", Icon: CheckCircle2 },
  needs_attention: { className: "bg-amber-50 text-amber-800 ring-amber-300", Icon: AlertTriangle },
  at_risk: { className: "bg-rose-50 text-rose-700 ring-rose-200", Icon: AlertOctagon },
};

/**
 * Urgency pill (On track / Needs attention / At risk). The native tooltip lists the
 * reasons and the rule; screen readers get the same text. Renders nothing without urgency.
 */
export function UrgencyBadge({
  urgency,
  reasons,
  size = "md",
  className,
}: {
  urgency: Urgency | null | undefined;
  reasons?: string[] | null;
  size?: "sm" | "md";
  className?: string;
}) {
  if (!urgency || !(urgency in STYLES)) return null;
  const { className: tone, Icon } = STYLES[urgency];
  const label = URGENCY_LABELS[urgency];
  const details = [...(reasons ?? []).filter(Boolean), `Rule: ${URGENCY_RULE}.`];
  const tooltip = `${label}\n${details.join("\n")}`;
  return (
    <span
      title={tooltip}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full font-medium ring-1 ring-inset",
        size === "sm" ? "gap-1 px-2 py-0.5 text-[11px]" : "gap-1.5 px-2.5 py-1 text-xs",
        tone,
        className,
      )}
    >
      <Icon className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden />
      {label}
      <span className="sr-only">. {details.join(" ")}</span>
    </span>
  );
}
