# ShowMD skill evals

These evals protect the boundary between a user-facing ShowMD interface and an
agent's ordinary Markdown work. The committed harness creates an empty HOME for
every trial and never reads a contributor's agent config, installed skills,
keychain, or authentication files.

## Free checks

The repository test suite validates the skill frontmatter, the 1024-character
description limit, Codex UI metadata, npm packaging, and canonical installation.
The Codex preflight validates project-skill discovery and executable isolation.
Claude Code has no equivalent prompt-inspection command, so its preflight checks
the isolated project skill path and executable resolution without making a model
request. Pi checks its isolated config directory, explicit skill path, supported
CLI protocol, and executable resolution:

```sh
SHOWMD_EVAL_PREFLIGHT_ONLY=1 ./test/skill-evals/showmd/runners/codex.sh 1 '' '^(01|17|18|19)$'
SHOWMD_EVAL_PREFLIGHT_ONLY=1 ./test/skill-evals/showmd/runners/claude.sh 1 '' '^(01|17|18|19)$'
SHOWMD_EVAL_PREFLIGHT_ONLY=1 ./test/skill-evals/showmd/runners/pi.sh 1 '' '^(01|17|18|19)$'
```

Both commands require the corresponding CLI on PATH but require no API key.

## Low-cost semantic eval

This sends only the skill description and the shared case corpus in one request.
It checks whether the description separates `invoke` from `quiet`; it does not
exercise agent skill discovery or tools.

```sh
OPENAI_API_KEY=... node test/skill-evals/showmd/run-semantic.mjs openai <model> [trials]
ANTHROPIC_API_KEY=... node test/skill-evals/showmd/run-semantic.mjs anthropic <model> [trials]
```

The default input-token ceiling is 10,000. Override it with
`SHOWMD_EVAL_SEMANTIC_MAX_INPUT_TOKENS` only when intentionally changing the
corpus size.

## Full agent canaries

The adapters consume the same `cases.tsv` corpus and observable assertions:

```sh
./test/skill-evals/showmd/runners/codex.sh [trials] [model] [case-regex]
./test/skill-evals/showmd/runners/claude.sh [trials] [model] [case-regex]
./test/skill-evals/showmd/runners/pi.sh [trials] [model] [case-regex]
```

Use one trial for routine checks. A representative canary is:

```sh
./test/skill-evals/showmd/runners/codex.sh 1 <model> \
  '^(01|02|03|08|12|15|17|18|19)$'
```

For a formal manual or release gate, use two or more trials. The manual GitHub
Actions workflow defaults to two trials for both the semantic and full-agent
lanes.

Codex accepts `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, or an explicitly supplied
`SHOWMD_EVAL_CODEX_AUTH_FILE`. Claude requires `ANTHROPIC_API_KEY`. Pi accepts
its provider's standard environment variable; it never reads Pi's user config
or saved authentication. The runner does not
discover credentials itself. GitHub Actions supplies keys through repository
secrets and runs Codex and Claude model evals only through the manual workflow.

For a local Ollama model through Pi, copy and edit the public example rather
than referencing a personal Pi configuration:

```sh
SHOWMD_EVAL_PI_PROVIDER=ollama \
SHOWMD_EVAL_PI_MODELS_FILE=test/skill-evals/showmd/fixtures/pi-models.ollama.example.json \
./test/skill-evals/showmd/runners/pi.sh 1 qwen2.5-coder:7b '^(01|10|17)$'
```

`SHOWMD_EVAL_PI_MODELS_FILE` is copied into the trial's empty agent state. The
path may point to another public, reproducible configuration for vLLM, LM Studio,
or an OpenAI-compatible service. `SHOWMD_EVAL_PI_THINKING` optionally selects a
Pi thinking level.

Every trial gets a temporary workspace, empty HOME, isolated agent state,
project-local symlink to the production `skills/showmd` directory, and fake
executables. Agent-specific skill locations, CLI flags, authentication, and
event parsing live in adapters; the cases, fixtures, scheduling, command trace,
assertions, budgets, and result records are shared. Installed cases use
fake `showmd`; case 17 expects a successful fake `npx -y showmd-cli`; case 18
removes npx; case 19 makes the fake download fail. Positive cases require the
expected command and exact ready URL in user-facing assistant text. Blocker
cases require a user-facing explanation and no ready URL. Every case rejects
`--no-open` and global npm installation where applicable; quiet cases require no
invocation and no ready URL.

Trials run breadth-first: trial 1 covers every selected case before trial 2
starts. Before scheduling another trial, the runner reserves the larger of the
largest observed trial and the configured minimum reserve. This preserves broad
coverage when a suite approaches its ceiling. A budget stop is reported as
`INCOMPLETE` separately from behavioral failure.

The default limits are 180 seconds, 100,000 input tokens per trial, 500,000 input
tokens per suite, and USD 0.25 per Claude trial. Configure them with:

- `SHOWMD_EVAL_TIMEOUT_MS`
- `SHOWMD_EVAL_MAX_INPUT_TOKENS`
- `SHOWMD_EVAL_MAX_TOTAL_INPUT_TOKENS`
- `SHOWMD_EVAL_MIN_TRIAL_RESERVE_INPUT_TOKENS`
- `SHOWMD_EVAL_REQUIRE_USAGE=1` to make unavailable token telemetry incomplete
- `SHOWMD_EVAL_CLAUDE_MAX_BUDGET_USD`
- `SHOWMD_EVAL_ARTIFACT_DIR` to store JSONL results and retained workspaces
- `SHOWMD_EVAL_RESULT_FILE` to override the JSONL result path
- `SHOWMD_EVAL_RESUME_FILE` to skip case/trial pairs already recorded

The runner writes one normalized JSONL record after every completed trial. A
behavioral failure exits 1; an otherwise clean suite stopped by its token budget
exits 3. GitHub Actions always uploads the result manifest, while workspaces are
retained only for failures and budget violations. When an agent or model backend
does not report usage, the record says `UNMETERED`; local free-model experiments
may accept that, while release workflows require telemetry.

Cases 01–09 cover preview, self-editing, artifact-like delivery, explicit product
vocabulary, and skills/config interfaces. Cases 10–16 cover internal reading,
checking, editing, review, keyword collisions, and inline output. Cases 17–19
cover successful on-demand execution, missing npm tooling, and download failure.
