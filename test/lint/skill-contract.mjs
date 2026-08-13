import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const skill = readFileSync(path.join(root, 'skills/showmd/SKILL.md'), 'utf8');
const metadata = readFileSync(path.join(root, 'skills/showmd/agents/openai.yaml'), 'utf8');
const failures = [];
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];

if (!frontmatter) failures.push('SKILL.md must begin with YAML frontmatter');
const name = frontmatter?.match(/^name:\s*(.+)$/m)?.[1];
const descriptionSource = frontmatter?.match(/^description:\s*(.+)$/m)?.[1];
let description;
try {
  description = JSON.parse(descriptionSource);
} catch {
  failures.push('SKILL.md frontmatter description must be a double-quoted YAML string');
}
if (name !== 'showmd') failures.push('SKILL.md frontmatter name must be showmd');
if (!description) failures.push('SKILL.md frontmatter needs a one-line description');
else if (description.length > 1024) failures.push(`SKILL.md description is ${description.length} characters; maximum is 1024`);

// agent evals record argv only, so backgrounding is observable nowhere cheaper
const body = skill.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '');
if (!/launch[^.]*background|background[^.]*launch/i.test(body)) failures.push('SKILL.md must tell the agent to launch ShowMD in the background');

if (!/^interface:\s*$/m.test(metadata)) failures.push('openai.yaml needs an interface mapping');
if (!/^\s{2}display_name:\s*"ShowMD"\s*$/m.test(metadata)) failures.push('openai.yaml display_name must preserve the ShowMD brand');
const defaultPrompt = metadata.match(/^\s{2}default_prompt:\s*"(.+)"\s*$/m)?.[1];
if (!defaultPrompt?.includes('$showmd')) failures.push('openai.yaml default_prompt must explicitly mention $showmd');

if (failures.length) {
  console.error('skill-contract:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`skill-contract: valid metadata; description ${description.length}/1024 characters`);
}
