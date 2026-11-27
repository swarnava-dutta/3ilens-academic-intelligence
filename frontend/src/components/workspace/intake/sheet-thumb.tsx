"use client";

import { useEffect, useRef, useState } from "react";
import { DocPreview } from "@/components/preview/doc-preview";
import { cn } from "@/lib/utils";

/**
 * A staged answer sheet's page thumbnail (DocPreview, size sm) for a batch row. It mounts once the
 * row comes near the viewport: a PDF or Word page is drawn by the API (POST /api/intake/preview), so
 * a 50-sheet batch does not send every file at once.
 */
export function SheetThumb({ file, className }: { file: File; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      const timer = window.setTimeout(() => setNear(true), 0);
      return () => window.clearTimeout(timer);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  return (
    <div ref={ref} className={cn("w-[120px] shrink-0", className)}>
      {near ? (
        <DocPreview label="Answer sheet" source={{ kind: "file", file }} size="sm" className="w-[120px] border-0 p-0" />
      ) : (
        <div aria-hidden className="flex flex-col gap-1.5">
          <span className="text-[11px] text-slate-500">Answer sheet</span>
          <span className="block h-[160px] w-[120px] rounded-sm border border-slate-200 bg-slate-50" />
        </div>
      )}
    </div>
  );
}
