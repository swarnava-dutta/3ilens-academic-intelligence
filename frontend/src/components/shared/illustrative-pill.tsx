import { cn } from "@/lib/utils";

const DEFAULT_TITLE =
  "Sample/illustrative content: coefficients, weightage and projections are not calibrated against real NEET outcomes.";

/**
 * Marks sample or illustrative content (ROI projections, the chapter-weightage matrix,
 * the mixed NEET demo rubric, simulated WhatsApp delivery) so it is never mistaken for
 * a calibrated or real result.
 */
export function IllustrativePill({
  label = "Illustrative · not calibrated",
  title = DEFAULT_TITLE,
  className,
}: {
  label?: string;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-sm border border-slate-300 px-1.5 text-xs text-slate-600",
        className,
      )}
    >
      {label}
      <span className="sr-only">. {title}</span>
    </span>
  );
}
