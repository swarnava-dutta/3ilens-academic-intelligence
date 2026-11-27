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
  // Long lists get small cells with the label inside and the value in the tooltip.
  const dense = cells.length > 40;
  const cellH = dense ? 24 : CELL;
  // Phones get several rows rather than cells too narrow to label.
  const perRow = c.w ? Math.max(1, Math.min(cells.length, Math.floor(c.w / (dense ? 40 : 64)))) : cells.length;
  const cw = c.w / perRow;
  const rowH = dense ? cellH + 2 : CELL + 40;
  return (
    <Plot
      chart={c}
      h={Math.ceil(cells.length / perRow) * rowH - (dense ? 2 : 6)}
      label={`Heat strip of ${cells.length} cells. ${extremes(cells, format)}`}
    >
      {cells.map((d, i) => {
        const t = Math.min(1, Math.max(0, (d.value - lo) / (hi - lo || 1)));
        const text = format(d.value);
        const inside = dense ? d.label : text;
        const x = (i % perRow) * cw;
        const y = Math.floor(i / perRow) * rowH;
        return (
          <g key={i} {...c.mark(tipBody(d.label, [["Value", text]]))}>
            <rect x={x} y={y} width={cw} height={rowH} fill="transparent" />
            <rect x={x + 1} y={y} width={Math.max(cw - 2, 1)} height={cellH} rx={2} fill={ramp(t)} />
            {textWidth(inside) + 8 <= cw - 2 && (
              <text
                x={x + cw / 2}
                y={y + cellH / 2}
                dy="0.32em"
                textAnchor="middle"
                fontWeight={500}
                fill={t >= 0.7 ? "#fff" : "#0f172a"}
              >
                {inside}
              </text>
            )}
            {!dense && <Text x={x + cw / 2} y={y + CELL + 14} width={cw - 4} text={d.label} />}
          </g>
        );
      })}
    </Plot>
  );
}
