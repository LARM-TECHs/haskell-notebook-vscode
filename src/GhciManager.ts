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
//   4. Código multilínea: si hay líneas indentadas se envuelve en :{ :};
//      si son sentencias independientes se envían una a una.
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

    /** Ejecuta un bloque de código Haskell. */
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
            // prepareCode devuelve un array de bloques; cada bloque es un array de
            // líneas que se envían juntas y producen UN solo prompt de respuesta.
            const blocks = this.prepareCode(code.trim());
            const outputs: string[] = [];

            for (const block of blocks) {
                this.outputBuf = '';
                block.forEach(l => this.sendRaw(l));

                const output = await this.awaitPrompt(this.timeoutMs);

                // Parar en el primer error
                const interim = this.classifyOutput(output, Date.now() - startMs);
                if (interim.kind === 'error') {
                    this.setState('ready');
                    return interim;
                }

                if (output) { outputs.push(output); }
            }

            const elapsed = Date.now() - startMs;
            this.setState('ready');
            const combined = outputs.filter(Boolean).join('\n').trimEnd();
            return { kind: 'success', output: combined, timeMs: elapsed };

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
     * Prepara el código para GHCi y devuelve un array de "bloques".
     * Cada bloque es un array de líneas que se envían juntas y generan
     * exactamente UN prompt de respuesta.
     *
     * Reglas:
     *  - Línea única              → [[línea]]
     *  - Empieza con ':'          → cada línea es su propio bloque
     *  - Tiene líneas indentadas  → un solo bloque envuelto en :{ :}
     *    (continuaciones: where, do, let, guards, etc.)
     *  - Resto (sentencias        → cada línea no-vacía es su propio bloque
     *    independientes sin       (evita el parse error de mezclar
     *    indentación)              declaraciones y expresiones en :{ :})
     */
    private prepareCode(code: string): string[][] {
        const lines = code.split('\n');

        // Línea única — caso más común
        if (lines.length === 1) {
            return [[code]];
        }

        // Comandos GHCi (:load, :type, etc.) — cada línea por separado
        if (code.trimStart().startsWith(':')) {
            return lines.filter(l => l.trim()).map(l => [l]);
        }

        // Si alguna línea (distinta de la primera) está indentada, es un bloque
        // multilínea real (where, do, guards…) → envolver en :{ :}
        const hasIndentation = lines.slice(1).some(l => /^\s+\S/.test(l));
        if (hasIndentation) {
            return [[':{', ...lines, ':}']];
        }

        // Sentencias independientes sin indentación → agrupar y enviar una a una.
        //
        // Problema: `name :: Type` enviado solo al REPL se interpreta como
        // una EXPRESIÓN con anotación de tipo (no como declaración), lo que
        // hace que GHCi evalúe `name` y lo imprima antes de tiempo.
        //
        // Solución: detectar firmas de tipo y agruparlas con todas las
        // ecuaciones que les siguen en un bloque :{ :}.
        const nonEmpty = lines.filter(l => l.trim() && !l.trimStart().startsWith('--'));
        const blocks: string[][] = [];
        let i = 0;

        while (i < nonEmpty.length) {
            const line = nonEmpty[i];
            const typeSigName = this.extractTypeSigName(line);

            if (typeSigName !== null) {
                // Recoger la firma + todas las ecuaciones del mismo nombre
                const group = [line];
                let j = i + 1;
                while (j < nonEmpty.length &&
                    this.isDefinitionOf(nonEmpty[j], typeSigName)) {
                    group.push(nonEmpty[j]);
                    j++;
                }
                if (group.length > 1) {
                    // Firma + al menos una ecuación → bloque :{ :}
                    blocks.push([':{', ...group, ':}']);
                } else {
                    // Firma sin definición (raro) → línea suelta
                    blocks.push([line]);
                }
                i = j;
            } else {
                blocks.push([line]);
                i++;
            }
        }

        return blocks;
    }

    /**
     * Si la línea es una firma de tipo (`name :: ...`), devuelve `name`.
     * En caso contrario devuelve null.
     */
    private extractTypeSigName(line: string): string | null {
        const m = line.match(/^([a-z_][\w']*|\([^)]+\))\s*::/);
        return m ? m[1] : null;
    }

    /**
     * Devuelve true si `line` es una ecuación para `name`
     * (empieza con `name` seguido de `=`, un patrón, o un guard `|`).
     */
    private isDefinitionOf(line: string, name: string): boolean {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // La línea debe empezar con `name` Y contener `=` (definición).
        // Así excluimos aplicaciones como `double 21` que no son definiciones.
        return new RegExp(`^${escaped}(\\s|=|\\|)`).test(line) && line.includes('=');
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