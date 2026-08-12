import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';

export const claudeAdapter = {
  id: 'claude',
  executable: 'claude',

  setup(context) {
    context.env.CLAUDE_CONFIG_DIR = context.stateDir;
    const skillRoot = path.join(context.workspace, '.claude', 'skills');
    mkdirSync(skillRoot, { recursive: true });
    symlinkSync(context.skillDir, path.join(skillRoot, 'showmd'), 'dir');
    context.loadedSkillPath = path.join(skillRoot, 'showmd', 'SKILL.md');
  },

  async preflight(context) {
    return { status: existsSync(context.loadedSkillPath) ? 0 : 90, supported: false };
  },

  async authenticate(context) {
    if (context.env.ANTHROPIC_API_KEY || context.env.CLAUDE_CODE_OAUTH_TOKEN) return 0;
    console.error('  ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) is required for model evals; preflight needs no key');
    return 94;
  },

  invocation(context, model) {
    const args = [
      '-p', '--no-session-persistence', '--setting-sources', 'project',
      '--exclude-dynamic-system-prompt-sections',
      '--tools', 'Bash,Read,Edit,Write,Skill',
      // Bash(showmd *) prefix rules cannot match the skill's compound background launch
      '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Skill',
      '--permission-mode', 'dontAsk', '--output-format', 'stream-json', '--verbose',
      '--max-budget-usd', process.env.SHOWMD_EVAL_CLAUDE_MAX_BUDGET_USD ?? '0.25',
    ];
    if (model) args.push('--model', model);
    args.push(context.testCase.prompt);
    return args;
  },

  parseOutput(output) {
    const messages = [];
    let latestUsage = null;
    let costUsd = null;
    for (const event of jsonLines(output)) {
      if (event.type === 'assistant') {
        for (const content of event.message?.content ?? []) {
          if (content.type === 'text' && content.text) messages.push(content.text);
        }
      }
      if (event.type === 'result') {
        if (typeof event.result === 'string') messages.push(event.result);
        if (event.usage) latestUsage = event.usage;
        if (Number.isFinite(event.total_cost_usd)) costUsd = event.total_cost_usd;
      }
    }
    return {
      assistantText: messages.join('\n'),
      usage: {
        cachedInputTokens: Number(latestUsage?.cache_read_input_tokens ?? 0),
        costUsd,
        inputTokens: Number(latestUsage?.input_tokens ?? 0)
          + Number(latestUsage?.cache_creation_input_tokens ?? 0)
          + Number(latestUsage?.cache_read_input_tokens ?? 0),
        outputTokens: Number(latestUsage?.output_tokens ?? 0),
        raw: latestUsage,
        source: latestUsage ? 'reported' : 'unavailable',
      },
    };
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
