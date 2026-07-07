# Agent 开发平台主线文档加深 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the new `agent-development-platform` mainline docs so readers can understand the platform from the mainline alone, without needing to open the appendix for core implementation evidence.

**Architecture:** Pull concrete code snippets, state boundaries, and flow diagrams from the old deep-dive docs and implementation appendix, then inline the highest-signal evidence into each mainline doc. Each core mainline doc should end up with at least one execution diagram and one or more real code examples that prove the document’s main claims.

**Tech Stack:** Docusaurus docs, Markdown, Mermaid, fenced code blocks

---

### Task 1: Enrich overview and foundation docs with concrete architecture evidence

**Files:**
- Modify: `docs/application-notes/agent-development-platform/platform-definition-and-overview.md`
- Modify: `docs/application-notes/agent-development-platform/configuration-assets-and-platform-foundation.md`

- [ ] **Step 1: Add a platform assembly flow diagram to the overview**
- [ ] **Step 2: Inline the real runtime assembly code from the old overview into the new overview**
- [ ] **Step 3: Add concrete `App` / draft config / publish snapshot code to the foundation doc**
- [ ] **Step 4: Add an asset lifecycle diagram showing draft, validate, publish, and run**

### Task 2: Enrich runtime, tools, and knowledge docs with mainline implementation evidence

**Files:**
- Modify: `docs/application-notes/agent-development-platform/agent-runtime-and-memory.md`
- Modify: `docs/application-notes/agent-development-platform/tools-and-external-capabilities.md`
- Modify: `docs/application-notes/agent-development-platform/knowledge-base-and-retrieval-pipeline.md`

- [ ] **Step 1: Add the Agent LangGraph skeleton, event queue code, and memory injection snippet**
- [ ] **Step 2: Add a runtime flow diagram showing request -> config -> memory -> llm -> tools -> events**
- [ ] **Step 3: Add concrete tool abstraction snippets for API Tool, MCP Tool, and unified tool assembly**
- [ ] **Step 4: Add concrete knowledge pipeline snippets for document creation, segment splitting, hybrid retrieval, and retrieval tool reuse**

### Task 3: Enrich workflow, governance, and scenario docs with diagrams and code

**Files:**
- Modify: `docs/application-notes/agent-development-platform/workflow-orchestration-engine.md`
- Modify: `docs/application-notes/agent-development-platform/release-governance-and-async-execution.md`
- Modify: `docs/application-notes/agent-development-platform/scenario-templates-and-build-order.md`

- [ ] **Step 1: Add workflow DSL -> draft -> validate -> publish -> tool reuse diagram**
- [ ] **Step 2: Inline workflow args schema, draft/publish gate, and conditional edge compilation snippets**
- [ ] **Step 3: Add governance code for publish snapshot, published-entry checks, and model/API-key runtime loading**
- [ ] **Step 4: Add a phased build-order diagram and concrete “minimum assembly” code to the scenario doc**

### Task 4: Verify the docs are now self-contained

**Files:**
- Verify: `docs/application-notes/agent-development-platform/*.md`

- [ ] **Step 1: Confirm each core doc includes at least one Mermaid or flow diagram**

Run: `rg -n "```mermaid|flowchart|sequenceDiagram" docs/application-notes/agent-development-platform/*.md`

- [ ] **Step 2: Confirm each core implementation doc includes real code snippets**

Run: `rg -n "```python" docs/application-notes/agent-development-platform/*.md`

- [ ] **Step 3: Run static cross-checks for new files**

Run: `Get-ChildItem docs/application-notes/agent-development-platform -Filter *.md`

- [ ] **Step 4: Attempt Docusaurus build or explain the environment blocker**

Run: `npx docusaurus build --out-dir build-codex-check-20260516-agent-platform-deepen`
Expected: either success or a clearly documented environment permission failure unrelated to doc IDs
