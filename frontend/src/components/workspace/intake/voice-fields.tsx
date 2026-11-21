"use client";

import { AlertTriangle, Mic } from "lucide-react";
import type { RubricSourceState } from "@/components/rubrics/use-rubric-source";
import { cn } from "@/lib/utils";
import type { VoiceSettings } from "../format";

/** A rubric question a per-question voice recording can answer. */
export interface VoiceQuestionOption {
  question: number;
  topic: string;
}

function questionsFromJson(text: string): VoiceQuestionOption[] {
  try {
    const data = JSON.parse(text) as { questions?: unknown };
    if (!Array.isArray(data.questions)) return [];
    return data.questions.flatMap((q, i) => {
      const item = (q ?? {}) as { question?: unknown; topic?: unknown };
      const n = typeof item.question === "number" ? item.question : i + 1;
      return [{ question: n, topic: typeof item.topic === "string" ? item.topic : "" }];
    });
  } catch {
    return [];
  }
}

/** Questions of the rubric chosen in the intake form (saved rubric, or the custom JSON file). */
export function rubricQuestionOptions(state: RubricSourceState): VoiceQuestionOption[] {
  if (state.mode === "json" && state.custom) return questionsFromJson(state.custom.text);
  const questions = state.selectedRubric?.content?.questions ?? [];
  return questions.map((q) => ({ question: q.question, topic: q.topic }));
}

/** The voice_question to send: only a question that exists in the chosen rubric (else whole recording). */
export function voiceQuestionFor(value: number | null, questions: number[] | undefined): number | undefined {
  if (value === null) return undefined;
  return !questions || questions.includes(value) ? value : undefined;
}

/** "Answers question" select: whole recording (AI maps it) or one rubric question. */
export function VoiceQuestionSelect({
  id,
  value,
  onChange,
  questions,
  disabled,
  compact,
}: {
  id: string;
  value: number | null;
  onChange: (question: number | null) => void;
  questions: VoiceQuestionOption[];
  disabled?: boolean;
  compact?: boolean;
}) {
  const valid = value !== null && questions.some((q) => q.question === value) ? value : null;
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className={cn("font-medium text-slate-700", compact ? "text-xs" : "text-sm")}>
        Answers question
      </label>
      <select
        id={id}
        value={valid ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className={cn(
          "block w-full min-w-0 appearance-auto rounded-md border border-slate-300 bg-white pr-8 text-slate-800 focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50",
          compact ? "px-2 py-1.5 text-xs" : "px-3 py-2 text-sm",
        )}
      >
        <option value="">Whole recording - AI maps it</option>
        {questions.map((q) => (
          <option key={q.question} value={q.question}>
            Q{q.question}
            {q.topic ? ` - ${q.topic}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

/** "Voice answer" chip with the mic icon. */
export function VoiceChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700",
        className,
      )}
    >
      <Mic className="h-3 w-3" aria-hidden />
      Voice answer
    </span>
  );
}

/** Transcription provenance, plus the amber warning when the server has no OpenAI key. */
export function VoiceNotes({ voice, className }: { voice: VoiceSettings; className?: string }) {
  return (
    <div className={cn("space-y-1 text-xs", className)}>
      <p className="text-slate-600">
        Transcribed by OpenAI {voice.model || "gpt-transcribe"} (PoC stand-in for Whisper large-v3 / Sarvam) - not
        residency-approved, PoC only. Transcription cost: unknown.
      </p>
      {!voice.ready ? (
        <p className="flex items-start gap-1.5 font-medium text-amber-900">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden />
          OPENAI_API_KEY missing - this voice answer will fail at transcription
        </p>
      ) : null}
    </div>
  );
}
