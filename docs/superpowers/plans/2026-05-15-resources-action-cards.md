# Resources Action Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen the resources landing page by adding a concrete 30-minute start action and two high-value note links to each resource card.

**Architecture:** Keep the current map-first resources page structure intact and only enrich the role cards in `docs/resources/index.md`. Each resource card gets two new slots: one immediate start action and one pair of note links that expose already-written takeaways instead of only pointing people deeper generically.

**Tech Stack:** Markdown docs, Docusaurus build verification

---

### Task 1: Enrich the resource cards with action slots

**Files:**
- Modify: `docs/resources/index.md`

- [x] **Step 1: Add a 30-minute start action to each resource card**
- [x] **Step 2: Add two selected note links to each resource card**

### Task 2: Verify docs build behavior

**Files:**
- Verify only: `docs/resources/index.md`

- [x] **Step 1: Run a Docusaurus build into a fresh output directory**
- [x] **Step 2: Check whether the resources route was generated**
- [x] **Step 3: Report the verified result, distinguishing content success from any Windows file-lock cleanup failure**
