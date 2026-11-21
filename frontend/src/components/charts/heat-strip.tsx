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
  const cw = c.w / cells.length;
  return (
    <Plot chart={c} h={CELL + 34} label={`Heat strip of ${cells.length} cells. ${extremes(cells, format)}`}>
      {cells.map((d, i) => {
        const t = Math.min(1, Math.max(0, (d.value - lo) / (hi - lo || 1)));
        const text = format(d.value);
        const cx = (i + 0.5) * cw;
        return (
          <g key={i} {...c.mark(tipBody(d.label, [["Value", text]]))}>
            <rect x={i * cw} width={cw} height={CELL + 34} fill="transparent" />
            <rect x={i * cw + 1} width={Math.max(cw - 2, 1)} height={CELL} rx={2} fill={ramp(t)} />
            {textWidth(text) + 8 <= cw - 2 && (
              <text x={cx} y={CELL / 2} dy="0.32em" textAnchor="middle" fontWeight={500} fill={t >= 0.7 ? "#fff" : "#0f172a"}>
                {text}
              </text>
            )}
            <Text x={cx} y={CELL + 14} width={cw - 4} text={d.label} />
          </g>
        );
      })}
    </Plot>
  );
}
