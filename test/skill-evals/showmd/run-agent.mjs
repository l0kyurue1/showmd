import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeAdapter } from './adapters/claude.mjs';
import { codexAdapter } from './adapters/codex.mjs';
import { piAdapter } from './adapters/pi.mjs';
import {
  appendResult,
  createWorkspace,
  evaluateBehavior,
  findExecutable,
  numberEnv,
  preserveWorkspace,
  readCases,
  readResumeState,
  readTextIfPresent,
  removeWorkspace,
  runCommand,
  verifyExecutableIsolation,
} from './eval-core.mjs';

const suiteDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(suiteDir, '../../..');
const skillDir = path.join(repoRoot, 'skills', 'showmd');
const fixtureDir = path.join(suiteDir, 'fixtures');
const adapters = new Map([
  [codexAdapter.id, codexAdapter],
  [claudeAdapter.id, claudeAdapter],
  [piAdapter.id, piAdapter],
]);
const agentId = process.argv[2];
const trials = Number.parseInt(process.argv[3] ?? '1', 10);
const model = process.argv[4] ?? '';
const caseRegex = process.argv[5] ? new RegExp(process.argv[5]) : null;
const adapter = adapters.get(agentId);
const preflightOnly = process.env.SHOWMD_EVAL_PREFLIGHT_ONLY === '1';
const timeoutMs = numberEnv('SHOWMD_EVAL_TIMEOUT_MS', 180_000);
const maxInputTokens = numberEnv('SHOWMD_EVAL_MAX_INPUT_TOKENS', 100_000);
const maxTotalInputTokens = numberEnv('SHOWMD_EVAL_MAX_TOTAL_INPUT_TOKENS', 500_000);
const minimumReserve = numberEnv('SHOWMD_EVAL_MIN_TRIAL_RESERVE_INPUT_TOKENS', 0, { allowZero: true });
const requireUsage = process.env.SHOWMD_EVAL_REQUIRE_USAGE === '1';
const artifactRoot = process.env.SHOWMD_EVAL_ARTIFACT_DIR;
const resultFile = process.env.SHOWMD_EVAL_RESULT_FILE
  ?? (artifactRoot ? path.join(artifactRoot, `${agentId}-results.jsonl`) : null);
const resumeFile = process.env.SHOWMD_EVAL_RESUME_FILE;

if (!adapter) {
  console.error(`usage: node run-agent.mjs <${[...adapters.keys()].join('|')}> [trials] [model] [case-regex]`);
  process.exit(2);
}
if (!Number.isInteger(trials) || trials < 1) {
  console.error('trials must be a positive integer');
  process.exit(2);
}

const executable = findExecutable(adapter.executable, process.env.PATH ?? '');
if (!executable) {
  console.error(`${adapter.executable} is required to run ${agentId} trigger evals`);
  process.exit(2);
}

const cases = readCases(suiteDir).filter((testCase) => !caseRegex || caseRegex.test(testCase.id));
const resumeState = readResumeState(resumeFile, { agent: agentId, model: model || null });
const completedTrials = resumeState.completedTrials;
let behaviorFailed = resumeState.behaviorFailed;
let budgetIncomplete = false;
let usageUnavailable = false;
let totalInputTokens = resumeState.totalInputTokens;
let largestObservedTrial = resumeState.largestObservedTrial;
let stopScheduling = false;

for (let trial = 1; trial <= trials && !stopScheduling; trial += 1) {
  for (const testCase of cases) {
    const trialKey = `${testCase.id}:${trial}`;
    if (completedTrials.has(trialKey)) {
      console.log(`${testCase.id} trial ${trial}: RESUME SKIP`);
      continue;
    }

    if (!preflightOnly && shouldStopBeforeNextTrial()) {
      budgetIncomplete = true;
      stopScheduling = true;
      const remaining = Math.max(0, maxTotalInputTokens - totalInputTokens);
      console.log(`suite budget reserve reached before ${testCase.id} trial ${trial}: ${remaining} input tokens remain`);
      break;
    }

    const result = await runTrial(testCase);
    if (result.preflight) {
      const detail = result.preflightSupported ? '' : ' (prompt inspection unsupported)';
      console.log(`${testCase.id} trial ${trial}: ISOLATION PASS${detail}`);
      continue;
    }

    const inputTokens = result.usage.inputTokens;
    const trialUsageUnavailable = result.usage.source === 'unavailable';
    usageUnavailable ||= trialUsageUnavailable;
    totalInputTokens += inputTokens;
    largestObservedTrial = Math.max(largestObservedTrial, inputTokens);
    const perTrialBudgetExceeded = inputTokens > maxInputTokens;
    const suiteBudgetExceeded = totalInputTokens > maxTotalInputTokens;
    const budgetExceeded = perTrialBudgetExceeded || suiteBudgetExceeded;
    if (trialUsageUnavailable && requireUsage) budgetIncomplete = true;
    behaviorFailed ||= !result.behaviorPassed;
    budgetIncomplete ||= budgetExceeded;

    let outcome = result.behaviorPassed ? 'PASS' : 'FAIL';
    if (budgetExceeded) outcome = result.behaviorPassed ? 'BUDGET_EXCEEDED' : 'FAIL_AND_BUDGET_EXCEEDED';
    const keepWorkspace = !result.behaviorPassed || budgetExceeded;
    let artifacts = null;
    if (keepWorkspace) artifacts = preserveWorkspace(result.workspace, artifactRoot);
    else removeWorkspace(result.workspace);

    console.log(`${testCase.id} trial ${trial}: ${outcome}${artifacts ? ` — artifacts: ${artifacts}` : ''}`);
    console.log(`  usage: ${JSON.stringify(result.usage)}`);
    if (trialUsageUnavailable) console.log('  input-token usage unavailable; token ceiling was not enforceable');
    if (perTrialBudgetExceeded) {
      console.log(`  input-token budget exceeded: ${inputTokens} > ${maxInputTokens}`);
    }
    if (suiteBudgetExceeded) {
      console.log(`  suite input-token budget exceeded: ${totalInputTokens} > ${maxTotalInputTokens}`);
    }

    appendResult(resultFile, {
      agent: agentId,
      artifacts,
      behaviorStatus: result.behaviorPassed ? 'PASS' : 'FAIL',
      budgetStatus: budgetExceeded ? 'EXCEEDED' : (trialUsageUnavailable ? 'UNMETERED' : 'PASS'),
      caseId: testCase.id,
      model: model || null,
      outcome,
      trial,
      usage: result.usage,
    });

    if (budgetExceeded) {
      stopScheduling = true;
      break;
    }
  }
}

if (!preflightOnly) {
  appendResult(resultFile, {
    agent: agentId,
    behaviorStatus: behaviorFailed ? 'FAIL' : 'PASS',
    budgetStatus: budgetIncomplete ? 'INCOMPLETE' : (usageUnavailable ? 'UNMETERED' : 'PASS'),
    model: model || null,
    totalInputTokens,
    type: 'suite_summary',
  });
}

process.exitCode = behaviorFailed ? 1 : (budgetIncomplete ? 3 : 0);

function shouldStopBeforeNextTrial() {
  if (totalInputTokens >= maxTotalInputTokens) return true;
  if (totalInputTokens === 0) return false;
  const projectedNextTrial = Math.max(minimumReserve, largestObservedTrial);
  return maxTotalInputTokens - totalInputTokens < projectedNextTrial;
}

async function runTrial(testCase) {
  const context = createWorkspace({ adapter, fixtureDir, skillDir, testCase });
  const runtime = { executable, repoRoot, runCommand, timeoutMs };
  let status = 0;
  let preflight = { status: 0, supported: false };

  try {
    adapter.setup(context);
    preflight = await adapter.preflight(context, runtime);
    status = preflight.status;

    const executableIsolation = verifyExecutableIsolation(context);
    if (status === 0 && !executableIsolation.passed) status = 93;

    if (status === 0 && preflightOnly) {
      removeWorkspace(context.workspace);
      return { preflight: true, preflightSupported: preflight.supported };
    }

    if (status === 0) status = await adapter.authenticate(context, runtime);
    if (status === 0) {
      const execution = await runCommand(executable, adapter.invocation(context, model), {
        cwd: context.workspace,
        env: context.env,
        outputFile: context.outputLog,
        timeout: timeoutMs,
      });
      status = execution.timedOut ? 124 : execution.status;
    }
  } catch (error) {
    status = 95;
    console.error(`  adapter error: ${error.stack ?? error}`);
  }

  const output = readTextIfPresent(context.outputLog);
  const parsed = adapter.parseOutput(output);
  const invocationLog = readTextIfPresent(context.invocationLog).trim();
  const behavior = evaluateBehavior(testCase, {
    assistantText: parsed.assistantText,
    exitCode: status,
  }, invocationLog);

  return {
    behaviorPassed: behavior.passed,
    commands: behavior.commands,
    usage: parsed.usage,
    workspace: context.workspace,
  };
}
