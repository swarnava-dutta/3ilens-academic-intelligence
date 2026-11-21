"use client";

/* eslint-disable @next/next/no-img-element -- page scans are served by the FastAPI backend (another origin, arbitrary sizes); next/image would need remotePatterns and adds nothing here. */

import { ChevronLeft, ChevronRight, ImageOff, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage, errorStatus, getPages, pageImageUrl } from "@/lib/api";
import type { PageRef, Result } from "@/lib/types";
import { cn, formatConfidence } from "@/lib/utils";
import { Modal, btnSecondary } from "./dialog";
import { Pill, SectionCard } from "./primitives";
import { OPEN_PAGE_EVENT, currentHash, pageFromHash, replaceHash, scrollToId } from "./report-events";

type Variant = "processed" | "original";
type LoadState = { kind: "loading" } | { kind: "ready"; pages: PageRef[] } | { kind: "error"; message: string };

function PageImage({
  id,
  page,
  variant,
  className,
  alt,
}: {
  id: number;
  page: PageRef;
  variant: Variant;
  className?: string;
  alt: string;
}) {
  const [failed, setFailed] = useState(false);
  const useOriginal = variant === "original" && page.original_url !== null;
  if (failed) {
    return (
      <div className={cn("grid place-items-center bg-slate-100 text-xs text-slate-500", className)}>
        <span className="flex flex-col items-center gap-1 p-4 text-center">
          <ImageOff className="h-5 w-5" aria-hidden /> Image unavailable
        </span>
      </div>
    );
  }
  return (
    <img
      src={pageImageUrl(id, page.page_number, useOriginal ? "original" : "processed")}
      alt={alt}
      width={page.width ?? undefined}
      height={page.height ?? undefined}
      onError={() => setFailed(true)}
      className={cn("bg-white object-contain", className)}
    />
  );
}

/** Source pages viewer (the report's "Original pages" section): thumbnails, large page, lightbox, processed/original toggle. */
export function SourcePagesViewer({ result }: { result: Result }) {
  const id = result.submission.id;
  const isDemo = result.submission.is_demo;
  const [state, setState] = useState<LoadState>(() => (isDemo ? { kind: "ready", pages: [] } : { kind: "loading" }));
  const [current, setCurrent] = useState<number>(() => pageFromHash(currentHash()) ?? 1);
  const [variant, setVariant] = useState<Variant>("processed");
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => {
    if (isDemo) return;
    let cancelled = false;
    getPages(id)
      .then((pages) => {
        if (cancelled) return;
        const list = (Array.isArray(pages) ? pages : []).filter((p) => typeof p?.page_number === "number");
        setState({ kind: "ready", pages: list.sort((a, b) => a.page_number - b.page_number) });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            errorStatus(err) === 404
              ? "Page images are not available for this submission (no stored pages, or the backend does not serve them yet)."
              : errorMessage(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [id, isDemo]);

  // "Open page n" links elsewhere in the report.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const page = (e as CustomEvent<number>).detail;
      if (typeof page === "number") {
        setCurrent(page);
        scrollToId("source-pages");
      }
    };
    window.addEventListener(OPEN_PAGE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PAGE_EVENT, onOpen);
  }, []);

  const pages = state.kind === "ready" ? state.pages : [];
  const index = Math.max(0, pages.findIndex((p) => p.page_number === current));
  const page = pages[index] ?? null;
  const hasOriginal = pages.some((p) => p.original_url !== null);
  const flagged = new Set(result.extraction.flagged_pages);
  const confidence = new Map(result.extraction.page_confidences.map((p) => [p.page, p.confidence]));

  const go = (i: number) => {
    const target = pages[Math.min(pages.length - 1, Math.max(0, i))];
    if (!target) return;
    setCurrent(target.page_number);
    replaceHash(`page-${target.page_number}`);
  };

  // Arrow keys while the lightbox is open (Esc is handled by <dialog>).
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(index + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(index - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <SectionCard
      id="source-pages"
      title="Original pages"
      description={
        isDemo
          ? "Synthetic record: no source scan."
          : "The pages exactly as uploaded, and as the vision model saw them after pre-processing."
      }
      action={
        hasOriginal ? (
          <div role="group" aria-label="Image variant" className="flex rounded-md border border-slate-300 text-xs print:hidden">
            {(
              [
                ["processed", "Processed"],
                ["original", "Original"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={variant === k}
                onClick={() => setVariant(k)}
                className={cn(
                  "min-h-8 px-3 py-1 font-medium transition-colors duration-150 first:rounded-l-md last:rounded-r-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan",
                  variant === k ? "bg-brand-navy text-white" : "bg-white text-slate-600 hover:bg-slate-50",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null
      }
    >
      {isDemo ? (
        <div className="py-2">
          <p className="max-w-xl text-sm text-slate-600">
            Demo rows are generated locally without an uploaded answer sheet, OCR or AI call, so there are no pages to show.
          </p>
        </div>
      ) : state.kind === "loading" ? (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading page images…
        </p>
      ) : state.kind === "error" ? (
        <p className="py-2 text-sm text-slate-500">{state.message}</p>
      ) : pages.length === 0 || !page ? (
        <p className="py-2 text-sm text-slate-500">
          No page images were stored for this submission.
        </p>
      ) : (
        <>
          <div className="print:hidden">
            <ol className="relative flex gap-2 overflow-x-auto pb-2 print:overflow-visible" aria-label="Page thumbnails">
              {pages.map((p, i) => (
                <li key={p.page_number} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => go(i)}
                    aria-current={i === index ? "page" : undefined}
                    className={cn(
                      "relative block w-20 overflow-hidden rounded-sm border-2 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan",
                      i === index ? "border-brand-cyan" : "border-slate-200 hover:border-slate-400",
                    )}
                  >
                    <PageImage id={id} page={p} variant={variant} alt={`Page ${p.page_number} thumbnail`} className="h-24 w-20" />
                    <span
                      className={cn(
                        "absolute inset-x-0 bottom-0 px-1 py-0.5 text-center text-[11px] font-medium tabular-nums",
                        flagged.has(p.page_number) ? "bg-amber-400 text-amber-950" : "bg-slate-800/85 text-white",
                      )}
                    >
                      p. {p.page_number}
                      {flagged.has(p.page_number) ? " · flagged" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ol>

            <div id={`page-${page.page_number}`} className="mt-3 scroll-mt-48">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold tabular-nums text-brand-navy">
                  Page {page.page_number} of {pages.length}
                </p>
                <span className="text-xs text-slate-500">
                  {variant === "original" && page.original_url ? "Original upload" : "Processed (what the model saw)"}
                </span>
                {confidence.has(page.page_number) ? (
                  <Pill
                    className={
                      flagged.has(page.page_number)
                        ? "bg-amber-50 text-amber-800"
                        : "bg-slate-100 text-slate-600"
                    }
                  >
                    Legibility {formatConfidence(confidence.get(page.page_number))}
                  </Pill>
                ) : null}
                <div className="ml-auto flex gap-2">
                  <button type="button" className={btnSecondary} onClick={() => go(index - 1)} disabled={index === 0}>
                    <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
                  </button>
                  <button type="button" className={btnSecondary} onClick={() => go(index + 1)} disabled={index >= pages.length - 1}>
                    Next <ChevronRight className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setLightbox(true)}
                className="group relative block w-full overflow-hidden rounded-md border border-slate-200 bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
                aria-label={`Open page ${page.page_number} fullscreen`}
              >
                <PageImage
                  key={`${page.page_number}-${variant}`}
                  id={id}
                  page={page}
                  variant={variant}
                  alt={`Answer sheet page ${page.page_number}`}
                  className="mx-auto max-h-[70vh] w-full"
                />
                <span className="absolute right-2 top-2 rounded-sm bg-slate-800/85 px-2 py-1 text-xs font-medium text-white">
                  Fullscreen
                </span>
              </button>
              <p className="mt-2 text-xs text-slate-500">
                Pages render as uploaded; no marks or claims are drawn onto the images.
              </p>
            </div>
          </div>

          <div className="sair-print-only">
            <div className="grid grid-cols-2 gap-3">
              {pages.map((p) => (
                <figure key={p.page_number} className="break-inside-avoid">
                  <PageImage id={id} page={p} variant="processed" alt={`Page ${p.page_number}`} className="w-full border border-slate-300" />
                  <figcaption className="mt-1 text-center text-[10px] text-slate-500">Page {p.page_number}</figcaption>
                </figure>
              ))}
            </div>
          </div>

          <Modal
            open={lightbox}
            onClose={() => setLightbox(false)}
            size="xl"
            eyebrow={variant === "original" && page.original_url ? "Original upload" : "Processed page"}
            title={`Page ${page.page_number} of ${pages.length}`}
            description="Use ← / → to change page, Esc to close."
            footer={
              <div className="flex justify-between gap-2">
                <button type="button" className={btnSecondary} onClick={() => go(index - 1)} disabled={index === 0}>
                  <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
                </button>
                <button type="button" className={btnSecondary} onClick={() => go(index + 1)} disabled={index >= pages.length - 1}>
                  Next <ChevronRight className="h-4 w-4" aria-hidden />
                </button>
              </div>
            }
          >
            <PageImage
              key={`lb-${page.page_number}-${variant}`}
              id={id}
              page={page}
              variant={variant}
              alt={`Answer sheet page ${page.page_number}, full size`}
              className="mx-auto max-h-[75dvh] w-full"
            />
          </Modal>
        </>
      )}
    </SectionCard>
  );
}
