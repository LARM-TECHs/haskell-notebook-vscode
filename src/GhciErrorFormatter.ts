// ════════════════════════════════════════════════════════════════════════════
// GHCI ERROR FORMATTER
//
// Parsea el output de error de GHCi y produce HTML formateado.
//
// Formatos soportados:
//   <interactive>:LINE:COL: error:
//   <interactive>:LINE:COL-COLEND: error:
//   <interactive>:LINE:COL: warning: [-Wflag]
//   <interactive>:LINE:COL: parse error (...)
//   *** Exception: mensaje
// ════════════════════════════════════════════════════════════════════════════

export type GhciErrorKind = 'error' | 'warning' | 'exception';

export interface ParsedGhciError {
    kind: GhciErrorKind;
    line: number;
    col: number;
    colEnd: number | null;
    flag: string | null;
    body: string;
    raw: string;
}

// ════════════════════════════════════════════════════════════════════════════
// PARSER
// ════════════════════════════════════════════════════════════════════════════

// Sólo la primera línea: <interactive>:LINE:COL[-END]: KIND [FLAG]:
const HEADER_RE =
    /^<interactive>:(\d+):(\d+)(?:-(\d+))?\s*:\s*(error|warning|parse error)(?:\s*\[(.*?)\])?\s*:?\s*(.*)/;

const EXCEPTION_RE = /^\*\*\* Exception:\s*(.*)/;

export function parseGhciError(raw: string): ParsedGhciError | null {

    const lines = raw.split('\n');
    const firstLine = lines[0] ?? '';

    // ── Caso 1: <interactive>:… ──────────────────────────────────────────────
    const m = firstLine.match(HEADER_RE);
    if (m) {
        const [, lineStr, colStr, colEndStr, kindStr, flag, inlineRest] = m;
        const kind: GhciErrorKind = kindStr === 'warning' ? 'warning' : 'error';

        // El cuerpo puede empezar en la misma línea del header (inlineRest)
        // o en las líneas siguientes (lines[1..])
        const bodyParts = [
            (inlineRest ?? '').trim(),
            lines.slice(1).join('\n').trimEnd(),
        ].filter(Boolean);

        return {
            kind,
            line: parseInt(lineStr, 10),
            col: parseInt(colStr, 10),
            colEnd: colEndStr ? parseInt(colEndStr, 10) : null,
            flag: flag?.trim() ?? null,
            body: bodyParts.join('\n').trim(),
            raw,
        };
    }

    // ── Caso 2: *** Exception ────────────────────────────────────────────────
    const ex = firstLine.match(EXCEPTION_RE);
    if (ex) {
        const rest = lines.slice(1).join('\n').trimEnd();
        const body = [ex[1].trim(), rest].filter(Boolean).join('\n');
        return {
            kind: 'exception',
            line: 0,
            col: 0,
            colEnd: null,
            flag: null,
            body,
            raw,
        };
    }

    // ── Caso 3: error genérico ────────────────────────────────────────────────
    if (firstLine.trimStart().startsWith('error:')) {
        return {
            kind: 'error',
            line: 0,
            col: 0,
            colEnd: null,
            flag: null,
            body: raw.slice(raw.indexOf('error:') + 'error:'.length).trim(),
            raw,
        };
    }

    return null;
}

// ════════════════════════════════════════════════════════════════════════════
// RENDERER HTML
// ════════════════════════════════════════════════════════════════════════════

/**
 * Convierte el output de error de GHCi en HTML formateado.
 * Si no puede parsear el formato, devuelve el texto en un bloque pre simple.
 */
export function formatGhciError(raw: string): string {
    const blocks = splitErrors(raw);
    const parsed = blocks.map(parseGhciError);

    if (parsed.every(e => e === null)) {
        return wrapFallback(raw);
    }

    return parsed.map(e => e ? renderError(e) : '').join('');
}

// ── Divide un output con múltiples errores en bloques individuales ────────
function splitErrors(raw: string): string[] {
    // Cada nuevo error empieza con <interactive>: o *** Exception
    const boundary = /(?=<interactive>:|\*\*\* Exception:)/g;
    const parts = raw.split(boundary).map(s => s.trim()).filter(Boolean);
    return parts.length ? parts : [raw];
}

// ── HTML de un error parseado ─────────────────────────────────────────────
function renderError(e: ParsedGhciError): string {
    const colors: Record<GhciErrorKind, { badge: string; border: string; text: string }> = {
        error: { badge: '#f44747', border: '#f4474740', text: '#f44747' },
        warning: { badge: '#cca700', border: '#cca70040', text: '#cca700' },
        exception: { badge: '#f44747', border: '#f4474740', text: '#f44747' },
    };
    const c = colors[e.kind];

    const kindLabel = e.kind === 'exception' ? 'Exception' :
        e.kind === 'warning' ? 'Warning' : 'Error';

    const locationStr = e.line
        ? `line ${e.line}, col ${e.col}${e.colEnd ? `\u2013${e.colEnd}` : ''}`
        : '';

    const flagBadge = e.flag
        ? `<span style="
        margin-left:8px;
        font-size:11px;
        padding:1px 6px;
        border-radius:3px;
        background:${c.badge}22;
        color:${c.text};
        font-family:var(--vscode-editor-font-family,monospace);
      ">${escHtml(e.flag)}</span>`
        : '';

    const locationBadge = locationStr
        ? `<span style="
        margin-left:auto;
        font-size:11px;
        opacity:0.75;
        font-family:var(--vscode-editor-font-family,monospace);
      ">${escHtml(locationStr)}</span>`
        : '';

    const bodyHtml = e.body
        ? `<pre style="
        margin:0;
        padding:8px 12px;
        font-size:12px;
        font-family:var(--vscode-editor-font-family,monospace);
        white-space:pre-wrap;
        word-break:break-word;
        line-height:1.5;
        color:var(--vscode-editor-foreground);
        border-top:1px solid ${c.border};
      ">${escHtml(e.body)}</pre>`
        : '';

    return `
<div style="
  margin:4px 0;
  border:1px solid ${c.border};
  border-left:3px solid ${c.badge};
  border-radius:4px;
  overflow:hidden;
  background:var(--vscode-editor-background);
  font-family:var(--vscode-font-family,sans-serif);
">
  <div style="
    display:flex;
    align-items:center;
    gap:6px;
    padding:6px 12px;
    background:${c.badge}18;
  ">
    <span style="
      font-size:11px;
      font-weight:700;
      letter-spacing:.04em;
      color:${c.text};
      text-transform:uppercase;
    ">${kindLabel}</span>
    ${flagBadge}
    ${locationBadge}
  </div>
  ${bodyHtml}
</div>`.trim();
}

// ── Fallback para output no parseado ─────────────────────────────────────
function wrapFallback(raw: string): string {
    return `
<pre style="
  margin:4px 0;
  padding:8px 12px;
  border:1px solid var(--vscode-inputValidation-errorBorder,#f44747);
  border-left:3px solid var(--vscode-inputValidation-errorBorder,#f44747);
  border-radius:4px;
  font-size:12px;
  font-family:var(--vscode-editor-font-family,monospace);
  white-space:pre-wrap;
  word-break:break-word;
  color:var(--vscode-editor-foreground);
  background:var(--vscode-editor-background);
">${escHtml(raw)}</pre>`.trim();
}

// ── Escapar HTML ─────────────────────────────────────────────────────────
function escHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}