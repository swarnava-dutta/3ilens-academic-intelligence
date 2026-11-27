/**
 * Short OCR caption from Health.ocr_adapter, e.g. "anthropic vision (claude-sonnet-5-5) - PoC
 * stand-in for Google Vision DOCUMENT_TEXT_DETECTION" -> "Claude vision (stand-in for Google Vision)".
 */
function ocrAdapterCaption(adapter: string | null | undefined): string {
  const text = (adapter ?? "").trim();
  if (!text) return "Vision LLM (stand-in for Google Vision)";
  const standIn = /google vision/i.test(text) ? " (stand-in for Google Vision)" : "";
  if (/anthropic|claude/i.test(text)) return `Claude vision${standIn}`;
  if (/openai|gpt/i.test(text)) return `GPT-4o vision${standIn}`;
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** Eight stages: the seven processing steps plus "Report & delivery". */
export function PipelineStrip({
  ocrAdapter,
  voiceModel,
}: {
  ocrAdapter?: string | null;
  /** Health.transcription_model when voice answers are on (null = voice off). */
  voiceModel?: string | null;
}) {
  const steps: { title: string; caption: string; ai?: boolean }[] = [
    { title: "Ingest", caption: "Magic bytes · SHA-256 · local (S3)" },
    { title: "Queue", caption: "BackgroundTasks (SQS) · retry 3× → DLQ" },
    { title: "Pre-process", caption: "200 DPI · deskew · contrast · sharpen" },
    { title: "OCR", caption: ocrAdapterCaption(ocrAdapter), ai: true },
    { title: "Evaluate", caption: "Rubric grading · nudges", ai: true },
    { title: "Insights & ROI", caption: "Deterministic engine" },
    { title: "Persist", caption: "SQLite (RDS) · versions" },
    { title: "Report & delivery", caption: "PDF · WhatsApp (simulated)" },
  ];

  return (
    <section aria-labelledby="pipeline-title" className="text-xs text-slate-500">
      <h2 id="pipeline-title" className="sr-only">
        Pipeline steps
      </h2>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {steps.map(({ title, caption, ai }, index) => (
          <li key={title} className="inline-flex items-center gap-1.5" title={index === 3 ? (ocrAdapter ?? caption) : caption}>
            {index > 0 ? (
              <span className="text-slate-300" aria-hidden>
                →
              </span>
            ) : null}
            <span className="tabular-nums text-slate-400">{index + 1}</span>
            <span className="font-medium text-slate-700">{title}</span>
            {ai ? <span className="text-brand-cyan-600">(AI)</span> : null}
          </li>
        ))}
      </ol>
      <p className="mt-1">
        Sheets with a page below the OCR gate stop before step 5 and go to faculty review. A rubric edit re-runs steps
        5-8 from the stored OCR (no new vision calls).
        {voiceModel ? (
          <>
            {" "}
            Voice answers skip step 3; step 4 is transcription (OpenAI {voiceModel}, stand-in for Whisper large-v3 /
            Sarvam - not residency-approved).
          </>
        ) : null}
      </p>
    </section>
  );
}
