# Homepage Conservative Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the homepage so it works as a clearer, lighter-weight entry page without changing the site's docs-first architecture.

**Architecture:** Keep the homepage in `docs/index.md`, but reorganize it into four scoped sections wrapped with lightweight HTML hooks. Add homepage-only CSS in `src/css/custom.css`, plus one small Node content-contract script that gives this docs/CSS change a red-green verification loop before the full build.

**Tech Stack:** Docusaurus 3, Markdown, custom CSS, Node.js assertions

---

### Task 1: Add the red-state homepage contract

**Files:**
- Create: `scripts/validate-homepage-conservative-refresh.mjs`

- [ ] **Step 1: Write the failing contract script**

```js
const docMarkers = ['home-lead', 'home-route-list', 'home-library-groups', 'home-principles'];
const cssMarkers = ['.home-lead', '.home-route-list', '.home-library-groups', '.home-principles'];
```

- [ ] **Step 2: Run the contract to verify it fails**

Run: `node scripts/validate-homepage-conservative-refresh.mjs`
Expected: FAIL because the homepage markers and homepage CSS hooks do not exist yet

### Task 2: Restructure the homepage content

**Files:**
- Modify: `docs/index.md`

- [ ] **Step 1: Replace the prose-first structure with four explicit homepage sections**

```md
<section class="home-lead">...</section>
## 你现在该去哪
<section class="home-route-list">...</section>
## 当前收录怎么分
<section class="home-library-groups">...</section>
## 这个站怎么写
<section class="home-principles">...</section>
```

- [ ] **Step 2: Keep the same voice, but compress repeated guidance**

Expected result: the homepage reads like an entry page, not like a long site note

### Task 3: Add homepage-only visual hierarchy

**Files:**
- Modify: `src/css/custom.css`

- [ ] **Step 1: Add homepage-scoped styles for the four section hooks**

```css
html[class~='docs-doc-id-index'] .home-lead { ... }
html[class~='docs-doc-id-index'] .home-route-list { ... }
html[class~='docs-doc-id-index'] .home-library-groups { ... }
html[class~='docs-doc-id-index'] .home-principles { ... }
```

- [ ] **Step 2: Keep styling restrained and docs-like**

Expected result: stronger hierarchy without cards, gradients, or landing-page chrome

### Task 4: Verify the refresh end to end

**Files:**
- Verify only: `scripts/validate-homepage-conservative-refresh.mjs`
- Verify only: `docs/index.md`
- Verify only: `src/css/custom.css`

- [ ] **Step 1: Re-run the contract after implementation**

Run: `node scripts/validate-homepage-conservative-refresh.mjs`
Expected: PASS

- [ ] **Step 2: Run the full site build**

Run: `npm run build`
Expected: exit code 0 with a successful Docusaurus production build
