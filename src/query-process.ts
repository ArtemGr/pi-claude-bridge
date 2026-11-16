// The SDK iterator can settle before Claude Code finishes flushing its file.
// Use the documented custom-spawn hook to observe the real child's close.
import { spawn } from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

/** Keep the end of stderr, because that's where Claude Code, or a wrapper set as pathToClaudeCodeExecutable,
 *  says why it exited. */
const STDERR_TAIL_CHARS = 2000;
/** Long arguments are elided, because --system-prompt and similar can carry prompts. */
const ARG_CHARS = 80;

export class QueryProcess {
	private started = false;
	private launch: SpawnOptions | undefined;
	private stderrTail = "";
	private child: SpawnedProcess | undefined;
	private closed = false;
	private resolveExit!: () => void;
	readonly exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });
	constructor(
		private stderr?: (data: string) => void,
		private onSpawn?: (options: SpawnOptions, pid: number | undefined) => void,
	) {}
	spawn = (options: SpawnOptions): SpawnedProcess => {
		if (this.closed || this.started) throw new Error("Query process spawned after close or more than once");
		const child = spawn(options.command, options.args, {
			cwd: options.cwd, env: options.env, signal: options.signal,
			stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
		});
		// Only a returned child can close; a synchronous spawn failure leaves none.
		this.started = true;
		this.child = child;
		this.launch = options;
		this.onSpawn?.(options, child.pid);
		child.stderr.on("data", (data: Buffer) => {
			const text = data.toString();
			this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
			this.stderr?.(text);
		});
		child.once("close", () => this.resolveExit());
		return child;
	};
	/** What was run and how, plus its stderr tail, for an error message about the process exiting. */
	describe(): string {
		if (!this.launch) return "\nClaude Code was not spawned.";
		const { command, args, cwd } = this.launch;
		const shown = args.map((a) => ARG_CHARS < a.length ? `<${a.length} chars>`
			: /^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a));
		const stderr = this.stderrTail.trim();
		return `\nRan: ${command} ${shown.join(" ")}\nIn: ${cwd ?? process.cwd()}`
			+ (stderr ? `\nStderr:\n${stderr}` : "\nStderr: empty");
	}
	/** A query constructor can throw after spawning, before returning a handle. */
	terminate(): void {
		this.close();
		if (this.child && !this.child.killed) this.child.kill("SIGTERM");
	}
	/** Called only after closing the SDK query, which forbids a deferred spawn. */
	close(): void {
		this.closed = true;
		if (!this.started) this.resolveExit();
	}
}
