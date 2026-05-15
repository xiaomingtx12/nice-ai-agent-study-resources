# Site Entry Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the home page, about page, and resources hub into stronger entry pages that support a hybrid "judge first, deep read second" browsing flow.

**Architecture:** Keep the existing Docusaurus docs tree and resource detail pages intact, but move shared entry-page summaries into a small React data/component layer. Use MDX docs pages for the three top-level entry pages and add one lightweight content-contract script plus a full site build for verification.

**Tech Stack:** Docusaurus 3, React 18, TypeScript, MDX, custom CSS, Node.js assertions

---

### Task 1: Create the plan artifact and red-state content contract

**Files:**
- Create: `docs/superpowers/plans/2026-05-15-site-entry-redesign.md`
- Create: `scripts/validate-page-redesign.mjs`

- [ ] **Step 1: Write the failing content-contract script**

```js
const requiredMarkers = {
  'docs/index.mdx': ['landing-hero', 'site-route', 'home-collection'],
  'docs/about/index.mdx': ['about-hero', 'belief-grid', 'focus-stack'],
  'docs/resources/index.mdx': ['resource-hub-shell', '<ResourceHub entries={resourceEntries} />'],
};
```

- [ ] **Step 2: Run script to verify it fails**

Run: `node scripts/validate-page-redesign.mjs`
Expected: FAIL because the MDX pages and component markers do not exist yet

### Task 2: Build shared resource-summary primitives

**Files:**
- Create: `src/components/siteData.ts`
- Create: `src/components/ResourceHub.tsx`

- [ ] **Step 1: Add the shared resource summary dataset**

```ts
export const resourceEntries = [
  {
    title: 'HelloAgents',
    overview: '...',
    critique: '...',
    notes: '...',
  },
];
```

- [ ] **Step 2: Add the expandable resource hub component**

```tsx
export function ResourceHub() {
  return (
    <div className="resource-hub">
      <details>
        <summary>...</summary>
      </details>
    </div>
  );
}
```

- [ ] **Step 3: Re-run content contract**

Run: `node scripts/validate-page-redesign.mjs`
Expected: Still FAIL because the three entry pages are not implemented yet

### Task 3: Rebuild the three entry pages as MDX landing pages

**Files:**
- Delete: `docs/index.md`
- Create: `docs/index.mdx`
- Delete: `docs/about/index.md`
- Create: `docs/about/index.mdx`
- Delete: `docs/resources/index.md`
- Create: `docs/resources/index.mdx`

- [ ] **Step 1: Rebuild home page structure**

```mdx
<section className="landing-hero">...</section>
<section className="site-route">...</section>
<section className="home-collection">...</section>
```

- [ ] **Step 2: Rebuild about page structure**

```mdx
<section className="about-hero">...</section>
<section className="belief-grid">...</section>
<section className="focus-stack">...</section>
```

- [ ] **Step 3: Rebuild resources hub structure**

```mdx
<section className="resource-hub-shell">
  <ResourceHub entries={resourceEntries} />
</section>
```

- [ ] **Step 4: Re-run content contract**

Run: `node scripts/validate-page-redesign.mjs`
Expected: PASS

### Task 4: Add the visual system and verify the site build

**Files:**
- Modify: `src/css/custom.css`

- [ ] **Step 1: Add landing and hub page styles**

```css
.landing-hero { ... }
.resource-card { ... }
.belief-grid { ... }
```

- [ ] **Step 2: Run content contract after styling**

Run: `node scripts/validate-page-redesign.mjs`
Expected: PASS

- [ ] **Step 3: Run the full site build**

Run: `npm run build`
Expected: exit code 0 with a successful Docusaurus production build
