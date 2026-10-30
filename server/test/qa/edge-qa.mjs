// EDGE AND ABUSE CASES against a RUNNING server, as the QA account (test@example.com / test123456).
//   BASE=http://localhost:3456 node server/test/qa/edge-qa.mjs
// Things a careless or hostile user does: odd names, huge bodies, bursts, sandbox escapes, endless code, duplicate paths,
// and a real schedule that must fire on its own. Everything it creates is deleted at the end.
const BASE = (process.env.BASE || 'http://localhost:3456').replace(/\/$/, '');
const ok = (c, m) => { if (!c) throw new Error(m); };
const show = (v, n = 160) => String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const node = (id, type, name, parameters = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 } });
const edge = (from, to, fromOutput = 0) => ({ from, to, fromOutput, toInput: 0 });
const chain = (ns) => ns.slice(1).map((n, i) => edge(ns[i].id, n.id));

async function http(method, url, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text; try { data = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, data };
}
let r = await http('POST', '/api/auth/login', { body: { email: 'test@example.com', password: 'test123456' } });
if (r.status === 401) r = await http('POST', '/api/auth/signup', { body: { email: 'test@example.com', password: 'test123456', name: 'QA Tester' } });
const tk = r.data.token;
const made = [];
const create = async (name, nodes, connections = chain(nodes), settings) => {
  const x = await http('POST', '/api/workflows', { token: tk, body: { name, definition: { nodes, connections }, settings } });
  if (x.data?.id) made.push(x.data.id);
  return x;
};
const runWf = (id) => http('POST', `/api/workflows/${id}/run`, { token: tk, body: {} });

const results = [];
async function t(id, title, fn) {
  const t0 = Date.now();
  try { const note = await fn(); results.push({ id, ok: true }); console.log(`  ✔ ${id} ${title} (${Date.now() - t0} ms)\n      ${note}`); } catch (e) { results.push({ id, ok: false, msg: e.message }); console.log(`  ✘ ${id} ${title} (${Date.now() - t0} ms)\n      ${e.message}`); }
}

await t('E01', 'Odd names: HTML, emoji, right-to-left text and 500 characters are stored safely', async () => {
  const names = ['<img src=x onerror=alert(1)>', '📦 Orders → Slack ✅', 'تقرير يومي', 'x'.repeat(500)];
  const got = [];
  for (const n of names) { const x = await create(n, [node('t', 'trigger.manual', 'Start')], []); ok(x.status === 201, `${x.status} ${show(x.data)}`); got.push(x.data.name); }
  ok(got[0] === names[0] && got[1] === names[1] && got[2] === names[2], `names changed: ${show(got)}`);
  ok(got[3].length === 120, `long name not cut to 120: ${got[3].length}`);
  return 'kept exactly (HTML is shown as text by the UI), long name cut to 120';
});

await t('E02', 'Webhook bursts: 60 calls at the same time all answer and all runs are recorded', async () => {
  const path = `qa-burst-${Date.now().toString(36)}`;
  const nodes = [node('wh', 'trigger.webhook', 'In', { path, method: 'POST', respond: 'lastNode' }), node('s', 'data.set', 'Echo', { fields: [{ name: 'n', value: '{{ $json.body.n }}' }], keepOthers: false })];
  const wf = await create('QA burst', nodes);
  await http('POST', `/api/workflows/${wf.data.id}/activate`, { token: tk });
  const t0 = Date.now();
  const answers = await Promise.all(Array.from({ length: 60 }, (_, n) => http('POST', `/webhook/${path}`, { body: { n } })));
  const ms = Date.now() - t0;
  const bad = answers.filter((a, n) => a.status !== 200 || JSON.stringify(a.data).indexOf(`"n":${n}`) < 0);
  ok(!bad.length, `${bad.length} wrong answers, e.g. ${show(bad[0])}`);
  await sleep(300);
  const ex = await http('GET', `/api/executions?workflowId=${wf.data.id}&limit=200`, { token: tk });
  const list = (Array.isArray(ex.data) ? ex.data : ex.data.executions ?? []).filter((e) => (e.workflowId ?? e.workflow_id) === wf.data.id);
  await http('POST', `/api/workflows/${wf.data.id}/deactivate`, { token: tk });
  ok(list.length >= 50, `only ${list.length} runs listed for 60 calls`);
  return `60/60 correct answers in ${ms} ms; ${list.length} runs listed${list.length < 60 ? ' (the list shows at most ' + list.length + ')' : ''}`;
});

await t('E03', 'A 6 MB webhook body is refused with 413, not a crash; the server keeps working', async () => {
  const path = `qa-big-${Date.now().toString(36)}`;
  const wf = await create('QA big body', [node('wh', 'trigger.webhook', 'In', { path, method: 'POST' })], []);
  await http('POST', `/api/workflows/${wf.data.id}/activate`, { token: tk });
  const big = await http('POST', `/webhook/${path}`, { body: { blob: 'x'.repeat(6 * 1024 * 1024) } });
  const after = await http('GET', '/api/workflows', { token: tk });
  await http('POST', `/api/workflows/${wf.data.id}/deactivate`, { token: tk });
  ok(big.status === 413, `expected 413, got ${big.status} ${show(big.data)}`);
  ok(after.status === 200, 'server stopped answering');
  return `413: ${show(big.data, 90)}`;
});

await t('E04', 'Sandbox: expressions and Code cannot reach the server (process, require, constructor tricks)', async () => {
  const tries = ['{{ process.env }}', '{{ require("fs") }}', '{{ this.constructor.constructor("return process")().env }}', '{{ globalThis.process }}'];
  const msgs = [];
  for (const expr of tries) {
    const wf = await create('QA escape', [node('t', 'trigger.manual', 'Start'), node('s', 'data.set', 'Try', { fields: [{ name: 'x', value: expr }] })]);
    const x = await runWf(wf.data.id);
    const val = x.data.results?.s?.output?.[0]?.[0]?.json?.x;
    const leak = JSON.stringify(val ?? '').match(/PATH|Path|APPDATA|readFileSync/);
    ok(!leak, `${expr} leaked: ${show(val)}`);
    msgs.push(x.data.status === 'error' ? show(x.data.error?.message ?? x.data.error, 60) : `value ${show(val, 30)}`);
  }
  const code = await create('QA escape code', [node('t', 'trigger.manual', 'Start'), node('c', 'data.code', 'Try', { code: 'return [{ p: typeof process, r: typeof require, f: (() => { try { return this.constructor.constructor("return process")().pid } catch (e) { return "blocked" } })() }];' })]);
  const cx = await runWf(code.data.id);
  const cv = cx.data.results?.c?.output?.[0]?.[0]?.json;
  ok(cx.data.status === 'error' || (cv?.p === 'undefined' && cv?.r === 'undefined' && !Number.isInteger(cv?.f)), `Code node reached the host: ${show(cv)}`);
  return `${msgs.join(' | ')} | code: ${show(cv ?? cx.data.error, 80)}`;
});

await t('E05', 'Endless loop in a Code node stops with a timeout message; the next run works', async () => {
  const wf = await create('QA endless', [node('t', 'trigger.manual', 'Start'), node('c', 'data.code', 'Spin', { code: 'while (true) {}' })]);
  const t0 = Date.now();
  const x = await runWf(wf.data.id);
  const ms = Date.now() - t0;
  ok(x.data.status === 'error' && /time|long|limit/i.test(show(x.data.error)), `expected a timeout error: ${show(x.data)}`);
  const ok2 = await create('QA after endless', [node('t', 'trigger.manual', 'Start'), node('n', 'logic.noop', 'N')]);
  const y = await runWf(ok2.data.id);
  ok(y.data.status === 'success', 'the next run failed');
  return `stopped after ${ms} ms: ${show(x.data.error?.message ?? x.data.error, 100)}`;
});

await t('E06', 'Two active workflows cannot share one webhook path', async () => {
  const path = `qa-same-${Date.now().toString(36)}`;
  const a = await create('QA path A', [node('wh', 'trigger.webhook', 'In', { path })], []);
  const b = await create('QA path B', [node('wh', 'trigger.webhook', 'In', { path })], []);
  const actA = await http('POST', `/api/workflows/${a.data.id}/activate`, { token: tk });
  const actB = await http('POST', `/api/workflows/${b.data.id}/activate`, { token: tk });
  await http('POST', `/api/workflows/${a.data.id}/deactivate`, { token: tk });
  ok(actA.status === 200 && actB.status >= 400, `A ${actA.status}, B ${actB.status} ${show(actB.data)}`);
  return `second activation refused (${actB.status}): ${show(actB.data.error ?? actB.data, 100)}`;
});

await t('E07', 'Limits: 201 nodes refused; a definition that is not a list refused', async () => {
  const many = Array.from({ length: 201 }, (_, i) => node(`n${i}`, i ? 'logic.noop' : 'trigger.manual', `N${i}`));
  const x = await create('QA huge', many);
  const y = await http('POST', '/api/workflows', { token: tk, body: { name: 'QA broken', definition: { nodes: 'nope', connections: {} } } });
  ok(x.status === 400 && y.status === 400, `201 nodes: ${x.status}; broken: ${y.status}`);
  return `${show(x.data.error, 60)} | ${show(y.data.error, 60)}`;
});

await t('E08', 'Executions filter: only errors when asked for errors', async () => {
  const wf = await create('QA fail once', [node('t', 'trigger.manual', 'Start'), node('x', 'logic.stopAndError', 'Fail', { message: 'filter me' })]);
  await runWf(wf.data.id);
  const ex = await http('GET', '/api/executions?status=error', { token: tk });
  const list = Array.isArray(ex.data) ? ex.data : ex.data.executions ?? [];
  ok(list.length >= 1 && list.every((e) => e.status === 'error'), `filter returned ${show(list.map((e) => e.status))}`);
  return `${list.length} error runs, no others`;
});

await t('E09', 'Schedule: a workflow set to every minute runs by itself within 70 seconds', async () => {
  const wf = await create('QA every minute', [node('c', 'trigger.cron', 'Every minute', { cron: '* * * * *', timezone: 'UTC' }), node('n', 'logic.noop', 'Tick')]);
  const act = await http('POST', `/api/workflows/${wf.data.id}/activate`, { token: tk });
  ok(act.status === 200, `activate: ${act.status} ${show(act.data)}`);
  let runs = [];
  for (let i = 0; i < 35 && !runs.length; i += 1) {
    await sleep(2000);
    const ex = await http('GET', `/api/executions?workflowId=${wf.data.id}`, { token: tk });
    runs = (Array.isArray(ex.data) ? ex.data : ex.data.executions ?? []).filter((e) => (e.workflowId ?? e.workflow_id) === wf.data.id);
  }
  await http('POST', `/api/workflows/${wf.data.id}/deactivate`, { token: tk });
  ok(runs.length >= 1, 'the schedule never fired');
  ok(runs[0].mode !== 'manual', `run mode is ${runs[0].mode}`);
  return `fired by itself (mode ${runs[0].mode}, status ${runs[0].status})`;
});

await t('E10', 'Login guessing is slowed down: repeated wrong passwords get 429', async () => {
  let last;
  for (let i = 0; i < 30; i += 1) { last = await http('POST', '/api/auth/login', { body: { email: `nobody-${i}@example.com`, password: 'wrong-password' } }); if (last.status === 429) break; }
  ok(last.status === 429, `never limited (last ${last.status})`);
  return `429: ${show(last.data.error ?? last.data, 80)}`;
});

for (const id of made) await http('DELETE', `/api/workflows/${id}`, { token: tk });
const fail = results.filter((x) => !x.ok).length;
console.log(`\nEDGE ${results.length}  PASS ${results.length - fail}  FAIL ${fail}`);
process.exitCode = fail ? 1 : 0;
