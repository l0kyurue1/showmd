import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(suiteDir, '../../..');
const provider = process.argv[2];
const model = process.argv[3];
const trials = Number.parseInt(process.argv[4] ?? '1', 10);
const maxInputTokens = Number.parseInt(process.env.SHOWMD_EVAL_SEMANTIC_MAX_INPUT_TOKENS ?? '10000', 10);

if (!['openai', 'anthropic'].includes(provider) || !model || !Number.isInteger(trials) || trials < 1) {
  console.error('usage: node run-semantic.mjs <openai|anthropic> <model> [trials]');
  process.exit(2);
}

const cases = readFileSync(path.join(suiteDir, 'cases.tsv'), 'utf8').trim().split('\n').map((line) => {
  const [id, expectation, , , , prompt] = line.split('\t');
  return { id, expectation: expectation === 'quiet' ? 'quiet' : 'invoke', prompt };
});
const skill = readFileSync(path.join(repoRoot, 'skills', 'showmd', 'SKILL.md'), 'utf8');
const description = skill.match(/^description:\s*(.+)$/m)?.[1];
if (!description) throw new Error('SKILL.md has no one-line description');

const system = [
  'Decide whether an agent should invoke a skill from its description.',
  'Return one JSON object whose keys are the supplied case IDs and whose values are exactly "invoke" or "quiet".',
  'Judge only from the skill description and user request.',
  `Skill description: ${description}`,
].join('\n');
const user = cases.map(({ id, prompt }) => `${id}\t${prompt}`).join('\n');
let failed = false;
for (let trial = 1; trial <= trials; trial += 1) {
  const response = provider === 'openai'
    ? await callOpenAI(system, user)
    : await callAnthropic(system, user);
  const decisions = parseJsonObject(response.text);
  for (const testCase of cases) {
    const actual = decisions[testCase.id];
    const passed = actual === testCase.expectation;
    console.log(`${testCase.id} trial ${trial}: ${passed ? 'PASS' : `FAIL — expected ${testCase.expectation}, got ${String(actual)}`}`);
    failed ||= !passed;
  }
  console.log(`trial ${trial} usage: ${JSON.stringify(response.usage ?? {})}`);
  const inputTokens = Number(response.usage?.input_tokens ?? response.usage?.inputTokens ?? 0);
  if (inputTokens > maxInputTokens) {
    console.error(`semantic input-token budget exceeded: ${inputTokens} > ${maxInputTokens}`);
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;

async function callOpenAI(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  const result = await postJson('https://api.openai.com/v1/responses', apiKey, {
    model,
    input: [
      { role: 'developer', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'showmd_skill_routing',
        strict: true,
        schema: {
          type: 'object',
          properties: Object.fromEntries(cases.map(({ id }) => [id, { enum: ['invoke', 'quiet'] }])),
          required: cases.map(({ id }) => id),
          additionalProperties: false,
        },
      },
    },
  });
  const text = result.output_text ?? result.output?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === 'output_text')?.text;
  return { text, usage: result.usage };
}

async function callAnthropic(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
  const result = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  const body = await responseJson(result);
  const text = body.content?.find((item) => item.type === 'text')?.text;
  return { text, usage: body.usage };
}

async function postJson(url, apiKey, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return responseJson(response);
}

async function responseJson(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(body)}`);
  return body;
}

function parseJsonObject(text) {
  if (!text) throw new Error('model returned no text');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`model returned no JSON object: ${text}`);
  return JSON.parse(match[0]);
}
