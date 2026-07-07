# Architecture And Source Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six concrete notes for AI Agent Book, OpenClaw, and Claude Code Architecture, then wire them into the notes indexes and sidebar.

**Architecture:** Keep the current resource structure and extend each of the three resources with two short topic-driven notes. Each note answers one hard question: either what reading path matters first or what patterns are worth extracting into real project judgment. Then update the matching `notes/index.md` pages and sidebar note lists so the new pieces appear in a deliberate reading order.

**Tech Stack:** Markdown docs, Docusaurus docs sidebar config, npm build verification

---

### Task 1: Add AI Agent Book note pair

**Files:**
- Create: `docs/resources/ai-agent-book/notes/which-questions-have-to-enter-your-head-first.md`
- Create: `docs/resources/ai-agent-book/notes/which-patterns-are-worth-using-now-and-which-should-wait.md`
- Modify: `docs/resources/ai-agent-book/notes/index.md`

- [x] **Step 1: Add the first AI Agent Book note**
- [x] **Step 2: Add the second AI Agent Book note**
- [x] **Step 3: Update the AI Agent Book notes index with the new reading order**

### Task 2: Add OpenClaw note pair

**Files:**
- Create: `docs/resources/openclaw-book/notes/if-i-only-follow-one-line-i-follow-gateway-to-runtime.md`
- Create: `docs/resources/openclaw-book/notes/which-implementations-are-worth-extracting-into-general-patterns.md`
- Modify: `docs/resources/openclaw-book/notes/index.md`

- [x] **Step 1: Add the first OpenClaw note**
- [x] **Step 2: Add the second OpenClaw note**
- [x] **Step 3: Update the OpenClaw notes index with the new reading order**

### Task 3: Add Claude Code Architecture note pair

**Files:**
- Create: `docs/resources/claude-code-architecture/notes/which-layers-are-most-worth-reusing-as-a-framework.md`
- Create: `docs/resources/claude-code-architecture/notes/why-queryengine-permissions-compaction-and-telemetry-are-the-real-product-divide.md`
- Modify: `docs/resources/claude-code-architecture/notes/index.md`

- [x] **Step 1: Add the first Claude Code Architecture note**
- [x] **Step 2: Add the second Claude Code Architecture note**
- [x] **Step 3: Update the Claude Code Architecture notes index with the new reading order**

### Task 4: Wire new note pages into the sidebar

**Files:**
- Modify: `sidebars.ts`

- [x] **Step 1: Add the new AI Agent Book note ids**
- [x] **Step 2: Add the new OpenClaw note ids**
- [x] **Step 3: Add the new Claude Code Architecture note ids**

### Task 5: Verify docs build behavior

**Files:**
- Verify only: `docs/resources/**`, `sidebars.ts`

- [x] **Step 1: Run a Docusaurus build into a fresh output directory**
- [x] **Step 2: Check whether the new note routes were generated**
- [x] **Step 3: Report the verified result, distinguishing content success from any Windows file-lock cleanup failure**
