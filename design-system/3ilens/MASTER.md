# 3iLens design system

What the app actually uses. Keep this file by hand and in step with the code; do not regenerate it.

## Where the values live

- **Tailwind tokens:** the `@theme` block in `frontend/src/app/globals.css` (`brand-*` colours, `font-sans`, `font-mono`) is the source for every utility class.
- **Literal mirrors** that must change with it: `COLOR` in `frontend/src/components/report/summary/tokens.ts`, `SERIES` in `frontend/src/components/charts/core.tsx`, and the PDF palette at the top of `backend/reports.py` (Python cannot read the CSS).

## Palette

| Role | Value | Token / use |
|---|---|---|
| Navy | `#1e3a8a` | `brand-navy`: headings, primary action buttons, headline ink |
| Navy 700 | `#1e40af` | `brand-navy-700` and `brand-cyan-600` (same value): text links, focus rings and measures (the first chart series; "navy" in `tokens.ts`, `core.tsx` and the PDF) |
| Blue (accent) | `#2563eb` | `brand-cyan` (the name is older than the colour): the single interactive accent; tint `brand-cyan-50` `#eff6ff` |
| Light blue | `#3b82f6` | second chart series |
| Amber | `#d97706` | needs review; chart targets and highlights only. Amber text on white uses `#b45309` (4.5:1) |
| Red | `#dc2626` | failure, at risk, wrong answers (always with a hatch or glyph, never colour alone) |
| Lime | `#a0d84e`, `#7fb52f`, `#f3fae8` | `brand-lime`, `-600`, `-50`: positive data only |
| Page / text | `#f8fafc` / `#1e293b` | page background (slate-50) and body text (slate-800); muted text is slate-500 |

## Type

- **Fira Sans** (`font-sans`) for all text, headings included; **Fira Code** (`font-mono`, tabular figures) for scores and table numbers. Both load through `next/font` in `frontend/src/app/layout.tsx`.
- Body 14 px, line height 1.5. Inputs are 16 px below 640 px wide (iOS zooms smaller fields).

## Surfaces

- Panels: `bg-white`, `border border-slate-200`, `rounded-md`, no shadow. Tags and chips: `rounded-sm`. Shadows only on popovers, menus and dialogs.
- One flat, data-dense style: KPI strips, dense tables, small rectangular status tags. Icons from `lucide-react`, never emoji.
- Charts: series hues in the order navy 700, light blue, amber, never cycled.

## Rules

- Text contrast at least 4.5:1.
- Visible focus: 2 px `#1e40af` outline with a 2 px offset (`:focus-visible` in `globals.css`).
- `prefers-reduced-motion` turns animations and transitions off (`globals.css`).
- No horizontal scroll at 390 px.
