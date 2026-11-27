// Small DOM helpers shared by the report sections (no React state crosses section boundaries).
//
// - Folds ("More details") open on OPEN_FOLD_EVENT (detail = fold id) and mount their content then.
// - Question references (Q-ref chips, evidence trace, action plan) open the "Question-by-question
//   details" fold, wait for the card #q-<n> to mount, scroll to it and flash it.
// - "Open page n" links open the "Answer sheet pages" fold, ask its viewer to show page n via a
//   window event and record #page-<n> in the URL so the view can be shared.
// - Key-insight evidence links scroll to their anchor and, for the question grid, set its filter.

export const OPEN_PAGE_EVENT = "sair:open-page";
export const OPEN_FOLD_EVENT = "sair:open-fold";
export const GRID_FILTER_EVENT = "sair:grid-filter";
export const SHOW_QUESTION_EVENT = "sair:show-question";

/** Fold ids (the anchors in "More details"). */
export const FOLD = {
  topics: "more-topics",
  technique: "more-technique",
  plan: "more-plan",
  questions: "more-questions",
  pages: "more-pages",
  cohort: "more-cohort",
  review: "faculty-review",
  lab: "faculty-lab",
  teaching: "faculty-teaching",
  reading: "faculty-reading",
  audit: "faculty-audit",
} as const;

export type GridFilter = "all" | "right" | "wrong" | "blank" | "bonus" | "partial" | "zero" | "unclear";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Replace the URL hash without adding a history entry (keeps Next.js' history state). */
export function replaceHash(hash: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const url = `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ""}`;
    window.history.replaceState(window.history.state, "", url);
  } catch {
    /* a sandboxed frame may refuse; the hash is only a convenience */
  }
}

/** Current hash without the leading "#". */
export function currentHash(): string {
  return typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.replace(/^#/, ""));
}

export function scrollToId(id: string, block: ScrollLogicalPosition = "start"): HTMLElement | null {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block });
  return el;
}

/** Briefly highlight an element (a static ring under reduced motion, see globals.css). */
export function flash(el: HTMLElement): void {
  el.classList.remove("sair-flash");
  // Restart the animation when the same element is flashed twice in a row.
  void el.offsetWidth;
  el.classList.add("sair-flash");
  window.setTimeout(() => el.classList.remove("sair-flash"), 1900);
}

/** The fold that holds a deep-linked element: #q-51 -> questions, #page-3 -> pages, #more-x -> itself. */
export function foldForHash(hash: string): string | null {
  if (/^q-\d+$/.test(hash)) return FOLD.questions;
  if (/^page-\d+$/.test(hash)) return FOLD.pages;
  if ((Object.values(FOLD) as string[]).includes(hash)) return hash;
  return null;
}

/** Open (and mount) a fold. */
export function openFold(id: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(OPEN_FOLD_EVENT, { detail: id }));
}

/** Calls `found` once #id exists (a fold mounts its content a frame after opening); gives up after ~2 s. */
function whenMounted(id: string, found: (el: HTMLElement) => void, tries = 40): void {
  const el = document.getElementById(id);
  if (el) {
    found(el);
    return;
  }
  if (tries > 0) window.setTimeout(() => whenMounted(id, found, tries - 1), 50);
}

/** Open a fold, then scroll to it once its content has mounted. */
export function openFoldAndScroll(id: string): void {
  openFold(id);
  replaceHash(id);
  window.setTimeout(() => scrollToId(id), 60);
}

/** Question asked for before its (paginated, lazily mounted) list existed. */
let pendingQuestion: number | null = null;

/** Read once by the question list when it mounts, so it opens on the right page. */
export function takePendingQuestion(): number | null {
  const n = pendingQuestion;
  pendingQuestion = null;
  return n;
}

/** Open "Question-by-question details", show the page with question n, then scroll to its card and flash it. */
export function focusQuestion(question: number): void {
  pendingQuestion = question;
  openFold(FOLD.questions);
  window.dispatchEvent(new CustomEvent<number>(SHOW_QUESTION_EVENT, { detail: question }));
  replaceHash(`q-${question}`);
  whenMounted(`q-${question}`, (el) => {
    pendingQuestion = null;
    // One more frame so the fold's height transition does not move the card after the scroll starts.
    window.setTimeout(() => {
      el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
      flash(el);
      replaceHash(`q-${question}`);
    }, 220);
  });
}

/** Open the "Answer sheet pages" fold and show page n in its viewer. */
export function openSourcePage(page: number): void {
  openFold(FOLD.pages);
  replaceHash(`page-${page}`);
  // The viewer reads #page-n when it mounts; the event covers a viewer that is already open.
  whenMounted("source-pages", () => {
    window.dispatchEvent(new CustomEvent<number>(OPEN_PAGE_EVENT, { detail: page }));
    window.setTimeout(() => scrollToId("source-pages"), 60);
  });
}

/** "page-3" -> 3 */
export function pageFromHash(hash: string): number | null {
  const m = /^page-(\d{1,3})$/.exec(hash);
  return m ? Number(m[1]) : null;
}

/**
 * A key insight's "See evidence": set the question grid's filter (when given), scroll to the anchor,
 * flash it and record it in the hash. An anchor that is not on the page falls back to its section.
 */
export function openEvidence({ anchor, filter, fallback }: { anchor: string; filter?: GridFilter | null; fallback?: string }): void {
  if (typeof window === "undefined") return;
  if (filter) window.dispatchEvent(new CustomEvent<GridFilter>(GRID_FILTER_EVENT, { detail: filter }));
  const id = anchor.replace(/^#/, "");
  const target = document.getElementById(id) ? id : fallback && document.getElementById(fallback) ? fallback : null;
  if (!target) return;
  const fold = foldForHash(target);
  if (fold) openFold(fold);
  replaceHash(target);
  window.setTimeout(() => {
    const el = scrollToId(target, "start");
    if (el) flash(el);
  }, fold ? 80 : 0);
}
