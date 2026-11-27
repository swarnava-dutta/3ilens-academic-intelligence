"use client";

import { useEffect, useState } from "react";
import { DocPreview, type DocPreviewProps } from "@/components/preview/doc-preview";
import { PreviewPair } from "@/components/preview/preview-pair";
import { sourceLabel } from "@/components/rubrics/rubric-utils";
import { errorMessage, errorStatus, getPages, getRubricSources, pageImageUrl, rubricSourcePreviewUrl } from "@/lib/api";
import type { PageRef, RubricSourceFile, Submission } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SectionCard } from "./primitives";

export const NO_KEY_FILES =
  "The key for this sheet was not uploaded as a file (pasted or JSON), or it was drafted on this page for a re-run or re-grade.";

const ORDER = { paper: 0, key: 1 } as const;
/** A failed page list is asked for once more after this long (the pages may still be being drawn). */
const PAGES_RETRY_MS = 1500;

type Loaded = { rubricId: number; files: RubricSourceFile[]; error: null } | { rubricId: number; files: null; error: string };

/** GET /api/rubrics/{id}/sources for the sheet's key; null while loading. A 404 (older API) reads as no files. */
function useRubricSources(rubricId: number): Loaded | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let cancelled = false;
    getRubricSources(rubricId).then(
      (list) => {
        if (cancelled) return;
        const files = (Array.isArray(list) ? list : [])
          .filter((f) => f?.kind === "paper" || f?.kind === "key")
          .sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
        setLoaded({ rubricId, files, error: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        setLoaded(
          errorStatus(err) === 404
            ? { rubricId, files: [], error: null }
            : { rubricId, files: null, error: errorMessage(err) },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rubricId]);
  return loaded?.rubricId === rubricId ? loaded : null;
}

type SheetPages = { id: number; pages: PageRef[]; error: null } | { id: number; pages: null; error: string };

/**
 * GET /api/submissions/{id}/pages: the sheet's stored page images. This call also draws them for a
 * sheet held or failed before pre-processing, so the thumbnails use its refs (never page_count
 * alone). Asked again when the sheet's status or page count changes (the last list stays shown
 * meanwhile); a failure is retried once. Null while loading or when skipped (a voice answer).
 */
function useSheetPages(submission: Submission, skip: boolean): SheetPages | null {
  const id = submission.id;
  const status = submission.status;
  const pageCount = submission.page_count;
  const [loaded, setLoaded] = useState<SheetPages | null>(null);
  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = (retry: boolean) => {
      getPages(id).then(
        (list) => {
          if (cancelled) return;
          const pages = (Array.isArray(list) ? list : [])
            .filter((p) => typeof p?.page_number === "number")
            .sort((a, b) => a.page_number - b.page_number);
          setLoaded({ id, pages, error: null });
        },
        (err: unknown) => {
          if (cancelled) return;
          if (retry) {
            timer = window.setTimeout(() => load(false), PAGES_RETRY_MS);
            return;
          }
          setLoaded({
            id,
            pages: null,
            error: errorStatus(err) === 404 ? "the page images are not available" : errorMessage(err),
          });
        },
      );
    };
    load(true);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [id, status, pageCount, skip]);
  return !skip && loaded?.id === id ? loaded : null;
}

/** The answer-sheet card: the listed page images, or why there are none. */
function sheetDoc(submission: Submission, sheet: SheetPages | null): DocPreviewProps {
  const base = { label: "Answer sheet", name: submission.original_filename || undefined };
  if (!sheet) return { ...base, source: null, emptyText: "Loading the sheet's pages…" };
  if (!sheet.pages) return { ...base, source: null, emptyText: `Could not load the sheet's pages: ${sheet.error}` };
  const pages = sheet.pages;
  if (!pages.length) return { ...base, source: null, emptyText: "No page images are stored for this sheet." };
  return {
    ...base,
    source: {
      kind: "url",
      pageUrl: (n: number) => pageImageUrl(submission.id, pages[n - 1]?.page_number ?? n),
      pageCount: pages.length,
    },
  };
}

/**
 * "Sources": a small preview of the student's answer sheet (its stored page images) next to the
 * question paper and the answer-key file the sheet's key was drafted from (kept per upload, not a
 * library). Shown on the completed report and on the held / failed views; not for demo rows.
 */
export function SourcesPanel({
  submission,
  rubricId: graded,
  className,
}: {
  submission: Submission;
  /** The key the shown result was graded with (an archived version's); default the sheet's current key. */
  rubricId?: number;
  className?: string;
}) {
  const rubricId = graded ?? submission.rubric_id;
  const voice = submission.input_kind === "voice";
  const sources = useRubricSources(rubricId);
  const sheet = useSheetPages(submission, voice);

  const keyDocs: DocPreviewProps[] = sources?.files?.length
    ? sources.files.map((f) => ({
        label: sourceLabel(f.kind, f.role),
        name: f.filename || undefined,
        source: {
          kind: "url",
          pageUrl: (n: number) => rubricSourcePreviewUrl(rubricId, f.kind, n),
          pageCount: Math.max(1, f.pages ?? 1),
        },
      }))
    : [
        {
          label: "Question paper",
          source: null,
          emptyText: !sources
            ? "Loading the key files…"
            : sources.error
              ? `Could not load the key files: ${sources.error}`
              : NO_KEY_FILES,
        },
      ];
  const docs: DocPreviewProps[] = voice ? keyDocs : [sheetDoc(submission, sheet), ...keyDocs];

  return (
    <SectionCard
      id="sources"
      title="Sources"
      description={
        voice
          ? "The files this answer's key was drafted from. Click a page for full size."
          : "The answer sheet next to the files its key was drafted from. Click a page for full size."
      }
      className={cn("print:hidden", className)}
    >
      {voice ? (
        <p className="mb-3 text-sm text-slate-600">
          Voice answer: a recording, so there is no answer-sheet page to preview.
        </p>
      ) : null}
      {docs.length === 2 ? (
        <PreviewPair left={docs[0]} right={docs[1]} />
      ) : (
        // Sheet, question paper and answer-key file: PreviewPair's row with a third card (wraps when narrow).
        <div
          role="group"
          aria-label={docs.map((d) => d.label).join(", ")}
          className="flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap"
        >
          {docs.map((d, i) => (
            <DocPreview key={`${i}-${d.label}`} size="md" {...d} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
