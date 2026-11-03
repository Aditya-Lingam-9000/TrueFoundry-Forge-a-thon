/**
 * Runs shell commands for the run_command tool (only after the user approved the exact command
 * in the agent panel). Output is mirrored to the "Forge Agent: Commands" output channel so the
 * user sees it live; Stop kills whatever is running.
 *
 * Commands run through a shell (`$SHELL -lc "…"`), which starts its own children (`sleep 30 && echo`,
 * pytest workers, …). Killing only the shell would leave those running and keep the output pipe
 * open, so each command gets its own process group and Stop / timeout kill the whole group.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { resolveInWorkspace, workspaceRoot } from './workspace';

const MAX_RESULT_CHARS = 12_000;

export interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  output: string;
  seconds: number;
}

export class CommandRunner {
  private readonly running = new Set<ChildProcess>();

  constructor(private readonly channel: vscode.OutputChannel) {}

  async run(command: string, cwd: string | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<CommandResult> {
    const dir = cwd ? resolveInWorkspace(cwd).abs : workspaceRoot();
    // A login shell picks up the user's PATH (Homebrew, uv, pyenv…) even when VS Code was started from the Dock.
    const shell = process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || '/bin/bash';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
    const started = Date.now();

    this.channel.appendLine('');
    this.channel.appendLine(`$ ${command}    (in ${dir})`);
    this.channel.show(true);

    return new Promise(resolve => {
      const child = spawn(shell, args, {
        cwd: dir,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        detached: process.platform !== 'win32', // own process group, so the whole tree can be killed
      });
      this.running.add(child);
      let output = '';
      let timedOut = false;
      let killed = false;
      let finished = false;
      const append = (chunk: Buffer): void => {
        const text = chunk.toString('utf8');
        this.channel.append(text);
        output += text;
        if (output.length > 4 * MAX_RESULT_CHARS) {
          output = output.slice(0, MAX_RESULT_CHARS) + '\n…\n' + output.slice(-2 * MAX_RESULT_CHARS);
        }
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      const kill = (): void => {
        if (child.exitCode === null) {
          killTree(child, 'SIGTERM');
          setTimeout(() => {
            if (!finished) {
              killTree(child, 'SIGKILL');
            }
          }, 3000);
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutSeconds * 1000);
      const onAbort = (): void => {
        killed = true;
        kill();
      };
      signal?.addEventListener('abort', onAbort);

      const done = (exitCode: number | null): void => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.running.delete(child);
        const seconds = (Date.now() - started) / 1000;
        this.channel.appendLine(`[exit ${exitCode ?? 'killed'} after ${seconds.toFixed(1)} s]`);
        resolve({ exitCode, timedOut, killed, output: trimOutput(output), seconds });
      };
      child.on('error', err => {
        output += `\n${err.message}`;
        done(null);
      });
      child.on('close', code => done(code));
    });
  }

  /** Kill every running command and everything it started (Stop). */
  killAll(): void {
    for (const child of this.running) {
      killTree(child, 'SIGKILL');
    }
  }
}

/** Signal a command's whole process tree: its process group on macOS/Linux, taskkill /T on Windows. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal); // negative pid: the whole process group
    }
  } catch {
    child.kill(signal); // the group is already gone, or not ours: fall back to the shell itself
  }
}

function trimOutput(output: string): string {
  if (output.length <= MAX_RESULT_CHARS) {
    return output;
  }
  const head = output.slice(0, 2000);
  const tail = output.slice(-(MAX_RESULT_CHARS - 2000));
  return `${head}\n… (${output.length - MAX_RESULT_CHARS} characters omitted) …\n${tail}`;
}
