"use client";

import { type Domain, Empty, extremes, fmt, Plot, Text, textWidth, tipBody, useChart } from "./core";

// Sequential cyan ramp, light to dark.
const LIGHT = [0xcd, 0xee, 0xf4];
const DARK = [0x03, 0x5e, 0x70];
const ramp = (t: number) => `rgb(${LIGHT.map((a, i) => Math.round(a + (DARK[i] - a) * t)).join(",")})`;

const CELL = 40;

export function HeatStrip({
  cells,
  domain,
  format = (v) => fmt(v),
}: {
  cells: { label: string; value: number }[];
  domain?: Domain;
  format?: (v: number) => string;
}) {
  const c = useChart();
  if (!cells.length) return <Empty />;
  const values = cells.map((d) => d.value);
  const [lo, hi] = domain ?? [Math.min(...values), Math.max(...values)];
  // Phones get several rows rather than cells too narrow to label.
  const perRow = c.w ? Math.max(1, Math.min(cells.length, Math.floor(c.w / 64))) : cells.length;
  const cw = c.w / perRow;
  const rowH = CELL + 40;
  return (
    <Plot
      chart={c}
      h={Math.ceil(cells.length / perRow) * rowH - 6}
      label={`Heat strip of ${cells.length} cells. ${extremes(cells, format)}`}
    >
      {cells.map((d, i) => {
        const t = Math.min(1, Math.max(0, (d.value - lo) / (hi - lo || 1)));
        const text = format(d.value);
        const x = (i % perRow) * cw;
        const y = Math.floor(i / perRow) * rowH;
        return (
          <g key={i} {...c.mark(tipBody(d.label, [["Value", text]]))}>
            <rect x={x} y={y} width={cw} height={rowH - 6} fill="transparent" />
            <rect x={x + 1} y={y} width={Math.max(cw - 2, 1)} height={CELL} rx={2} fill={ramp(t)} />
            {textWidth(text) + 8 <= cw - 2 && (
              <text
                x={x + cw / 2}
                y={y + CELL / 2}
                dy="0.32em"
                textAnchor="middle"
                fontWeight={500}
                fill={t >= 0.7 ? "#fff" : "#0f172a"}
              >
                {text}
              </text>
            )}
            <Text x={x + cw / 2} y={y + CELL + 14} width={cw - 4} text={d.label} />
          </g>
        );
      })}
    </Plot>
  );
}
