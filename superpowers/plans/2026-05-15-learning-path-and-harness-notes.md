# Learning Path And Harness Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six concrete, non-generic learning notes for the HelloAgents, AI Agents From Zero, and Learn Claude Code resources, then wire them into the notes indexes and sidebar.

**Architecture:** Keep the existing resource structure intact and extend each resource with two focused note pages that answer one hard question each. Update the corresponding `notes/index.md` files to surface the new pieces in a deliberate reading order, then extend `sidebars.ts` so the new note pages appear in navigation without changing the larger category layout.

**Tech Stack:** Markdown docs, Docusaurus docs sidebar config, npm build verification

---

### Task 1: Add HelloAgents note pair

**Files:**
- Create: `docs/resources/hello-agents/notes/which-modules-are-worth-reading-first.md`
- Create: `docs/resources/hello-agents/notes/how-to-check-whether-you-learned-more-than-vocabulary.md`
- Modify: `docs/resources/hello-agents/notes/index.md`

- [x] **Step 1: Add the first HelloAgents note**
- [x] **Step 2: Add the second HelloAgents note**
- [x] **Step 3: Update the HelloAgents notes index with the new reading order**

### Task 2: Add AI Agents From Zero note pair

**Files:**
- Create: `docs/resources/ai-agents-from-zero/notes/which-projects-are-worth-doing-first.md`
- Create: `docs/resources/ai-agents-from-zero/notes/which-parts-of-workflow-mcp-and-rag-are-portable.md`
- Modify: `docs/resources/ai-agents-from-zero/notes/index.md`

- [x] **Step 1: Add the first AI Agents From Zero note**
- [x] **Step 2: Add the second AI Agents From Zero note**
- [x] **Step 3: Update the AI Agents From Zero notes index with the new reading order**

### Task 3: Add Learn Claude Code note pair

**Files:**
- Create: `docs/resources/learn-claude-code/notes/what-in-s01-to-s06-is-the-real-backbone.md`
- Create: `docs/resources/learn-claude-code/notes/which-runtime-mechanisms-i-would-steal-first.md`
- Modify: `docs/resources/learn-claude-code/notes/index.md`

- [x] **Step 1: Add the first Learn Claude Code note**
- [x] **Step 2: Add the second Learn Claude Code note**
- [x] **Step 3: Update the Learn Claude Code notes index with the new reading order**

### Task 4: Wire new note pages into the sidebar

**Files:**
- Modify: `sidebars.ts`

- [x] **Step 1: Add the new HelloAgents note ids**
- [x] **Step 2: Add the new AI Agents From Zero note ids**
- [x] **Step 3: Add the new Learn Claude Code note ids**

### Task 5: Verify docs build behavior

**Files:**
- Verify only: `docs/resources/**`, `sidebars.ts`

- [x] **Step 1: Run a Docusaurus build into a fresh output directory**
- [x] **Step 2: Check whether the new note routes were generated**
- [x] **Step 3: Report the verified result, distinguishing content success from any Windows file-lock cleanup failure**
