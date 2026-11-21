"use client";

import { ChevronDown, FileAudio, Mic, RotateCcw } from "lucide-react";
import { useState } from "react";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { audioUrl, errorCode, errorMessage, getTranscript } from "@/lib/api";
import type { Submission, VoiceInfo, VoiceTranscript } from "@/lib/types";
import { cn } from "@/lib/utils";
import { btnSecondary } from "./dialog";
import { Pill, SectionCard } from "./primitives";
import { UncertainText } from "./uncertain-text";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  hi: "Hindi",
  ta: "Tamil",
  kn: "Kannada",
  te: "Telugu",
};

export function languageName(code: string): string {
  const key = code.trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_NAMES[key] ?? code;
}

/** 75 -> "1:15". */
function clock(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** VoiceInfo for a voice submission that has no Result yet (review / pending pages). */
export function voiceInfoFromSubmission(s: Submission): VoiceInfo {
  return {
    audio_url: s.is_demo ? null : `/api/submissions/${s.id}/audio`,
    audio_seconds: s.audio_seconds,
    detected_languages: s.detected_languages ?? [],
    transcription_model: null,
    voice_question: s.voice_question,
    transcript_chars: 0,
    synthetic: s.is_demo,
  };
}

type TranscriptState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: VoiceTranscript }
  | { kind: "missing" }
  | { kind: "error"; message: string };

/**
 * The voice answer (FR-2.8): the recording (when stored), duration, detected languages, the
 * transcription model and the transcript, loaded when expanded.
 */
export function VoiceAnswerPanel({
  submissionId,
  voice,
  mappedQuestions,
  isDemo,
}: {
  submissionId: number;
  voice: VoiceInfo;
  /** Questions the transcript was mapped to (whole-recording answers). */
  mappedQuestions?: number[];
  isDemo: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptState>({ kind: "idle" });
  const duration = clock(voice.audio_seconds);
  const languages = voice.detected_languages ?? [];
  const mapped = (mappedQuestions ?? []).filter((q) => Number.isFinite(q));

  async function load() {
    setTranscript({ kind: "loading" });
    try {
      setTranscript({ kind: "ready", data: await getTranscript(submissionId) });
    } catch (err) {
      setTranscript(errorCode(err) === "no_transcript" ? { kind: "missing" } : { kind: "error", message: errorMessage(err) });
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && (transcript.kind === "idle" || transcript.kind === "error")) void load();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill className="bg-violet-50 text-violet-800 ring-violet-200">
          <Mic className="h-3.5 w-3.5" aria-hidden />
          Voice answer{duration ? ` · ${duration}` : ""}
        </Pill>
        {voice.voice_question ? (
          <Pill className="bg-white text-slate-700 ring-slate-300">Mapped to Q{voice.voice_question}</Pill>
        ) : mapped.length ? (
          <Pill className="bg-white text-slate-700 ring-slate-300">AI-mapped to Q{mapped.join(", Q")}</Pill>
        ) : (
          <Pill className="bg-white text-slate-700 ring-slate-300">Whole recording - AI-mapped</Pill>
        )}
        {isDemo || voice.synthetic ? <IllustrativePill label="Sample data" title="Synthetic sample voice answer - no audio file, no AI call." /> : null}
      </div>

      {voice.audio_url ? (
        <audio
          controls
          preload="none"
          src={audioUrl(submissionId)}
          className="h-10 w-full"
          aria-label="Play the student's voice answer"
        />
      ) : (
        <p className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600">
          <FileAudio className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
          Audio not stored for sample rows
        </p>
      )}

      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">Languages detected</dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {languages.length ? (
              languages.map((code) => (
                <span
                  key={code}
                  className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300"
                >
                  <span className="font-mono text-[10px] uppercase text-slate-500">{code}</span>
                  {languageName(code)}
                </span>
              ))
            ) : (
              <span className="text-slate-500">Not reported</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">Transcription</dt>
          <dd className="mt-1 text-slate-700">
            {voice.synthetic
              ? "Synthetic transcript - no transcription call"
              : `OpenAI ${voice.transcription_model || "gpt-transcribe"}`}
            <span className="block text-xs text-slate-500">
              PoC stand-in for Whisper large-v3 / Sarvam - not residency-approved. Cost: unknown.
            </span>
          </dd>
        </div>
      </dl>

      <div className="rounded-lg ring-1 ring-inset ring-slate-200">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-brand-navy hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-cyan"
        >
          <span>
            Transcript{voice.transcript_chars > 0 ? <span className="font-normal text-slate-500"> · {voice.transcript_chars} characters</span> : null}
          </span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
        {open ? (
          <div className="border-t border-slate-200 px-3 py-2.5" aria-live="polite">
            {transcript.kind === "loading" || transcript.kind === "idle" ? (
              <div className="space-y-2" aria-label="Loading the transcript">
                <div className="h-3 w-full animate-pulse rounded bg-slate-200" />
                <div className="h-3 w-5/6 animate-pulse rounded bg-slate-200" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-slate-200" />
              </div>
            ) : transcript.kind === "missing" ? (
              <p className="text-sm text-slate-600">No transcript stored for this submission yet.</p>
            ) : transcript.kind === "error" ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-rose-700" role="alert">
                {transcript.message}
                <button type="button" className={btnSecondary} onClick={() => void load()}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  Retry
                </button>
              </div>
            ) : (
              <>
                <blockquote className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-r-lg border-l-4 border-violet-400 bg-slate-50 px-3 py-2 font-mono text-[13px] leading-relaxed text-slate-700">
                  {transcript.data.text.trim() ? <UncertainText text={transcript.data.text} words={[]} /> : "(empty transcript)"}
                </blockquote>
                <p className="mt-1 text-[11px] text-slate-500">
                  {transcript.data.synthetic ? "Synthetic sample transcript" : `Model ${transcript.data.model ?? "unknown"}`}
                  {transcript.data.detected_languages.length
                    ? ` · ${transcript.data.detected_languages.map(languageName).join(", ")}`
                    : ""}
                </p>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Report card wrapper for the voice answer (the "Original pages" section for voice submissions). */
export function VoiceAnswerCard({
  submissionId,
  voice,
  mappedQuestions,
  isDemo,
}: {
  submissionId: number;
  voice: VoiceInfo;
  mappedQuestions?: number[];
  isDemo: boolean;
}) {
  return (
    <SectionCard
      id="voice-answer"
      title="Voice answer"
      description="The recording, the languages heard and the transcript the grader read."
      icon={Mic}
    >
      <VoiceAnswerPanel submissionId={submissionId} voice={voice} mappedQuestions={mappedQuestions} isDemo={isDemo} />
    </SectionCard>
  );
}
