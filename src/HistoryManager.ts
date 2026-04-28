// ════════════════════════════════════════════════════════════════════════════
// HISTORY MANAGER
//
// Persiste el historial de expresiones consultadas via "Show Type"
// usando ExtensionContext.globalState (sobrevive entre sesiones de VS Code).
//
// Límite: 200 entradas. Las duplicadas se mueven al frente.
// ════════════════════════════════════════════════════════════════════════════

import * as vscode from 'vscode';

const HISTORY_KEY = 'haskellNotebook.typeQueryHistory';
const MAX_ENTRIES = 200;

export class HistoryManager {

    private history: string[];

    constructor(private readonly state: vscode.Memento) {
        this.history = state.get<string[]>(HISTORY_KEY, []);
    }

    // ── Añade una entrada al frente (deduplicando) ───────────────────────────
    add(entry: string): void {
        const trimmed = entry.trim();
        if (!trimmed) return;
        this.history = [
            trimmed,
            ...this.history.filter(e => e !== trimmed),
        ].slice(0, MAX_ENTRIES);
        this.state.update(HISTORY_KEY, this.history);
    }

    // ── Devuelve todas las entradas (más reciente primero) ───────────────────
    getAll(): string[] {
        return this.history;
    }

    // ── Borra el historial completo ──────────────────────────────────────────
    clear(): void {
        this.history = [];
        this.state.update(HISTORY_KEY, []);
    }
}