import type { QuestionEvaluation, Result, TopicMastery } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtMarks, fmtPct1 } from "../format";
import { chapterLevel, kindCounts } from "../normalize-summary";
import { numeric } from "../summary/tokens";

type Row = { t: TopicMastery; right: number; wrong: number; blank: number; bonus: number };

function rows(result: Result): Row[] {
  const byNumber = new Map(result.question_evaluations.map((q) => [q.question, q]));
  return [...result.topic_mastery]
    .sort(
      (a, b) =>
        a.score / (a.max_marks || 1) - b.score / (b.max_marks || 1) || b.max_marks - a.max_marks || a.topic.localeCompare(b.topic),
    )
    .map((t) => {
      const c = kindCounts(t.questions.map((n) => byNumber.get(n)).filter((q): q is QuestionEvaluation => !!q));
      return { t, right: c.right, wrong: c.wrong + c.zero + c.partial, blank: c.blank, bonus: c.bonus };
    });
}

/** "42 chapters" / "3 subjects" for the fold teaser. */
export function topicTeaser(result: Result): string {
  const n = result.topic_mastery.length;
  const chapters = chapterLevel(result.topic_mastery);
  return `${n} ${chapters ? (n === 1 ? "chapter" : "chapters") : n === 1 ? "subject" : "subjects"}, weakest first`;
}

/** F1: every chapter (or subject) with its score, percentage and right / wrong / blank, weakest first. */
export function TopicTable({ result }: { result: Result }) {
  const list = rows(result);
  const chapters = chapterLevel(result.topic_mastery);
  if (!list.length) return <p className="text-sm text-slate-600">No topic marks were recorded for this result.</p>;
  return (
    <>
      {chapters ? null : (
        <p className="text-[13px] text-slate-600">
          This sheet was graded before chapters were read from the paper, so the rows are its subjects.
        </p>
      )}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">{chapters ? "Chapters" : "Subjects"}, weakest first</caption>
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th scope="col" className="py-2 pr-3 font-medium">{chapters ? "Chapter" : "Subject"}</th>
              {chapters ? <th scope="col" className="py-2 pr-3 font-medium">Subject</th> : null}
              <th scope="col" className="py-2 pr-3 text-right font-medium">Score</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">%</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Right</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Wrong</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Blank</th>
            </tr>
          </thead>
          <tbody>
            {list.map(({ t, right, wrong, blank, bonus }) => (
              <tr key={t.topic} className="border-b border-slate-100">
                <th scope="row" className="py-1.5 pr-3 text-left font-medium text-slate-800">
                  {t.topic}
                  {bonus ? <span className="ml-1 text-xs font-normal text-slate-500">({bonus} bonus)</span> : null}
                </th>
                {chapters ? <td className="py-1.5 pr-3 text-slate-600">{t.subject}</td> : null}
                <td className={cn("py-1.5 pr-3 text-right", numeric)}>
                  {fmtMarks(t.score)}/{fmtMarks(t.max_marks)}
                </td>
                <td className={cn("py-1.5 pr-3 text-right font-medium", numeric)}>{fmtPct1(t.score, t.max_marks)}</td>
                <td className={cn("py-1.5 pr-3 text-right", numeric)}>{right}</td>
                <td className={cn("py-1.5 pr-3 text-right", numeric)}>{wrong}</td>
                <td className={cn("py-1.5 pr-3 text-right", numeric)}>{blank}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 sm:hidden">
        {list.map(({ t, right, wrong, blank, bonus }) => (
          <li key={t.topic} className="rounded-md border border-slate-200 p-2.5 text-[13px]">
            <p className="flex justify-between gap-2">
              <span className="font-medium text-slate-800">{t.topic}</span>
              <span className={numeric}>
                {fmtMarks(t.score)}/{fmtMarks(t.max_marks)} · {fmtPct1(t.score, t.max_marks)}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-slate-600">
              {chapters ? `${t.subject} · ` : ""}
              <span className={numeric}>{right}</span> right · <span className={numeric}>{wrong}</span> wrong ·{" "}
              <span className={numeric}>{blank}</span> blank
              {bonus ? (
                <>
                  {" "}
                  · <span className={numeric}>{bonus}</span> bonus
                </>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}
