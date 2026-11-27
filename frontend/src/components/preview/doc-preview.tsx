"use client";

/* eslint-disable @next/next/no-img-element -- previews are blob: URLs or FastAPI page images (another origin, arbitrary sizes); next/image adds nothing here. */

/**
 * <DocPreview>: a small page thumbnail of a document with its label, name, type and page count,
 * a page stepper (buttons, or ← / → / Home / End while the stepper has focus) and an
 * "Open full size" dialog (click the thumbnail; ← / → change page there too, Esc closes).
 *
 *   import { DocPreview } from "@/components/preview/doc-preview";
 *
 *   // A local file picked in the intake, before upload (answer sheet, question paper, key):
 *   <DocPreview label="Question paper" source={{ kind: "file", file }} size="sm" />
 *
 *   // An uploaded answer sheet, from its stored page images:
 *   <DocPreview
 *     label="Answer sheet"
 *     name={submission.original_filename}
 *     source={{ kind: "url", pageUrl: (n) => pageImageUrl(submission.id, n), pageCount: pages.length }}
 *   />
 *
 *   // Nothing chosen yet: source={null} shows the empty state.
 *   <DocPreview label="Answer key" source={null} emptyText="No key file" />
 *
 * Props
 *   source     DocSource | null (below). null = empty state.
 *   label      what the document is: "Answer sheet", "Question paper", "Answer key".
 *   name       display name; defaults to file.name for a file source.
 *   size       "sm" (120px-wide thumbnail, for staged rows) | "md" (240px, side by side). Default "md".
 *   emptyText  empty-state text. Default "Nothing to preview yet".
 *   className  merged onto the card (tailwind-merge), e.g. "border-0 p-0".
 *
 * Sources
 *   { kind: "file", file }  A local File. Browser-decodable images (PNG, JPEG, WebP, GIF, AVIF, BMP)
 *       are shown from an object URL (revoked when the page changes or on unmount). Everything else
 *       (PDF, DOCX, TXT, HEIC, TIFF...) is rendered by the API: POST multipart
 *       `${API_BASE_URL}/api/intake/preview` with fields file, page (1-based), width (px). The
 *       response body is the page image; X-Page-Count and X-File-Type headers give the page count
 *       and type (the API's CORS `expose_headers` must list both, or the count falls back to 1).
 *       Codes no_preview / unsupported_signature (or a bare 415) show "No preview for this file
 *       type"; other errors show the API's detail (e.g. "The PDF could not be opened"). Rendered
 *       pages are cached per (file, page, width) in a WeakMap, and a file-level 4xx per file; a
 *       request still in flight is aborted on unmount.
 *   { kind: "url", pageUrl, pageCount }  Pages already stored by the server; pageUrl(n) returns
 *       the image URL of page n (1-based). The function may be an inline arrow: only its result
 *       is compared, so a new function each render does not reset the page.
 *
 * A url source carries a function, so render <DocPreview> from a client component. Clicks inside
 * the card (and its dialog) stop at the card, so it can sit in a clickable row; do not put it in a <label>.
 */

import { ChevronLeft, ChevronRight, FileText, ImageOff, Maximize2 } from "lucide-react";
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Modal } from "@/components/report/dialog";
import { API_BASE_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

type DocSource =
  | { kind: "file"; file: File }
  | { kind: "url"; pageUrl: (page: number) => string; pageCount: number };

export interface DocPreviewProps {
  source: DocSource | null;
  label: string;
  name?: string;
  size?: "sm" | "md";
  emptyText?: string;
  className?: string;
}

const NO_PREVIEW_MESSAGE = "No preview for this file type";

/** Rendered widths requested from the API: 2x the thumbnail for sharp scans; the dialog at the API's cap (120-1200). */
const THUMB_WIDTH = { sm: 240, md: 480 } as const;
const FULL_WIDTH = 1200;

const BROWSER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const BROWSER_IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

function isBrowserImage(file: File): boolean {
  return file.type ? BROWSER_IMAGE_TYPES.has(file.type.toLowerCase()) : BROWSER_IMAGE_EXT.test(file.name);
}

/** "application/pdf" | "pdf" -> "PDF"; falls back to the file extension. */
function typeLabel(raw: string | null | undefined, fileName?: string | null): string | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (t.includes("pdf")) return "PDF";
  if (t.includes("wordprocessingml") || t === "docx") return "DOCX";
  if (t === "text/plain" || t === "text" || t === "txt") return "TXT";
  const tail = t.slice(t.lastIndexOf("/") + 1);
  if (tail && tail !== "image" && tail.length <= 5) return tail.toUpperCase();
  const ext = fileName?.match(/\.([a-z0-9]{1,5})$/i)?.[1];
  return ext ? ext.toUpperCase() : null;
}

// --------------------------------------------------------------------------- //
// Loading a page of a local file
// --------------------------------------------------------------------------- //
interface PageBlob {
  blob: Blob;
  pageCount: number | null;
  fileType: string | null;
}

const pageCache = new WeakMap<File, Map<string, PageBlob>>();
/** Files the API refused as a whole (no preview, corrupt, too large...): the message, not asked again. */
const fileFailures = new WeakMap<File, string>();
/** Coded 415s that mean "this kind of file has no picture" (audio, an unknown format). */
const NO_PREVIEW_CODES = new Set(["no_preview", "unsupported_signature"]);
/** Errors about the request (page / width), not the file. */
const REQUEST_CODES = new Set(["invalid_page", "invalid_request"]);

function positiveInt(value: string | null): number | null {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadFilePage(file: File, page: number, width: number, signal: AbortSignal): Promise<PageBlob> {
  if (isBrowserImage(file)) return { blob: file, pageCount: 1, fileType: file.type || null };
  const failure = fileFailures.get(file);
  if (failure) throw new Error(failure);
  const key = `${page}@${width}`;
  const hit = pageCache.get(file)?.get(key);
  if (hit) return hit;

  const form = new FormData();
  form.append("file", file);
  form.append("page", String(page));
  form.append("width", String(width));
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL.replace(/\/+$/, "")}/api/intake/preview`, { method: "POST", body: form, signal });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error("Cannot reach the 3iLens API");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown; code?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code : null;
    const detail = typeof body?.detail === "string" ? body.detail : null;
    const message =
      NO_PREVIEW_CODES.has(code ?? "") || (res.status === 415 && !code)
        ? NO_PREVIEW_MESSAGE
        : res.status === 404 && !code
          ? "Preview is not available on this server"
          : (detail ?? `Preview failed (HTTP ${res.status})`);
    // A coded 4xx about the file itself holds for every page and width.
    if (code && res.status >= 400 && res.status < 500 && !REQUEST_CODES.has(code)) fileFailures.set(file, message);
    throw new Error(message);
  }
  const entry: PageBlob = {
    blob: await res.blob(),
    pageCount: positiveInt(res.headers.get("X-Page-Count")),
    fileType: res.headers.get("X-File-Type"),
  };
  let pages = pageCache.get(file);
  if (!pages) pageCache.set(file, (pages = new Map()));
  pages.set(key, entry);
  return entry;
}

type PageView = { status: "loading" } | { status: "ready"; src: string } | { status: "error"; message: string };
type Loaded = { file: File; page: number; width: number } & ({ ok: true; url: string } | { ok: false; message: string });
type FileMeta = { file: File; pageCount: number | null; fileType: string | null };

/** Page `page` of a local file as an object URL (idle when file is null). */
function useFilePage(file: File | null, page: number, width: number): { view: PageView; meta: FileMeta | null } {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [meta, setMeta] = useState<FileMeta | null>(null);

  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    let url: string | null = null;
    loadFilePage(file, page, width, controller.signal).then(
      (entry) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(entry.blob);
        setLoaded({ file, page, width, ok: true, url });
        setMeta({ file, pageCount: entry.pageCount, fileType: entry.fileType });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({ file, page, width, ok: false, message: err instanceof Error ? err.message : "Preview failed" });
      },
    );
    return () => {
      controller.abort();
      if (url) {
        const revoked = url;
        URL.revokeObjectURL(revoked);
        // Never show a revoked URL if this same page is asked for again before it reloads.
        setLoaded((cur) => (cur?.ok && cur.url === revoked ? null : cur));
      }
    };
  }, [file, page, width]);

  const current = file && loaded?.file === file && loaded.page === page && loaded.width === width ? loaded : null;
  const view: PageView = !current
    ? { status: "loading" }
    : current.ok
      ? { status: "ready", src: current.url }
      : { status: "error", message: current.message };
  return { view, meta: file && meta?.file === file ? meta : null };
}

// --------------------------------------------------------------------------- //
// Pieces
// --------------------------------------------------------------------------- //
function Skeleton() {
  return <span aria-hidden className="absolute inset-0 animate-pulse bg-slate-100 motion-reduce:animate-none" />;
}

function Placeholder({ icon: Icon, text }: { icon: typeof FileText; text: string }) {
  return (
    <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 p-2 text-center text-xs text-slate-500">
      <Icon className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
      <span className="line-clamp-4" title={text}>
        {text}
      </span>
    </span>
  );
}

/** An image with its own loading skeleton and "unavailable" fallback. */
function PageImage({ src, alt }: { src: string; alt: string }) {
  const [settled, setSettled] = useState<{ src: string; ok: boolean } | null>(null);
  const state = settled?.src === src ? (settled.ok ? "ready" : "error") : "loading";
  if (state === "error") return <Placeholder icon={ImageOff} text="Preview unavailable" />;
  return (
    <>
      {state === "loading" ? <Skeleton /> : null}
      <img
        src={src}
        alt={alt}
        // An image that finished before hydration fires no load event.
        ref={(el) => {
          if (el?.complete && settled?.src !== src) setSettled({ src, ok: el.naturalWidth > 0 });
        }}
        onLoad={() => setSettled({ src, ok: true })}
        onError={() => setSettled({ src, ok: false })}
        className={cn("h-full w-full object-contain", state === "loading" && "invisible")}
      />
    </>
  );
}

/** What the source shows for `page`: skeleton, image or error text (`view` is the file load). */
function PageContent({ source, view, page, alt }: { source: DocSource; view: PageView; page: number; alt: string }) {
  if (source.kind === "url") return <PageImage src={source.pageUrl(page)} alt={alt} />;
  if (view.status === "loading") return <Skeleton />;
  if (view.status === "error") return <Placeholder icon={ImageOff} text={view.message} />;
  return <PageImage src={view.src} alt={alt} />;
}

const stepButton =
  "grid h-9 w-9 shrink-0 place-items-center rounded-md border border-slate-300 bg-white text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-white";

/** Prev / next with "Page n of N". aria-disabled (not disabled) keeps focus on the button at either end. */
function Stepper({
  page,
  count,
  label,
  compact,
  onGo,
  className,
}: {
  page: number;
  count: number;
  label: string;
  compact: boolean;
  onGo: (page: number) => void;
  className?: string;
}) {
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const target =
      e.key === "ArrowLeft" ? page - 1 : e.key === "ArrowRight" ? page + 1 : e.key === "Home" ? 1 : e.key === "End" ? count : null;
    if (target === null) return;
    e.preventDefault();
    onGo(target);
  };
  return (
    <div role="group" aria-label={`${label} pages`} onKeyDown={onKeyDown} className={cn("flex items-center justify-between gap-1", className)}>
      <button
        type="button"
        className={stepButton}
        aria-label="Previous page"
        aria-disabled={page <= 1}
        onClick={() => onGo(page - 1)}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </button>
      <span className="min-w-0 text-center text-xs tabular-nums text-slate-600" aria-live="polite">
        {compact ? (
          <>
            <span aria-hidden>
              {page}/{count}
            </span>
            <span className="sr-only">
              Page {page} of {count}
            </span>
          </>
        ) : (
          `Page ${page} of ${count}`
        )}
      </span>
      <button
        type="button"
        className={stepButton}
        aria-label="Next page"
        aria-disabled={page >= count}
        onClick={() => onGo(page + 1)}
      >
        <ChevronRight className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/** Dialog body: the page at full width, with ← / → while open. */
function FullSizePage({
  source,
  page,
  alt,
  onStep,
}: {
  source: DocSource;
  page: number;
  alt: string;
  onStep: (delta: number) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // the footer stepper already moved
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        onStep(e.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStep]);
  const { view } = useFilePage(source.kind === "file" ? source.file : null, page, FULL_WIDTH);
  return (
    <div className="relative mx-auto h-[70dvh] w-full overflow-hidden rounded-sm bg-slate-50">
      <PageContent source={source} view={view} page={page} alt={alt} />
    </div>
  );
}

// --------------------------------------------------------------------------- //
// DocPreview
// --------------------------------------------------------------------------- //
export function DocPreview({
  source,
  label,
  name,
  size = "md",
  emptyText = "Nothing to preview yet",
  className,
}: DocPreviewProps) {
  const sm = size === "sm";
  const file = source?.kind === "file" ? source.file : null;
  // What the page number belongs to: a new file or another set of server pages starts at page 1.
  const identity: File | string | null =
    source === null ? null : source.kind === "file" ? source.file : `${source.pageUrl(1)}#${source.pageCount}`;
  const [view, setView] = useState<{ of: File | string | null; page: number }>({ of: identity, page: 1 });
  const [open, setOpen] = useState(false);

  const urlCount = source?.kind === "url" ? Math.max(0, Math.floor(source.pageCount)) : null;
  const requested = view.of === identity ? view.page : 1;
  const page = urlCount ? Math.min(requested, urlCount) : requested;
  // The thumbnail's load also reports the file's page count and type.
  const thumb = useFilePage(file, page, THUMB_WIDTH[size]);
  const meta = thumb.meta;
  const pageCount = urlCount ?? (meta ? (meta.pageCount ?? 1) : null);

  const displayName = name ?? file?.name ?? null;
  const type = file ? typeLabel(meta?.fileType ?? (isBrowserImage(file) ? file.type : null), file.name) : null;
  const facts = [type, pageCount ? `${pageCount} page${pageCount === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");
  const empty = source === null || urlCount === 0;
  const multi = pageCount !== null && pageCount > 1;
  const alt = `${label}${displayName ? ` (${displayName})` : ""}, page ${page}${pageCount ? ` of ${pageCount}` : ""}`;
  // A file the API could not render: show the reason, no full-size action.
  const failed = file !== null && thumb.view.status === "error";
  const box = cn("relative block overflow-hidden rounded-sm border bg-slate-50", sm ? "h-[160px] w-[120px]" : "h-[320px] w-full");

  const go = (target: number) => {
    if (!pageCount) return;
    const next = Math.min(pageCount, Math.max(1, target));
    if (next !== page) setView({ of: identity, page: next });
  };

  return (
    <div
      role="group"
      aria-label={`${label} preview`}
      // The thumbnail, stepper and <dialog> live in this card: their clicks never reach a clickable staged row.
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "flex min-w-0 flex-col rounded-md border border-slate-200 bg-white",
        sm ? "w-[138px] gap-1.5 p-2" : "w-full max-w-[264px] gap-2 p-3",
        className,
      )}
    >
      <div className="min-w-0">
        <p className={cn("truncate text-slate-500", sm ? "text-[11px]" : "text-xs")}>{label}</p>
        {displayName ? (
          <p className={cn("truncate font-medium text-slate-800", sm ? "text-xs" : "text-sm")} title={displayName}>
            {displayName}
          </p>
        ) : null}
        {facts ? <p className={cn("tabular-nums text-slate-500", sm ? "text-[11px]" : "text-xs")}>{facts}</p> : null}
      </div>

      {empty || !source ? (
        <div className={cn(box, "border-dashed border-slate-300")}>
          <Placeholder icon={FileText} text={source === null ? emptyText : "No pages stored"} />
        </div>
      ) : failed ? (
        <div className={cn(box, "border-slate-200")}>
          <PageContent source={source} view={thumb.view} page={page} alt={alt} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Open ${label} page ${page} full size`}
          className={cn(
            box,
            "border-slate-200 transition-colors duration-150 hover:border-slate-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan",
          )}
        >
          <PageContent source={source} view={thumb.view} page={page} alt={alt} />
          <span
            aria-hidden
            className="absolute right-1 bottom-1 inline-flex items-center gap-1 rounded-sm bg-slate-800/85 px-1.5 py-0.5 text-[11px] font-medium text-white"
          >
            <Maximize2 className="h-3 w-3" />
            {sm ? null : "Full size"}
          </span>
        </button>
      )}

      {multi ? <Stepper page={page} count={pageCount} label={label} compact={sm} onGo={go} /> : null}

      {source && !empty && !failed ? (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          size="xl"
          eyebrow={label}
          title={displayName ?? label}
          description={multi ? `Page ${page} of ${pageCount}. Use ← / → to change page, Esc to close.` : "Esc to close."}
          footer={multi ? <Stepper page={page} count={pageCount} label={label} compact={false} onGo={go} /> : undefined}
        >
          <FullSizePage source={source} page={page} alt={`${alt}, full size`} onStep={(delta) => go(page + delta)} />
        </Modal>
      ) : null}
    </div>
  );
}
