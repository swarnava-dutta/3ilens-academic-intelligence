import type { ReactNode } from "react";
import type { UncertainWord } from "@/lib/types";
import { formatConfidence } from "@/lib/utils";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The answer text with every low-confidence OCR word underlined in amber; the native tooltip
 * gives the word's OCR confidence. Matching is case-insensitive, longest word first.
 */
export function UncertainText({ text, words }: { text: string; words: UncertainWord[] }): ReactNode {
  const list = words
    .map((w) => ({ text: String(w?.text ?? "").trim(), confidence: w?.confidence }))
    .filter((w) => w.text.length > 0)
    .sort((a, b) => b.text.length - a.text.length);
  if (!text || list.length === 0) return text;
  const pattern = new RegExp(`(${list.map((w) => escapeRegExp(w.text)).join("|")})`, "gi");
  const parts = text.split(pattern);
  return parts.map((part, i) => {
    if (i % 2 === 0) return part;
    const word = list.find((w) => w.text.toLowerCase() === part.toLowerCase());
    const conf = typeof word?.confidence === "number" ? formatConfidence(word.confidence) : "low";
    return (
      <mark
        key={i}
        title={`Low OCR confidence: ${conf}`}
        className="rounded-sm bg-amber-100/70 text-inherit underline decoration-amber-500 decoration-2 underline-offset-2 [print-color-adjust:exact]"
      >
        {part}
        <span className="sr-only"> (uncertain, OCR {conf})</span>
      </mark>
    );
  });
}
