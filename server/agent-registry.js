'use strict';
const fs = require('node:fs');
const path = require('node:path');

// home-relative bases with real-CLI env var overrides, mirroring the
// `skills` CLI's own home constants (dist/cli.mjs)
function claudeHome(home) { return (process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(home, '.claude'); }
function codexHome(home) { return (process.env.CODEX_HOME || '').trim() || path.join(home, '.codex'); }
function configHome(home) { return (process.env.XDG_CONFIG_HOME || '').trim() || path.join(home, '.config'); }
function autohandHome(home) { return (process.env.AUTOHAND_HOME || '').trim() || path.join(home, '.autohand'); }
function vibeHome(home) { return (process.env.VIBE_HOME || '').trim() || path.join(home, '.vibe'); }
function hermesHome(home) { return (process.env.HERMES_HOME || '').trim() || path.join(home, '.hermes'); }

function packageJsonHasDependency(packageJsonPath, name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return !!((pkg.dependencies && pkg.dependencies[name]) || (pkg.devDependencies && pkg.devDependencies[name]));
  } catch {
    return false;
  }
}

// Mirrors `npx skills list -g` order. Universal agents read .agents/skills;
// config browsing metadata exists only for supported agents.
const AGENT_REGISTRY = [
  { name: "aider-desk", displayName: "AiderDesk", universal: false, detect: (home) => fs.existsSync(path.join(home, ".aider-desk")), globalDir: (home) => path.join(home, ".aider-desk/skills") },
  { name: "amp", displayName: "Amp", universal: true, detect: (home) => fs.existsSync(path.join(configHome(home), "amp")), globalDir: (home) => path.join(configHome(home), "agents/skills") },
  { name: "antigravity", displayName: "Antigravity", universal: true, detect: (home) => fs.existsSync(path.join(home, ".gemini/antigravity")), globalDir: (home) => path.join(home, ".gemini/antigravity/skills") },
  { name: "antigravity-cli", displayName: "Antigravity CLI", universal: true, detect: (home) => fs.existsSync(path.join(home, ".gemini/antigravity-cli")), globalDir: (home) => path.join(home, ".gemini/antigravity-cli/skills") },
  { name: "astrbot", displayName: "AstrBot", universal: false, detect: (home, cwd) => fs.existsSync(path.join(cwd, "data/skills")) || fs.existsSync(path.join(home, ".astrbot")), globalDir: (home) => path.join(home, ".astrbot/data/skills") },
  { name: "autohand-code", displayName: "Autohand Code CLI", universal: false, detect: (home) => fs.existsSync(autohandHome(home)), globalDir: (home) => path.join(autohandHome(home), "skills") },
  { name: "augment", displayName: "Augment", universal: false, detect: (home) => fs.existsSync(path.join(home, ".augment")), globalDir: (home) => path.join(home, ".augment/skills") },
  { name: "bob", displayName: "IBM Bob", universal: false, detect: (home) => fs.existsSync(path.join(home, ".bob")), globalDir: (home) => path.join(home, ".bob/skills") },
  { name: "claude-code", displayName: "Claude Code", universal: false, detect: (home) => fs.existsSync(claudeHome(home)), globalDir: (home) => path.join(claudeHome(home), "skills"), key: "claude", configLabel: "Claude", instructionsFile: (home) => path.join(claudeHome(home), "CLAUDE.md"), rulesDir: (home) => path.join(claudeHome(home), "rules"), projectsDir: (home) => path.join(claudeHome(home), "projects") },
  { name: "openclaw", displayName: "OpenClaw", universal: false, detect: (home) => fs.existsSync(path.join(home, '.openclaw')) || fs.existsSync(path.join(home, '.clawdbot')) || fs.existsSync(path.join(home, '.moltbot')), globalDir: (home) => fs.existsSync(path.join(home, '.openclaw')) ? path.join(home, '.openclaw/skills') : fs.existsSync(path.join(home, '.clawdbot')) ? path.join(home, '.clawdbot/skills') : path.join(home, '.moltbot/skills') },
  { name: "cline", displayName: "Cline", universal: true, detect: (home) => fs.existsSync(path.join(home, ".cline")), globalDir: (home) => path.join(home, ".agents", "skills") },
  { name: "codearts-agent", displayName: "CodeArts Agent", universal: false, detect: (home) => fs.existsSync(path.join(home, ".codeartsdoer")), globalDir: (home) => path.join(home, ".codeartsdoer/skills") },
  { name: "codebuddy", displayName: "CodeBuddy", universal: false, detect: (home, cwd) => fs.existsSync(path.join(cwd, ".codebuddy")) || fs.existsSync(path.join(home, ".codebuddy")), globalDir: (home) => path.join(home, ".codebuddy/skills") },
  { name: "codemaker", displayName: "Codemaker", universal: false, detect: (home) => fs.existsSync(path.join(home, ".codemaker")), globalDir: (home) => path.join(home, ".codemaker/skills") },
  { name: "codestudio", displayName: "Code Studio", universal: false, detect: (home) => fs.existsSync(path.join(home, ".codestudio")), globalDir: (home) => path.join(home, ".codestudio/skills") },
  { name: "codex", displayName: "Codex", universal: true, detect: (home) => fs.existsSync(codexHome(home)) || fs.existsSync("/etc/codex"), globalDir: (home) => path.join(codexHome(home), "skills"), key: "codex", instructionsFile: (home) => path.join(codexHome(home), "AGENTS.md"), rulesDir: null, projectsDir: null },
  { name: "command-code", displayName: "Command Code", universal: false, detect: (home) => fs.existsSync(path.join(home, ".commandcode")), globalDir: (home) => path.join(home, ".commandcode/skills") },
  { name: "continue", displayName: "Continue", universal: false, detect: (home, cwd) => fs.existsSync(path.join(cwd, ".continue")) || fs.existsSync(path.join(home, ".continue")), globalDir: (home) => path.join(home, ".continue/skills") },
  { name: "cortex", displayName: "Cortex Code", universal: false, detect: (home) => fs.existsSync(path.join(home, ".snowflake/cortex")), globalDir: (home) => path.join(home, ".snowflake/cortex/skills") },
  { name: "crush", displayName: "Crush", universal: false, detect: (home) => fs.existsSync(path.join(home, ".config/crush")), globalDir: (home) => path.join(home, ".config/crush/skills") },
  { name: "cursor", displayName: "Cursor", universal: true, detect: (home) => fs.existsSync(path.join(home, ".cursor")), globalDir: (home) => path.join(home, ".cursor/skills") },
  { name: "deepagents", displayName: "Deep Agents", universal: true, detect: (home) => fs.existsSync(path.join(home, ".deepagents")), globalDir: (home) => path.join(home, ".deepagents/agent/skills") },
  { name: "devin", displayName: "Devin for Terminal", universal: false, detect: (home) => fs.existsSync(path.join(configHome(home), "devin")), globalDir: (home) => path.join(configHome(home), "devin/skills") },
  { name: "dexto", displayName: "Dexto", universal: true, detect: (home) => fs.existsSync(path.join(home, ".dexto")), globalDir: (home) => path.join(home, ".agents/skills") },
  { name: "droid", displayName: "Droid", universal: false, detect: (home) => fs.existsSync(path.join(home, ".factory")), globalDir: (home) => path.join(home, ".factory/skills") },
  { name: "eve", displayName: "Eve", universal: false, detect: (home, cwd) => fs.existsSync(path.join(cwd, 'agent')) && packageJsonHasDependency(path.join(cwd, 'package.json'), 'eve'), globalDir: null },
  { name: "firebender", displayName: "Firebender", universal: true, detect: (home) => fs.existsSync(path.join(home, ".firebender")), globalDir: (home) => path.join(home, ".firebender/skills") },
  { name: "forgecode", displayName: "ForgeCode", universal: false, detect: (home) => fs.existsSync(path.join(home, ".forge")), globalDir: (home) => path.join(home, ".forge/skills") },
  { name: "gemini-cli", displayName: "Gemini CLI", universal: true, detect: (home) => fs.existsSync(path.join(home, ".gemini")), globalDir: (home) => path.join(home, ".gemini/skills") },
  { name: "github-copilot", displayName: "GitHub Copilot", universal: true, detect: (home) => fs.existsSync(path.join(home, ".copilot")), globalDir: (home) => path.join(home, ".copilot/skills") },
  { name: "goose", displayName: "Goose", universal: false, detect: (home) => fs.existsSync(path.join(configHome(home), "goose")), globalDir: (home) => path.join(configHome(home), "goose/skills") },
  { name: "hermes-agent", displayName: "Hermes Agent", universal: false, detect: (home) => fs.existsSync(hermesHome(home)), globalDir: (home) => path.join(hermesHome(home), "skills") },
  { name: "inference-sh", displayName: "inference.sh", universal: false, detect: (home) => fs.existsSync(path.join(home, ".inferencesh")), globalDir: (home) => path.join(home, ".inferencesh/skills") },
  { name: "jazz", displayName: "Jazz", universal: false, detect: (home, cwd) => fs.existsSync(path.join(home, ".jazz")) || fs.existsSync(path.join(cwd, ".jazz")), globalDir: (home) => path.join(home, ".jazz/skills") },
  { name: "junie", displayName: "Junie", universal: false, detect: (home) => fs.existsSync(path.join(home, ".junie")), globalDir: (home) => path.join(home, ".junie/skills") },
  { name: "iflow-cli", displayName: "iFlow CLI", universal: false, detect: (home) => fs.existsSync(path.join(home, ".iflow")), globalDir: (home) => path.join(home, ".iflow/skills") },
  { name: "kilo", displayName: "Kilo Code", universal: false, detect: (home) => fs.existsSync(path.join(home, ".kilocode")), globalDir: (home) => path.join(home, ".kilocode/skills") },
  { name: "kimi-code-cli", displayName: "Kimi Code CLI", universal: true, detect: (home) => fs.existsSync(path.join(home, ".kimi-code")) || fs.existsSync(path.join(home, ".kimi")), globalDir: (home) => path.join(home, ".agents/skills") },
  { name: "kiro-cli", displayName: "Kiro CLI", universal: false, detect: (home) => fs.existsSync(path.join(home, ".kiro")), globalDir: (home) => path.join(home, ".kiro/skills") },
  { name: "kode", displayName: "Kode", universal: false, detect: (home) => fs.existsSync(path.join(home, ".kode")), globalDir: (home) => path.join(home, ".kode/skills") },
  { name: "lingma", displayName: "Lingma", universal: false, detect: (home) => fs.existsSync(path.join(home, ".lingma")), globalDir: (home) => path.join(home, ".lingma/skills") },
  { name: "loaf", displayName: "Loaf", universal: true, detect: (home) => fs.existsSync(path.join(home, ".loaf")), globalDir: (home) => path.join(home, ".agents/skills") },
  { name: "mcpjam", displayName: "MCPJam", universal: false, detect: (home) => fs.existsSync(path.join(home, ".mcpjam")), globalDir: (home) => path.join(home, ".mcpjam/skills") },
  { name: "mistral-vibe", displayName: "Mistral Vibe", universal: false, detect: (home) => fs.existsSync(vibeHome(home)), globalDir: (home) => path.join(vibeHome(home), "skills") },
  { name: "moxby", displayName: "Moxby", universal: false, detect: (home) => fs.existsSync(path.join(home, ".moxby")), globalDir: (home) => path.join(home, ".moxby/skills") },
  { name: "mux", displayName: "Mux", universal: false, detect: (home) => fs.existsSync(path.join(home, ".mux")), globalDir: (home) => path.join(home, ".mux/skills") },
  { name: "opencode", displayName: "OpenCode", universal: true, detect: (home) => fs.existsSync(path.join(configHome(home), "opencode")), globalDir: (home) => path.join(configHome(home), "opencode/skills") },
  { name: "openhands", displayName: "OpenHands", universal: false, detect: (home) => fs.existsSync(path.join(home, ".openhands")), globalDir: (home) => path.join(home, ".openhands/skills") },
  { name: "ona", displayName: "Ona", universal: false, detect: (home) => fs.existsSync(path.join(home, ".ona")), globalDir: (home) => path.join(home, ".ona/skills") },
  { name: "pi", displayName: "Pi", universal: false, detect: (home) => fs.existsSync(path.join(home, ".pi/agent")), globalDir: (home) => path.join(home, ".pi/agent/skills") },
  { name: "qoder", displayName: "Qoder", universal: false, detect: (home) => fs.existsSync(path.join(home, ".qoder")), globalDir: (home) => path.join(home, ".qoder/skills") },
  { name: "qoder-cn", displayName: "Qoder CN", universal: false, detect: (home) => fs.existsSync(path.join(home, ".qoder-cn")), globalDir: (home) => path.join(home, ".qoder-cn/skills") },
  { name: "qwen-code", displayName: "Qwen Code", universal: false, detect: (home) => fs.existsSync(path.join(home, ".qwen")), globalDir: (home) => path.join(home, ".qwen/skills") },
  { name: "replit", displayName: "Replit", universal: true, detect: (home, cwd) => fs.existsSync(path.join(cwd, ".replit")), globalDir: (home) => path.join(configHome(home), "agents/skills") },
  { name: "reasonix", displayName: "Reasonix", universal: false, detect: (home) => fs.existsSync(path.join(home, ".reasonix")), globalDir: (home) => path.join(home, ".reasonix/skills") },
  { name: "rovodev", displayName: "Rovo Dev", universal: false, detect: (home) => fs.existsSync(path.join(home, ".rovodev")), globalDir: (home) => path.join(home, ".rovodev/skills") },
  { name: "roo", displayName: "Roo Code", universal: false, detect: (home) => fs.existsSync(path.join(home, ".roo")), globalDir: (home) => path.join(home, ".roo/skills") },
  { name: "tabnine-cli", displayName: "Tabnine CLI", universal: false, detect: (home) => fs.existsSync(path.join(home, ".tabnine")), globalDir: (home) => path.join(home, ".tabnine/agent/skills") },
  { name: "terramind", displayName: "Terramind", universal: false, detect: (home) => fs.existsSync(path.join(home, ".terramind")), globalDir: (home) => path.join(home, ".terramind/skills") },
  { name: "tinycloud", displayName: "Tinycloud", universal: false, detect: (home) => fs.existsSync(path.join(home, ".tinycloud")), globalDir: (home) => path.join(home, ".tinycloud/skills") },
  { name: "trae", displayName: "Trae", universal: false, detect: (home) => fs.existsSync(path.join(home, ".trae")), globalDir: (home) => path.join(home, ".trae/skills") },
  { name: "trae-cn", displayName: "Trae CN", universal: false, detect: (home) => fs.existsSync(path.join(home, ".trae-cn")), globalDir: (home) => path.join(home, ".trae-cn/skills") },
  { name: "warp", displayName: "Warp", universal: true, detect: (home) => fs.existsSync(path.join(home, ".warp")), globalDir: (home) => path.join(home, ".agents/skills") },
  { name: "windsurf", displayName: "Windsurf", universal: false, detect: (home) => fs.existsSync(path.join(home, ".codeium/windsurf")), globalDir: (home) => path.join(home, ".codeium/windsurf/skills") },
  { name: "zed", displayName: "Zed", universal: true, detect: (home) => fs.existsSync(path.join(configHome(home), 'zed')) || (!!process.env.APPDATA && fs.existsSync(path.join(process.env.APPDATA, 'Zed'))) || (!!process.env.FLATPAK_XDG_CONFIG_HOME && fs.existsSync(path.join(process.env.FLATPAK_XDG_CONFIG_HOME, 'zed'))), globalDir: (home) => path.join(home, '.agents', 'skills') },
  { name: "zcode", displayName: "ZCode", universal: false, detect: (home) => fs.existsSync(path.join(home, '.zcode')) || fs.existsSync('/Applications/ZCode.app'), globalDir: (home) => path.join(home, '.zcode/skills') },
  { name: "zencoder", displayName: "Zencoder", universal: false, detect: (home) => fs.existsSync(path.join(home, ".zencoder")), globalDir: (home) => path.join(home, ".zencoder/skills") },
  { name: "zenflow", displayName: "Zenflow", universal: false, detect: (home) => fs.existsSync(path.join(home, ".zencoder")), globalDir: (home) => path.join(home, ".zencoder/skills") },
  { name: "neovate", displayName: "Neovate", universal: false, detect: (home) => fs.existsSync(path.join(home, ".neovate")), globalDir: (home) => path.join(home, ".neovate/skills") },
  { name: "pochi", displayName: "Pochi", universal: false, detect: (home) => fs.existsSync(path.join(home, ".pochi")), globalDir: (home) => path.join(home, ".pochi/skills") },
  { name: "promptscript", displayName: "PromptScript", universal: true, detect: (home, cwd) => fs.existsSync(path.join(cwd, '.promptscript')) || fs.existsSync(path.join(cwd, 'promptscript.yaml')), globalDir: null },
  { name: "adal", displayName: "AdaL", universal: false, detect: (home) => fs.existsSync(path.join(home, ".adal")), globalDir: (home) => path.join(home, ".adal/skills") },
  { name: "universal", displayName: "Universal", universal: true, detect: () => false, globalDir: null },
];

module.exports = AGENT_REGISTRY;
