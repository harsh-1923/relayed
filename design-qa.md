# Composer visual QA

- Source visual truth: `/var/folders/z7/jxg1pvs10w3b_y54z0_bvs500000gp/T/TemporaryItems/NSIRD_screencaptureui_wE6THq/Screenshot 2026-09-13 at 9.03.46 PM.png`
- Implementation: Relayed desktop chat composer
- Source dimensions: 1636 × 318 pixels
- Intended state: dark theme, idle composer with text
- Density normalization: unavailable because the running Electron surface could not be captured
- Implementation screenshot: unavailable
- Viewport: unavailable

## Full-view comparison evidence

The source image was opened at original resolution. It shows a wide, low-chrome card with a large writing area, strongly rounded corners, a left and right footer group, muted secondary controls, and a circular high-contrast send action. The implementation maps those visible regions and controls onto the existing Tiptap composer. Computer-use permission for the running Relayed Electron client was denied, so there is no valid browser-rendered implementation capture to compare.

## Focused-region comparison evidence

The source composer region was inspected directly. A valid implementation crop could not be captured, so typography, exact spacing, icon optical weight, token colors, and corner geometry remain visually unverified.

## Findings

- P2 — Rendered fidelity is unverified. The source is available and the production build succeeds, but the implementation could not be captured from the running desktop client. A same-state screenshot is required to judge and correct remaining visual drift.

## Comparison history

- Initial implementation: introduced the two-zone layout, generous editor height, reference-style footer groups, muted auxiliary actions, model and voice affordances, and circular upward send action.
- Post-fix visual evidence: blocked because access to both available Relayed Electron surfaces was denied.

## Required fidelity surfaces

- Fonts and typography: Geist remains the product font and approximates the source; rendered size and weight are unverified.
- Spacing and layout rhythm: source proportions were translated into the component; rendered alignment is unverified.
- Colors and visual tokens: existing `card`, `foreground`, `muted-foreground`, `accent`, and `border` tokens are used; rendered contrast is unverified.
- Image and asset fidelity: the source contains no raster assets; all controls use the existing Relayed icon library.
- Copy and content: footer copy follows the supplied reference as placeholder UI, as requested.

## Implementation checklist

- Capture the running Relayed composer in dark mode at a comparable width.
- Compare it directly with the source image.
- Correct any P0, P1, or P2 typography, spacing, color, icon, or geometry differences.

final result: blocked
