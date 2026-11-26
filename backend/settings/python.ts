import { detectionTiming } from './timing';
import { spawn, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import type { Logger } from '../platform/log';

export class PythonEnvironmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PythonEnvironmentError';
    this.code = code;
  }
}

export interface PythonEnvironmentResult {
  environmentPath: string;
  interpreterPath: string;
  version: string;
  prefix: string;
  message: string;
}

const PROBE_TIMEOUT_MS = 12_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * The OS-facing variables a Windows command needs when the tool shell does not
 * inherit the Codex process environment. Only names required by ordinary
 * commands are forwarded; credentials and application state are never added.
 */
const SHELL_ENVIRONMENT_BASE_NAMES = [
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'COMPUTERNAME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'PUBLIC',
  'ALLUSERSPROFILE',
] as const;

/**
 * A standalone shell environment for a normal (non-toolbox) conversation.
 * When the Codex process environment is not inherited, tools still need the
 * system PATH and Windows essentials; nothing secret is copied.
 */
export function buildShellEnvironmentBase(
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const pathValue = process.env.PATH;
  if (pathValue) env.PATH = pathValue;
  for (const name of SHELL_ENVIRONMENT_BASE_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (extra) {
    for (const [name, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      env[name] = value;
    }
  }
  return env;
}

/**
 * Per-thread Codex configuration for tool shells. Inheritance is disabled and
 * the complete environment is supplied explicitly, so the service credential
 * that authenticates the Codex process can never reach an ordinary tool
 * command or its descendants.
 */
export function buildToolShellEnvironmentPolicy(
  environment: Readonly<Record<string, string>>,
): { inherit: 'none'; set: Record<string, string> } {
  return { inherit: 'none', set: { ...environment } };
}


const ENV_PROBE = `
import json, sys
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps({
    "marker": "CHATFGM_PYTHON_ENV_PROBE",
    "executable": sys.executable,
    "prefix": sys.prefix,
    "base_prefix": getattr(sys, "base_prefix", sys.prefix),
    "version": "%d.%d.%d" % sys.version_info[:3],
}, ensure_ascii=False))
`;

function canonical(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function sanitizeOutput(value: string): string {
  return value
    .replace(/[A-Za-z]:\\[^\r\n:]+/g, '[path]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(sk|pk|ak)-[A-Za-z0-9._-]{6,}\b/gi, '[redacted]')
    .slice(-500);
}

function candidateInterpreters(environmentPath: string): string[] {
  return [
    path.join(environmentPath, 'Scripts', 'python.exe'),
    path.join(environmentPath, 'python.exe'),
    path.join(environmentPath, 'bin', 'python.exe'),
    path.join(environmentPath, 'Scripts', 'python3.exe'),
    path.join(environmentPath, 'bin', 'python3.exe'),
  ];
}

export interface ResolvedPythonEnvironment {
  environmentPath: string;
  interpreterPath: string;
}

/**
 * Resolves the real interpreter inside a Windows venv/Conda root. It never
 * falls back to the system Python: an environment without a contained
 * interpreter is an explicit error.
 */
export function resolvePythonEnvironment(
  environmentPath: string,
): ResolvedPythonEnvironment {
  if (typeof environmentPath !== 'string' || !environmentPath.trim()) {
    throw new PythonEnvironmentError(
      'python-environment-missing',
      '请先在依赖设置中为该工具箱配置 Python 运行环境。',
    );
  }
  let environment: string;
  try {
    const stat = lstatSync(environmentPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('not a directory');
    }
    environment = realpathSync.native(environmentPath);
  } catch (error) {
    throw new PythonEnvironmentError(
      'python-environment-missing',
      '运行环境目录不存在或不可访问；请重新选择 venv 或 Conda 环境根目录。',
      { cause: error },
    );
  }
  for (const candidate of candidateInterpreters(environment)) {
    try {
      const stat = lstatSync(candidate);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      const resolved = realpathSync.native(candidate);
      if (!within(environment, resolved)) {
        throw new PythonEnvironmentError(
          'python-fallback',
          '目录中的 Python 解释器指向环境外部，已拒绝退回系统 Python。',
        );
      }
      return { environmentPath: environment, interpreterPath: resolved };
    } catch (error) {
      if (error instanceof PythonEnvironmentError) throw error;
      continue;
    }
  }
  throw new PythonEnvironmentError(
    'python-interpreter-missing',
    '运行环境目录中没有找到 python.exe；请选择 venv 或 Conda 环境根目录。',
  );
}

/**
 * Environment variables that make a toolbox interpreter the one used by
 * Agent commands. Only per-thread Codex config consumes this; the shared
 * app-server process environment is never modified.
 */
export function buildToolboxShellEnvironment(
  resolved: ResolvedPythonEnvironment,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  const environmentPath = resolved.environmentPath;
  const pathParts = [
    environmentPath,
    path.join(environmentPath, 'Scripts'),
    path.join(environmentPath, 'Library', 'bin'),
    path.join(environmentPath, 'Library', 'mingw-w64', 'bin'),
    path.join(environmentPath, 'DLLs'),
  ];
  const inheritedPath = process.env.PATH;
  if (inheritedPath) pathParts.push(inheritedPath);
  const env: Record<string, string> = {
    ...buildShellEnvironmentBase(),
    PATH: pathParts.join(path.delimiter),
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    CONDA_PREFIX: environmentPath,
    CONDA_DEFAULT_ENV: path.basename(environmentPath),
    VIRTUAL_ENV: environmentPath,
    CHATFGM_PYTHON: resolved.interpreterPath,
    CHATFGM_ENV_ROOT: environmentPath,
  };
  if (extra) {
    for (const [name, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      env[name] = value;
    }
  }
  return env;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        new PythonEnvironmentError(
          'python-spawn-failed',
          '无法启动 Python 解释器。',
          { cause: error },
        ),
      );
      return;
    }
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let aborted = false;
    const kill = () => {
      const pid = child.pid;
      if (!pid) return;
      try {
        child.kill();
      } catch {
        // Ignore.
      }
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 3000,
        });
      } catch {
        // Ignore.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const abort = () => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const collect = (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > MAX_OUTPUT_BYTES) {
        kill();
        return false;
      }
      return true;
    };
    child.stdout?.on('data', (chunk: string) => {
      if (collect(chunk)) stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      if (collect(chunk)) stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reject(
        new PythonEnvironmentError(
          'python-spawn-failed',
          '无法启动 Python 解释器。',
          { cause: error },
        ),
      );
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ code, stdout, stderr, timedOut, aborted });
    });
  });
}

function lastJsonLine(value: string): unknown {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!);
    } catch {
      // Keep looking for the marker object.
    }
  }
  return null;
}

export class PythonEnvironmentService {
  constructor(
    private readonly logger: Logger,
    private readonly probeRoot: string,
  ) {}

  /**
   * Verifies that the configured environment really owns the interpreter, that
   * the interpreter runs, and which Python version/prefix it reports. No
   * toolbox-provided probe script, module list or version range is required.
   */
  async detect(
    environmentPath: string,
    signal?: AbortSignal,
  ): Promise<PythonEnvironmentResult> {
    const timing = detectionTiming(this.logger, 'python');
    if (signal?.aborted) {
      throw new PythonEnvironmentError('python-cancelled', '运行环境检测已取消。');
    }
    const { environmentPath: environment, interpreterPath: interpreter } =
      resolvePythonEnvironment(environmentPath);
    timing('resolve');
    mkdirSync(this.probeRoot, { recursive: true });
    const work = mkdtempSync(path.join(this.probeRoot, 'python-'));
    const env = buildToolboxShellEnvironment({
      environmentPath: environment,
      interpreterPath: interpreter,
    });
    try {
      const probe = await runProcess(
        interpreter,
        ['-I', '-B', '-c', ENV_PROBE],
        { cwd: work, env, timeoutMs: PROBE_TIMEOUT_MS, signal },
      );
      timing('process');
      if (probe.aborted) {
        throw new PythonEnvironmentError(
          'python-cancelled',
          '运行环境检测已取消。',
        );
      }
      if (probe.timedOut) {
        throw new PythonEnvironmentError('python-timeout', 'Python 环境检测超时。');
      }
      if (probe.code !== 0) {
        throw new PythonEnvironmentError(
          'python-exit-failed',
          `Python 解释器启动失败${probe.stderr ? `：${sanitizeOutput(probe.stderr)}` : '。'}`,
        );
      }
      const parsed = lastJsonLine(probe.stdout);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as Record<string, unknown>).marker !== 'CHATFGM_PYTHON_ENV_PROBE'
      ) {
        throw new PythonEnvironmentError(
          'python-probe-invalid',
          'Python 环境探测没有返回有效结果。',
        );
      }
      const value = parsed as Record<string, unknown>;
      const executable =
        typeof value.executable === 'string' ? canonical(value.executable) : '';
      const prefix = typeof value.prefix === 'string' ? canonical(value.prefix) : '';
      const version = typeof value.version === 'string' ? value.version : '';
      if (executable.toLowerCase() !== canonical(interpreter).toLowerCase()) {
        throw new PythonEnvironmentError(
          'python-interpreter-mismatch',
          '实际运行的 Python 与所选环境的解释器不一致。',
        );
      }
      if (!within(environment, prefix)) {
        throw new PythonEnvironmentError(
          'python-fallback',
          'Python 前缀不在所选环境目录内，疑似退回系统 Python。',
        );
      }
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new PythonEnvironmentError(
          'python-version',
          'Python 没有返回有效版本号。',
        );
      }
      timing('validation');
      this.logger.info('python-environment-detected', {
        environment: path.basename(environment),
        version,
      });
      return {
        environmentPath: environment,
        interpreterPath: interpreter,
        version,
        prefix,
        message: `Python ${version}`,
      };
    } finally {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        // A transient file lock must not hide the result.
      }
      timing('cleanup');
    }
  }
}
