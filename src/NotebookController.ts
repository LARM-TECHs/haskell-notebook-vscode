// ════════════════════════════════════════════════════════════════════════════
// NOTEBOOK CONTROLLER
//
// Conecta la VS Code Notebook API con GhciManager.
// ════════════════════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { GhciManager } from './GhciManager';
import { GhciResult } from './types';
import { formatGhciError } from './GhciErrorFormatter';
import { formatGhciOutput } from './GhciOutputFormatter';

export class HaskellNotebookController {

    private readonly controller: vscode.NotebookController;
    private executionOrder: number = 0;

    constructor(private readonly ghci: GhciManager) {
        this.controller = vscode.notebooks.createNotebookController(
            'haskell-notebook-kernel',
            'haskell-notebook',
            'GHCi 8.6.5',
        );

        this.controller.supportedLanguages = ['haskell'];
        this.controller.supportsExecutionOrder = true;
        this.controller.description = 'Ejecuta código Haskell via GHCi';
        this.controller.executeHandler = this.execute.bind(this);
    }

    // ════════════════════════════════════════════════════════════════════════
    // HANDLER DE EJECUCIÓN
    // ════════════════════════════════════════════════════════════════════════

    private async execute(
        cells: vscode.NotebookCell[],
        _nb: vscode.NotebookDocument,
        _ctrl: vscode.NotebookController,
    ): Promise<void> {

        if (this.ghci.getState() === 'disconnected' ||
            this.ghci.getState() === 'error') {
            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Iniciando GHCi…',
                        cancellable: false,
                    },
                    () => this.ghci.start(),
                );
            } catch (e: any) {
                vscode.window.showErrorMessage(e.message);
                return;
            }
        }

        for (const cell of cells) {
            await this.executeCell(cell);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // EJECUCIÓN DE UNA CELDA
    // ════════════════════════════════════════════════════════════════════════

    private async executeCell(cell: vscode.NotebookCell): Promise<void> {
        const execution = this.controller.createNotebookCellExecution(cell);
        execution.executionOrder = ++this.executionOrder;
        execution.start(Date.now());
        execution.clearOutput();

        try {
            const source = cell.document.getText();
            const result = await this.ghci.execute(source);
            await this.renderResult(execution, result);
        } catch (e: any) {
            await this.renderError(execution, e.message ?? 'Error inesperado');
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // RENDERIZADO DE OUTPUT
    // ════════════════════════════════════════════════════════════════════════

    private async renderResult(
        exec: vscode.NotebookCellExecution,
        result: GhciResult,
    ): Promise<void> {
        switch (result.kind) {

            case 'success': {
                const html = formatGhciOutput(result.output);
                await exec.appendOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(html || result.output, 'text/html'),
                ]));
                exec.end(true, Date.now());
                break;
            }

            case 'error': {
                const html = formatGhciError(result.output);
                await exec.appendOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(html, 'text/html'),
                ]));
                exec.end(false, Date.now());
                break;
            }

            case 'timeout': {
                await this.renderError(
                    exec,
                    'Timeout: la ejecución superó el límite configurado.\n' +
                    'Usa "Haskell: Restart GHCi" si el proceso quedó colgado.',
                );
                break;
            }

            case 'not_running': {
                await this.renderError(exec, 'GHCi no está iniciado.');
                break;
            }
        }
    }

    private async renderError(
        exec: vscode.NotebookCellExecution,
        msg: string,
    ): Promise<void> {
        const html = formatGhciError(msg);
        await exec.appendOutput(new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(html, 'text/html'),
        ]));
        exec.end(false, Date.now());
    }

    // ════════════════════════════════════════════════════════════════════════
    // CICLO DE VIDA
    // ════════════════════════════════════════════════════════════════════════

    dispose() {
        this.controller.dispose();
    }
}