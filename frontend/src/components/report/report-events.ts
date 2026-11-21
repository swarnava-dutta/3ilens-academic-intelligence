// Small DOM helpers shared by the report sections (no React state crosses section boundaries).
//
// - Question references (Q-ref chips, evidence trace, action plan) scroll to the question card
//   #q-<n> and flash it.
// - "Open page n" links ask the source-page viewer (section 05) to show page n via a window event
//   and record #page-<n> in the URL so the view can be shared.

export const OPEN_PAGE_EVENT = "sair:open-page";

function prefersReducedMotion(): boolean {
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

/** Scroll to the question card #q-<n> and briefly highlight it. */
export function focusQuestion(question: number): void {
  const el = scrollToId(`q-${question}`, "center");
  if (!el) return;
  el.classList.remove("sair-flash");
  // Restart the animation when the same card is flashed twice in a row.
  void el.offsetWidth;
  el.classList.add("sair-flash");
  window.setTimeout(() => el.classList.remove("sair-flash"), 1900);
  replaceHash(`q-${question}`);
}

/** Show page n in the source-page viewer (section 05) and scroll to it. */
export function openSourcePage(page: number): void {
  replaceHash(`page-${page}`);
  window.dispatchEvent(new CustomEvent<number>(OPEN_PAGE_EVENT, { detail: page }));
}

/** "page-3" -> 3 */
export function pageFromHash(hash: string): number | null {
  const m = /^page-(\d{1,3})$/.exec(hash);
  return m ? Number(m[1]) : null;
}
