"use client";

import { ListTree } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  currentHash,
  focusQuestion,
  foldForHash,
  openFoldAndScroll,
  openSourcePage,
  pageFromHash,
  replaceHash,
  scrollToId,
} from "./report-events";
import { Menu } from "./summary/menu";
import { focusRing, sectionTitle } from "./summary/tokens";

/** The report's five anchors: the summary, three compact sections, then the folds. */
export const REPORT_SECTIONS = [
  { id: "summary", label: "Summary" },
  { id: "subjects", label: "Subjects" },
  { id: "focus", label: "Focus" },
  { id: "questions", label: "Questions" },
  { id: "more", label: "More details" },
] as const;

export type ReportSectionId = (typeof REPORT_SECTIONS)[number]["id"];

const SECTION_IDS: string[] = REPORT_SECTIONS.map((s) => s.id);

/** Section that holds the element the URL hash points at (#q-3 and #more-plan live in "more"). */
function sectionForHash(hash: string): ReportSectionId {
  if (SECTION_IDS.includes(hash)) return hash as ReportSectionId;
  if (foldForHash(hash)) return "more";
  if (/^(subject|focus)-/.test(hash)) return hash.startsWith("subject") ? "subjects" : "focus";
  return "summary";
}

function go(id: ReportSectionId) {
  scrollToId(id);
  replaceHash(id);
}

/**
 * Section navigation. Desktop: a sticky row of the five anchors, the one in view highlighted and
 * kept in the URL hash (a deep link inside a section, #q-51 or #more-plan, is left alone). Phones: no
 * sticky row, a floating "Jump to" button instead. Deep links that arrive before the client-rendered
 * report exists (#q-51, #page-3, #more-plan) are applied once it has mounted.
 */
export function SectionNav() {
  const [active, setActive] = useState<ReportSectionId>(() => sectionForHash(currentHash()));
  // Phones: the floating "Sections" button appears only once the summary has scrolled away, so it never
  // covers the score or the first insights.
  const [pastSummary, setPastSummary] = useState(false);

  useEffect(() => {
    const summary = document.getElementById("summary");
    if (!summary) return;
    const observer = new IntersectionObserver(([e]) => setPastSummary(!e.isIntersecting && e.boundingClientRect.top < 0));
    observer.observe(summary);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const hash = currentHash();
    if (!hash) return;
    const timer = window.setTimeout(() => {
      const q = /^q-(\d+)$/.exec(hash);
      const page = pageFromHash(hash);
      if (q) focusQuestion(Number(q[1]));
      else if (page !== null) openSourcePage(page);
      else if (foldForHash(hash)) openFoldAndScroll(hash);
      else if (document.getElementById(hash)) scrollToId(hash);
    }, 150);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const sections = SECTION_IDS.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    if (sections.length === 0) return;

    const activate = (id: ReportSectionId) => {
      setActive(id);
      const hash = currentHash();
      if (hash === id) return;
      const target = hash ? document.getElementById(hash) : null;
      const section = document.getElementById(id);
      // Keep #q-3 / #more-plan / #subject-physics while their own section is the one in view.
      if (target && section && section !== target && section.contains(target)) return;
      // A fold, question or page link (#more-plan, #q-51, #page-3) whose content is still mounting.
      if (id === "more" && foldForHash(hash)) return;
      if (!hash && id === "summary" && window.scrollY < 200) return;
      replaceHash(id);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        // Near the top of the page the summary is the section in view, whatever the band holds.
        if (window.scrollY < 120) activate("summary");
        else if (hit) activate(hit.target.id as ReportSectionId);
      },
      { rootMargin: "-30% 0px -65% 0px" },
    );
    sections.forEach((el) => observer.observe(el));

    // A short last section never reaches the band: activate it at the bottom of the page.
    const onScroll = () => {
      const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8;
      if (bottom) activate(sections[sections.length - 1].id as ReportSectionId);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <>
      <nav
        aria-label="Report sections"
        className="sair-section-nav sticky top-[5.5rem] z-30 hidden border-b border-slate-200 bg-[#f8fafc] md:block print:hidden"
      >
        <ol className="flex">
          {REPORT_SECTIONS.map((s) => {
            const isActive = active === s.id;
            return (
              <li key={s.id} className="shrink-0">
                <a
                  href={`#${s.id}`}
                  aria-current={isActive ? "location" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    setActive(s.id);
                    go(s.id);
                  }}
                  className={cn(
                    "-mb-px flex min-h-10 cursor-pointer items-center whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150",
                    focusRing,
                    "focus-visible:-outline-offset-2",
                    isActive
                      ? "border-[#1E40AF] text-[#1E3A8A]"
                      : "border-transparent text-slate-600 hover:border-slate-300 hover:text-[#1E3A8A]",
                  )}
                >
                  {s.label}
                </a>
              </li>
            );
          })}
        </ol>
      </nav>
      <div
        className={cn(
          "fixed bottom-4 right-4 z-40 transition-opacity duration-200 md:hidden print:hidden",
          pastSummary ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        inert={!pastSummary}
      >
        <Menu
          label="Jump to a section"
          placement="above"
          buttonClassName="min-h-11 min-w-11 rounded-full border-[#1E40AF] bg-[#1E40AF] px-3 text-white shadow-lg hover:bg-[#1E3A8A]"
          button={
            <>
              <ListTree className="h-4 w-4" aria-hidden />
              <span className="sr-only">Sections</span>
            </>
          }
          items={REPORT_SECTIONS.map((s) => ({ key: s.id, label: s.label, onSelect: () => go(s.id) }))}
        />
      </div>
    </>
  );
}

/** One report section: an h2 (visually hidden for the summary) and its anchor for the nav. */
export function ReportSection({
  id,
  title,
  description,
  hideTitle = false,
  children,
}: {
  id: ReportSectionId;
  title?: string;
  description?: ReactNode;
  hideTitle?: boolean;
  children: ReactNode;
}) {
  const meta = REPORT_SECTIONS.find((s) => s.id === id)!;
  return (
    <section
      id={id}
      data-report-section
      aria-labelledby={`${id}-heading`}
      className="min-w-0 scroll-mt-28 space-y-3 md:scroll-mt-36 print:space-y-3"
    >
      <header
        className={cn(
          hideTitle ? "sr-only" : "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 print:break-after-avoid",
        )}
      >
        <h2 id={`${id}-heading`} className={sectionTitle}>
          {title ?? meta.label}
        </h2>
        {description ? <p className="text-[13px] text-slate-600">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}
