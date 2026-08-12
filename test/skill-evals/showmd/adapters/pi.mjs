import { copyFileSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';

export const piAdapter = {
  id: 'pi',
  executable: 'pi',

  setup(context) {
    context.env.PI_CODING_AGENT_DIR = context.stateDir;
    context.env.PI_CODING_AGENT_SESSION_DIR = path.join(context.stateDir, 'sessions');
    context.env.PI_OFFLINE = '1';
    context.env.PI_SKIP_VERSION_CHECK = '1';
    context.env.PI_TELEMETRY = '0';
    mkdirSync(context.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
    const skillRoot = path.join(context.workspace, '.pi', 'skills');
    mkdirSync(skillRoot, { recursive: true });
    symlinkSync(context.skillDir, path.join(skillRoot, 'showmd'), 'dir');
    context.loadedSkillPath = path.join(skillRoot, 'showmd');

    const modelsFile = process.env.SHOWMD_EVAL_PI_MODELS_FILE;
    if (modelsFile) copyFileSync(modelsFile, path.join(context.stateDir, 'models.json'));
  },

  async preflight(context, runtime) {
    const execution = await runtime.runCommand(runtime.executable, ['--help'], {
      cwd: context.workspace,
      env: context.env,
      outputFile: context.isolationLog,
      timeout: runtime.timeoutMs,
    });
    const supported = execution.output.includes('--skill <path>')
      && execution.output.includes('--mode <mode>');
    return { status: execution.status === 0 && supported ? 0 : 90, supported: true };
  },

  async authenticate() {
    // Pi may use an environment API key or a local OpenAI-compatible provider.
    return 0;
  },

  invocation(context, model) {
    const args = [
      '--mode', 'json', '--print', '--no-session',
      '--no-extensions', '--no-prompt-templates', '--no-context-files',
      '--tools', 'read,bash,edit,write', '--skill', context.loadedSkillPath,
    ];
    const provider = process.env.SHOWMD_EVAL_PI_PROVIDER;
    const thinking = process.env.SHOWMD_EVAL_PI_THINKING;
    if (provider) args.push('--provider', provider);
    if (model) args.push('--model', model);
    if (thinking) args.push('--thinking', thinking);
    args.push(context.testCase.prompt);
    return args;
  },

  parseOutput(output) {
    const messages = [];
    const usage = {
      cachedInputTokens: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      raw: [],
      source: 'unavailable',
    };
    for (const event of jsonLines(output)) {
      if (event.type !== 'message_end' || event.message?.role !== 'assistant') continue;
      for (const content of event.message.content ?? []) {
        if (content.type === 'text' && content.text) messages.push(content.text);
      }
      if (event.message.usage) {
        const item = event.message.usage;
        usage.inputTokens += Number(item.input ?? 0)
          + Number(item.cacheRead ?? 0)
          + Number(item.cacheWrite ?? 0);
        usage.outputTokens += Number(item.output ?? 0);
        usage.cachedInputTokens += Number(item.cacheRead ?? 0) + Number(item.cacheWrite ?? 0);
        usage.costUsd += Number(item.cost?.total ?? 0);
        usage.raw.push(item);
        usage.source = 'reported';
      }
    }
    if (usage.source === 'unavailable') usage.costUsd = null;
    return { assistantText: messages.join('\n'), usage };
  },
};

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
