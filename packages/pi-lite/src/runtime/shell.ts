import {
  createBashToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type BashOperations,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent';
import type { CommandRegistry } from '@lumino/commands';

import { DRIVE } from './vfs';

const SHELL_COMMANDS = {
  execute: '@jupyterlite/terminal:execute-shell',
  start: '@jupyterlite/terminal:start-shell',
  shutdown: '@jupyterlite/terminal:shutdown-shell'
};

const DEFAULT_TIMEOUT_SECONDS = 120;
const CD_TIMEOUT_MS = 10000;

export const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

const COCKLE_DESCRIPTION =
  'Execute a command line in cockle, the in-browser shell of JupyterLite (WebAssembly builds of common tools), in the current working directory. ' +
  'Pipes (|), command lists (;, &&, || or newlines), $VAR expansion, here documents and file redirections (>, >>, 2>, 2>&1, <) are supported. ' +
  'Not supported: command substitution ($(...) or backticks), \\ escapes, background jobs, python, node, pip or network access. ' +
  'Commands read an empty stdin. ' +
  'Only /drive is shared with the file tools, the kernels and JupyterLab. ' +
  'Available commands include the coreutils (ls, cat, head, tail, wc, mkdir, cp, mv, rm, touch, sort, uniq, tr, cut, seq, date, stat...), grep, sed and the commands that the site adds (for example tree or git); run "cockle-config command" to list them all. ' +
  `Returns stdout and stderr. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); the full output is then saved to a /tmp file that only the read and grep tools can open. ` +
  'Optionally provide a timeout in seconds.';

/**
 * TAB, Ctrl-D, Ctrl-L, ESC and DEL, which cockle's line editor reads as keys.
 */
// eslint-disable-next-line no-control-regex
const KEYS = /[\t\x04\x0c\x1b\x7f]/;
const WORD = / *((?:'[^']*'|"[^"]*"|[^\s;&|<>'"])*)/y;
/**
 * A redirection operator, with the descriptor that it duplicates (`2>&1`).
 */
const REDIRECTION = /(?:<<<|<<-?|[<>]+)(?:&\d+)?/y;
/**
 * Spaces and line continuations around a part.
 */
const PADDING = /^(?:\s|\\\n)+|(?:\s|\\\n)+$/g;

interface IShellPart {
  code: string;
  /**
   * The part runs after a success (`&&`) or a failure (`||`) only.
   */
  condition?: '&&' | '||';
}

interface IShellResult {
  success: boolean;
  status: 'ok' | 'error' | 'timeout';
  output: string;
  exitCode: number | null;
  message: string;
}

/**
 * Whether the page has the headless cockle shells of JupyterLite terminals.
 */
export function hasCockleShell(commands: CommandRegistry): boolean {
  return commands.hasCommand(SHELL_COMMANDS.execute);
}

/**
 * cockle has no escape character: each `'` goes in double quotes, in the
 * same word.
 */
function quote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * The word after the spaces at `start`, without its quotes, and the index
 * after it.
 */
function readWord(text: string, start: number): [string, number] {
  WORD.lastIndex = start;
  const raw = WORD.exec(text)![1];
  return [raw.replace(/'([^']*)'|"([^"]*)"/g, '$1$2'), WORD.lastIndex];
}

/**
 * The exit code of an `exit` command (null: the code of the command before),
 * or undefined for another command.
 */
function exitCode(code: string): number | null | undefined {
  const [name, after] = readWord(code, 0);
  if (name !== 'exit') {
    return undefined;
  }
  const [status] = readWord(code, after);
  if (!status) {
    return null;
  }
  return /^-?\d+$/.test(status) ? ((Number(status) % 256) + 256) % 256 : 2;
}

/**
 * The pipelines of a command line, each run on its own: cockle has no `#`
 * comments, echoes the lines of a multi-line command, and its `exit` in a
 * list ends the shell. A heredoc body stays as written with its command.
 * Throws for what cockle would run wrong.
 */
function commandParts(code: string): IShellPart[] {
  if (KEYS.test(code)) {
    throw new Error(
      'cockle reads a TAB or a control character in a command as a key, so it cannot keep it. ' +
        'Use the write tool for files that contain tabs; sed understands \\t, and cut splits on TAB by default.'
    );
  }
  const text = `${code.replace(/\r\n?/g, '\n')}\n`;
  const parts: IShellPart[] = [];
  const heredocs: { part: IShellPart; delimiter: string }[] = [];
  let part: IShellPart = { code: '' };
  let quoted = '';
  let piped = false;
  let input = false;
  const endCommand = () => {
    if (!piped && !input) {
      // A headless command that reads stdin would wait until the timeout.
      part.code = part.code.replace(/(?:\s|\\\n)*$/, ' < /dev/null$&');
    }
    piped = true;
  };
  const close = (condition?: IShellPart['condition']) => {
    if (part.code.trim()) {
      endCommand();
      part.code = part.code.replace(PADDING, '');
      if (part.code.endsWith('|')) {
        throw new Error('The command ends with |');
      }
      parts.push(part);
    } else if (condition) {
      throw new Error(`The command has no command before ${condition}`);
    }
    part = { code: '', condition };
    piped = input = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      quoted = char === quoted ? '' : quoted;
    } else if (char === "'" || char === '"') {
      quoted = char;
    } else if (char === '#' && /[\s;&|()<>]/.test(text[i - 1] ?? ' ')) {
      i = text.indexOf('\n', i) - 1;
      continue;
    } else if (char === '\n') {
      if (/(?:\\|\|\s*)$/.test(part.code)) {
        // A newline after `\` or `|` continues the command.
        if (heredocs.length) {
          throw new Error(
            'cockle runs a here document at the end of its line: put the rest of the pipeline on the line of the <<'
          );
        }
        part.code += char;
        continue;
      }
      // After `&&` or `||`, the next line continues the list.
      if (part.code.trim() || !part.condition) {
        close();
      }
      for (const { part: target, delimiter } of heredocs.splice(0)) {
        const start = text.indexOf(`\n${delimiter}\n`, i);
        if (start < 0 || delimiter.includes('\n')) {
          throw new Error(`The here document has no ${delimiter} end line`);
        }
        const end = start + delimiter.length + 1;
        target.code += text.slice(i, end);
        i = end;
      }
      continue;
    } else if (text.startsWith('&&', i) || text.startsWith('||', i)) {
      close(text.slice(i, i + 2) as IShellPart['condition']);
      i++;
      continue;
    } else if (char === ';' || (char === '&' && text[i + 1] !== '>')) {
      close();
      continue;
    } else if (char === '|') {
      endCommand();
    } else if (char === '<' || char === '>') {
      REDIRECTION.lastIndex = i;
      const [token] = REDIRECTION.exec(text)!;
      part.code += token;
      i += token.length - 1;
      input ||= char === '<' && !piped;
      if (token === '<<' || token === '<<-') {
        const [delimiter, end] = readWord(text, i + 1);
        if (!delimiter) {
          throw new Error('cockle needs a here document delimiter word');
        }
        part.code += text.slice(i + 1, end);
        heredocs.push({ part, delimiter });
        i = end - 1;
      }
      continue;
    }
    part.code += char;
  }
  if (quoted) {
    throw new Error(
      `The command has no closing ${quoted} quote (cockle has no \\ escapes)`
    );
  }
  close();
  return parts;
}

/**
 * The output without the echo of a command that cockle reads over several
 * lines (heredoc, quote, `\` or `|` continuation): the exec plugin removes
 * the echo of one line only, and cockle shows the next lines after a `> `.
 */
function withoutEcho(output: string, code: string): string {
  const lines = code.trim().split('\n');
  const echo = `${lines.join('\n> ')}\n`;
  return lines.length > 1 && output.startsWith(echo)
    ? output.slice(echo.length)
    : output;
}

/**
 * Settle with the promise, or reject with `message` (`aborted` by default)
 * when the signal aborts first.
 */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
  message = 'aborted'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(new Error(message));
    };
    if (signal?.aborted) {
      abort();
    }
    signal?.addEventListener('abort', abort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', abort));
  });
}

/**
 * Runs commands in a headless cockle shell that shares the file system of
 * the JupyterLite terminals. A shell runs one command at a time, so the
 * commands wait in a queue.
 */
export class ShellRunner {
  constructor(commands: CommandRegistry) {
    this._commands = commands;
  }

  /**
   * The name of the shell, started on first use.
   */
  start(): Promise<string> {
    if (this._shellName) {
      return Promise.resolve(this._shellName);
    }
    if (!this._starting) {
      const generation = this._generation;
      const starting = (async () => {
        const { shellName } = (await this._commands.execute(
          SHELL_COMMANDS.start,
          { cwd: DRIVE }
        )) as { shellName: string };
        if (generation !== this._generation) {
          void this._abandon(shellName);
          throw new Error('The shell is disposed');
        }
        this._shellName = shellName;
        return shellName;
      })();
      const reset = () => {
        if (this._starting === starting) {
          this._starting = undefined;
        }
      };
      void starting.then(reset, reset);
      this._starting = starting;
    }
    return this._starting;
  }

  /**
   * Run a command line in a working directory once the queued commands are
   * done. An abort stops the shell: cockle cannot interrupt a command.
   */
  exec(
    code: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<IShellResult> {
    const previous = this._queue;
    let shellName: string | undefined;
    const run = async () => {
      const parts = commandParts(code);
      signal?.throwIfAborted();
      shellName = await this.start();
      signal?.throwIfAborted();
      const moved = await this._run(
        shellName,
        `cd ${quote(cwd)}`,
        CD_TIMEOUT_MS
      );
      signal?.throwIfAborted();
      if (!moved.success) {
        throw new Error(
          `Cannot change to the working directory ${cwd}: ${moved.output.trim() || moved.message}`
        );
      }
      const deadline = Date.now() + timeoutMs;
      let output = '';
      let last = moved;
      for (const part of parts) {
        if (part.condition && (part.condition === '&&') !== last.success) {
          continue;
        }
        const exit = exitCode(part.code);
        if (exit !== undefined) {
          // cockle's exit stops the shell: the command would never finish.
          last = { ...last, exitCode: exit ?? last.exitCode };
          break;
        }
        signal?.throwIfAborted();
        last = await this._run(
          shellName,
          part.code,
          Math.max(1, deadline - Date.now())
        );
        output += withoutEcho(last.output, part.code);
        if (last.status === 'timeout') {
          break;
        }
      }
      return { ...last, output };
    };
    const result = abortable(previous.then(run), signal, () => {
      if (shellName) {
        void this._abandon(shellName);
      }
    });
    this._queue = Promise.allSettled([previous, result]);
    return result;
  }

  async dispose(): Promise<void> {
    this._generation++;
    this._starting = undefined;
    if (this._shellName) {
      await this._abandon(this._shellName);
    }
  }

  private async _run(
    shellName: string,
    code: string,
    timeoutMs: number
  ): Promise<IShellResult> {
    try {
      const result = (await this._commands.execute(SHELL_COMMANDS.execute, {
        code,
        shellName,
        timeout: timeoutMs
      })) as unknown as IShellResult;
      if (result.status === 'timeout') {
        // The exec plugin refuses to reuse a shell whose command timed out.
        void this._abandon(shellName);
      }
      return { ...result, output: result.output.replace(ANSI_PATTERN, '') };
    } catch (error) {
      void this._abandon(shellName);
      throw error;
    }
  }

  /**
   * Shut down a shell; the next command starts a new one.
   */
  private async _abandon(shellName: string): Promise<void> {
    if (this._shellName === shellName) {
      this._shellName = undefined;
    }
    try {
      await this._commands.execute(SHELL_COMMANDS.shutdown, { shellName });
    } catch {
      // The shell may already be gone.
    }
  }

  private _commands: CommandRegistry;
  private _shellName?: string;
  private _starting?: Promise<string>;
  private _generation = 0;
  private _queue: Promise<unknown> = Promise.resolve();
}

/**
 * pi bash operations over a cockle shell: each command starts in the given
 * working directory, the output arrives in one chunk.
 */
export function cockleOperations(shell: ShellRunner): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const seconds = timeout ?? DEFAULT_TIMEOUT_SECONDS;
      const result = await shell.exec(command, cwd, seconds * 1000, signal);
      if (result.output) {
        onData(Buffer.from(result.output));
      }
      if (result.status === 'timeout') {
        throw new Error(`timeout:${seconds}`);
      }
      return { exitCode: result.exitCode ?? 1 };
    }
  };
}

/**
 * pi's bash tool, running in cockle. A batch with a command runs in order:
 * the command must see the files that the calls before it saved.
 */
export function createCockleBashTool(
  cwd: string,
  shell: ShellRunner
): ToolDefinition {
  return {
    ...createBashToolDefinition(cwd, {
      operations: cockleOperations(shell),
      exposeSessionEnvironment: false
    }),
    description: COCKLE_DESCRIPTION,
    promptSnippet:
      'Run commands in cockle, the in-browser shell (limited shell syntax, no python or network)',
    executionMode: 'sequential'
  } as ToolDefinition;
}
