// ════════════════════════════════════════════════════════════════════════════
// EXTENSION ENTRY POINT
//
// activate()   — registra serializer, controller, comandos y status bar
// deactivate() — limpia recursos (GhciManager.stop() ya maneja el proceso)
// ════════════════════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { GhciManager } from './GhciManager';
import { GhciState } from './types';
import { HaskellNotebookController } from './NotebookController';
import { HaskellNotebookSerializer } from './NotebookSerializer';
import { HistoryManager } from './HistoryManager';

// Instancias globales (viven durante toda la sesión de VS Code)
let ghci: GhciManager | null = null;
let controller: HaskellNotebookController | null = null;

// ════════════════════════════════════════════════════════════════════════════
// ACTIVATE
// ════════════════════════════════════════════════════════════════════════════

export function activate(context: vscode.ExtensionContext) {

	// ── Leer configuración del usuario ────────────────────────────────────────
	const config = vscode.workspace.getConfiguration('haskellNotebook');
	const ghciPath = config.get<string>('ghciPath', 'ghci');
	const timeoutMs = config.get<number>('timeoutMs', 30_000);

	// ── Instanciar núcleo ─────────────────────────────────────────────────────
	ghci = new GhciManager(ghciPath, timeoutMs);
	controller = new HaskellNotebookController(ghci);

	// ── Historial persistente ─────────────────────────────────────────────────
	const history = new HistoryManager(context.globalState);

	// ── Status bar ────────────────────────────────────────────────────────────
	const statusBar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	);
	statusBar.command = 'haskellNotebook.startGhci';
	statusBar.show();
	updateStatusBar(statusBar, 'disconnected');

	ghci.on('stateChanged', (state: GhciState) => {
		updateStatusBar(statusBar, state);
	});

	ghci.on('unexpectedExit', () => {
		vscode.window.showWarningMessage(
			'GHCi terminó inesperadamente.',
			'Reiniciar',
		).then(sel => {
			if (sel === 'Reiniciar') vscode.commands.executeCommand('haskellNotebook.restartGhci');
		});
	});

	// ── Serializer — asocia .ihsnb con el notebook ───────────────────────────
	context.subscriptions.push(
		vscode.workspace.registerNotebookSerializer(
			'haskell-notebook',
			new HaskellNotebookSerializer(),
			{ transientOutputs: false },
		),
	);

	// ── Comandos ──────────────────────────────────────────────────────────────
	context.subscriptions.push(

		vscode.commands.registerCommand('haskellNotebook.startGhci', async () => {
			if (!ghci) return;
			if (ghci.getState() === 'ready' || ghci.getState() === 'connecting') {
				vscode.window.showInformationMessage('GHCi ya está activo.');
				return;
			}
			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Iniciando GHCi…' },
					() => ghci!.start(),
				);
				vscode.window.showInformationMessage('GHCi iniciado correctamente.');
			} catch (e: any) {
				vscode.window.showErrorMessage(e.message);
			}
		}),

		vscode.commands.registerCommand('haskellNotebook.restartGhci', async () => {
			if (!ghci) return;
			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Reiniciando GHCi…' },
					() => ghci!.restart(),
				);
				vscode.window.showInformationMessage('GHCi reiniciado.');
			} catch (e: any) {
				vscode.window.showErrorMessage(e.message);
			}
		}),

		vscode.commands.registerCommand('haskellNotebook.stopGhci', () => {
			ghci?.stop();
			vscode.window.showInformationMessage('GHCi detenido.');
		}),

		// ── Show Type (:t <expr>) ────────────────────────────────────────────────
		vscode.commands.registerCommand('haskellNotebook.showType', async () => {
			if (!ghci) return;

			if (ghci.getState() === 'disconnected' || ghci.getState() === 'error') {
				vscode.window.showErrorMessage('GHCi no está iniciado. Ejecuta una celda primero.');
				return;
			}

			// 1. Intentar usar el texto seleccionado en el editor activo
			const editor = vscode.window.activeTextEditor;
			const selection = editor?.selection;
			const selected = (editor && selection && !selection.isEmpty)
				? editor.document.getText(selection).trim()
				: '';

			// 2. QuickPick con historial persistente
			const expr = await pickExpression(selected, history);
			if (!expr) return;

			// 3. Guardar en historial
			history.add(expr);

			// 4. Ejecutar :t <expr>
			const result = await ghci.sendCommand(`:t ${expr}`);

			if (result.kind === 'success' || result.kind === 'error') {
				vscode.window.showInformationMessage(
					result.output || `${expr} :: ?`,
					{ modal: false },
				);
			} else if (result.kind === 'timeout') {
				vscode.window.showErrorMessage('Timeout al consultar el tipo.');
			}
		}),

		// ── Borrar historial ─────────────────────────────────────────────────────
		vscode.commands.registerCommand('haskellNotebook.clearTypeHistory', () => {
			history.clear();
			vscode.window.showInformationMessage('Historial de tipos borrado.');
		}),

	);

	// ── Cleanup al deactivate ─────────────────────────────────────────────────
	context.subscriptions.push(
		statusBar,
		{ dispose: () => controller?.dispose() },
		{ dispose: () => ghci?.stop() },
	);
}

// ════════════════════════════════════════════════════════════════════════════
// DEACTIVATE
// ════════════════════════════════════════════════════════════════════════════

export function deactivate() {
	ghci?.stop();
}

// ════════════════════════════════════════════════════════════════════════════
// QUICK PICK CON HISTORIAL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Muestra un QuickPick con el historial de expresiones.
 * Si `prefill` no está vacío, lo pone como valor inicial.
 * Devuelve la expresión elegida o vacío si el usuario cancela.
 */
function pickExpression(prefill: string, history: HistoryManager): Promise<string> {
	return new Promise(resolve => {
		const qp = vscode.window.createQuickPick();
		qp.title = 'Show Type — :t';
		qp.placeholder = 'Escribe una expresión Haskell o elige del historial';
		qp.value = prefill;
		qp.canSelectMany = false;

		const toItems = (filter: string) =>
			history.getAll()
				.filter(e => !filter || e.toLowerCase().includes(filter.toLowerCase()))
				.map(e => ({ label: e }));

		qp.items = toItems(prefill);

		qp.onDidChangeValue(v => { qp.items = toItems(v); });

		qp.onDidAccept(() => {
			const value = qp.selectedItems[0]?.label ?? qp.value;
			qp.hide();
			resolve(value.trim());
		});

		qp.onDidHide(() => resolve(''));
		qp.show();
	});
}

// ════════════════════════════════════════════════════════════════════════════
// UTILIDADES PRIVADAS
// ════════════════════════════════════════════════════════════════════════════

function updateStatusBar(
	item: vscode.StatusBarItem,
	state: GhciState,
) {
	const labels: Record<GhciState, string> = {
		disconnected: '$(debug-disconnect) GHCi',
		connecting: '$(loading~spin) GHCi',
		ready: '$(check) GHCi listo',
		busy: '$(loading~spin) GHCi ejecutando…',
		error: '$(error) GHCi error',
	};
	const tooltips: Record<GhciState, string> = {
		disconnected: 'GHCi desconectado — clic para iniciar',
		connecting: 'GHCi iniciando…',
		ready: 'GHCi listo para ejecutar',
		busy: 'GHCi ejecutando un comando…',
		error: 'GHCi encontró un error — clic para reiniciar',
	};

	item.text = labels[state] ?? state;
	item.tooltip = tooltips[state] ?? '';
	item.command = state === 'error'
		? 'haskellNotebook.restartGhci'
		: 'haskellNotebook.startGhci';
}