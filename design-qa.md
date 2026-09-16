# Panel tab trailing-fade visual QA

- Source visual truth:
  - `/var/folders/z7/jxg1pvs10w3b_y54z0_bvs500000gp/T/TemporaryItems/NSIRD_screencaptureui_UV7l8G/Screenshot 2026-09-16 at 11.17.03 AM.png`
  - `/var/folders/z7/jxg1pvs10w3b_y54z0_bvs500000gp/T/TemporaryItems/NSIRD_screencaptureui_lI96t3/Screenshot 2026-09-16 at 11.17.51 AM.png`
  - `/var/folders/z7/jxg1pvs10w3b_y54z0_bvs500000gp/T/TemporaryItems/NSIRD_screencaptureui_vLb4iF/Screenshot 2026-09-16 at 11.40.07 AM.png`
  - `/var/folders/z7/jxg1pvs10w3b_y54z0_bvs500000gp/T/TemporaryItems/NSIRD_screencaptureui_GZLNwK/Screenshot 2026-09-16 at 11.44.17 AM.png`
- Implementation screenshots:
  - Corrected rest: `/private/tmp/relayed-panel-tabs-surface-rest.png`
  - Corrected rest crop: `/private/tmp/relayed-panel-tabs-surface-rest-crop.png`
  - Stronger hover/focus treatment: `/private/tmp/relayed-panel-tabs-steep-hover.png`
  - Stronger hover/focus crop: `/private/tmp/relayed-panel-tabs-steep-hover-crop.png`
- Viewport: Relayed desktop window at 1188 × 768 px.
- Source pixels: 1682 × 96 px and 1424 × 106 px; implementation pixels: 1188 × 768 px.
- Density normalization: the source strips and the live implementation were compared at their captured pixel densities. Exact browser-tab dimensions were not scored because the source is interaction guidance for Relayed's existing panel-tab component, not a full-size layout target.
- State: dark theme. The latest focused comparison uses the user's hovered-tab reference and a live capture with the exact hover classes temporarily forced on the selected tab.

## Full-view comparison evidence

The live Relayed window shows the interaction inside the real panel container. The resting fade now resolves to the panel-strip background, so it removes overflowing glyphs without showing a differently colored patch. Hover or keyboard focus changes both the tab and fade to the exact same blended muted surface, then widens the fade beneath the close control without changing layout.

## Focused comparison evidence

The latest supplied hovered-tab reference and the corrected live hover crop were viewed together. The fade now reaches a fully opaque surface beneath the entire close-button footprint, so the trailing glyph no longer competes with the ×. The close mark remains overlaid without reserving layout space.

## Required fidelity surfaces

- Fonts and typography: existing Geist tab typography, weight, line height, and truncation are unchanged. Trailing glyphs fade before the overlaid close mark instead of competing with it.
- Spacing and layout rhythm: tab height, resting width, icon-label gap, selected pill, neighboring-tab positions, and plus-control position remain stable between rest and hover.
- Colors and visual tokens: an inactive fade ends in the exact panel background. A selected or hovered fade ends in the same opaque color mix used by the tab surface: 50% muted and 50% background. On hover/focus, the surface remains fully opaque through 65% of the 2rem fade before falling to transparent, placing the entire close control over a clean surface.
- Image quality and asset fidelity: the existing icon component is preserved; no raster assets or substitute artwork were introduced.
- Copy and content: unchanged.

## Findings

No actionable P0, P1, or P2 mismatch remains for the requested trailing-fade interaction.

## Comparison history

- Earlier implementation: the close control animated from zero width to 16 px. That removed the resting gap but expanded the hovered tab and shifted adjacent tabs.
- First fix: positioned the close control absolutely at the trailing edge and changed the transition to opacity only. This removed movement, but trailing text remained visually tangled with the icon.
- Second fix: added an absolute, clipped end fade that is narrow at rest and widens behind the close control on hover or focus. The icon became legible, but the fade always used the muted color, leaving a dark patch on inactive tabs.
- Current fix: made the tab and fade share one state-derived surface color. Inactive fades use the strip background; selected, hovered, and focus-within tabs use one identical muted/background blend.
- Post-fix evidence: `/private/tmp/relayed-panel-tabs-surface-rest-crop.png` shows the inactive trailing fade merging into the strip without a visible color boundary.
- Hover-strength fix: the expanded fade now keeps the solid surface through 65% of its width, then transitions over the final 35%. `/private/tmp/relayed-panel-tabs-steep-hover-crop.png` shows the × isolated from the trailing label.
- Motion adjustment: the fade width now switches immediately between rest and hover/focus. Only the close icon's opacity still transitions; no gradient expansion is animated.

## Follow-up polish

None required for this scoped interaction.

final result: passed
