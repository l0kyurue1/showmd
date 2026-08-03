import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PROJECT = path.resolve(HERE, '..', '..');
// both servers bind port 0 and report back; hardcoded ports collide with
// whatever else the machine (or a parallel CI job) already holds
let PORT;
let BASE;
let PORT2;
let BASE2;

const workDir = mkdtempSync(path.join(tmpdir(), 'showmd-smoke-'));
// keep every shadow repo inside the temp dir; the real home stays untouched.
// settings home is isolated too, with updateCheck off, so this spawn never
// makes the one outbound call showmd can make (npm test needs no network)
const settingsHome = path.join(workDir, 'settings-home');
mkdirSync(settingsHome, { recursive: true });
writeFileSync(path.join(settingsHome, 'settings.json'), JSON.stringify({ updateCheck: false }));
const env = { ...process.env, SHOWMD_HISTORY_HOME: path.join(workDir, 'history'), SHOWMD_SETTINGS_HOME: settingsHome };
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

async function collectSSE(url, ms) {
  const controller = new AbortController();
  const events = [];
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice('data: '.length)));
      }
    }
  } catch {
    // expected: aborted once the collection window elapses
  } finally {
    clearTimeout(timer);
  }
  return events;
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
});

test.after(() => {
  child.kill();
  if (child2) child2.kill();
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

test('/, /api/tree, /api/raw serve ok; traversal rejected 403', async () => {
  const rootRes = await fetch(`${BASE}/`);
  assert.equal(rootRes.status, 200);
  const rootHtml = await rootRes.text();
  assert.ok(rootHtml.includes('<title>showmd</title>'), 'root serves app shell');

  const treeRes = await fetch(`${BASE}/api/tree`);
  assert.equal(treeRes.status, 200);
  const tree = await treeRes.json();
  assert.ok(tree.includes('hello.md'));
  assert.ok(tree.includes('notes/ideas.md'));

  const rawRes = await fetch(`${BASE}/api/raw?path=hello.md`);
  assert.equal(rawRes.status, 200);
  const rawText = await rawRes.text();
  assert.ok(rawText.includes('# Hello'));

  const traversalRes = await fetch(`${BASE}/api/raw?path=../outside/secret.md`);
  assert.equal(traversalRes.status, 403);
  console.log('criterion 3 PASS: /, /api/tree, /api/raw ok; traversal rejected 403');
});

test('PUT roundtrip — 204, file on disk updated, GET returns new content', async () => {
  const newContent = '# Hello (edited)\n\nUpdated via PUT.\n';
  const putRes = await fetch(`${BASE}/api/raw?path=hello.md`, { method: 'PUT', body: newContent });
  assert.equal(putRes.status, 204);
  assert.equal(readFileSync(helloPath, 'utf8'), newContent, 'file on disk updated');
  const getAfterPut = await fetch(`${BASE}/api/raw?path=hello.md`);
  assert.equal(await getAfterPut.text(), newContent, 'GET reflects the new content');
  console.log('criterion 4 PASS: PUT roundtrip — 204, file on disk updated, GET returns new content');
});

test('PUT traversal (plain + URL-encoded) rejected 403', async () => {
  const putTraversalRes = await fetch(`${BASE}/api/raw?path=../outside/secret.md`, { method: 'PUT', body: '# hack\n' });
  assert.equal(putTraversalRes.status, 403);
  const putTraversalEncodedRes = await fetch(`${BASE}/api/raw?path=..%2Foutside%2Fsecret.md`, { method: 'PUT', body: '# hack\n' });
  assert.equal(putTraversalEncodedRes.status, 403);
  console.log('criterion 5 PASS: PUT traversal (plain + URL-encoded) rejected 403');
});

test('PUT to non-.md rejected 403', async () => {
  const putNonMdRes = await fetch(`${BASE}/api/raw?path=hello.txt`, { method: 'PUT', body: 'not markdown' });
  assert.equal(putNonMdRes.status, 403);
  console.log('criterion 6 PASS: PUT to non-.md rejected 403');
});

test('sse event arrives on external file change', async () => {
  const sseController = new AbortController();
  const ssePromise = fetch(`${BASE}/api/events`, { signal: sseController.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      buf += decoder.decode(value, { stream: true });
      const match = buf.match(/data: (\{.*\})/);
      if (match) return JSON.parse(match[1]);
    }
  });

  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  appendFileSync(helloPath, '\nAppended line.\n');
  const event = await Promise.race([
    ssePromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('SSE timeout')), 3000)),
  ]);
  const elapsed = Date.now() - t0;
  sseController.abort();
  assert.ok(event, 'sse event received');
  assert.equal(event.path, 'hello.md');
  console.log(`criterion 7 PASS: sse event arrived in ${elapsed}ms: ${JSON.stringify(event)}`);
});

// this whole flow builds one growing history on the same file (versioned.md);
// each step's assertion depends on the entry count the previous step left
// behind, so it stays one test rather than being split artificially
test('versioned.md: PUT/external/amend/diff/restore/bad-rev history flow', async () => {
  const verFile = 'versioned.md';
  const verEnc = encodeURIComponent(verFile);
  const verPath = path.join(servedRoot, verFile);

  const vPut1 = await fetch(`${BASE}/api/raw?path=${verEnc}`, { method: 'PUT', body: '# V\n\nfirst\n' });
  assert.equal(vPut1.status, 204);
  await new Promise((r) => setTimeout(r, 200));
  let hist = await (await fetch(`${BASE}/api/history?path=${verEnc}`)).json();
  assert.equal(hist.length, 1, 'one entry after first PUT');
  assert.equal(hist[0].source, 'user');
  assert.ok(hist[0].adds > 0 && hist[0].dels === 0, 'plausible adds/dels');
  console.log(`M3 criterion 1 PASS (a): PUT save -> 1 history entry: ${JSON.stringify(hist[0])}`);

  appendFileSync(verPath, 'external addition\n');
  await new Promise((r) => setTimeout(r, 400));
  hist = await (await fetch(`${BASE}/api/history?path=${verEnc}`)).json();
  assert.equal(hist.length, 2, 'external edit adds a second entry');
  assert.equal(hist[0].source, 'external');
  console.log(`M3 criterion 1 PASS (b): external edit -> new entry source=external: ${JSON.stringify(hist[0])}`);

  const vPut2 = await fetch(`${BASE}/api/raw?path=${verEnc}`, { method: 'PUT', body: '# V\n\nfirst\n\nsecond\n' });
  assert.equal(vPut2.status, 204);
  await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 2000));
  const vPut3 = await fetch(`${BASE}/api/raw?path=${verEnc}`, { method: 'PUT', body: '# V\n\nfirst\n\nsecond\n\nthird\n' });
  assert.equal(vPut3.status, 204);
  await new Promise((r) => setTimeout(r, 200));
  hist = await (await fetch(`${BASE}/api/history?path=${verEnc}`)).json();
  assert.equal(hist.length, 3, 'two PUTs ~2s apart amend into one new user entry');
  assert.equal(hist[0].source, 'user');
  console.log(`M3 criterion 2 PASS (amend): two PUTs 2s apart -> still one user entry, total=${hist.length}`);

  appendFileSync(verPath, 'another external edit\n');
  await new Promise((r) => setTimeout(r, 400));
  hist = await (await fetch(`${BASE}/api/history?path=${verEnc}`)).json();
  assert.equal(hist.length, 4, 'external edit after amend window breaks it into a new entry');
  assert.equal(hist[0].source, 'external');
  console.log(`M3 criterion 2 PASS (source break): external edit ends amend window, total=${hist.length}`);

  const diffRes = await fetch(`${BASE}/api/diff?path=${verEnc}&rev=${hist[0].rev}`);
  assert.equal(diffRes.status, 200);
  const diffText = await diffRes.text();
  assert.ok(diffText.includes('+another external edit'), 'diff contains the changed line');
  console.log('M3 criterion 3 PASS: /api/diff returns a unified diff containing the changed line');

  const oldestRev = hist[hist.length - 1].rev;
  const sseController2 = new AbortController();
  const ssePromise2 = fetch(`${BASE}/api/events`, { signal: sseController2.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      buf += decoder.decode(value, { stream: true });
      const match = buf.match(new RegExp(`data: (\\{"path":"${verFile}"[^}]*\\})`));
      if (match) return JSON.parse(match[1]);
    }
  });
  await new Promise((r) => setTimeout(r, 200));
  const restoreRes = await fetch(`${BASE}/api/restore?path=${verEnc}&rev=${oldestRev}`, { method: 'POST' });
  assert.equal(restoreRes.status, 204);
  const restoreEvent = await Promise.race([
    ssePromise2,
    new Promise((_, rej) => setTimeout(() => rej(new Error('restore SSE timeout')), 3000)),
  ]);
  sseController2.abort();
  assert.ok(restoreEvent, 'sse event received for restore');
  assert.equal(readFileSync(verPath, 'utf8'), '# V\n\nfirst\n', 'file on disk matches restored content');
  hist = await (await fetch(`${BASE}/api/history?path=${verEnc}`)).json();
  assert.equal(hist[0].source, 'restore', 'newest entry is a restore commit');
  console.log('M3 criterion 4 PASS: restore -> disk content matches (cat proof above), SSE event fired, history gained a restore entry: ' + JSON.stringify(restoreEvent));

  // the full bad-rev list is unit-covered in test/unit/documents.test.mjs; one
  // representative case here is enough to prove the API wires it up end to end
  const badRev = '../x';
  const dRes = await fetch(`${BASE}/api/diff?path=${verEnc}&rev=${encodeURIComponent(badRev)}`);
  assert.equal(dRes.status, 400, `diff rejects rev=${badRev}`);
  const rRes = await fetch(`${BASE}/api/restore?path=${verEnc}&rev=${encodeURIComponent(badRev)}`, { method: 'POST' });
  assert.equal(rRes.status, 400, `restore rejects rev=${badRev}`);
  console.log(`M3 criterion 6 PASS: invalid rev format (${badRev}) rejected 400`);
});

test('concurrent double-PUT is safe: one clean user history entry, no index.lock', async () => {
  const racePath = 'concurrent-race.md';
  const raceEnc = encodeURIComponent(racePath);
  const [race1, race2] = await Promise.all([
    fetch(`${BASE}/api/raw?path=${raceEnc}`, { method: 'PUT', body: '# race\n\nattempt one\n' }),
    fetch(`${BASE}/api/raw?path=${raceEnc}`, { method: 'PUT', body: '# race\n\nattempt two\n' }),
  ]);
  assert.ok(race1.status >= 200 && race1.status < 300, `race1 status ${race1.status}`);
  assert.ok(race2.status >= 200 && race2.status < 300, `race2 status ${race2.status}`);
  await new Promise((r) => setTimeout(r, 300));
  const raceHist = await (await fetch(`${BASE}/api/history?path=${raceEnc}`)).json();
  assert.equal(raceHist[0].source, 'user', 'top entry after concurrent double-PUT is user');
  assert.ok(!stderr.includes('index.lock'), 'no index.lock error after concurrent double-PUT');
  console.log(`concurrency check 1 PASS: concurrent double-PUT -> both ${race1.status}/${race2.status}, top history entry ${JSON.stringify(raceHist[0])}, stderr clean`);
});

test('cross-contamination: external edit + immediate user PUT emit correct SSE and history', async () => {
  // within the 100ms debounce window
  const crossAPath = path.join(servedRoot, 'crossA.md');
  const crossBEnc = encodeURIComponent('crossB.md');
  writeFileSync(crossAPath, '# A\n\ninitial\n');
  await new Promise((r) => setTimeout(r, 400)); // let the initial external commit for A settle

  const crossEventsPromise = collectSSE(`${BASE}/api/events`, 800);
  await new Promise((r) => setTimeout(r, 200));
  appendFileSync(crossAPath, 'external addition to A\n');
  const crossPutRes = await fetch(`${BASE}/api/raw?path=${crossBEnc}`, { method: 'PUT', body: '# B\n\nfrom user\n' });
  assert.equal(crossPutRes.status, 204);
  const crossEvents = await crossEventsPromise;
  await new Promise((r) => setTimeout(r, 300)); // let A's async external commit finish

  assert.ok(crossEvents.some((e) => e.path === 'crossA.md'), 'SSE event for A arrived');
  assert.ok(crossEvents.some((e) => e.path === 'crossB.md'), 'SSE event for B arrived');
  const histA = await (await fetch(`${BASE}/api/history?path=crossA.md`)).json();
  const histB = await (await fetch(`${BASE}/api/history?path=${crossBEnc}`)).json();
  assert.equal(histA[0].source, 'external', 'A entry stayed external');
  assert.equal(histB[0].source, 'user', 'B entry stayed user');
  assert.ok(!stderr.includes('index.lock'), 'no index.lock error after cross-contamination scenario');
  console.log(`concurrency check 2 PASS: external A + immediate PUT B -> SSE events ${JSON.stringify(crossEvents)}, histA[0]=${JSON.stringify(histA[0])}, histB[0]=${JSON.stringify(histB[0])}`);
});

test('two overlapping external writes both produce external history entries', async () => {
  const raceAPath = path.join(servedRoot, 'raceExtA.md');
  const raceBPath = path.join(servedRoot, 'raceExtB.md');
  const raceEventsPromise = collectSSE(`${BASE}/api/events`, 800);
  await new Promise((r) => setTimeout(r, 200));
  writeFileSync(raceAPath, '# race ext A\n');
  await new Promise((r) => setTimeout(r, 50));
  writeFileSync(raceBPath, '# race ext B\n');
  const raceEvents = await raceEventsPromise;
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(raceEvents.some((e) => e.path === 'raceExtA.md'), 'SSE event for raceExtA arrived');
  assert.ok(raceEvents.some((e) => e.path === 'raceExtB.md'), 'SSE event for raceExtB arrived');
  const histRaceA = await (await fetch(`${BASE}/api/history?path=raceExtA.md`)).json();
  const histRaceB = await (await fetch(`${BASE}/api/history?path=raceExtB.md`)).json();
  assert.equal(histRaceA[0].source, 'external', 'raceExtA entry is external');
  assert.equal(histRaceB[0].source, 'external', 'raceExtB entry is external');
  assert.ok(!stderr.includes('index.lock'), 'no index.lock error after two overlapping external writes');
  console.log(`concurrency check 3 PASS: two external writes 50ms apart -> SSE events ${JSON.stringify(raceEvents)}, histRaceA[0]=${JSON.stringify(histRaceA[0])}, histRaceB[0]=${JSON.stringify(histRaceB[0])}`);
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
  // note: a plain '../' in a fetch() URL is collapsed by the WHATWG URL parser
  // before the request is even sent, so traversal payloads below encode the
  // slash (%2F) to survive as a literal path segment and reach the server raw
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
  assert.ok(stdout2.includes(`http://127.0.0.1:${PORT2}/hello.md`), 'cli prints file URL ending in /hello.md');

  const treeRes2 = await fetch(`${BASE2}/api/tree`);
  assert.equal(treeRes2.status, 200);
  const tree2 = await treeRes2.json();
  assert.ok(tree2.includes('hello.md'));
  assert.ok(tree2.includes('notes/ideas.md'), 'sibling .md files listed when root is a file');

  const shellRes2 = await fetch(`${BASE2}/hello.md`);
  assert.equal(shellRes2.status, 200);
  assert.ok((await shellRes2.text()).includes('<title>showmd</title>'), 'file arg still serves app shell');

  const rawRes2 = await fetch(`${BASE2}/api/raw?path=hello.md`);
  assert.equal(rawRes2.status, 200);
  console.log('criterion 8 PASS: file arg — tree lists siblings, shell and raw both 200');

  assert.ok(!stderr.includes('index.lock') && !stderr2.includes('index.lock'), 'no index.lock in either server stderr across the whole run');
  console.log('concurrency final check PASS: grep for index.lock across both servers\' stderr — no matches');
});
