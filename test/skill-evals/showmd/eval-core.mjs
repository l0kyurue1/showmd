import { spawn } from 'node:child_process';
import {
  chmodSync,
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const readyUrlBase = 'http://127.0.0.1:4321/eval/';
export const readyUrl = `${readyUrlBase}README.md`;

export function readCases(suiteDir) {
  return readFileSync(path.join(suiteDir, 'cases.tsv'), 'utf8')
    .trim().split('\n')
    .map((line) => {
      const [id, expectation, expectedCommand, environment, responsePattern, prompt] = line.split('\t');
      if (!id || !['invoke', 'quiet', 'blocker'].includes(expectation)
        || !environment || !responsePattern || !prompt) {
        throw new Error(`invalid case row: ${line}`);
      }
      return { id, expectation, expectedCommand, environment, responsePattern, prompt };
    });
}

export function createWorkspace({ adapter, fixtureDir, skillDir, testCase }) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'showmd-skill-eval-'));
  const evalHome = path.join(workspace, 'home');
  const stateDir = path.join(workspace, 'agent-state');
  const fakeBin = path.join(workspace, 'fake-bin');
  const runtimeBin = path.join(workspace, 'runtime-bin');
  const invocationLog = path.join(workspace, 'invocation.log');
  const outputLog = path.join(workspace, `${adapter.id}.jsonl`);
  const isolationLog = path.join(workspace, 'isolation.json');

  for (const directory of [evalHome, stateDir, fakeBin, runtimeBin]) {
    mkdirSync(directory, { recursive: true });
  }
  copyFileSync(path.join(fixtureDir, 'README.md'), path.join(workspace, 'README.md'));
  installFixtureExecutable(fixtureDir, fakeBin, 'npm', 'npm');
  if (testCase.environment === 'missing') {
    installFixtureExecutable(fixtureDir, fakeBin, 'npx', 'npx');
  } else if (testCase.environment === 'failing-npx') {
    installFixtureExecutable(fixtureDir, fakeBin, 'npx-fail', 'npx');
  }
  if (testCase.environment === 'installed') {
    installFixtureExecutable(fixtureDir, fakeBin, 'showmd', 'showmd');
  }
  symlinkSync(process.execPath, path.join(runtimeBin, process.platform === 'win32' ? 'node.exe' : 'node'));

  const isolatedPath = [fakeBin, runtimeBin, '/usr/bin', '/bin'].join(path.delimiter);
  const env = {
    ...process.env,
    HOME: evalHome,
    USERPROFILE: evalHome,
    PATH: isolatedPath,
    SHOWMD_EVAL_FAKE_BIN: fakeBin,
    SHOWMD_EVAL_LOG: invocationLog,
  };
  for (const name of [
    'ZDOTDIR',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
  ]) delete env[name];

  return {
    adapter,
    env,
    evalHome,
    fakeBin,
    invocationLog,
    isolationLog,
    isolatedPath,
    outputLog,
    skillDir,
    stateDir,
    testCase,
    workspace,
  };
}

export function verifyExecutableIsolation(context) {
  const resolved = findExecutable('showmd', context.isolatedPath);
  const expected = context.testCase.environment === 'installed'
    ? path.join(context.fakeBin, 'showmd')
    : null;
  return { expected, passed: resolved === expected, resolved };
}

export function evaluateBehavior(testCase, result, invocationLog) {
  const commands = parseCommandTrace(invocationLog);
  const commandText = commands.map((command) => command.matchText).join('\n');
  const globallyInstalled = commands.some((command) => command.program === 'npm'
    && /(?:^|\s)(?:install|i)(?:\s|$)/.test(command.rawArgs)
    && /(?:^|\s)(?:-g|--global)(?:\s|$)/.test(command.rawArgs));
  let passed = result.exitCode === 0;

  if (passed && testCase.expectation === 'invoke') {
    passed = commands.length > 0
      && result.assistantText.includes(servedUrl(commands))
      && !/(^|\s)--no-open(?:\s|$)/.test(commandText)
      && new RegExp(testCase.expectedCommand).test(commandText)
      && responseMatches(testCase.responsePattern, result.assistantText)
      && !globallyInstalled;
  } else if (passed && testCase.expectation === 'blocker') {
    const commandMatches = testCase.expectedCommand === '-'
      ? commands.length === 0
      : new RegExp(testCase.expectedCommand).test(commandText);
    passed = commandMatches
      && !result.assistantText.includes(readyUrlBase)
      && responseMatches(testCase.responsePattern, result.assistantText)
      && !globallyInstalled;
  } else if (passed) {
    passed = commands.length === 0 && !result.assistantText.includes(readyUrlBase);
  }

  return { commands, passed };
}

function servedUrl(commands) {
  const tokens = commands[commands.length - 1].rawArgs.split(/\s+/)
    .filter((token) => token && !token.startsWith('-') && token !== 'showmd-cli');
  const file = tokens[tokens.length - 1];
  return file ? readyUrlBase + path.basename(file) : readyUrl;
}

export function parseCommandTrace(log) {
  return log.trim().split('\n').filter(Boolean).map((line) => {
    const match = line.match(/^(npm|npx)\s*(.*)$/);
    if (match) return { matchText: line, program: match[1], raw: line, rawArgs: match[2] };
    return { matchText: line, program: 'showmd', raw: line, rawArgs: line };
  });
}

export function runCommand(command, args, { cwd, env, input = '', outputFile, timeout }) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeout);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => chunks.push(Buffer.from(`${error.stack ?? error}\n`)));
    child.on('close', (status) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString('utf8');
      if (outputFile) writeFileSync(outputFile, output);
      resolve({ output, status: status ?? 1, timedOut });
    });
    child.stdin.end(input);
  });
}

export function findExecutable(name, searchPath) {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
    if (process.platform === 'win32' && existsSync(`${candidate}.exe`)) return `${candidate}.exe`;
  }
  return null;
}

export function readTextIfPresent(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export function preserveWorkspace(workspace, artifactRoot) {
  if (!artifactRoot) return workspace;
  mkdirSync(artifactRoot, { recursive: true });
  const destination = path.join(artifactRoot, path.basename(workspace));
  cpSync(workspace, destination, { recursive: true });
  rmSync(workspace, { recursive: true, force: true });
  return destination;
}

export function removeWorkspace(workspace) {
  rmSync(workspace, { recursive: true, force: true });
}

export function appendResult(file, record) {
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export function readResumeState(file, expected = {}) {
  const state = {
    behaviorFailed: false,
    completedTrials: new Set(),
    largestObservedTrial: 0,
    totalInputTokens: 0,
  };
  if (!file || !existsSync(file)) return state;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const result = JSON.parse(line);
    if (result.caseId && Number.isInteger(result.trial)) {
      if (expected.agent && result.agent !== expected.agent) {
        throw new Error(`resume manifest agent ${String(result.agent)} does not match ${expected.agent}`);
      }
      if (Object.hasOwn(expected, 'model') && result.model !== expected.model) {
        throw new Error(`resume manifest model ${String(result.model)} does not match ${String(expected.model)}`);
      }
      state.completedTrials.add(`${result.caseId}:${result.trial}`);
      state.behaviorFailed ||= result.behaviorStatus === 'FAIL';
      const inputTokens = Number(result.usage?.inputTokens ?? 0);
      state.totalInputTokens += inputTokens;
      state.largestObservedTrial = Math.max(state.largestObservedTrial, inputTokens);
    }
  }
  return state;
}

export function numberEnv(name, fallback, { allowZero = false } = {}) {
  const value = Number.parseInt(process.env[name] ?? `${fallback}`, 10);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function installFixtureExecutable(fixtureDir, fakeBin, source, destination) {
  copyFileSync(path.join(fixtureDir, 'bin', source), path.join(fakeBin, destination));
  chmodSync(path.join(fakeBin, destination), 0o755);
}

function responseMatches(pattern, output) {
  return pattern === '-' || new RegExp(pattern, 'i').test(output);
}
