import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

/** "For faculty" marker (Lock icon + text) on teacher-only folds and actions. */
export function FacultyBadge({ className, label = "For faculty" }: { className?: string; label?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700",
        className,
      )}
    >
      <Lock className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}
