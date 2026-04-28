// ════════════════════════════════════════════════════════════════════════════
// NOTEBOOK SERIALIZER
//
// Lee y escribe archivos .ihsnb (JSON propio, compatible con la app desktop).
// Puerto directo de NotebookSerializer.kt.
// ════════════════════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { IHSnbCell, IHSnbFile } from './types';

export class HaskellNotebookSerializer implements vscode.NotebookSerializer {

    // ════════════════════════════════════════════════════════════════════════
    // DESERIALIZACIÓN — .ihsnb → NotebookData
    // ════════════════════════════════════════════════════════════════════════

    async deserializeNotebook(
        content: Uint8Array,
        _token: vscode.CancellationToken,
    ): Promise<vscode.NotebookData> {

        const text = new TextDecoder().decode(content);

        let file: IHSnbFile;
        try {
            file = text.trim()
                ? JSON.parse(text)
                : this.emptyFile();
        } catch {
            // JSON inválido → notebook vacío para no bloquear al usuario
            file = this.emptyFile();
        }

        const cells = file.cells.map(c => {
            const cell = new vscode.NotebookCellData(
                c.type === 'code'
                    ? vscode.NotebookCellKind.Code
                    : vscode.NotebookCellKind.Markup,
                c.source,
                c.type === 'code' ? 'haskell' : 'markdown',
            );

            // Restaurar output de la sesión anterior si existe
            if (c.executed && c.output.value) {
                const item = c.output.type === 'error'
                    ? vscode.NotebookCellOutputItem.stderr(c.output.value)
                    : vscode.NotebookCellOutputItem.text(c.output.value);
                cell.outputs = [new vscode.NotebookCellOutput([item])];
            }

            // Metadatos de runtime (no se muestran en la UI, pero se preservan)
            cell.metadata = {
                id: c.id,
                executionCount: c.executionCount,
                executionTimeMs: c.executionTimeMs,
            };

            return cell;
        });

        return new vscode.NotebookData(cells);
    }

    // ════════════════════════════════════════════════════════════════════════
    // SERIALIZACIÓN — NotebookData → .ihsnb
    // ════════════════════════════════════════════════════════════════════════

    async serializeNotebook(
        data: vscode.NotebookData,
        _token: vscode.CancellationToken,
    ): Promise<Uint8Array> {

        const now = new Date().toISOString();

        const cells: IHSnbCell[] = data.cells.map((c, i) => {
            const output = c.outputs?.[0];
            const outItem = output?.items?.[0];
            const outText = outItem
                ? new TextDecoder().decode(outItem.data)
                : '';
            const isError = outItem?.mime === 'application/vnd.code.notebook.stderr';

            return {
                id: c.metadata?.id ?? `cell-${i}-${Date.now()}`,
                type: c.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown',
                source: c.value,
                output: {
                    type: isError ? 'error' : (outText ? 'success' : 'none'),
                    value: outText,
                },
                executed: !!outText,
                executionCount: c.metadata?.executionCount ?? 0,
                executionTimeMs: c.metadata?.executionTimeMs ?? 0,
            };
        });

        const file: IHSnbFile = {
            version: '1.0',
            metadata: {
                ghcVersion: '8.6.5',
                created: now,
                modified: now,
            },
            cells,
        };

        return new TextEncoder().encode(JSON.stringify(file, null, 2));
    }

    // ════════════════════════════════════════════════════════════════════════
    // UTILIDADES PRIVADAS
    // ════════════════════════════════════════════════════════════════════════

    private emptyFile(): IHSnbFile {
        const now = new Date().toISOString();
        return {
            version: '1.0',
            metadata: { ghcVersion: '8.6.5', created: now, modified: now },
            cells: [],
        };
    }
}