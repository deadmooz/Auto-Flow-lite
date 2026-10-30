import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

/* Guards for the speed and memory work: the fast paths must give exactly the answers real JavaScript gives, a damaged
 * sandbox must never be reused, shared data must be fresh for every item, and the compressed static files must be safe. */
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'liteforeflow-perf-'));
process.env.DB_PATH = ':memory:';
process.env.LITEFOREFLOW_SECRET = 'perf';
process.env.AUTH_RATE_LIMIT_PER_MIN = '100000';
process.env.HTTP_MAX_RESPONSE_MB = '2'; // small, so the download limit can be tested quickly

const { Sandbox, drainSandboxPool, sandboxMode } = await import('../src/sandbox.js');
const { createNodeEvaluator, createResolver } = await import('../src/expressions.js');
const { createApp } = await import('../src/app.js');
const { startWorker, closeQueue } = await import('../src/queue.js');
const { closeDb } = await import('../src/db.js');
const { loadPlugins } = await import('../src/plugins.js');

after(async () => { drainSandboxPool(); await closeQueue(); await closeDb(); });

const makeEval = (items, nodes = {}) => {
  const sandbox = new Sandbox();
  const ev = createNodeEvaluator({
    baseFn: (i) => ({ $json: items[i], $itemIndex: i, $workflow: { id: 'w', name: 'W' }, $now: '2026-01-01T00:00:00.000Z' }),
    extraFn: () => ({ $node: nodes, $input: { all: items } }),
    sandbox,
  });
  return { ev, sandbox, done: () => { ev.release(); sandbox.dispose(); } };
};
const ITEMS = [{ v: 1, list: [3, 1, 2], s: 'abc', n: null, o: { a: { b: 5 } } }, { v: 2, list: [9, 8], s: 'xyz' }, { v: 3, list: [], s: '' }];

test('plain lookups answer exactly what JavaScript would, without the sandbox', async () => {
  const { ev, done } = makeEval(ITEMS, { Fetch: { json: { list: [1, 2], n: 7 }, items: [] } });
  const cases = [
    ['{{ $json.v }}', 0, 1], ['{{ $json.o.a.b }}', 0, 5], ['{{ $json["s"] }}', 1, 'xyz'], ["{{ $json['list'][1] }}", 0, 1], ['{{ $json.list.length }}', 0, 3],
    ['{{ $json.s.length }}', 0, 3], ['{{ $json.s[1] }}', 0, 'b'], ['{{ $json.n }}', 0, null], ['{{ $json.missing }}', 0, undefined], ['{{ $itemIndex }}', 2, 2],
    ['{{ $now }}', 0, '2026-01-01T00:00:00.000Z'], ['{{ $workflow.name }}', 0, 'W'], ['{{ $node["Fetch"].json.n }}', 0, 7], ["{{ $node['Fetch'].json.list[1] }}", 1, 2],
    ['{{ $json.toString }}', 0, undefined], ['{{ $json.hasOwnProperty }}', 0, undefined],
  ];
  for (const [expr, i, want] of cases) assert.deepEqual(await ev.resolve(expr, i), want, expr);
  assert.equal(await ev.resolve('a {{ $json.v }} b {{ $json.s }} c', 0), 'a 1 b abc c');
  assert.deepEqual(await ev.resolve({ x: '{{ $json.v }}', y: ['{{ $json.s }}', 'plain'] }, 1), { x: 2, y: ['xyz', 'plain'] });
  done();
});

test('what a lookup returns is a copy, and the names that could poison objects are never followed', async () => {
  const { ev, done } = makeEval(ITEMS);
  const list = await ev.resolve('{{ $json.list }}', 0);
  list.push(99);
  assert.equal(ITEMS[0].list.length, 3, 'changing the answer must not change the item');
  for (const bad of ['{{ $json.__proto__ }}', '{{ $json.constructor }}', '{{ $json.constructor.prototype }}']) {
    const v = await ev.resolve(bad, 0).catch(() => 'err');
    assert.ok(v === undefined || v === 'err' || typeof v === 'object', bad);
  }
  assert.equal(({}).polluted, undefined);
  done();
});

test('a lookup through something that is not there fails with the same message as real JavaScript', async () => {
  const { ev, done } = makeEval(ITEMS);
  await assert.rejects(ev.resolve('{{ $json.nope.deeper }}', 0), /Expression error in .*Cannot read properties of undefined/);
  await assert.rejects(ev.resolve('{{ $node["Nothing"].json.x }}', 0), /Expression error/);
  done();
});

test('expressions that change their data cannot affect the next item', async () => {
  const { ev, done } = makeEval(ITEMS, { Fetch: { json: { list: [1, 2, 3] }, items: [] } });
  await ev.resolve('{{ $json.v = 100 }}', 0);
  assert.equal(await ev.resolve('{{ $json.v + 0 }}', 1), 2);
  await ev.resolve('{{ $json.list.reverse() }}', 0);
  assert.equal(await ev.resolve('{{ $json.list.join() }}', 1), '9,8');
  const a = await ev.resolve('{{ $node["Fetch"].json.list.reverse()[0] }}', 0);
  const b = await ev.resolve('{{ $node["Fetch"].json.list.reverse()[0] }}', 1);
  assert.deepEqual([a, b], [3, 3], 'shared $node data is parsed fresh for each item');
  assert.equal(await ev.resolve('{{ $input.all().length }}', 0), 3);
  assert.equal(await ev.resolve('{{ $input.first().json.s }}', 2), 'abc');
  assert.equal(await ev.resolve('{{ $input.item.json.s }}', 1), 'xyz');
  done();
});

test('a node run with thousands of items stays fast and correct (the old code took 0.8 ms per item for even a plain lookup)', async () => {
  const big = Array.from({ length: 4000 }, (_, i) => ({ v: i, name: `n${i}` }));
  const { ev, done } = makeEval(big, { Gen: { json: { k: 1 }, items: big } });
  const t0 = Date.now();
  for (let i = 0; i < big.length; i += 1) {
    assert.equal(await ev.resolve('{{ $json.v }}', i), i);
    assert.equal(await ev.resolve('{{ $json.v * 2 + 1 }}', i), i * 2 + 1);
    assert.equal(await ev.resolve('{{ $node["Gen"].json.k }}', i), 1); // was quadratic: every item rebuilt all earlier data
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `${big.length} items took ${ms} ms`);
  done();
});

test('the one-item resolver kept for older callers still works', async () => {
  const r = createResolver(() => ({ $json: { a: 2 } }), () => ({ $node: {}, $input: { all: [] } }));
  assert.equal(await r.resolve('{{ $json.a * 21 }}'), 42);
  assert.equal(await r.resolve('{{ $json.a }}'), 2);
  r.release();
});

test('sandbox: an infinite loop is stopped, the run carries on, and a damaged isolate is never reused', { skip: sandboxMode() !== 'isolated-vm' }, async () => {
  drainSandboxPool();
  const { ev, done } = makeEval(ITEMS);
  const t0 = Date.now();
  await assert.rejects(ev.resolve('{{ (function () { while (true) {} })() }}', 0), /timed out/);
  assert.ok(Date.now() - t0 < 3000, 'the 1 s limit still applies after the quick synchronous try');
  assert.equal(await ev.resolve('{{ $json.v * 10 }}', 1), 20, 'the next item still works');
  done();
  const again = makeEval(ITEMS);
  assert.equal(await again.ev.resolve('{{ $json.v + 1 }}', 0), 2, 'the next node run gets a healthy isolate');
  again.done();

  const bomb = makeEval(ITEMS);
  await assert.rejects(bomb.ev.resolve('{{ (function () { const a = []; while (true) a.push(new Array(1e6).fill("x".repeat(100))); })() }}', 0), /memory|timed out/);
  bomb.done();
  const after2 = makeEval(ITEMS);
  assert.equal(await after2.ev.resolve('{{ $json.v * 3 }}', 2), 9);
  after2.done();
});

test('sandbox: nothing from the host is reachable', async () => {
  const { ev, done } = makeEval(ITEMS);
  for (const probe of ['typeof process', 'typeof require', 'typeof Buffer', 'typeof fetch', 'typeof module']) assert.equal(await ev.resolve(`{{ ${probe} }}`, 0), 'undefined', probe);
  const esc = await ev.resolve('{{ (function(){ try { return this.constructor.constructor("return process")() } catch (e) { return "blocked" } })() }}', 0).catch(() => 'blocked');
  assert.ok(esc === 'blocked' || esc === undefined, String(esc));
  done();
});

test('the isolate pool keeps a few small ones ready and drops big ones at once', { skip: sandboxMode() !== 'isolated-vm' }, async () => {
  drainSandboxPool();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) { const s = new Sandbox(); const c = s.reusable(); c.setItem({ $json: { i } }); await c.run('"1"', 500); c.release(); s.dispose(); }
  const msEach = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  assert.ok(msEach < 1.2, `a node run that needs the sandbox costs ${msEach.toFixed(2)} ms (creating a fresh isolate each time costs about 2.4 ms)`);
});

/* ------------------------------------ the web server ------------------------------------ */
let server;
let port;
const getRaw = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

test('built files are served gzip-compressed, cached, and only from inside the web folder', async () => {
  await loadPlugins();
  await startWorker();
  server = createApp().listen(0);
  port = server.address().port;
  const index = (await getRaw('/')).body.toString();
  const js = index.match(/assets\/index-[^"]+\.js/)[0];
  const plain = await getRaw(`/${js}`);
  const zipped = await getRaw(`/${js}`, { 'accept-encoding': 'gzip' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.ok(zipped.body.length < plain.body.length / 2, `${zipped.body.length} vs ${plain.body.length}`);
  assert.equal((await import('node:zlib')).gunzipSync(zipped.body).toString(), plain.body.toString(), 'same bytes after decompressing');
  assert.match(zipped.headers['cache-control'], /immutable/);
  assert.equal((await getRaw(`/${js}`, { 'accept-encoding': 'gzip', 'if-none-match': zipped.headers.etag })).status, 304);
  const page = await getRaw('/workflows/abc', { 'accept-encoding': 'gzip' });
  assert.equal(page.headers['content-encoding'], 'gzip', 'page routes get the editor page');
  for (const evil of ['/assets/..%2f..%2fpackage.json', '/..%2fserver%2fsrc%2fconfig.js', '/assets/../../../package.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%5c..%5cpackage.json', '/server/src/config.js', '/package.json']) {
    const r = await getRaw(evil, { 'accept-encoding': 'gzip' });
    const text = (r.headers['content-encoding'] === 'gzip' ? (await import('node:zlib')).gunzipSync(r.body) : r.body).toString();
    assert.ok(/<!doctype html>/i.test(text) || r.status >= 400, `${evil} returned something other than the editor page`);
    assert.ok(!/LITEFOREFLOW_SECRET|"dependencies"/.test(text), `${evil} leaked a source file`);
  }
  assert.equal((await getRaw('/api/health', { 'accept-encoding': 'gzip' })).headers['content-encoding'], undefined, 'the API is not touched');
  server.close();
});

test('the editor script that every page loads is small because the canvas is loaded on demand', async () => {
  const assets = fs.readdirSync(new URL('../../web/dist/assets', import.meta.url));
  const main = assets.find((f) => /^index-.*\.js$/.test(f));
  const editor = assets.find((f) => /^Editor-.*\.js$/.test(f));
  assert.ok(editor, 'the editor must be its own file');
  assert.ok(fs.statSync(new URL(`../../web/dist/assets/${main}`, import.meta.url)).size < 260_000);
});

/* -------------------------- found by reading the code (code-review pass) -------------------------- */
const app2 = async () => {
  await loadPlugins();
  await startWorker();
  const srv = createApp().listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = async (method, url, { token, body } = {}) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let data = text; try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
  };
  const token = (await api('POST', '/api/auth/signup', { body: { email: `cr${Date.now()}${Math.random()}@example.com`, password: 'password123', name: 'CR' } })).data.token;
  const run = async (nodes) => {
    const all = [{ id: 't', type: 'trigger.manual', name: 'Start', parameters: {}, position: { x: 0, y: 0 } }, ...nodes.map((n) => ({ position: { x: 0, y: 0 }, ...n }))];
    const wf = (await api('POST', '/api/workflows', { token, body: { name: 'cr', definition: { nodes: all, connections: all.slice(1).map((n, i) => ({ from: all[i].id, to: n.id, fromOutput: 0, toInput: 0 })) } } })).data;
    return (await api('POST', `/api/workflows/${wf.id}/run`, { token })).data;
  };
  return { srv, api, token, run };
};

test('250,000 items flow from one block to the next (passing them as call arguments used to crash above ~150,000)', async () => {
  const { srv, run } = await app2();
  try {
    const r = await run([
      { id: 'g', type: 'data.code', name: 'Gen', parameters: { code: 'return [{ list: Array.from({ length: 250000 }, (_, i) => i) }];' } },
      { id: 's', type: 'data.splitOut', name: 'Split', parameters: { field: 'list' } },
      { id: 'n', type: 'logic.noop', name: 'Next' },
      { id: 'l', type: 'data.limit', name: 'Few', parameters: { max: 3 } },
    ]);
    assert.equal(r.status, 'success', JSON.stringify(r.error));
    assert.deepEqual(r.results.l.output[0].map((x) => x.json.value), [0, 1, 2]);
  } finally { srv.close(); }
});

test('a download larger than HTTP_MAX_RESPONSE_MB fails cleanly instead of filling the memory; smaller ones work', async () => {
  const { srv, run } = await app2();
  const MB = 1048576;
  const big = http.createServer((req, res) => {
    const size = Number(new URL(req.url, 'http://x').searchParams.get('mb')) * MB;
    if (req.url.includes('declared')) res.setHeader('content-length', size);
    res.setHeader('content-type', 'text/plain');
    let sent = 0; const chunk = Buffer.alloc(64 * 1024, 120);
    const pump = () => { while (sent < size) { sent += chunk.length; if (!res.write(chunk)) return res.once('drain', pump); } return res.end(); };
    pump();
  }).listen(0);
  const url = (q) => `http://127.0.0.1:${big.address().port}/${q}`;
  try {
    for (const q of ['declared?mb=3', 'chunked?mb=3']) {
      const r = await run([{ id: 'h', type: 'http.request', name: 'Get', parameters: { method: 'GET', url: url(q) } }]);
      assert.equal(r.status, 'error', q);
      assert.match(r.error.message, /larger than 2 MB.*HTTP_MAX_RESPONSE_MB/, q);
    }
    const ok = await run([{ id: 'h', type: 'http.request', name: 'Get', parameters: { method: 'GET', url: url('chunked?mb=1') } }]);
    assert.equal(ok.status, 'success', JSON.stringify(ok.error));
  } finally { big.close(); srv.close(); }
});

test('sign-in tokens issued before the signing-key change still work', async () => {
  const { srv, api } = await app2();
  try {
    const { default: jwt } = await import('jsonwebtoken');
    const { jwtSecret } = await import('../src/crypto.js');
    const signup = await api('POST', '/api/auth/signup', { body: { email: `old${Date.now()}@example.com`, password: 'password123', name: 'Old' } });
    const oldStyle = jwt.sign({ sub: signup.data.user.id }, jwtSecret, { expiresIn: '7d' }); // exactly how earlier versions signed
    assert.equal((await api('GET', '/api/me', { token: oldStyle })).status, 200);
    assert.equal((await api('GET', '/api/me', { token: signup.data.token })).status, 200);
    const forged = jwt.sign({ sub: signup.data.user.id }, 'some other secret');
    assert.equal((await api('GET', '/api/me', { token: forged })).status, 401);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: signup.data.user.id })).toString('base64url')}.`;
    assert.equal((await api('GET', '/api/me', { token: none })).status, 401, 'unsigned tokens are refused');
  } finally { srv.close(); }
});


/* ------------------------------- found by using the product (end-to-end QA pass) ------------------------------- */
test('a service that cannot be reached is named, with the reason, instead of "fetch failed"; an empty error body adds no ": {}"', async () => {
  const { srv, run } = await app2();
  const closed = http.createServer().listen(0);
  const port = closed.address().port;
  await new Promise((r) => closed.close(r)); // nothing listens there now
  const empty = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); }).listen(0);
  try {
    const refused = await run([{ id: 'h', type: 'http.request', name: 'Get', parameters: { url: `http://127.0.0.1:${port}/x` } }]);
    assert.equal(refused.status, 'error');
    assert.match(refused.error.message, new RegExp(`Could not reach 127\.0\.0\.1:${port}: the connection was refused`));
    const missing = await run([{ id: 'h', type: 'http.request', name: 'Get', parameters: { url: `http://127.0.0.1:${empty.address().port}/nope` } }]);
    assert.match(missing.error.message, /HTTP 404 Not Found$/);
  } finally { empty.close(); srv.close(); }
});

test('names are trimmed; a blank name keeps the old one (workflows and credentials)', async () => {
  const { srv, api, token } = await app2();
  try {
    const wf = (await api('POST', '/api/workflows', { token, body: { name: '  Orders  ' } })).data;
    assert.equal(wf.name, 'Orders');
    assert.equal((await api('PUT', `/api/workflows/${wf.id}`, { token, body: { name: '   ' } })).data.name, 'Orders');
    assert.equal((await api('POST', '/api/workflows', { token, body: { name: '   ' } })).data.name, 'Untitled workflow');
    assert.equal((await api('POST', '/api/credentials', { token, body: { name: '   ', type: 'httpBearer', data: { token: 'x' } } })).status, 400);
    const c = (await api('POST', '/api/credentials', { token, body: { name: ' Key ', type: 'httpBearer', data: { token: 'x' } } })).data;
    assert.equal(c.name, 'Key');
    assert.equal((await api('PUT', `/api/credentials/${c.id}`, { token, body: { name: '  ', data: {} } })).data.name, 'Key');
  } finally { srv.close(); }
});

test('an SMTP credential may leave the port empty (the usual port is used)', async () => {
  const { srv, api, token } = await app2();
  try {
    const r = await api('POST', '/api/credentials', { token, body: { name: 'Mail', type: 'smtp', data: { host: 'smtp.example.com', from: 'a@example.com' } } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  } finally { srv.close(); }
});
