import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, appendFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSSE } from '../helpers/sse-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');
// both servers bind port 0 and report back; hardcoded ports collide with
// whatever else the machine (or a parallel CI job) already holds
let PORT;
let BASE;
let KEY;
let PORT2;
let BASE2;
let KEY2;

// realpath: windows hands back an 8.3 short name, which makes libuv abort
// when a watch event's long filename does not match the dir it was given
const workDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-smoke-')));
// Isolate history/settings and disable the only outbound update check.
const settingsHome = path.join(workDir, 'settings-home');
mkdirSync(settingsHome, { recursive: true });
writeFileSync(path.join(settingsHome, 'settings.json'), JSON.stringify({ updateCheck: false }));
const env = { ...process.env, SHOWMD_HISTORY_HOME: path.join(workDir, 'history'), SHOWMD_SETTINGS_HOME: settingsHome, SHOWMD_APP_DIR: path.join(workDir, 'app-dir') };
const servedRoot = path.join(workDir, 'docs');
const outsideDir = path.join(workDir, 'outside');
mkdirSync(path.join(servedRoot, 'notes'), { recursive: true });
mkdirSync(outsideDir, { recursive: true });

const helloPath = path.join(servedRoot, 'hello.md');
writeFileSync(helloPath, '# Hello\n\nSome text.\n');
writeFileSync(path.join(servedRoot, 'notes', 'ideas.md'), '# Ideas\n\n- [ ] one\n- [x] two\n');
writeFileSync(path.join(outsideDir, 'secret.md'), '# secret\n');

async function waitForServer(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start in time');
}

async function waitForPort(getOutput, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    const match = getOutput().match(/http:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) return Number(match[1]);
    if (Date.now() - start > timeoutMs) throw new Error('cli did not print a URL in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

// a commit lands when the watcher and git are done, not after a fixed nap; a
// loaded CI runner outruns any interval short enough to keep the suite quick
async function historyOfAtLeast(url, want, timeoutMs = 15000) {
  const start = Date.now();
  let hist = [];
  for (;;) {
    hist = await historyNow(url);
    if (hist.length >= want) return hist;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`history did not reach ${want} entries: ${JSON.stringify(hist)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function historyNow(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`history request failed: ${res.status}`);
  return res.json();
}

// Stop collection when every path arrives, retaining a generous slow-runner ceiling.
function collectSSEUntil(url, wantPaths, ms = 8000) {
  const remaining = new Set(wantPaths);
  return openSSE(url, {
    timeoutMs: ms,
    until(event) {
      remaining.delete(event.path);
      return remaining.size === 0;
    },
  });
}

let child;
let stdout = '';
let stderr = '';
let child2 = null;
let stdout2 = '';
let stderr2 = '';

test.before(async () => {
  child = spawn(
    'node',
    [path.join(PROJECT, 'bin', 'cli.js'), servedRoot, '--no-open', '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'], env }
  );
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));
  PORT = await waitForPort(() => stdout);
  BASE = `http://127.0.0.1:${PORT}`;
  await waitForServer(`${BASE}/`);
  KEY = (await (await fetch(`${BASE}/api/roots`)).json()).roots[0].key;
});

async function killAndWait(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill();
  await exited;
}

test.after(async () => {
  await Promise.all([killAndWait(child), killAndWait(child2)]);
  rmSync(workDir, { recursive: true, force: true });
});

test('cli started and printed URL', () => {
  assert.ok(stdout.includes(`http://127.0.0.1:${PORT}/`), 'cli prints URL');
  console.log('criterion 1 PASS: cli started and printed URL\n' + stdout.trim());
});

test('socket table shows 127.0.0.1 binding, not wildcard', () => {
  // windows has no lsof; netstat prints the wildcard as 0.0.0.0 where lsof prints *
  const isWindows = process.platform === 'win32';
  const raw = isWindows
    ? execSync('netstat -ano -p TCP').toString()
    : execSync(`lsof -n -iTCP:${PORT} -sTCP:LISTEN`).toString();
  const out = isWindows
    ? raw.split('\n').filter((l) => l.includes(`:${PORT} `) && l.includes('LISTENING')).join('\n')
    : raw;
  assert.ok(out.includes(`127.0.0.1:${PORT}`), 'bound to 127.0.0.1');
  assert.ok(!out.includes(isWindows ? `0.0.0.0:${PORT}` : `*:${PORT}`), 'must not bind to the wildcard address');
  console.log('criterion 2 PASS: socket table shows 127.0.0.1 binding\n' + out.trim());
});

test('/, root tree, root raw serve ok; traversal rejected 403', async () => {
  const rootRes = await fetch(`${BASE}/`);
  assert.equal(rootRes.status, 200);
  const rootHtml = await rootRes.text();
  assert.ok(rootHtml.includes('<title>showmd</title>'), 'root serves app shell');

  const treeRes = await fetch(`${BASE}/api/roots/${KEY}/tree`);
  assert.equal(treeRes.status, 200);
  const tree = await treeRes.json();
  assert.ok(tree.includes('hello.md'));
  assert.ok(tree.includes('notes/ideas.md'));

  const rawRes = await fetch(`${BASE}/api/roots/${KEY}/raw?path=hello.md`);
  assert.equal(rawRes.status, 200);
  const rawText = await rawRes.text();
  assert.ok(rawText.includes('# Hello'));

  const traversalRes = await fetch(`${BASE}/api/roots/${KEY}/raw?path=../outside/secret.md`);
  assert.equal(traversalRes.status, 403);
  console.log('criterion 3 PASS: /, root tree, root raw ok; traversal rejected 403');
});

test('PUT roundtrip — 204, file on disk updated, GET returns new content', async () => {
  const newContent = '# Hello (edited)\n\nUpdated via PUT.\n';
  const putRes = await fetch(`${BASE}/api/roots/${KEY}/raw?path=hello.md`, { method: 'PUT', body: newContent });
  assert.equal(putRes.status, 204);
  assert.equal(readFileSync(helloPath, 'utf8'), newContent, 'file on disk updated');
  const getAfterPut = await fetch(`${BASE}/api/roots/${KEY}/raw?path=hello.md`);
  assert.equal(await getAfterPut.text(), newContent, 'GET reflects the new content');
  console.log('criterion 4 PASS: PUT roundtrip — 204, file on disk updated, GET returns new content');
});

test('sse event arrives on external file change', async () => {
  const stream = collectSSEUntil(`${BASE}/api/events`, ['hello.md'], 3000);
  await stream.ready;
  const t0 = Date.now();
  appendFileSync(helloPath, '\nAppended line.\n');
  const event = (await stream.events).find((entry) => entry.path === 'hello.md');
  const elapsed = Date.now() - t0;
  assert.ok(event, 'sse event received');
  assert.equal(event.path, 'hello.md');
  console.log(`criterion 5 PASS: sse event arrived in ${elapsed}ms: ${JSON.stringify(event)}`);
});

// Keep the dependent versioned.md history flow in one test.
test('versioned.md: PUT/external/amend/diff/restore/bad-rev history flow', async () => {
  const verFile = 'versioned.md';
  const verEnc = encodeURIComponent(verFile);
  const verPath = path.join(servedRoot, verFile);

  const vPut1 = await fetch(`${BASE}/api/roots/${KEY}/raw?path=${verEnc}`, { method: 'PUT', body: '# V\n\nfirst\n' });
  assert.equal(vPut1.status, 204);
  const historyUrl = `${BASE}/api/roots/${KEY}/history?path=${verEnc}`;
  let hist = await historyNow(historyUrl);
  assert.equal(hist.length, 1, 'one entry after first PUT');
  assert.equal(hist[0].source, 'user');
  assert.ok(hist[0].adds > 0 && hist[0].dels === 0, 'plausible adds/dels');
  console.log(`M3 criterion 1 PASS (a): PUT save -> 1 history entry: ${JSON.stringify(hist[0])}`);

  appendFileSync(verPath, 'external addition\n');
  hist = await historyOfAtLeast(historyUrl, 2);
  assert.equal(hist.length, 2, 'external edit adds a second entry');
  assert.equal(hist[0].source, 'external');
  console.log(`M3 criterion 1 PASS (b): external edit -> new entry source=external: ${JSON.stringify(hist[0])}`);

  const vPut2 = await fetch(`${BASE}/api/roots/${KEY}/raw?path=${verEnc}`, { method: 'PUT', body: '# V\n\nfirst\n\nsecond\n' });
  assert.equal(vPut2.status, 204);
  const vPut3 = await fetch(`${BASE}/api/roots/${KEY}/raw?path=${verEnc}`, { method: 'PUT', body: '# V\n\nfirst\n\nsecond\n\nthird\n' });
  assert.equal(vPut3.status, 204);
  hist = await historyNow(historyUrl);
  assert.equal(hist.length, 3, `successive PUTs amend into one new user entry, got ${JSON.stringify(hist.map((e) => `${e.source}@${e.ts}`))}`);
  assert.equal(hist[0].source, 'user');
  console.log(`M3 criterion 2 PASS (amend): successive PUTs -> still one user entry, total=${hist.length}`);

  appendFileSync(verPath, 'another external edit\n');
  hist = await historyOfAtLeast(historyUrl, 4);
  assert.equal(hist.length, 4, 'external edit after amend window breaks it into a new entry');
  assert.equal(hist[0].source, 'external');
  console.log(`M3 criterion 2 PASS (source break): external edit ends amend window, total=${hist.length}`);

  const diffRes = await fetch(`${BASE}/api/roots/${KEY}/diff?path=${verEnc}&rev=${hist[0].rev}`);
  assert.equal(diffRes.status, 200);
  const diffText = await diffRes.text();
  assert.ok(diffText.includes('+another external edit'), 'diff contains the changed line');
  console.log('M3 criterion 3 PASS: root diff returns a unified diff containing the changed line');

  const oldestRev = hist[hist.length - 1].rev;
  const restoreStream = collectSSEUntil(`${BASE}/api/events`, [verFile], 3000);
  await restoreStream.ready;
  const restoreRes = await fetch(`${BASE}/api/roots/${KEY}/restore?path=${verEnc}&rev=${oldestRev}`, { method: 'POST' });
  assert.equal(restoreRes.status, 204);
  const restoreEvent = (await restoreStream.events).find((entry) => entry.path === verFile);
  assert.ok(restoreEvent, 'sse event received for restore');
  assert.equal(readFileSync(verPath, 'utf8'), '# V\n\nfirst\n', 'file on disk matches restored content');
  hist = await historyNow(historyUrl);
  assert.equal(hist[0].source, 'restore', 'newest entry is a restore commit');
  console.log('M3 criterion 4 PASS: restore -> disk content matches (cat proof above), SSE event fired, history gained a restore entry: ' + JSON.stringify(restoreEvent));

  // the full bad-rev list is unit-covered in test/unit/documents.test.mjs; one
  // representative case here is enough to prove the API wires it up end to end
  const badRev = '../x';
  const dRes = await fetch(`${BASE}/api/roots/${KEY}/diff?path=${verEnc}&rev=${encodeURIComponent(badRev)}`);
  assert.equal(dRes.status, 400, `diff rejects rev=${badRev}`);
  const rRes = await fetch(`${BASE}/api/roots/${KEY}/restore?path=${verEnc}&rev=${encodeURIComponent(badRev)}`, { method: 'POST' });
  assert.equal(rRes.status, 400, `restore rejects rev=${badRev}`);
  console.log(`M3 criterion 6 PASS: invalid rev format (${badRev}) rejected 400`);
});

test('concurrent double-PUT is safe: one clean user history entry, no index.lock', async () => {
  const racePath = 'concurrent-race.md';
  const raceEnc = encodeURIComponent(racePath);
  const [race1, race2] = await Promise.all([
    fetch(`${BASE}/api/roots/${KEY}/raw?path=${raceEnc}`, { method: 'PUT', body: '# race\n\nattempt one\n' }),
    fetch(`${BASE}/api/roots/${KEY}/raw?path=${raceEnc}`, { method: 'PUT', body: '# race\n\nattempt two\n' }),
  ]);
  assert.ok(race1.status >= 200 && race1.status < 300, `race1 status ${race1.status}`);
  assert.ok(race2.status >= 200 && race2.status < 300, `race2 status ${race2.status}`);
  const raceHist = await historyNow(`${BASE}/api/roots/${KEY}/history?path=${raceEnc}`);
  assert.equal(raceHist[0].source, 'user', 'top entry after concurrent double-PUT is user');
  assert.ok(!stderr.includes('index.lock'), 'no index.lock error after concurrent double-PUT');
  console.log(`concurrency check 1 PASS: concurrent double-PUT -> both ${race1.status}/${race2.status}, top history entry ${JSON.stringify(raceHist[0])}, stderr clean`);
});

test('cross-contamination: external edit + immediate user PUT emit correct SSE and history', async () => {
  // within the 100ms debounce window
  const crossAPath = path.join(servedRoot, 'crossA.md');
  const crossBEnc = encodeURIComponent('crossB.md');
  const seedA = await fetch(`${BASE}/api/roots/${KEY}/raw?path=crossA.md`, {
    method: 'PUT',
    body: '# A\n\ninitial\n',
  });
  assert.equal(seedA.status, 204);
  assert.equal((await historyNow(`${BASE}/api/roots/${KEY}/history?path=crossA.md`)).length, 1);

  const crossStream = collectSSEUntil(`${BASE}/api/events`, ['crossA.md', 'crossB.md']);
  await crossStream.ready;
  appendFileSync(crossAPath, 'external addition to A\n');
  const crossPutRes = await fetch(`${BASE}/api/roots/${KEY}/raw?path=${crossBEnc}`, { method: 'PUT', body: '# B\n\nfrom user\n' });
  assert.equal(crossPutRes.status, 204);
  const crossEvents = await crossStream.events;

  assert.ok(crossEvents.some((e) => e.path === 'crossA.md'), 'SSE event for A arrived');
  assert.ok(crossEvents.some((e) => e.path === 'crossB.md'), 'SSE event for B arrived');
  const histA = await historyOfAtLeast(`${BASE}/api/roots/${KEY}/history?path=crossA.md`, 2);
  const histB = await historyNow(`${BASE}/api/roots/${KEY}/history?path=${crossBEnc}`);
  assert.equal(histA[0].source, 'external', 'A entry stayed external');
  assert.equal(histB[0].source, 'user', 'B entry stayed user');
  assert.ok(!stderr.includes('index.lock'), 'no index.lock error after cross-contamination scenario');
  console.log(`concurrency check 2 PASS: external A + immediate PUT B -> SSE events ${JSON.stringify(crossEvents)}, histA[0]=${JSON.stringify(histA[0])}, histB[0]=${JSON.stringify(histB[0])}`);
});

test('two overlapping external writes both produce external history entries', async () => {
  const raceAPath = path.join(servedRoot, 'raceExtA.md');
  const raceBPath = path.join(servedRoot, 'raceExtB.md');
  const raceStream = collectSSEUntil(`${BASE}/api/events`, ['raceExtA.md', 'raceExtB.md']);
  await raceStream.ready;
  writeFileSync(raceAPath, '# race ext A\n');
  writeFileSync(raceBPath, '# race ext B\n');
  const raceEvents = await raceStream.events;

  assert.ok(raceEvents.some((e) => e.path === 'raceExtA.md'), 'SSE event for raceExtA arrived');
  assert.ok(raceEvents.some((e) => e.path === 'raceExtB.md'), 'SSE event for raceExtB arrived');
  const histRaceA = await historyOfAtLeast(`${BASE}/api/roots/${KEY}/history?path=raceExtA.md`, 1);
  const histRaceB = await historyOfAtLeast(`${BASE}/api/roots/${KEY}/history?path=raceExtB.md`, 1);
  assert.equal(histRaceA[0].source, 'external', 'raceExtA entry is external');
  assert.equal(histRaceB[0].source, 'external', 'raceExtB entry is external');
  assert.ok(!stderr.includes('index.lock'), 'no index.lock error after two overlapping external writes');
  console.log(`concurrency check 3 PASS: two back-to-back external writes -> SSE events ${JSON.stringify(raceEvents)}, histRaceA[0]=${JSON.stringify(histRaceA[0])}, histRaceB[0]=${JSON.stringify(histRaceB[0])}`);
});

test('vendor allowlist: every route 200s with correct content-type', async () => {
  const vendorAllowed = [
    ['/assets/vendor/mermaid/mermaid.min.js', 'text/javascript'],
    ['/assets/vendor/katex/katex.min.js', 'text/javascript'],
    ['/assets/vendor/katex/katex.min.css', 'text/css'],
    ['/assets/vendor/katex/fonts/KaTeX_Main-Regular.woff2', 'font/woff2'],
    ['/assets/dist/hljs.js', 'text/javascript'],
  ];
  for (const [route, expectType] of vendorAllowed) {
    const r = await fetch(`${BASE}${route}`);
    assert.equal(r.status, 200, `${route} status`);
    assert.ok(r.headers.get('content-type').includes(expectType), `${route} content-type is ${expectType}`);
  }
  console.log('vendor criterion 1 PASS: every allowlisted vendor route 200s with sensible content-type');
});

test('vendor allowlist: non-allowlisted and traversal attempts rejected 403/404', async () => {
  // Encode traversal slashes so the URL parser cannot collapse them first.
  const vendorRejected = [
    ['/assets/vendor/chokidar/package.json', [403, 404]],
    ['/assets/vendor/katex/fonts/' + encodeURIComponent('../../../package.json'), [403, 404]],
    ['/assets/vendor/highlight.js/' + encodeURIComponent('../../package.json'), [403, 404]],
  ];
  for (const [route, okCodes] of vendorRejected) {
    const r = await fetch(`${BASE}${route}`);
    assert.ok(okCodes.includes(r.status), `${route} rejected, got ${r.status}`);
  }
  console.log('vendor criterion 2 PASS: non-allowlisted node_modules path and traversal attempts all rejected 403/404');
});

test('file-arg mode: second cli instance on a single file lists siblings; no index.lock anywhere', async () => {
  child2 = spawn(
    'node',
    [path.join(PROJECT, 'bin', 'cli.js'), helloPath, '--no-open', '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'], env }
  );
  child2.stdout.on('data', (d) => (stdout2 += d.toString()));
  child2.stderr.on('data', (d) => (stderr2 += d.toString()));
  PORT2 = await waitForPort(() => stdout2);
  BASE2 = `http://127.0.0.1:${PORT2}`;
  await waitForServer(`${BASE2}/hello.md`);
  assert.match(stdout2, new RegExp(`http://127\\.0\\.0\\.1:${PORT2}/r/r_[A-Za-z0-9_-]{22}/hello\\.md`), 'cli prints a Root Space URL ending in /hello.md');
  KEY2 = (await (await fetch(`${BASE2}/api/roots`)).json()).roots[0].key;

  const treeRes2 = await fetch(`${BASE2}/api/roots/${KEY2}/tree`);
  assert.equal(treeRes2.status, 200);
  const tree2 = await treeRes2.json();
  assert.ok(tree2.includes('hello.md'));
  assert.ok(tree2.includes('notes/ideas.md'), 'sibling .md files listed when root is a file');

  const shellRes2 = await fetch(`${BASE2}/hello.md`);
  assert.equal(shellRes2.status, 200);
  assert.ok((await shellRes2.text()).includes('<title>showmd</title>'), 'file arg still serves app shell');

  const rawRes2 = await fetch(`${BASE2}/api/roots/${KEY2}/raw?path=hello.md`);
  assert.equal(rawRes2.status, 200);
  console.log('criterion 6 PASS: file arg — tree lists siblings, shell and raw both 200');

  assert.ok(!stderr.includes('index.lock') && !stderr2.includes('index.lock'), 'no index.lock in either server stderr across the whole run');
  console.log('concurrency final check PASS: grep for index.lock across both servers\' stderr — no matches');
});

// Prove one process serves and tags events for two independent roots.
test('two roots on one process: POST /api/roots adds a second root; trees and SSE stay isolated per rootKey', async () => {
  const rootBDir = path.join(workDir, 'root-b');
  mkdirSync(rootBDir, { recursive: true });
  const bPath = path.join(rootBDir, 'b.md');
  writeFileSync(bPath, '# B\n');

  const addRes = await fetch(`${BASE}/api/roots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: rootBDir }),
  });
  assert.equal(addRes.status, 200);
  const added = await addRes.json();
  assert.equal(added.root.dir, rootBDir);
  const rootBKey = added.root.key;

  const rootsList = await (await fetch(`${BASE}/api/roots`)).json();
  assert.equal(rootsList.roots.length, 2, 'the boot root and the newly added root are both listed');
  const rootAKey = rootsList.roots.find((r) => r.dir === servedRoot).key;
  assert.notEqual(rootAKey, rootBKey);

  const treeB = await (await fetch(`${BASE}/api/roots/${rootBKey}/tree`)).json();
  assert.deepEqual(treeB, ['b.md']);
  const treeA = await (await fetch(`${BASE}/api/roots/${rootAKey}/tree`)).json();
  assert.ok(treeA.includes('hello.md'), "root A's own tree is unaffected by root B joining");
  assert.ok(!treeA.includes('b.md'), "root A's tree never leaks root B's files");

  const stream = collectSSEUntil(`${BASE}/api/events`, ['b.md', 'hello.md'], 6000);
  await stream.ready;
  appendFileSync(bPath, '\nchanged in B\n');
  appendFileSync(helloPath, '\nchanged in A again\n');
  const seen = await stream.events;

  const bEvent = seen.find((e) => e.path === 'b.md');
  const aEvent = seen.find((e) => e.path === 'hello.md');
  assert.ok(bEvent, 'root B change produced an SSE event');
  assert.ok(aEvent, 'root A change produced an SSE event');
  assert.equal(bEvent.rootKey, rootBKey, "root B's event is tagged with root B's key, not root A's");
  assert.equal(aEvent.rootKey, rootAKey, "root A's event is tagged with root A's key, not root B's");
  console.log('two-root criterion PASS: independent trees and rootKey-tagged SSE for two roots on one process');
});
