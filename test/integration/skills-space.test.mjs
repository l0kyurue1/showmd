import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createServer } = require('../../server/server.js');

function tmp(prefix) {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

function writeSkill(skillsDir, name, body) {
  const dir = path.join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), body);
  return dir;
}

// A private HOME keeps global discovery to the skills this test wrote, and
// hides ~/.claude.json so `scope=all` cannot wander into real projects.
async function withSkillsHome(fn) {
  const home = tmp('showmd-skills-home-');
  const prevHome = process.env.HOME;
  const prevSettings = process.env.SHOWMD_SETTINGS_HOME;
  process.env.HOME = home;
  process.env.SHOWMD_SETTINGS_HOME = path.join(home, 'settings');
  writeSkill(path.join(home, '.agents', 'skills'), 'demo', '# demo skill\n');
  const server = createServer(null);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, home);
  } finally {
    server.close();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevSettings === undefined) delete process.env.SHOWMD_SETTINGS_HOME;
    else process.env.SHOWMD_SETTINGS_HOME = prevSettings;
    rmSync(home, { recursive: true, force: true });
  }
}

function allSkills(tree) {
  return (tree.scopes || []).flatMap((scope) => [
    ...(scope.skills || []),
    ...(scope.groups || []).flatMap((group) => group.skills || []),
  ]);
}

test('GET /api/skills/tree: global selection emits restorable hrefs per skill', async () => {
  await withSkillsHome(async (base) => {
    const res = await fetch(`${base}/api/skills/tree`);
    assert.equal(res.status, 200);
    const tree = await res.json();
    const demo = allSkills(tree).find((s) => s.name === 'demo');
    assert.ok(demo, 'demo skill is discovered');
    assert.equal(demo.id, 'agents/demo/SKILL.md');
    assert.equal(demo.href, '/skills/agents/demo/SKILL.md');
  });
});

test('GET/PUT /api/skills/raw: read and write a skill document by id', async () => {
  await withSkillsHome(async (base, home) => {
    const res = await fetch(`${base}/api/skills/raw?id=${encodeURIComponent('agents/demo/SKILL.md')}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '# demo skill\n');

    const put = await fetch(`${base}/api/skills/raw?id=${encodeURIComponent('agents/demo/SKILL.md')}`, {
      method: 'PUT', body: '# edited\n',
    });
    assert.equal(put.status, 204);
    assert.equal(readFileSync(path.join(home, '.agents', 'skills', 'demo', 'SKILL.md'), 'utf8'), '# edited\n');
  });
});

test('GET /api/skills/raw: symlinked documents carry navigation headers', async () => {
  await withSkillsHome(async (base, home) => {
    const skillDir = path.join(home, '.agents', 'skills', 'demo');
    const target = path.join(skillDir, 'SKILL.md');
    symlinkSync(target, path.join(skillDir, 'linked.md'));

    const res = await fetch(`${base}/api/skills/raw?id=${encodeURIComponent('agents/demo/linked.md')}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-showmd-symlink'), '1');
    assert.equal(decodeURIComponent(res.headers.get('x-showmd-symlink-target')), target);
    assert.equal(decodeURIComponent(res.headers.get('x-showmd-symlink-doc')), 'agents/demo/SKILL.md');
  });
});

test('Skills selectors are strict: mutually exclusive, unknown values, and unknown keys all 400', async () => {
  await withSkillsHome(async (base) => {
    for (const query of ['?scope=all&root=r_AAAAAAAAAAAAAAAAAAAAAA', '?scope=global', '?view=skills', '?scope=all&scope=all']) {
      const res = await fetch(`${base}/api/skills/tree${query}`);
      assert.equal(res.status, 400, query);
      assert.equal((await res.json()).error, 'invalid_skills_selection');
    }
  });
});

test('Skills selection resolves against live registries: unknown root 404s, unknown context 410s', async () => {
  await withSkillsHome(async (base) => {
    const root = await fetch(`${base}/api/skills/tree?root=r_AAAAAAAAAAAAAAAAAAAAAA`);
    assert.equal(root.status, 404);
    assert.equal((await root.json()).error, 'root_not_open');

    const context = await fetch(`${base}/api/skills/tree?context=sc_missing`);
    assert.equal(context.status, 410);
    assert.equal((await context.json()).error, 'context_expired');
  });
});

test('root selection lists the registered root project skills with root-scoped hrefs', async () => {
  await withSkillsHome(async (base) => {
    const project = tmp('showmd-skills-project-');
    try {
      writeSkill(path.join(project, '.claude', 'skills'), 'projskill', '# project skill\n');
      const added = await fetch(`${base}/api/roots`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: project }),
      });
      const { root } = await added.json();

      const res = await fetch(`${base}/api/skills/tree?root=${root.key}`);
      assert.equal(res.status, 200);
      const skill = allSkills(await res.json()).find((s) => s.name === 'projskill');
      assert.ok(skill, 'project skill is discovered');
      assert.equal(skill.href, `/skills/${skill.id.split('/').map(encodeURIComponent).join('/')}?root=${root.key}`);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('POST /api/skills/contexts: an ephemeral context serves its own project skills', async () => {
  await withSkillsHome(async (base) => {
    const project = tmp('showmd-skills-ctx-');
    try {
      writeSkill(path.join(project, '.agents', 'skills'), 'ctxskill', '# context skill\n');
      const created = await fetch(`${base}/api/skills/contexts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDirs: [project] }),
      });
      assert.equal(created.status, 201);
      const { contextKey, url } = await created.json();
      assert.match(contextKey, /^sc_[A-Za-z0-9_-]{22}$/);
      assert.equal(url, `/skills/?context=${contextKey}`);

      const res = await fetch(`${base}/api/skills/tree?context=${contextKey}`);
      assert.equal(res.status, 200);
      const skill = allSkills(await res.json()).find((s) => s.name === 'ctxskill');
      assert.ok(skill, 'context skill is discovered');
      assert.ok(skill.href.endsWith(`?context=${contextKey}`), skill.href);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('POST /api/skills/contexts rejects an empty list and a non-directory', async () => {
  await withSkillsHome(async (base) => {
    for (const body of [{ projectDirs: [] }, { projectDirs: [path.join(tmpdir(), 'showmd-no-such-dir')] }, {}]) {
      const res = await fetch(`${base}/api/skills/contexts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'invalid_project_dirs');
    }
  });
});

test('a skill document keeps save history through the skills space', async (t) => {
  const { checkGitAvailable } = require('../../server/history.js');
  if (!(await checkGitAvailable())) {
    t.skip('git not available in this environment');
    return;
  }
  await withSkillsHome(async (base) => {
    const id = encodeURIComponent('agents/demo/SKILL.md');
    const put = await fetch(`${base}/api/skills/raw?id=${id}`, { method: 'PUT', body: '# demo skill, edited\n' });
    assert.equal(put.status, 204);

    const res = await fetch(`${base}/api/skills/history?id=${id}`);
    assert.equal(res.status, 200);
    const entries = await res.json();
    assert.ok(entries.length >= 1, 'the edit is recorded');

    const diff = await fetch(`${base}/api/skills/diff?id=${id}&rev=${encodeURIComponent(entries[0].rev)}`);
    assert.equal(diff.status, 200);
  });
});
