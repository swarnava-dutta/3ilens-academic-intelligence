import { CircleCheck, TriangleAlert } from "lucide-react";
import type { Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";

const BAND_LOOK: Record<Urgency, { cls: string; Icon: typeof TriangleAlert }> = {
  at_risk: { cls: "bg-red-50 text-red-700 ring-red-200", Icon: TriangleAlert },
  needs_attention: { cls: "bg-amber-50 text-amber-800 ring-amber-200", Icon: TriangleAlert },
  on_track: { cls: "bg-emerald-50 text-emerald-800 ring-emerald-200", Icon: CircleCheck },
};

const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset [print-color-adjust:exact]";

/** The one band (urgency rule): icon + text, never colour alone. */
export function BandChip({ band, label, className }: { band: Urgency; label: string; className?: string }) {
  const look = BAND_LOOK[band] ?? BAND_LOOK.needs_attention;
  return (
    <span className={cn(chip, look.cls, className)}>
      <look.Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>
  );
}
