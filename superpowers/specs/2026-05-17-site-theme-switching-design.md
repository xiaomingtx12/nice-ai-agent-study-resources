# Site Theme Switching Design

**Date:** 2026-05-17

## Goal

Add a site-wide theme preset switcher to the Docusaurus site so readers can switch among three distinct visual themes without breaking the existing docs-first structure. The default preset should be **Quiet Editorial**, and the site should continue to support Docusaurus light/dark mode with one shared dark-mode foundation.

## Confirmed Product Decisions

- Scope is **site-wide**, not homepage-only.
- Provide **three** user-selectable theme presets:
  - `editorial` as the default
  - `signal`
  - `archive`
- Keep Docusaurus `light / dark` color mode support.
- Do **not** create a separate dark palette for each preset.
- In dark mode, use one shared dark foundation and allow only light preset-specific identity through accent-level variables if needed.
- Persist the user’s preset choice across reloads.
- Place the preset switcher in the navbar on the right side near existing global controls.

## Constraints

- Preserve the existing docs-first architecture and current routes.
- Reuse Docusaurus color mode behavior instead of replacing it with a custom mode system.
- Avoid heavy theme infrastructure or a large settings panel.
- Keep preset switching instant and client-side only; no page reloads.
- Minimize first-paint theme flash when the page initializes.

## Architecture

The theme system should be split into two orthogonal layers:

1. **Site preset**
   - Managed by custom client-side state.
   - Stored as a semantic preset id: `editorial`, `signal`, or `archive`.
   - Applied to the root `html` element via a `data-site-theme` attribute.

2. **Color mode**
   - Continues to be managed by Docusaurus.
   - Exposed through the existing `data-theme="light|dark"` attribute behavior.

This separation keeps the site preset stable while still allowing users to toggle light/dark mode independently. The effective styling becomes:

- `light + editorial`
- `light + signal`
- `light + archive`
- `dark + any preset` using one shared dark base with optional accent differences

## File-Level Design

### 1. Root integration

Create [`src/theme/Root.tsx`](D:/repos/nice-ai-agent-study-resources/src/theme/Root.tsx) to wrap the app with a lightweight site-theme provider and ensure the preset attribute is attached at the top level as early as possible.

Responsibilities:

- Read the saved preset on the client.
- Apply `data-site-theme` to `document.documentElement`.
- Provide theme state to child UI components.
- Reduce initial flash back to the default preset during hydration.

If `Root.tsx` alone still applies too late to avoid a visible flash, the implementation plan may choose a smaller earlier bootstrap hook for the initial attribute write. The requirement is early application of the saved preset, not strict attachment to one specific hook.

### 2. Theme state provider

Create [`src/components/SiteThemeProvider/index.tsx`](D:/repos/nice-ai-agent-study-resources/src/components/SiteThemeProvider/index.tsx).

Responsibilities:

- Own the current preset state.
- Read and write a stable `localStorage` key.
- Expose `theme`, `setTheme`, and preset metadata to the toggle UI.
- Keep `html[data-site-theme]` synchronized whenever the preset changes.

The provider should treat `editorial` as the fallback whenever storage is empty or invalid. The storage key should be explicitly centralized so future migrations do not require searching through multiple files.

### 3. Navbar preset switcher

Create [`src/components/ThemePresetToggle/index.tsx`](D:/repos/nice-ai-agent-study-resources/src/components/ThemePresetToggle/index.tsx) as a small UI component, and register it through [`src/theme/NavbarItem/ComponentTypes.js`](D:/repos/nice-ai-agent-study-resources/src/theme/NavbarItem/ComponentTypes.js).

Responsibilities:

- Render a compact navbar control for the three presets.
- Work in both desktop and collapsed mobile navbar layouts.
- Apply changes immediately without reload.
- Clearly indicate the currently active preset.

The UI should stay compact and docs-like. A lightweight dropdown or segmented control is acceptable; a large modal or settings drawer is out of scope.

### 4. Config wiring

Update [`docusaurus.config.ts`](D:/repos/nice-ai-agent-study-resources/docusaurus.config.ts) to add a custom navbar item for the preset switcher. The item should live on the right side with the existing search and GitHub controls.

The config should reference one dedicated custom navbar item type rather than embedding ad hoc logic directly in config.

### 5. Styling system

Extend [`src/css/custom.css`](D:/repos/nice-ai-agent-study-resources/src/css/custom.css) from page-specific styling into a two-layer variable system:

- **Semantic site variables**
  - Examples: `--site-bg`, `--site-surface`, `--site-text`, `--site-muted`, `--site-border`, `--site-accent`, `--site-accent-strong`
- **Mapped framework variables**
  - Map semantic variables into Docusaurus / IFM variables such as:
    - `--ifm-background-color`
    - `--ifm-font-color-base`
    - `--ifm-heading-color`
    - `--ifm-color-primary`
    - `--ifm-navbar-background-color`
    - `--ifm-code-background`

This keeps preset logic centralized while allowing existing homepage and doc styles to inherit the active theme naturally.

## Visual Direction

### Default preset: Quiet Editorial

The default preset should feel like a marked-up reading desk or research notebook:

- paper-leaning background
- restrained ink-like text
- warm border and accent values
- strong readability over product-like shine

### Additional presets

- **Signal**
  - More technical and analytic
  - Higher contrast
  - Dark blue / cyan-leaning accents in light mode
- **Archive**
  - Warm indexed-library feeling
  - Soft archival paper tones with slightly olive support accents

### Dark mode

Dark mode should use a single shared base across all presets:

- unified dark background and surface system
- consistent contrast rules
- no full three-way dark palette split
- optional preset-specific accent/link variance only if it improves recognition without increasing maintenance cost

## UI Behavior

- Default first visit: `editorial + light`
- If a saved preset exists, restore it on load.
- Switching presets should:
  - update the navbar control state
  - update `html[data-site-theme]`
  - persist the value to storage
  - avoid full-page reload
- Toggling Docusaurus dark mode should not overwrite the saved preset.
- Invalid stored values should gracefully reset to `editorial`.

## Styling Coverage

The preset system should visibly cover the highest-signal parts of the site:

- navbar
- page background
- doc content background and text
- headings
- links
- section dividers and borders
- buttons and accent surfaces
- code blocks / inline code backgrounds where practical
- homepage route/group blocks already styled in `custom.css`

The search plugin should remain visually compatible, but redesigning its internal UI is not required for this iteration.

## Accessibility and UX Notes

- Theme names should be understandable in the switcher UI.
- The active preset must remain obvious in both desktop and mobile navigation.
- Contrast should remain readable in all three light presets and the shared dark mode.
- Preset switching should feel immediate and stable, not animated in a distracting way.

## Non-Goals

- No homepage-only skinning.
- No per-preset custom dark themes.
- No full visual redesign of search internals.
- No preference sync across devices or accounts.
- No large theme gallery, preview panel, or settings page.

## Verification

Add a small contract script first so the feature has a red-green check before the full build.

### Contract expectations

Create a validation script that checks at least:

- the preset list contains exactly `editorial`, `signal`, and `archive`
- the custom navbar component is registered
- the config includes the custom navbar theme item

### Verification flow

1. Write the contract script and run it before implementation to confirm it fails.
2. Implement the preset provider, navbar switcher, config wiring, and CSS variable system.
3. Re-run the contract script and confirm it passes.
4. Run `npm run build`.
5. Manually verify:
   - homepage
   - one resource index page
   - one regular note/doc page
   - desktop navbar
   - mobile navbar drawer
   - light/dark mode combined with each preset
   - first load behavior for flash/regression

## Risks and Mitigations

- **Risk:** Theme flash on first paint
  - **Mitigation:** Apply the saved preset at the root as early as possible through the root wrapper/provider path.
- **Risk:** Docusaurus default variables only partially follow custom preset values
  - **Mitigation:** Map site semantic variables deliberately into the key IFM variables that control navbar, typography, code, and surfaces.
- **Risk:** Navbar integration becomes brittle on mobile
  - **Mitigation:** Keep the custom item small and aligned with Docusaurus navbar item patterns instead of introducing a one-off overlay.
- **Risk:** Presets become hard to maintain if variables are copied around
  - **Mitigation:** Centralize theme tokens and avoid per-component hard-coded colors where possible.
