# Resources Cognitive Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the resources landing page into a stronger cognitive map with a learning map, route guidance, decision table, and memory-oriented resource cards.

**Architecture:** Keep the current docs tree and sidebar layout intact, but rewrite the content structure of `docs/resources/index.md` so it works like a map instead of a prose-heavy intro page. Add one small homepage wording sync in `docs/index.md`, then verify the generated routes and build behavior.

**Tech Stack:** Markdown/MDX docs, Mermaid, Docusaurus build verification

---

### Task 1: Rebuild the resources landing page structure

**Files:**
- Modify: `docs/resources/index.md`

- [x] **Step 1: Add the top-level learning map section**
- [x] **Step 2: Add the common reading-route diagram**
- [x] **Step 3: Add the "which resource to start with" decision table**
- [x] **Step 4: Rewrite resource summaries into memory-oriented cards**

### Task 2: Sync homepage wording

**Files:**
- Modify: `docs/index.md`

- [x] **Step 1: Update the resources-nav description to reflect the new map-first role**

### Task 3: Verify docs build behavior

**Files:**
- Verify only: `docs/resources/index.md`, `docs/index.md`

- [x] **Step 1: Run a Docusaurus build into a fresh output directory**
- [x] **Step 2: Check whether the rewritten resources route was generated**
- [x] **Step 3: Report the verified result, distinguishing content success from any Windows file-lock cleanup failure**
