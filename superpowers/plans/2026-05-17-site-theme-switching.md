# Site Theme Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a site-wide three-preset theme switcher with `editorial` as the default preset, keep Docusaurus light/dark mode, and persist the user’s preset choice across reloads.

**Architecture:** Centralize preset metadata in one shared module so config, provider, and UI all read the same source of truth. Use a tiny `headTags` bootstrap script for first paint, wrap the app with a site-theme provider through `@theme/Root` for reactive updates, register a custom navbar item type for the preset switcher, and drive the full visual result through semantic CSS variables mapped onto Docusaurus IFM tokens.

**Tech Stack:** Docusaurus 3, React 18, TypeScript, CSS Modules, global CSS custom properties, Node.js validation scripts

---

## File Map

- Create: `scripts/validate-site-theme-switching.mjs`
  Purpose: content contract for shared theme constants, provider/bootstrap wiring, navbar item registration, config markers, and CSS preset selectors.
- Create: `src/lib/siteTheme.ts`
  Purpose: source of truth for preset ids, labels, default preset, storage key, and runtime guard/helper functions.
- Create: `src/components/SiteThemeProvider/index.tsx`
  Purpose: React context provider plus `useSiteTheme()` hook; syncs the current preset to `document.documentElement`.
- Create: `src/components/ThemePresetToggle/index.tsx`
  Purpose: compact navbar control that renders the three presets and updates provider state without reloading the page.
- Create: `src/components/ThemePresetToggle/styles.module.css`
  Purpose: local styles for the navbar toggle in desktop and mobile layouts.
- Create: `src/theme/Root.tsx`
  Purpose: wraps the whole app with `SiteThemeProvider`.
- Create: `src/theme/NavbarItem/ComponentTypes.js`
  Purpose: extends Docusaurus navbar item mapping with one custom item type dedicated to the preset switcher.
- Modify: `docusaurus.config.ts`
  Purpose: injects the early bootstrap script through `headTags` and adds the custom navbar item on the right side.
- Modify: `src/css/custom.css`
  Purpose: defines semantic site tokens, maps them to IFM variables, and keeps the existing homepage/about styles working under all presets.

### Planned Boundaries

- Keep preset data and storage constants in `src/lib/siteTheme.ts`; do not duplicate ids or storage key strings across components.
- Keep stateful theme logic in `SiteThemeProvider`; `ThemePresetToggle` should stay presentational and consume the provider hook.
- Keep Docusaurus navbar integration isolated to `src/theme/NavbarItem/ComponentTypes.js` and `docusaurus.config.ts`; do not bury config-specific branching inside the React components.
- Keep component-local layout styling in `styles.module.css`, but keep global color tokens and page-surface theming in `src/css/custom.css`.

### Reference Spec

- `superpowers/specs/2026-05-17-site-theme-switching-design.md`

### Task 1: Shared theme constants and baseline contract

**Files:**
- Create: `scripts/validate-site-theme-switching.mjs`
- Create: `src/lib/siteTheme.ts`

- [ ] **Step 1: Write the first failing contract for shared theme constants**

```js
const requiredMarkers = {
  'src/lib/siteTheme.ts': [
    "editorial",
    "signal",
    "archive",
    "DEFAULT_SITE_THEME",
    "SITE_THEME_STORAGE_KEY",
    "export const SITE_THEME_PRESETS",
  ],
};
```

- [ ] **Step 2: Run the contract to verify the red state**

Run: `node scripts/validate-site-theme-switching.mjs`  
Expected: FAIL because `src/lib/siteTheme.ts` does not exist yet

- [ ] **Step 3: Create the minimal shared theme module**

```ts
export const SITE_THEME_PRESETS = [
  {id: 'editorial', label: 'Quiet Editorial'},
  {id: 'signal', label: 'Signal Desk'},
  {id: 'archive', label: 'Warm Archive'},
] as const;

export const DEFAULT_SITE_THEME = 'editorial';
export const SITE_THEME_STORAGE_KEY = 'nice-ai-site-theme';
```

Also add:

- a `SiteThemeId` type derived from the preset array
- an `isSiteThemeId(value)` guard
- a `getInitialSiteTheme(value)` helper that falls back to `DEFAULT_SITE_THEME`

- [ ] **Step 4: Re-run the contract to verify the green state**

Run: `node scripts/validate-site-theme-switching.mjs`  
Expected: PASS with a success message for the shared-theme contract

- [ ] **Step 5: Commit**

```bash
git add scripts/validate-site-theme-switching.mjs src/lib/siteTheme.ts
git commit -m "test: add site theme contract"
```

### Task 2: Early preset bootstrap and provider state

**Files:**
- Modify: `scripts/validate-site-theme-switching.mjs`
- Create: `src/components/SiteThemeProvider/index.tsx`
- Create: `src/theme/Root.tsx`
- Modify: `docusaurus.config.ts`

- [ ] **Step 1: Extend the contract with provider and bootstrap markers**

```js
requiredMarkers['src/components/SiteThemeProvider/index.tsx'] = [
  'createContext',
  'useSiteTheme',
  'document.documentElement.setAttribute',
  'SITE_THEME_STORAGE_KEY',
];

requiredMarkers['src/theme/Root.tsx'] = [
  'SiteThemeProvider',
  'children',
];

requiredMarkers['docusaurus.config.ts'] = [
  'headTags',
  'data-site-theme',
  'SITE_THEME_STORAGE_KEY',
  'DEFAULT_SITE_THEME',
];
```

- [ ] **Step 2: Run the contract to verify it fails for the new requirements**

Run: `node scripts/validate-site-theme-switching.mjs`  
Expected: FAIL because provider/root/bootstrap markers are still missing

- [ ] **Step 3: Implement the site-theme provider**

```tsx
const SiteThemeContext = createContext<SiteThemeContextValue | null>(null);

export function SiteThemeProvider({children}: {children: ReactNode}) {
  const [theme, setTheme] = useState<SiteThemeId>(DEFAULT_SITE_THEME);
  // read saved value on the client, sync html[data-site-theme], persist changes
}

export function useSiteTheme() {
  // throw if used outside the provider
}
```

Implementation notes:

- read the stored value only in the browser
- use the shared helper from `src/lib/siteTheme.ts`
- keep `html[data-site-theme]` and storage synchronized whenever `theme` changes
- keep the file focused on context/provider logic only

- [ ] **Step 4: Add the early bootstrap path**

In `docusaurus.config.ts`, inject a small `headTags` inline script that:

- reads `SITE_THEME_STORAGE_KEY`
- validates the stored value against `['editorial', 'signal', 'archive']`
- applies `document.documentElement.setAttribute('data-site-theme', theme)`
- falls back to `DEFAULT_SITE_THEME` inside `try/catch`

Use the standard Docusaurus tag shape instead of ad hoc config fields:

```ts
headTags: [
  {
    tagName: 'script',
    innerHTML: '(function(){/* bootstrap preset here */})()',
  },
],
```

Wrap the app in `src/theme/Root.tsx`:

```tsx
export default function Root({children}: Props): ReactNode {
  return <SiteThemeProvider>{children}</SiteThemeProvider>;
}
```

- [ ] **Step 5: Re-run the contract**

Run: `node scripts/validate-site-theme-switching.mjs`  
Expected: PASS with provider/root/bootstrap markers satisfied

- [ ] **Step 6: Run the build to verify Docusaurus still compiles**

Run: `npm run build`  
Expected: successful production build with no TypeScript or theme-resolution errors

- [ ] **Step 7: Commit**

```bash
git add scripts/validate-site-theme-switching.mjs src/components/SiteThemeProvider/index.tsx src/theme/Root.tsx docusaurus.config.ts
git commit -m "feat: add site theme provider bootstrap"
```

### Task 3: Custom navbar preset switcher

**Files:**
- Modify: `scripts/validate-site-theme-switching.mjs`
- Create: `src/components/ThemePresetToggle/index.tsx`
- Create: `src/components/ThemePresetToggle/styles.module.css`
- Create: `src/theme/NavbarItem/ComponentTypes.js`
- Modify: `docusaurus.config.ts`

- [ ] **Step 1: Extend the contract for navbar item registration**

```js
requiredMarkers['src/theme/NavbarItem/ComponentTypes.js'] = [
  'custom-siteThemePreset',
  'ThemePresetToggle',
];

requiredMarkers['src/components/ThemePresetToggle/index.tsx'] = [
  'useSiteTheme',
  'SITE_THEME_PRESETS',
  'setTheme',
];

requiredMarkers['docusaurus.config.ts'].push(
  "type: 'custom-siteThemePreset'",
  "position: 'right'",
);
```

- [ ] **Step 2: Run the contract to verify the new navbar requirements fail first**

Run: `node scripts/validate-site-theme-switching.mjs`  
Expected: FAIL because the custom navbar component and config item do not exist yet

- [ ] **Step 3: Implement the preset toggle component**

```tsx
export default function ThemePresetToggle(): ReactNode {
  const {theme, setTheme, presets} = useSiteTheme();
  // render 3 options, mark the active one, update provider state on click
}
```

Implementation notes:

- keep the UI compact and docs-like
- render labels from `SITE_THEME_PRESETS`
- ensure the active preset stays visible in desktop and mobile navbar contexts
- keep the component presentational; do not duplicate storage logic here

- [ ] **Step 4: Register the custom navbar item type and add it to config**

In `src/theme/NavbarItem/ComponentTypes.js`, extend the default mapping:

```js
import ComponentTypes from '@theme-original/NavbarItem/ComponentTypes';
import ThemePresetToggle from '@site/src/components/ThemePresetToggle';

export default {
  ...ComponentTypes,
  'custom-siteThemePreset': ThemePresetToggle,
};
```

Then add the config item in `docusaurus.config.ts` on the navbar right side in this order:

1. search
2. `custom-siteThemePreset`
3. GitHub link

This keeps the preset switcher adjacent to global controls without moving the primary navigation links.

- [ ] **Step 5: Re-run the contract**

Run: `node scripts/validate-site-theme-switching.mjs`  
Expected: PASS with the custom navbar type and config markers in place

- [ ] **Step 6: Run the build**

Run: `npm run build`  
Expected: successful production build with the custom navbar item resolved

- [ ] **Step 7: Commit**

```bash
git add scripts/validate-site-theme-switching.mjs src/components/ThemePresetToggle/index.tsx src/components/ThemePresetToggle/styles.module.css src/theme/NavbarItem/ComponentTypes.js docusaurus.config.ts
git commit -m "feat: add navbar theme preset switcher"
```

### Task 4: Global preset tokens and shared dark mode styling

**Files:**
- Modify: `scripts/validate-site-theme-switching.mjs`
- Modify: `src/css/custom.css`
- Modify: `src/components/ThemePresetToggle/styles.module.css`

- [ ] **Step 1: Extend the contract for the CSS token system**

```js
requiredMarkers['src/css/custom.css'] = [
  '--site-bg',
  '--site-surface',
  '--site-text',
  '--site-border',
  '--site-accent',
  "html[data-site-theme='editorial']",
  "html[data-site-theme='signal']",
  "html[data-site-theme='archive']",
  "html[data-theme='dark']",
  '--ifm-background-color',
  '--ifm-color-primary',
];
```

- [ ] **Step 2: Run the contract to verify the CSS requirements fail first**

Run: `node scripts/validate-site-theme-switching.mjs`  
Expected: FAIL because `custom.css` does not yet define the site-theme token system

- [ ] **Step 3: Implement semantic tokens and IFM mappings**

In `src/css/custom.css`, add sections in this order:

1. base semantic tokens
2. `html[data-site-theme='editorial']`
3. `html[data-site-theme='signal']`
4. `html[data-site-theme='archive']`
5. shared `html[data-theme='dark']` overrides
6. IFM variable mapping
7. existing homepage/about rules using the mapped variables

Use a structure like:

```css
:root {
  --site-bg: #f7f1e8;
  --site-surface: #fffaf2;
  --site-text: #2b241f;
}

html[data-site-theme='signal'] {
  --site-bg: #eef5fb;
  --site-accent: #1b6e94;
}

html[data-theme='dark'] {
  --site-bg: #10161d;
  --site-surface: #161f28;
}
```

Implementation notes:

- map semantic tokens into IFM variables instead of hard-coding colors into individual rules
- keep the existing homepage and about page layout rules, but convert any visible colors/borders to the new variables
- style the toggle component states so the active preset is obvious without overpowering the navbar

- [ ] **Step 4: Re-run the contract**

Run: `node scripts/validate-site-theme-switching.mjs`  
Expected: PASS with preset selectors and IFM token mappings present

- [ ] **Step 5: Run the build**

Run: `npm run build`  
Expected: successful production build with no CSS/theme regression errors

- [ ] **Step 6: Commit**

```bash
git add scripts/validate-site-theme-switching.mjs src/css/custom.css src/components/ThemePresetToggle/styles.module.css
git commit -m "feat: apply site theme presets globally"
```

### Task 5: End-to-end verification and regression sweep

**Files:**
- Verify only: `scripts/validate-site-theme-switching.mjs`
- Verify only: `src/lib/siteTheme.ts`
- Verify only: `src/components/SiteThemeProvider/index.tsx`
- Verify only: `src/components/ThemePresetToggle/index.tsx`
- Verify only: `src/theme/NavbarItem/ComponentTypes.js`
- Verify only: `src/theme/Root.tsx`
- Verify only: `docusaurus.config.ts`
- Verify only: `src/css/custom.css`

- [ ] **Step 1: Run the full contract one more time**

Run: `node scripts/validate-site-theme-switching.mjs`  
Expected: PASS

- [ ] **Step 2: Run the production build**

Run: `npm run build`  
Expected: PASS with a successful Docusaurus build

- [ ] **Step 3: Start the local dev server for manual verification**

Run: `npm run start`  
Expected: local dev server starts and prints the local site URL; with the current config it should serve the site under the `nice-ai-agent-study-resources` base path

- [ ] **Step 4: Manually verify the core routes and interactions**

Check all of the following:

- homepage route switches among all 3 presets without a reload
- refresh preserves the selected preset
- one resource page (for example `resources/hello-agents/`) inherits the active preset
- one note/doc page inherits the active preset
- Docusaurus light/dark toggle does not reset the selected preset
- dark mode uses one shared dark base instead of 3 separate dark palettes
- mobile navbar layout still exposes the preset switcher and the active state is visible
- first paint does not visibly flash back to the default preset after a refresh

- [ ] **Step 5: Fix any regression found during the manual pass and re-run the checks**

Run again after each fix:

- `node scripts/validate-site-theme-switching.mjs`
- `npm run build`

- [ ] **Step 6: Commit the verified feature**

```bash
git add scripts/validate-site-theme-switching.mjs src/lib/siteTheme.ts src/components/SiteThemeProvider/index.tsx src/components/ThemePresetToggle/index.tsx src/components/ThemePresetToggle/styles.module.css src/theme/NavbarItem/ComponentTypes.js src/theme/Root.tsx docusaurus.config.ts src/css/custom.css
git commit -m "feat: add site theme switching"
```
