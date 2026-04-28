// ════════════════════════════════════════════════════════════════════════════
// GHCI MANAGER
//
// Puerto directo de GhciManager.kt a TypeScript.
//
// Protocolo de comunicación:
//   1. Al iniciar, se configura un prompt único (PROMPT) como marcador de
//      fin de output: GHCi imprime el prompt cada vez que termina un comando.
//   2. Para ejecutar código: se envía el código por stdin y se espera a que
//      onData() detecte el prompt en stdout → resuelve la Promise pendiente.
//   3. stderr se redirige a stdout para simplificar la lectura.
//   4. Código multilínea se envuelve en :{ ... :} para que GHCi lo acepte.
//   5. Una cola FIFO garantiza que solo un comando se ejecuta a la vez.
// ════════════════════════════════════════════════════════════════════════════

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { GhciResult, GhciState } from './types';

export class GhciManager extends EventEmitter {

    private process: ChildProcessWithoutNullStreams | null = null;
    private outputBuf: string = '';
    private lineBuf: string = '';
    private state: GhciState = 'disconnected';

    // Cola FIFO — equivale al Mutex de GhciManager.kt
    private execQueue: Array<() => void> = [];
    private executing: boolean = false;

    // Prompt único como marcador de fin de output
    private readonly PROMPT =
        `HSNB_${Date.now().toString(36).toUpperCase()}> `;

    // Promise pendiente: se resuelve cuando readLoop detecta el PROMPT
    private pendingResolve: ((output: string) => void) | null = null;
    private pendingTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly ghciPath: string = 'ghci',
        private readonly timeoutMs: number = 30_000,
    ) { super(); }

    // ════════════════════════════════════════════════════════════════════════
    // ESTADO PÚBLICO
    // ════════════════════════════════════════════════════════════════════════

    getState(): GhciState { return this.state; }

    private setState(s: GhciState) {
        this.state = s;
        this.emit('stateChanged', s);
    }

    // ════════════════════════════════════════════════════════════════════════
    // INICIO
    // ════════════════════════════════════════════════════════════════════════

    async start(): Promise<void> {
        this.setState('connecting');

        return new Promise((resolve, reject) => {
            try {
                this.process = spawn(this.ghciPath, [], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                });

                // Redirigir stderr a stdout (igual que redirectErrorStream=true en Kotlin)
                this.process.stderr.on('data', (data: Buffer) => {
                    this.onData(data.toString());
                });

                this.process.stdout.on('data', (data: Buffer) => {
                    this.onData(data.toString());
                });

                this.process.on('exit', () => {
                    if (this.state !== 'disconnected') {
                        this.setState('error');
                        this.emit('unexpectedExit');
                    }
                });

                this.process.on('error', (err) => {
                    this.setState('error');
                    reject(new Error(
                        `No se encontró GHCi en '${this.ghciPath}'. ` +
                        `Comprueba que Haskell Platform esté instalado y en el PATH.\n${err.message}`
                    ));
                });

                // Esperar el primer prompt = GHCi listo
                this.awaitPrompt(15_000)
                    .then(() => { this.setState('ready'); resolve(); })
                    .catch(reject);

                // Configurar prompt único; GHCi responde con el prompt inicial
                this.sendRaw(`:set prompt "${this.PROMPT}"`);
                this.sendRaw(`:set prompt-cont "   "`);

            } catch (e: any) {
                this.setState('error');
                reject(new Error(
                    `Error al lanzar GHCi en '${this.ghciPath}': ${e.message}`
                ));
            }
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    // PARADA / REINICIO
    // ════════════════════════════════════════════════════════════════════════

    stop() {
        this.clearPending();
        this.execQueue = [];
        this.executing = false;
        this.process?.kill();
        this.process = null;
        this.outputBuf = '';
        this.lineBuf = '';
        this.setState('disconnected');
    }

    async restart(): Promise<void> {
        this.stop();
        await new Promise(r => setTimeout(r, 300));
        return this.start();
    }

    // ════════════════════════════════════════════════════════════════════════
    // EJECUCIÓN DE CÓDIGO
    // ════════════════════════════════════════════════════════════════════════

    /** Ejecuta un bloque de código Haskell (envuelve multilínea en :{ :}). */
    execute(code: string): Promise<GhciResult> {
        return this.enqueue(() => this.doExecute(code));
    }

    /** Envía un comando de una sola línea al REPL (sin wrap :{ :}). */
    sendCommand(cmd: string): Promise<GhciResult> {
        return this.enqueue(() => this.doSendCommand(cmd));
    }

    // ── Serialización de llamadas (equivale al Mutex de Kotlin) ──────────────
    private enqueue(task: () => Promise<GhciResult>): Promise<GhciResult> {
        return new Promise((resolve) => {
            this.execQueue.push(async () => {
                const result = await task();
                resolve(result);
                this.executing = false;
                this.runNext();
            });
            this.runNext();
        });
    }

    private runNext() {
        if (this.executing || this.execQueue.length === 0) return;
        this.executing = true;
        this.execQueue.shift()!();
    }

    private async doExecute(code: string): Promise<GhciResult> {
        if (!this.isRunning()) return { kind: 'not_running' };

        const startMs = Date.now();
        this.setState('busy');

        try {
            this.outputBuf = '';
            const lines = this.prepareCode(code.trim());
            lines.forEach(l => this.sendRaw(l));

            const output = await this.awaitPrompt(this.timeoutMs);
            const elapsed = Date.now() - startMs;
            this.setState('ready');
            return this.classifyOutput(output, elapsed);

        } catch {
            this.setState('ready');
            return { kind: 'timeout' };
        }
    }

    private async doSendCommand(cmd: string): Promise<GhciResult> {
        if (!this.isRunning()) return { kind: 'not_running' };

        const startMs = Date.now();
        this.setState('busy');

        try {
            this.outputBuf = '';
            this.sendRaw(cmd.trim());

            const output = await this.awaitPrompt(this.timeoutMs);
            const elapsed = Date.now() - startMs;
            this.setState('ready');
            return this.classifyOutput(output, elapsed);

        } catch {
            this.setState('ready');
            return { kind: 'timeout' };
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // BUCLE DE LECTURA CHAR A CHAR
    // Mismo protocolo que readLoop() en GhciManager.kt
    // ════════════════════════════════════════════════════════════════════════

    private onData(chunk: string) {
        for (const ch of chunk) {
            if (ch === '\r') continue;

            if (ch === '\n') {
                this.outputBuf += this.lineBuf + '\n';
                this.lineBuf = '';
            } else {
                this.lineBuf += ch;

                // ¿La línea actual termina con nuestro PROMPT?
                if (this.lineBuf.endsWith(this.PROMPT)) {
                    this.lineBuf = this.lineBuf.slice(0, -this.PROMPT.length);
                    if (this.lineBuf) {
                        this.outputBuf += this.lineBuf + '\n';
                        this.lineBuf = '';
                    }

                    // Señalizar que el comando terminó
                    const output = this.outputBuf.trimEnd();
                    this.outputBuf = '';

                    if (this.pendingResolve) {
                        const resolve = this.pendingResolve;
                        this.pendingResolve = null;
                        if (this.pendingTimer) {
                            clearTimeout(this.pendingTimer);
                            this.pendingTimer = null;
                        }
                        resolve(output);
                    }
                }
            }
        }
    }

    private awaitPrompt(ms: number): Promise<string> {
        return new Promise((resolve, reject) => {
            this.pendingResolve = resolve;
            this.pendingTimer = setTimeout(() => {
                this.pendingResolve = null;
                this.pendingTimer = null;
                reject(new Error('timeout'));
            }, ms);
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    // UTILIDADES PRIVADAS
    // ════════════════════════════════════════════════════════════════════════

    /** Envía una línea al stdin de GHCi. */
    private sendRaw(line: string) {
        this.process?.stdin.write(line + '\n');
    }

    /**
     * Prepara el código para GHCi:
     * - Línea única                    → se envía tal cual
     * - Multilínea con comandos ':'    → se envía línea a línea
     * - Multilínea sin comandos        → se envuelve en :{ ... :}
     */
    private prepareCode(code: string): string[] {
        const lines = code.split('\n');
        if (lines.length === 1) return [code];
        if (code.trimStart().startsWith(':')) return lines;
        return [':{', ...lines, ':}'];
    }

    /**
     * Detecta si el output de GHCi es un error.
     * Puerto directo de RawOutput.looksLikeError en GhciManager.kt.
     */
    private classifyOutput(output: string, timeMs: number): GhciResult {
        const isError =
            (output.includes('<interactive>') &&
                (output.includes('error:') ||
                    output.includes('parse error') ||
                    output.includes('warning:'))) ||
            output.includes('*** Exception:') ||
            output.trimStart().startsWith('error:');

        return isError
            ? { kind: 'error', output, timeMs }
            : { kind: 'success', output, timeMs };
    }

    private clearPending() {
        this.pendingResolve = null;
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
    }

    private isRunning(): boolean {
        return this.process !== null && !this.process.killed;
    }
}