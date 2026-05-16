# Agent 开发平台文档重组 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the current Dify-flavored application notes into a clearer `Agent 开发平台` documentation category with a numbered mainline, implementation appendix, and archive.

**Architecture:** Create a new `agent-development-platform` docs directory as the single public entry, move the current deep-dive directories underneath it as `implementation-appendix` and `archive`, then author a new mainline set of docs that explains the platform in build order rather than by borrowed product naming. Update the application-notes landing page and sidebar IDs to point at the new structure.

**Tech Stack:** Docusaurus docs, Markdown, JSON category metadata, TypeScript sidebar config

---

### Task 1: Create the new docs structure and relocate old material

**Files:**
- Create: `docs/application-notes/agent-development-platform/_category_.json`
- Create: `docs/application-notes/agent-development-platform/index.md`
- Move: `docs/application-notes/dify准备文档` -> `docs/application-notes/agent-development-platform/implementation-appendix`
- Move: `docs/application-notes/diyf-type-application-bac` -> `docs/application-notes/agent-development-platform/archive`
- Retire: `docs/application-notes/dify-type-application`

- [ ] **Step 1: Confirm the current source directories and target names**

Run: `Get-ChildItem -Directory docs\application-notes`
Expected: three source directories are present and no `agent-development-platform` directory exists yet

- [ ] **Step 2: Create the new root category directory and metadata**

Write:
- `docs/application-notes/agent-development-platform/_category_.json`
- a new category label for `Agent 开发平台`

Validation: `Test-Path docs\application-notes\agent-development-platform\_category_.json`

- [ ] **Step 3: Move the implementation-heavy prep docs under the new appendix path**

Run a safe move so the whole directory tree becomes:
- `docs/application-notes/agent-development-platform/implementation-appendix/`

Validation: `Get-ChildItem -Directory docs\application-notes\agent-development-platform`

- [ ] **Step 4: Move the historical backup docs under the new archive path**

Run a safe move so the whole directory tree becomes:
- `docs/application-notes/agent-development-platform/archive/`

Validation: `Get-ChildItem -Directory docs\application-notes\agent-development-platform`

### Task 2: Author the new mainline docs

**Files:**
- Create: `docs/application-notes/agent-development-platform/platform-definition-and-overview.md`
- Create: `docs/application-notes/agent-development-platform/configuration-assets-and-platform-foundation.md`
- Create: `docs/application-notes/agent-development-platform/agent-runtime-and-memory.md`
- Create: `docs/application-notes/agent-development-platform/tools-and-external-capabilities.md`
- Create: `docs/application-notes/agent-development-platform/knowledge-base-and-retrieval-pipeline.md`
- Create: `docs/application-notes/agent-development-platform/workflow-orchestration-engine.md`
- Create: `docs/application-notes/agent-development-platform/release-governance-and-async-execution.md`
- Create: `docs/application-notes/agent-development-platform/scenario-templates-and-build-order.md`
- Create: `docs/application-notes/agent-development-platform/how-to-write-useful-agent-platform-note.md`

- [ ] **Step 1: Write the category index**

Cover:
- what this category is
- recommended reading order
- distinction between mainline, appendix, and archive

Validation: `rg -n "主线|附录|归档" docs\application-notes\agent-development-platform\index.md`

- [ ] **Step 2: Write the first four mainline docs**

Author:
- overview
- foundation
- runtime and memory
- tools

Each doc must include:
- the business problem it solves
- the business/process flow
- the engineering decomposition
- how it supports hand-built implementation

Validation: `rg -n "^## " docs\application-notes\agent-development-platform\platform-definition-and-overview.md docs\application-notes\agent-development-platform\configuration-assets-and-platform-foundation.md docs\application-notes\agent-development-platform\agent-runtime-and-memory.md docs\application-notes\agent-development-platform\tools-and-external-capabilities.md`

- [ ] **Step 3: Write the remaining mainline docs**

Author:
- knowledge base and retrieval
- workflow engine
- governance and async execution
- scenario templates and build order
- writing standard

Validation: `rg -n "^## " docs\application-notes\agent-development-platform\knowledge-base-and-retrieval-pipeline.md docs\application-notes\agent-development-platform\workflow-orchestration-engine.md docs\application-notes\agent-development-platform\release-governance-and-async-execution.md docs\application-notes\agent-development-platform\scenario-templates-and-build-order.md docs\application-notes\agent-development-platform\how-to-write-useful-agent-platform-note.md`

### Task 3: Rewire entry pages and sidebar navigation

**Files:**
- Modify: `docs/application-notes/index.md`
- Modify: `sidebars.ts`

- [ ] **Step 1: Update the application-notes landing page**

Replace the old `Dify 型平台拆解` entry with the new `Agent 开发平台` entry and keep the page framing aligned with the new category.

Validation: `rg -n "Agent 开发平台|Dify 型平台拆解" docs\application-notes\index.md`

- [ ] **Step 2: Replace the old sidebar group with the new structure**

Sidebar structure should expose:
- category homepage
- numbered mainline docs
- writing standard
- implementation appendix group
- archive group

Validation: `rg -n "agent-development-platform|implementation-appendix|archive" sidebars.ts`

- [ ] **Step 3: Remove references to the retired public `dify-type-application` doc IDs**

Search and patch any remaining repo references that would break Docusaurus resolution.

Validation: `rg -n "dify-type-application" docs sidebars.ts`
Expected: only intentional historical mentions remain in content, not active doc IDs for navigation

### Task 4: Verify the docs build and navigation integrity

**Files:**
- Verify: `docs/application-notes/**`
- Verify: `sidebars.ts`

- [ ] **Step 1: Run a structure sanity check**

Run: `Get-ChildItem -Recurse docs\application-notes\agent-development-platform`
Expected: mainline docs, appendix tree, and archive tree all exist

- [ ] **Step 2: Run the Docusaurus build**

Run: `npm run build`
Expected: build succeeds without broken doc ID errors

- [ ] **Step 3: Review the git diff for accidental regressions**

Run: `git diff -- docs/application-notes sidebars.ts`
Expected: changes are limited to the new category, landing page, and sidebar rewiring

- [ ] **Step 4: Commit**

```bash
git add docs/application-notes docs/superpowers/plans/2026-05-16-agent-platform-docs-restructure.md sidebars.ts
git commit -m "docs: restructure application notes as agent platform guide"
```
