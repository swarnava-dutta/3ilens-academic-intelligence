import { FlaskConical } from "lucide-react";
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
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-inset ring-violet-200",
        className,
      )}
    >
      <FlaskConical className="h-3.5 w-3.5" aria-hidden />
      {label}
      <span className="sr-only">. {title}</span>
    </span>
  );
}
