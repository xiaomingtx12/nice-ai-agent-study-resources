// Stub for @mermaid-js/layout-elk. The real package (~500KB ELK engine) is
// intentionally not installed — no Mermaid diagram in this site uses ELK
// layout (verified: zero `layout: elk` directives across all docs). This
// module exists so webpack can resolve theme-mermaid's dynamic import() in
// loadMermaid.js without bundling the heavy engine.
//
// At runtime, the guarded `if (__DOCUSAURUS_MERMAID_LAYOUT_ELK_ENABLED__)`
// branch is dead code: the flag is false because theme-mermaid's
// isElkLayoutPackageAvailable() runs in Node (which cannot resolve the bare
// specifier either) and returns false. So this stub is never actually
// executed — it only satisfies webpack's static resolution.
export default undefined;
