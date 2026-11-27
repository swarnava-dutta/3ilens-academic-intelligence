"use client";

import { Gauge, Scale, Signpost } from "lucide-react";
import { cn } from "@/lib/utils";
import { Detail } from "./key-insights";
import { card } from "./tokens";

const ICONS = [Gauge, Scale, Signpost];

/** The number to highlight in a line: "+62" in the next step, nothing elsewhere. */
function leadOf(line: string, index: number): string | null {
  if (index !== 2) return null;
  const m = /\+\d[\d,]*(?:\.\d+)?/.exec(line);
  return m ? m[0] : null;
}

/**
 * "In short": the server's plain summary for the student (score and band, strongest / weakest with
 * the reason, the next step), the first thing under the header. Numbers in tabular Fira Code; the
 * next step's gain in amber.
 */
export function InShort({ lines, className }: { lines: string[]; className?: string }) {
  if (!lines.length) return null;
  return (
    <section aria-labelledby="in-short-heading" className={cn("min-w-0", className)}>
      <h2 id="in-short-heading" className="mb-2 text-xs font-semibold text-slate-600">
        In short
      </h2>
      <ul className={cn(card, "divide-y divide-slate-100 border-l-[3px] border-l-[#1E40AF] print:break-inside-avoid")}>
        {lines.map((line, i) => {
          const Icon = ICONS[i] ?? Signpost;
          return (
            <li key={i} className="flex gap-2.5 px-3 py-2 sm:px-3.5">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[#1E40AF]" aria-hidden />
              <p className={cn("min-w-0 text-[13.5px] leading-relaxed text-slate-800", i === 2 && "font-medium")}>
                <Detail text={line} lead={leadOf(line, i)} />
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
