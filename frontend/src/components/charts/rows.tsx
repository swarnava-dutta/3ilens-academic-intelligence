"use client";

import {
  AXIS,
  bar,
  CONTEXT,
  CRITICAL,
  delta,
  type Domain,
  Empty,
  fmt,
  INK,
  Legend,
  nice,
  Plot,
  scale,
  SERIES,
  Text,
  textWidth,
  tickCount,
  tipBody,
  useChart,
  VGrid,
} from "./core";

/** One labelled row per item over a shared x axis. Narrow containers put the label above the mark. */
function layout(w: number, labels: string[], domain: Domain) {
  const narrow = w < 480;
  const labelW = narrow ? 0 : Math.min(200, w * 0.35, Math.max(...labels.map(textWidth)) + 8);
  const rowH = narrow ? 42 : 32;
  const x0 = narrow ? 12 : labelW + 16;
  const x1 = w - 20;
  return {
    narrow,
    labelW,
    rowH,
    x0,
    x1,
    x: scale(domain, [x0, x1]),
    h: labels.length * rowH + 22,
    cy: (i: number) => i * rowH + (narrow ? 25 : rowH / 2),
  };
}

type Layout = ReturnType<typeof layout>;

function Axis({ L, domain, unit, n }: { L: Layout; domain: Domain; unit?: string; n: number }) {
  return <VGrid x={L.x} domain={domain} y0={0} y1={L.h - 22} unit={unit} n={Math.min(n, tickCount(L.x1 - L.x0))} />;
}

function RowLabel({ L, i, text }: { L: Layout; i: number; text: string }) {
  return L.narrow ? (
    <Text x={0} y={i * L.rowH + 12} width={L.x1} text={text} anchor="start" max={1} fill={INK} />
  ) : (
    <Text x={L.labelW} y={L.cy(i)} dy="0.32em" width={L.labelW} text={text} anchor="end" max={1} fill={INK} />
  );
}

/** Full-width transparent row so the whole row is the hover/focus target. */
const Hit = ({ L, i, w }: { L: Layout; i: number; w: number }) => (
  <rect y={i * L.rowH} width={w} height={L.rowH} fill="transparent" />
);

export function Dumbbell({
  rows,
  aLabel,
  bLabel,
  domain,
  unit,
}: {
  rows: { label: string; a: number; b: number }[];
  aLabel: string;
  bLabel: string;
  domain: Domain;
  unit?: string;
}) {
  const c = useChart();
  if (!rows.length) return <Empty />;
  const L = layout(c.w, rows.map((r) => r.label), domain);
  const widest = rows.reduce((m, r) => (Math.abs(r.a - r.b) > Math.abs(m.a - m.b) ? r : m));
  return (
    <div className="space-y-2">
      <Legend items={[{ label: aLabel, color: SERIES[0] }, { label: bLabel, color: CONTEXT }]} />
      <Plot
        chart={c}
        h={L.h}
        label={`${aLabel} against ${bLabel} for ${rows.length} rows. Widest gap: ${widest.label}, ${fmt(widest.a, unit)} against ${fmt(widest.b, unit)}.`}
      >
        <Axis L={L} domain={domain} unit={unit} n={5} />
        {rows.map((r, i) => {
          const y = L.cy(i);
          const tip = tipBody(r.label, [
            [aLabel, fmt(r.a, unit), SERIES[0]],
            [bLabel, fmt(r.b, unit), CONTEXT],
            ["Difference", delta(r.a - r.b, unit)],
          ]);
          return (
            <g key={i} {...c.mark(tip)}>
              <Hit L={L} i={i} w={c.w} />
              <RowLabel L={L} i={i} text={r.label} />
              <line x1={L.x(r.a)} x2={L.x(r.b)} y1={y} y2={y} stroke={CONTEXT} strokeWidth={2} />
              <circle cx={L.x(r.b)} cy={y} r={5.5} fill={CONTEXT} stroke="#fff" strokeWidth={2} />
              <circle cx={L.x(r.a)} cy={y} r={5.5} fill={SERIES[0]} stroke="#fff" strokeWidth={2} />
            </g>
          );
        })}
      </Plot>
    </div>
  );
}

export function Waterfall({
  start,
  steps,
  endLabel,
  unit,
}: {
  start: { label: string; value: number };
  steps: { label: string; value: number }[];
  endLabel: string;
  unit?: string;
}) {
  const c = useChart();
  if (!steps.length) return <Empty />;
  const bars = [{ label: start.label, from: 0, to: start.value, color: CONTEXT, note: fmt(start.value, unit), step: false }];
  let run = start.value;
  for (const s of steps) {
    bars.push({
      label: s.label,
      from: run,
      to: run + s.value,
      color: s.value < 0 ? CRITICAL : SERIES[0],
      note: delta(s.value, unit),
      step: true,
    });
    run += s.value;
  }
  bars.push({ label: endLabel, from: 0, to: run, color: CONTEXT, note: fmt(run, unit), step: false });
  const ends = bars.map((b) => b.to);
  const domain = nice(Math.min(0, ...ends), Math.max(0, ...ends));
  const L = layout(c.w, bars.map((b) => b.label), domain);
  return (
    <Plot
      chart={c}
      h={L.h}
      label={`Waterfall from ${start.label} ${fmt(start.value, unit)} to ${endLabel} ${fmt(run, unit)} over ${steps.length} steps.`}
    >
      <Axis L={L} domain={domain} unit={unit} n={5} />
      {bars.map((b, i) => {
        const y = L.cy(i);
        const lo = L.x(Math.min(b.from, b.to));
        const hi = L.x(Math.max(b.from, b.to));
        const right = hi + 6 + textWidth(b.note) <= c.w;
        return (
          <g key={i} {...c.mark(tipBody(b.label, b.step ? [["Change", b.note], ["Running total", fmt(b.to, unit)]] : [["Total", b.note]]))}>
            <Hit L={L} i={i} w={c.w} />
            <RowLabel L={L} i={i} text={b.label} />
            <path d={bar(lo, y - 6, Math.max(hi - lo, 1), 12, b.to < b.from ? "left" : "right")} fill={b.color} />
            <text x={right ? hi + 6 : lo - 6} y={y} dy="0.32em" textAnchor={right ? "start" : "end"} fill={INK} fontWeight={500}>
              {b.note}
            </text>
            {i < bars.length - 1 && !L.narrow && (
              <line x1={L.x(b.to)} x2={L.x(b.to)} y1={y + 6} y2={L.cy(i + 1) - 6} stroke={AXIS} strokeDasharray="2 2" />
            )}
          </g>
        );
      })}
    </Plot>
  );
}

export function StackedBars({
  rows,
  seriesOrder,
  unit,
  rest,
}: {
  rows: { label: string; segments: { name: string; value: number }[] }[];
  seriesOrder: string[];
  unit?: string;
  /** Name of a catch-all series, drawn in the context grey. */
  rest?: string;
}) {
  const c = useChart();
  if (!rows.length) return <Empty />;
  const names = seriesOrder.slice(0, 3);
  const color = (k: number) => (names[k] === rest ? CONTEXT : SERIES[k]);
  const stacks = rows.map((r) => {
    const segs: { name: string; color: string; value: number; from: number; to: number }[] = [];
    let acc = 0;
    for (const [k, name] of names.entries()) {
      const value = r.segments.find((s) => s.name === name)?.value ?? 0;
      if (value <= 0) continue;
      segs.push({ name, color: color(k), value, from: acc, to: acc + value });
      acc += value;
    }
    return { label: r.label, segs, total: acc };
  });
  const domain = nice(0, Math.max(...stacks.map((s) => s.total)));
  const L = layout(c.w, rows.map((r) => r.label), domain);
  return (
    <div className="space-y-2">
      <Legend items={names.map((label, k) => ({ label, color: color(k) }))} />
      <Plot chart={c} h={L.h} label={`Stacked bars of ${names.join(", ")} for ${rows.length} rows.`}>
        <Axis L={L} domain={domain} unit={unit} n={5} />
        {stacks.map((r, i) => {
          const y = L.cy(i);
          const tip = tipBody(r.label, [
            ...r.segs.map((s): [string, string, string] => [s.name, fmt(s.value, unit), s.color]),
            ["Total", fmt(r.total, unit)],
          ]);
          return (
            <g key={i} {...c.mark(tip)}>
              <Hit L={L} i={i} w={c.w} />
              <RowLabel L={L} i={i} text={r.label} />
              {r.segs.map((s, k) => {
                const last = k === r.segs.length - 1;
                const x = L.x(s.from);
                return (
                  <path
                    key={s.name}
                    d={bar(x, y - 6, L.x(s.to) - x - (last ? 0 : 2), 12, last ? "right" : undefined)}
                    fill={s.color}
                  />
                );
              })}
            </g>
          );
        })}
      </Plot>
    </div>
  );
}
