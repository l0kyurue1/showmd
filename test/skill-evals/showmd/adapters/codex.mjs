import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const codexAdapter = {
  id: 'codex',
  executable: 'codex',

  setup(context) {
    context.env.CODEX_HOME = context.stateDir;
    writeFileSync(path.join(context.stateDir, 'config.toml'), [
      'check_for_update_on_startup = false',
      'allow_login_shell = false',
      '[shell_environment_policy]',
      'inherit = "all"',
      '',
    ].join('\n'));
    const skillRoot = path.join(context.workspace, '.agents', 'skills');
    mkdirSync(skillRoot, { recursive: true });
    symlinkSync(context.skillDir, path.join(skillRoot, 'showmd'), 'dir');
    context.loadedSkillPath = path.join(skillRoot, 'showmd', 'SKILL.md');
  },

  async preflight(context, runtime) {
    const execution = await runtime.runCommand(runtime.executable,
      ['--cd', context.workspace, 'debug', 'prompt-input', context.testCase.prompt], {
        cwd: context.workspace,
        env: context.env,
        outputFile: context.isolationLog,
        timeout: runtime.timeoutMs,
      });
    if (execution.status !== 0) return { status: execution.status, supported: true };
    const promptInput = readFileSync(context.isolationLog, 'utf8');
    if (!promptInput.includes(context.loadedSkillPath)) return { status: 90, supported: true };
    if (promptInput.includes(path.join(os.homedir(), '.agents', 'skills'))) {
      return { status: 91, supported: true };
    }
    if (promptInput.includes('skills context budget')) return { status: 92, supported: true };
    return { status: 0, supported: true };
  },

  async authenticate(context, runtime) {
    const explicitAuth = process.env.SHOWMD_EVAL_CODEX_AUTH_FILE;
    if (explicitAuth) {
      if (!existsSync(explicitAuth)) {
        console.error(`  SHOWMD_EVAL_CODEX_AUTH_FILE does not exist: ${explicitAuth}`);
        return 94;
      }
      copyFileSync(explicitAuth, path.join(context.stateDir, 'auth.json'));
      return 0;
    }
    const secret = context.env.OPENAI_API_KEY || context.env.CODEX_ACCESS_TOKEN;
    if (!secret) {
      console.error('  OPENAI_API_KEY, CODEX_ACCESS_TOKEN, or SHOWMD_EVAL_CODEX_AUTH_FILE is required for model evals; preflight needs no key');
      return 94;
    }
    const flag = context.env.OPENAI_API_KEY ? '--with-api-key' : '--with-access-token';
    const login = await runtime.runCommand(runtime.executable, ['login', flag], {
      cwd: runtime.repoRoot,
      env: context.env,
      input: `${secret}\n`,
      timeout: runtime.timeoutMs,
    });
    return login.status;
  },

  invocation(context, model) {
    const args = [
      'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules',
      '--sandbox', 'workspace-write', '--cd', context.workspace, '--json',
    ];
    if (model) args.push('--model', model);
    args.push(context.testCase.prompt);
    return args;
  },

  parseOutput(output) {
    const messages = [];
    let latestUsage = null;
    for (const event of jsonLines(output)) {
      findUsage(event);
      if (event.type === 'item.completed'
        && event.item?.type === 'agent_message' && event.item.text) {
        messages.push(event.item.text);
      }
    }
    return { assistantText: messages.join('\n'), usage: normalizeUsage(latestUsage) };

    function findUsage(value) {
      if (!value || typeof value !== 'object') return;
      if (value.usage && typeof value.usage === 'object') latestUsage = value.usage;
      for (const child of Object.values(value)) findUsage(child);
    }
  },
};

function normalizeUsage(usage) {
  return {
    cachedInputTokens: Number(usage?.cached_input_tokens ?? 0),
    costUsd: null,
    inputTokens: Number(usage?.input_tokens ?? 0),
    outputTokens: Number(usage?.output_tokens ?? 0),
    raw: usage,
    source: usage ? 'reported' : 'unavailable',
  };
}

function jsonLines(output) {
  const events = [];
  for (const line of output.split('\n')) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Stream output may include non-JSON diagnostics.
    }
  }
  return events;
}
