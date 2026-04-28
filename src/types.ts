// ════════════════════════════════════════════════════════════════════════════
// TIPOS COMPARTIDOS
// Puerto directo de Cell.kt y GhciResult.kt
// ════════════════════════════════════════════════════════════════════════════

export type CellType = 'code' | 'markdown';
export type OutputType = 'none' | 'success' | 'error';

export interface CellOutput {
    type: OutputType;
    value: string;
}

export interface IHSnbCell {
    id: string;
    type: CellType;
    source: string;
    output: CellOutput;
    executed: boolean;
    executionCount: number;
    executionTimeMs: number;
}

export interface IHSnbMetadata {
    ghcVersion: string;
    created: string;
    modified: string;
}

export interface IHSnbFile {
    version: string;
    metadata: IHSnbMetadata;
    cells: IHSnbCell[];
}

// ── Resultado de GHCi — espejo de GhciResult.kt ──────────────────────────────
export type GhciResult =
    | { kind: 'success'; output: string; timeMs: number }
    | { kind: 'error'; output: string; timeMs: number }
    | { kind: 'timeout' }
    | { kind: 'not_running' };

// ── Estado del proceso GHCi — espejo de GhciState.kt ────────────────────────
export type GhciState =
    | 'disconnected'
    | 'connecting'
    | 'ready'
    | 'busy'
    | 'error';