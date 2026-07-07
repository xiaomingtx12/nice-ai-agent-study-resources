# Homepage Conservative Refresh Design

**Date:** 2026-05-16

## Goal

Keep the homepage as a docs-style entry page, but make it faster to scan and easier to route from. The page should explain the site's purpose quickly, split readers by intent, and summarize the current collection without reading like a long prose note.

## Constraints

- Only change the homepage content and homepage-scoped styling.
- Keep `docs/index.md` as Markdown instead of rebuilding the page as an MDX landing page.
- Do not change routes, sidebar behavior, or the structure of other entry pages.
- Avoid heavy cards, gradients, marketing-hero composition, or componentized homepage sections.

## Homepage Responsibilities

The refreshed homepage should do three jobs:

1. Explain what this site is in a few seconds.
2. Help readers choose the right entry path immediately.
3. Establish the site's judgment-heavy writing style without expanding into full resource commentary.

## Information Architecture

The page will be reorganized into four sections:

1. **Opening Position**
   - One direct headline and short lead paragraph.
   - Reframe the site as a judgment-first resource library rather than a link collection.
2. **Where To Go Now**
   - Three entry paths for readers with different intent:
     - find the right resource first
     - already started a resource and want notes/reviews
     - care more about AI application teardown than resource reviews
3. **How The Collection Is Grouped**
   - Replace the flat seven-item list with grouped summaries.
   - Groups:
     - learning path and onboarding
     - coding agent and harness analysis
     - production architecture and real systems
4. **Writing Principles**
   - Keep the current editorial tone, but compress it into three short principles.

## Content Strategy

- Reuse the judgments already present in the current homepage instead of inventing a new voice.
- Remove repeated guidance that currently appears in both the "what is here" and "how to use" sections.
- Shift from explanation-heavy paragraphs toward scannable short paragraphs and grouped lists.
- Keep each section focused on one job only.

## Visual Strategy

- Use spacing, section dividers, list density, and narrow text measures to create hierarchy.
- Introduce lightweight homepage-only section wrappers in Markdown HTML for targeted styling.
- Make the route section read like a clear entry list, not like a generic bullet dump.
- Present grouped resources as compact blocks with short summaries.
- Tighten spacing and line length on mobile to reduce the "wall of text" effect.

## Non-Goals

- No custom React components.
- No MDX-first landing page treatment.
- No redesign of `about`, `resources`, or other entry pages.
- No new information model for the whole site.

## Verification

- Add a small content-contract script that checks the expected homepage section markers and homepage CSS hooks.
- Run the contract script before implementation to confirm it fails.
- Run the contract script after implementation to confirm it passes.
- Run `npm run build` to verify the Docusaurus site still builds successfully.
