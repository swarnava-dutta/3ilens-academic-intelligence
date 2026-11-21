import {
  BrainCircuit,
  ChevronRight,
  CloudUpload,
  Database,
  FileOutput,
  Layers,
  Repeat2,
  ScanLine,
  ScanText,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Short OCR caption from Health.ocr_adapter, e.g. "anthropic vision (claude-sonnet-5-5) - PoC
 * stand-in for Google Vision DOCUMENT_TEXT_DETECTION" -> "Claude vision (stand-in for Google Vision)".
 */
export function ocrAdapterCaption(adapter: string | null | undefined): string {
  const text = (adapter ?? "").trim();
  if (!text) return "Vision LLM (stand-in for Google Vision)";
  const standIn = /google vision/i.test(text) ? " (stand-in for Google Vision)" : "";
  if (/anthropic|claude/i.test(text)) return `Claude vision${standIn}`;
  if (/openai|gpt/i.test(text)) return `GPT-4o vision${standIn}`;
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

interface Step {
  title: string;
  caption: string;
  Icon: typeof CloudUpload;
  ai: boolean;
  title_attr?: string;
}

/** Eight stages: the seven processing steps plus "Report & delivery". */
export function PipelineStrip({ ocrAdapter }: { ocrAdapter?: string | null }) {
  const steps: Step[] = [
    { title: "Ingest", caption: "Magic bytes · SHA-256 · local (S3)", Icon: CloudUpload, ai: false },
    { title: "Queue", caption: "BackgroundTasks (SQS) · retry 3× → DLQ", Icon: Layers, ai: false },
    { title: "Pre-process", caption: "300 DPI · deskew · contrast · sharpen", Icon: ScanLine, ai: false },
    {
      title: "OCR",
      caption: ocrAdapterCaption(ocrAdapter),
      Icon: ScanText,
      ai: true,
      title_attr: ocrAdapter ?? undefined,
    },
    { title: "Evaluate", caption: "Rubric grading · nudges", Icon: BrainCircuit, ai: true },
    { title: "Insights & ROI", caption: "Deterministic engine", Icon: TrendingUp, ai: false },
    { title: "Persist", caption: "SQLite (RDS) · versions", Icon: Database, ai: false },
    { title: "Report & delivery", caption: "PDF · WhatsApp (simulated)", Icon: FileOutput, ai: false },
  ];

  return (
    <section aria-labelledby="pipeline-title" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="pipeline-title" className="text-sm font-semibold uppercase tracking-[0.14em] text-brand-navy">
          How an answer sheet flows
        </h2>
        <p className="text-xs text-slate-500">
          A page averaging below the OCR gate stops the flow before evaluation and routes the sheet to faculty review.
        </p>
      </div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8 lg:gap-0">
        {steps.map(({ title, caption, Icon, ai, title_attr }, index) => (
          <li key={title} className="relative flex items-center lg:pr-3">
            <div
              title={title_attr}
              className={cn(
                "flex h-full w-full items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-inset lg:flex-col lg:items-center lg:gap-2 lg:px-2 lg:py-3 lg:text-center",
                ai
                  ? "bg-brand-cyan-50 ring-brand-cyan/25"
                  : index === steps.length - 1
                    ? "bg-brand-lime-50 ring-brand-lime/40"
                    : "bg-slate-50 ring-slate-200",
              )}
            >
              <span
                className={cn(
                  "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                  ai ? "bg-brand-cyan text-white" : "bg-white text-brand-navy ring-1 ring-inset ring-slate-200",
                )}
              >
                <Icon className="h-4.5 w-4.5" aria-hidden />
                <span className="absolute -left-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-brand-navy text-[10px] font-bold text-white">
                  {index + 1}
                </span>
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-semibold leading-tight text-brand-navy lg:justify-center">
                  {title}
                  {ai ? (
                    <span className="rounded-full bg-brand-cyan px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-white">
                      AI
                    </span>
                  ) : null}
                </span>
                <span className="block text-xs leading-snug text-slate-500">{caption}</span>
              </span>
            </div>
            {index < steps.length - 1 ? (
              <ChevronRight
                className="absolute -right-1 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-slate-300 lg:block"
                aria-hidden
              />
            ) : null}
          </li>
        ))}
      </ol>

      {/* Loop: a rubric edit re-runs Evaluate -> Report from the stored OCR (stages 5-8). */}
      <div className="mt-3 lg:grid lg:grid-cols-8">
        <p className="flex items-center gap-2 rounded-xl border border-dashed border-violet-300 bg-violet-50/60 px-3 py-2 text-xs text-violet-800 lg:col-span-4 lg:col-start-5 lg:justify-center">
          <Repeat2 className="h-4 w-4 shrink-0 text-violet-600" aria-hidden />
          <span>
            <span className="font-semibold">Rubric re-run reuses stored OCR</span> - a new rubric version re-grades
            stages 5-8 with 0 vision calls.
          </span>
        </p>
      </div>
    </section>
  );
}
