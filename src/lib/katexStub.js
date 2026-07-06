// Stub for the `katex` package (~264KB). No Mermaid diagram in this site uses
// math syntax ($$...$$ or $...$), verified: zero matches across all docs. The
// real katex is dynamically imported by mermaid only on the math-rendering
// code path, which is never reached here. This stub satisfies webpack's
// resolution of `import("katex")` so the heavy package is excluded from the
// bundle, while exposing the API surface mermaid expects.
function renderToString() {
  return '';
}
function render() {
  // no-op: math rendering is unused on this site
}
const katex = { renderToString, render };
export default katex;
export { renderToString, render };
