// The mark inside the app icon, as SVG.
//
// THE SAME PATH AND THE SAME PLACEMENT as `resources/icon.svg`, viewBox
// included, so a swatch in the picker is the real icon's proportions rather
// than an approximation that reads slightly wrong beside the Dock. The plate
// is not drawn here — the caller paints it as a background, which is what lets
// one element carry a gradient colorway.
//
// `currentColor`, so the mark follows the `color` of whatever renders it.

/** Taken verbatim from `resources/icon.svg`; the transform positions it in the 1024 box. */
const MARK_TRANSFORM = 'translate(299.24 310.40) scale(1.59971)';
const MARK_PATH =
  'M109.74 3.01Q133 -3.01 156.26 3.01L154.29 40.71L184 11Q200.66 15.89 214 27L171.15 '
  + '69.85L254.01 73.81Q262.66 89.44 266 107L173.52 102.81L257.72 189.27Q253.31 205.52 242 '
  + '218L152.55 128.55L148.58 270.99Q133 275.01 117.42 270.99L113.45 128.55L24 218Q12.69 '
  + '205.52 8.28 189.27L92.48 102.81L0 107Q3.34 89.44 11.99 73.81L94.85 69.85L52 27Q65.34 '
  + '15.89 82 11L111.71 40.71L109.74 3.01Z';

export function AppIconMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden focusable="false">
      <g transform={MARK_TRANSFORM}>
        <path fill="currentColor" d={MARK_PATH} />
      </g>
    </svg>
  );
}
