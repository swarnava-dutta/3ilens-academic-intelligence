import { Fragment, type ReactNode } from "react";
import { Flag } from "lucide-react";
import { formatConfidence } from "@/lib/format";
import type { UncertainWord } from "@/lib/types";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "[note to examiner: ...]" markers the transcriber leaves around text addressed to the grader. */
const EXAMINER_NOTE = /\[\s*note\s+to\s+(?:the\s+)?examiner\s*[:\-]?\s*([^\]]*)\]/gi;

const EXAMINER_NOTE_LABEL = "Possible instruction to examiner - ignored by grader";

/** True when the text carries at least one "[note to examiner: ...]" marker. */
function hasExaminerNote(text: string | null | undefined): boolean {
  return !!text && new RegExp(EXAMINER_NOTE.source, "i").test(text);
}

/** Amber flag chip shown in place of a "[note to examiner: ...]" marker; the note stays readable. */
function ExaminerNoteChip({ note }: { note: string }) {
  const text = note.trim();
  return (
    <span
      title={`${EXAMINER_NOTE_LABEL}${text ? `: "${text}"` : ""}`}
      className="my-0.5 inline-flex max-w-full flex-wrap items-start gap-1 whitespace-normal rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 align-middle font-sans text-xs font-medium text-amber-900 [print-color-adjust:exact]"
    >
      <Flag className="mt-px h-3 w-3 shrink-0 text-amber-700" aria-hidden />
      <span>{EXAMINER_NOTE_LABEL}</span>
      {text ? <span className="font-normal italic text-amber-800">&ldquo;{text}&rdquo;</span> : null}
    </span>
  );
}

/** Low-confidence OCR words underlined in amber (no examiner-note handling). */
function UnderlinedWords({ text, words }: { text: string; words: UncertainWord[] }): ReactNode {
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

/**
 * The answer text with every low-confidence OCR word underlined in amber (the native tooltip
 * gives the word's OCR confidence; matching is case-insensitive, longest word first). Any
 * "[note to examiner: ...]" marker renders as an amber flag chip: the grader ignores it.
 */
export function UncertainText({ text, words }: { text: string; words: UncertainWord[] }): ReactNode {
  if (!text || !hasExaminerNote(text)) return <UnderlinedWords text={text} words={words} />;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(EXAMINER_NOTE.source, "gi"))) {
    const start = m.index ?? 0;
    if (start > last) out.push(<UnderlinedWords key={`t-${last}`} text={text.slice(last, start)} words={words} />);
    out.push(<ExaminerNoteChip key={`n-${start}`} note={m[1] ?? ""} />);
    last = start + m[0].length;
  }
  if (last < text.length) out.push(<UnderlinedWords key={`t-${last}`} text={text.slice(last)} words={words} />);
  return <Fragment>{out}</Fragment>;
}
