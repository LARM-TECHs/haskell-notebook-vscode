// ════════════════════════════════════════════════════════════════════════════
// GHCI OUTPUT FORMATTER
//
// Aplica syntax highlighting al output de GHCi usando highlight.js.
// El HTML resultante es autocontenido (CSS inline) y compatible con
// el sandbox de VS Code Notebook (sin recursos externos).
// ════════════════════════════════════════════════════════════════════════════

import hljs from 'highlight.js/lib/core';
import haskell from 'highlight.js/lib/languages/haskell';

hljs.registerLanguage('haskell', haskell);

// ── CSS mínimo para las clases hljs ──────────────────────────────────────
// Paleta alineada con el tema Dark+ de VS Code para máxima coherencia visual
const HLJS_CSS = `
.hljs-output {
  font-family : var(--vscode-editor-font-family, 'Cascadia Code', monospace);
  font-size   : var(--vscode-editor-font-size, 13px);
  line-height : 1.6;
  padding     : 8px 12px;
  margin      : 0;
  white-space : pre-wrap;
  word-break  : break-word;
  color       : var(--vscode-editor-foreground, #d4d4d4);
  background  : transparent;
}
.hljs-keyword    { color: #569cd6; }
.hljs-type       { color: #4ec9b0; }
.hljs-string     { color: #ce9178; }
.hljs-number     { color: #b5cea8; }
.hljs-comment    { color: #6a9955; font-style: italic; }
.hljs-built_in   { color: #dcdcaa; }
.hljs-operator   { color: #d4d4d4; }
.hljs-punctuation{ color: #d4d4d4; }
.hljs-title      { color: #dcdcaa; }
.hljs-variable   { color: #9cdcfe; }
.hljs-params     { color: #9cdcfe; }
.hljs-literal    { color: #569cd6; }
.hljs-meta       { color: #c586c0; }
`.trim();

// ════════════════════════════════════════════════════════════════════════════
// API PÚBLICA
// ════════════════════════════════════════════════════════════════════════════

/**
 * Convierte el output de GHCi en HTML con syntax highlighting.
 * Si el output está vacío devuelve cadena vacía (celda sin output visible).
 */
export function formatGhciOutput(raw: string): string {
    if (!raw.trim()) { return ''; }

    let highlighted: string;
    try {
        const result = hljs.highlight(raw, { language: 'haskell', ignoreIllegals: true });
        highlighted = result.value;
    } catch {
        // Fallback: escapar HTML sin colorear
        highlighted = escHtml(raw);
    }

    return `<style>${HLJS_CSS}</style><pre class="hljs-output">${highlighted}</pre>`;
}

// ────────────────────────────────────────────────────────────────────────────
function escHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}