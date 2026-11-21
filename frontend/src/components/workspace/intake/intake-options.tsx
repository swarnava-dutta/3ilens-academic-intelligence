"use client";

import { useEffect, useId, useState } from "react";
import { Languages, Mic } from "lucide-react";
import { getFilters } from "@/lib/api";
import type { Batch, LanguageHint } from "@/lib/types";
import { cn } from "@/lib/utils";
import { batchLabel } from "../format";

const LANGUAGES: { code: LanguageHint; label: string; native: string }[] = [
  { code: "en", label: "English", native: "EN" },
  { code: "hi", label: "Hindi", native: "हिन्दी" },
  { code: "ta", label: "Tamil", native: "தமிழ்" },
  { code: "kn", label: "Kannada", native: "ಕನ್ನಡ" },
  { code: "te", label: "Telugu", native: "తెలుగు" },
];

/** "Answer language" multi-select chips (en default; at least one stays selected). */
export function LanguageChips({
  value,
  onChange,
  disabled,
  voice = false,
}: {
  value: LanguageHint[];
  onChange: (next: LanguageHint[]) => void;
  disabled?: boolean;
  /** A voice answer is attached/staged: the chips become the transcription languages. */
  voice?: boolean;
}) {
  const ids = useId();
  function toggle(code: LanguageHint) {
    const on = value.includes(code);
    if (on && value.length === 1) return; // keep at least one language
    const next = on ? value.filter((c) => c !== code) : [...value, code];
    onChange(LANGUAGES.map((l) => l.code).filter((c) => next.includes(c)));
  }

  return (
    <div className={cn("space-y-1.5", voice && "rounded-xl bg-violet-50/60 p-3 ring-1 ring-inset ring-violet-200")}>
      <span id={`${ids}-label`} className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
        {voice ? (
          <Mic className="h-4 w-4 text-violet-700" aria-hidden />
        ) : (
          <Languages className="h-4 w-4 text-slate-400" aria-hidden />
        )}
        {voice ? "Languages spoken" : "Answer language"}
      </span>
      <div role="group" aria-labelledby={`${ids}-label`} className="flex flex-wrap gap-1.5">
        {LANGUAGES.map(({ code, label, native }) => {
          const on = value.includes(code);
          return (
            <button
              key={code}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => toggle(code)}
              title={label}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-60",
                on
                  ? "bg-brand-navy text-white ring-brand-navy"
                  : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50",
              )}
            >
              <span>{native}</span>
              <span className={cn("text-[10px] uppercase", on ? "text-white/70" : "text-slate-400")}>{code}</span>
            </button>
          );
        })}
      </div>
      {voice ? (
        <p className="text-xs font-medium text-violet-900">
          Pick every language spoken - passed to transcription as a hint (code-mixed Hindi/English is common).
        </p>
      ) : (
        <p className="text-xs text-slate-500">Passed to OCR as a hint. Indian-script accuracy not benchmarked.</p>
      )}
    </div>
  );
}

/** Optional batch selector (GET /api/filters batches); hidden when only one batch exists. */
export function BatchSelect({
  value,
  onChange,
  fallback,
  disabled,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  /** Default batch from /api/health, shown when /api/filters is unavailable. */
  fallback: Batch | null;
  disabled?: boolean;
}) {
  const ids = useId();
  const [batches, setBatches] = useState<Batch[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFilters()
      .then((f) => {
        if (!cancelled) setBatches(f.batches ?? []);
      })
      .catch(() => {
        if (!cancelled) setBatches([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!batches || batches.length < 2) {
    const label = batchLabel(batches?.[0] ?? fallback);
    return label ? (
      <p className="text-xs text-slate-500">
        Batch: <span className="font-medium text-slate-700">{label}</span>
      </p>
    ) : null;
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={`${ids}-batch`} className="text-sm font-medium text-slate-700">
        Batch <span className="font-normal text-slate-400">(optional)</span>
      </label>
      <select
        id={`${ids}-batch`}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className="block w-full appearance-auto rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 pr-8 text-sm text-slate-800 shadow-sm focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50"
      >
        <option value="">Default ({batchLabel(fallback ?? batches[0]) ?? "first batch"})</option>
        {batches.map((b) => (
          <option key={b.id} value={b.id}>
            {batchLabel(b)}
          </option>
        ))}
      </select>
    </div>
  );
}
