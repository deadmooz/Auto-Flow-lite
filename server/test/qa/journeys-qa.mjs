// END-TO-END USER JOURNEYS against a RUNNING server, as the shared QA account (test@example.com / test123456).
// Each journey is what a real user does from start to finish, with live public services (Open-Meteo, JSONPlaceholder,
// GitHub, Postman Echo) and nothing faked. Run it several times to catch flaky behaviour:
//   BASE=http://localhost:3456 ROUNDS=3 node server/test/qa/journeys-qa.mjs
// The account is created when it does not exist yet. Workflows a journey creates are deleted at its end.
const BASE = (process.env.BASE || 'http://localhost:3456').replace(/\/$/, '');
const ROUNDS = Number(process.env.ROUNDS) || 1;
const ONLY = process.env.ONLY?.split(',');
const EMAIL = 'test@example.com';
const PASSWORD = 'test123456';

const ok = (c, m) => { if (!c) throw new Error(m); };
const show = (v, n = 160) => String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const node = (id, type, name, parameters = {}, extra = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 }, ...extra });
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
  return { status: res.status, data, headers: res.headers };
}

async function login(email, password, name) {
  let r = await http('POST', '/api/auth/login', { body: { email, password } });
  if (r.status === 401) r = await http('POST', '/api/auth/signup', { body: { email, password, name } });
  ok(r.data?.token, `cannot sign in as ${email}: ${r.status} ${show(r.data)}`);
  return r.data.token;
}

const created = [];
async function createWf(token, name, nodes, connections, settings) {
  const r = await http('POST', '/api/workflows', { token, body: { name, definition: { nodes, connections }, settings } });
  ok(r.status === 201, `create "${name}": ${r.status} ${show(r.data)}`);
  created.push([token, r.data.id]);
  return r.data;
}
const runWf = async (token, id, payload) => http('POST', `/api/workflows/${id}/run`, { token, body: payload === undefined ? {} : { payload } });
const out = (r, id, o = 0) => r.data.results?.[id]?.output?.[o]?.map((i) => i.json) ?? [];

/* --------------------------------------------------------------------------------------------- journeys */
const J = [];
const journey = (id, title, fn) => J.push({ id, title, fn });

journey('J01', 'Lead capture: public webhook validates the lead and answers 201 / 400; runs show up in Executions', async (tk) => {
  const path = `qa-lead-${Date.now().toString(36)}`;
  const nodes = [
    node('wh', 'trigger.webhook', 'Lead in', { path, method: 'POST', respond: 'responseNode', secret: 'lead-secret' }),
    node('set', 'data.set', 'Tidy', { fields: [{ name: 'email', value: '{{ $json.body.email }}' }, { name: 'name', value: '{{ $json.body.name }}' }], keepOthers: false }),
    node('if', 'logic.if', 'Valid email?', { conditions: [{ left: '{{ $json.email }}', op: 'contains', right: '@' }], combine: 'all' }),
    node('ok', 'respond.webhook', 'Accepted', { status: 201, send: 'json', json: '{ "saved": true, "email": "{{ $json.email }}" }' }),
    node('bad', 'respond.webhook', 'Rejected', { status: 400, send: 'json', json: '{ "saved": false, "reason": "invalid email" }' }),
  ];
  const wf = await createWf(tk, 'QA lead capture', nodes, [edge('wh', 'set'), edge('set', 'if'), edge('if', 'ok', 0), edge('if', 'bad', 1)]);
  const act = await http('POST', `/api/workflows/${wf.id}/activate`, { token: tk });
  ok(act.status === 200 && act.data.active, `activate: ${act.status} ${show(act.data)}`);
  const hook = (body, headers = { 'x-webhook-secret': 'lead-secret' }, method = 'POST') => http(method, `/webhook/${path}`, { body, headers });
  const good = await hook({ email: 'ada@example.com', name: 'Ada' });
  ok(good.status === 201 && good.data.saved === true && good.data.email === 'ada@example.com', `valid lead: ${good.status} ${show(good.data)}`);
  const bad = await hook({ email: 'not-an-email', name: 'Bob' });
  ok(bad.status === 400 && bad.data.saved === false, `invalid lead: ${bad.status} ${show(bad.data)}`);
  const noSecret = await hook({ email: 'eve@example.com' }, {});
  ok(noSecret.status === 401 || noSecret.status === 403, `missing secret must be refused: ${noSecret.status} ${show(noSecret.data)}`);
  const wrongMethod = await hook(undefined, { 'x-webhook-secret': 'lead-secret' }, 'GET');
  ok(wrongMethod.status >= 400 && wrongMethod.status < 500, `GET on a POST webhook: ${wrongMethod.status}`);
  const broken = await http('POST', `/webhook/${path}`, { body: '{"email": broken', raw: true, headers: { 'content-type': 'application/json', 'x-webhook-secret': 'lead-secret' } });
  ok(broken.status === 400, `broken JSON body should be a 400: ${broken.status} ${show(broken.data)}`);
  const ex = await http('GET', `/api/executions?workflowId=${wf.id}`, { token: tk });
  const list = Array.isArray(ex.data) ? ex.data : ex.data.executions ?? ex.data.items ?? [];
  const mine = list.filter((e) => (e.workflowId ?? e.workflow_id) === wf.id);
  ok(mine.length >= 2, `expected the 2 accepted calls in Executions, found ${mine.length}: ${show(ex.data)}`);
  await http('POST', `/api/workflows/${wf.id}/deactivate`, { token: tk });
  const after = await hook({ email: 'late@example.com' });
  ok(after.status === 404, `webhook must stop after deactivation: ${after.status}`);
  return `201 for a good lead, 400 for a bad one, ${noSecret.status} without the secret, ${wrongMethod.status} for GET, 400 for broken JSON, ${mine.length} runs listed, 404 once switched off`;
});

journey('J02', 'Weather check: live Open-Meteo forecast for 3 cities, branch on temperature, summary list', async (tk) => {
  const nodes = [
    node('t', 'trigger.manual', 'Start'),
    node('cities', 'data.code', 'Cities', { mode: 'runOnce', code: 'return [{ city: "Oslo", lat: 59.91, lon: 10.75 }, { city: "Cairo", lat: 30.04, lon: 31.24 }, { city: "Delhi", lat: 28.61, lon: 77.21 }];' }),
    node('wx', 'http.request', 'Forecast', { method: 'GET', url: 'https://api.open-meteo.com/v1/forecast', query: '{ "latitude": "{{ $json.lat }}", "longitude": "{{ $json.lon }}", "current": "temperature_2m" }' }),
    node('set', 'data.set', 'Shape', { fields: [{ name: 'temp', value: '{{ $json.current.temperature_2m }}' }, { name: 'lat', value: '{{ $json.latitude }}' }], keepOthers: false }),
    node('if', 'logic.if', 'Cold?', { conditions: [{ left: '{{ $json.temp }}', op: 'lt', right: '10' }] }),
    node('agg', 'data.aggregate', 'Warm list', { field: 'warm' }),
  ];
  const wf = await createWf(tk, 'QA weather', nodes, [...chain(nodes.slice(0, 5)), edge('if', 'agg', 1)]);
  const r = await runWf(tk, wf.id);
  ok(r.data.status === 'success', `run: ${show(r.data.error ?? r.data)}`);
  const shaped = out(r, 'set');
  ok(shaped.length === 3 && shaped.every((s) => typeof s.temp === 'number'), `3 numeric temperatures expected: ${show(shaped)}`);
  const cold = out(r, 'if', 0).length; const warm = out(r, 'if', 1).length;
  ok(cold + warm === 3, `IF lost items: ${cold}+${warm}`);
  return `temps ${shaped.map((s) => s.temp).join(' / ')} °C; ${cold} cold, ${warm} warm`;
});

journey('J03', 'Content pipeline: JSONPlaceholder posts -> split -> filter by user -> sort -> limit -> aggregate', async (tk) => {
  const nodes = [
    node('t', 'trigger.manual', 'Start'),
    node('get', 'http.request', 'Posts', { method: 'GET', url: 'https://jsonplaceholder.typicode.com/posts' }),
    node('split', 'data.splitOut', 'One per post', { field: 'data' }), // a JSON list arrives as ONE item { data: [...] }
    node('flt', 'tools.filter', 'User 3 only', { conditions: [{ left: '{{ $json.userId }}', op: 'equals', right: '3' }], combine: 'all' }),
    node('srt', 'tools.sort', 'Longest title first', { field: 'id', direction: 'desc', kind: 'number' }),
    node('lim', 'data.limit', 'Top 3', { max: 3 }),
    node('agg', 'data.aggregate', 'Digest', { field: 'posts' }),
  ];
  const wf = await createWf(tk, 'QA content', nodes, chain(nodes));
  const r = await runWf(tk, wf.id);
  ok(r.data.status === 'success', `run: ${show(r.data.error ?? r.data)}`);
  const got = out(r, 'get');
  const posts = out(r, 'agg')[0]?.posts ?? [];
  ok(posts.length === 3, `3 posts expected, got ${posts.length} (HTTP gave ${got.length} items: ${show(got[0])})`);
  ok(posts.every((p) => p.userId === 3), 'filter let other users through');
  ok(posts[0].id > posts[1].id && posts[1].id > posts[2].id, `not sorted: ${posts.map((p) => p.id)}`);
  return `HTTP gave ${got.length} item(s); digest ids ${posts.map((p) => p.id).join(', ')}`;
});

journey('J04', 'API with a saved secret: bearer credential is sent, never shown back, and a deleted credential fails clearly', async (tk) => {
  const token = `qa-${Math.random().toString(36).slice(2)}`;
  const c = await http('POST', '/api/credentials', { token: tk, body: { name: 'QA echo token', type: 'httpBearer', data: { token } } });
  ok(c.status === 201, `create credential: ${c.status} ${show(c.data)}`);
  const list = await http('GET', '/api/credentials', { token: tk });
  ok(!JSON.stringify(list.data).includes(token), 'credential list leaks the secret');
  const one = await http('GET', `/api/credentials/${c.data.id}`, { token: tk });
  ok(!JSON.stringify(one.data).includes(token) && one.data.secretsSet?.includes('token'), `credential detail leaks or forgets the secret: ${show(one.data)}`);
  const nodes = [node('t', 'trigger.manual', 'Start'), node('echo', 'http.request', 'Echo', { method: 'GET', url: 'https://postman-echo.com/get?probe=1', credential: c.data.id })];
  const wf = await createWf(tk, 'QA echo', nodes, chain(nodes));
  const r = await runWf(tk, wf.id);
  ok(r.data.status === 'success', `run: ${show(r.data.error ?? r.data)}`);
  const sent = out(r, 'echo')[0]?.headers?.authorization;
  ok(sent === `Bearer ${token}`, `server did not send the saved token (echo saw ${show(sent)})`);
  const rename = await http('PUT', `/api/credentials/${c.data.id}`, { token: tk, body: { name: 'QA echo token (renamed)', data: { token: '' } } });
  ok(rename.status === 200, `rename: ${rename.status} ${show(rename.data)}`);
  const r2 = await runWf(tk, wf.id);
  ok(out(r2, 'echo')[0]?.headers?.authorization === `Bearer ${token}`, 'renaming with a blank secret lost the stored token');
  const del = await http('DELETE', `/api/credentials/${c.data.id}`, { token: tk });
  ok(del.status === 204 || del.status === 200, `delete: ${del.status}`);
  const r3 = await runWf(tk, wf.id);
  const msg = show(r3.data.error?.message ?? r3.data.error ?? r3.data, 200);
  ok(r3.data.status === 'error' && /credential/i.test(msg), `a run with a deleted credential must fail with a clear message: ${msg}`);
  return `token sent as Bearer, hidden in list+detail, kept on rename; after delete: "${msg.slice(0, 90)}"`;
});

journey('J05', 'Failure handling: a failing workflow starts its Error workflow with the failure details', async (tk) => {
  const errNodes = [node('et', 'trigger.error', 'On failure'), node('note', 'data.set', 'Alert text', { fields: [{ name: 'alert', value: 'Failed: {{ $json.workflow.name }} - {{ $json.execution.error.message }}' }], keepOthers: true })];
  const ew = await createWf(tk, 'QA error handler', errNodes, chain(errNodes));
  const nodes = [node('t', 'trigger.manual', 'Start'), node('boom', 'logic.stopAndError', 'Fail on purpose', { message: 'Inventory API returned nothing' })];
  const wf = await createWf(tk, 'QA failing job', nodes, chain(nodes), { errorWorkflowId: ew.id });
  const r = await runWf(tk, wf.id);
  ok(r.data.status === 'error', `the run should fail: ${show(r.data)}`);
  let found;
  for (let i = 0; i < 20 && !found; i += 1) {
    await sleep(250);
    const ex = await http('GET', `/api/executions?workflowId=${ew.id}`, { token: tk });
    const list = (Array.isArray(ex.data) ? ex.data : ex.data.executions ?? []).filter((e) => (e.workflowId ?? e.workflow_id) === ew.id);
    if (list.length) found = list[0];
  }
  ok(found, 'the error workflow never ran');
  const detail = await http('GET', `/api/executions/${found.id}`, { token: tk });
  const text = JSON.stringify(detail.data);
  ok(text.includes('Inventory API returned nothing'), `error workflow did not receive the failure message: ${show(detail.data, 300)}`);
  return `error workflow ran (${found.status}) and saw the message`;
});

journey('J06', 'Migration: import an n8n export, review the report, run it', async (tk) => {
  const n8n = {
    name: 'From n8n',
    nodes: [
      { id: 'a', name: 'When clicking', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'b', name: 'Set fields', type: 'n8n-nodes-base.set', typeVersion: 3, position: [200, 0], parameters: { values: { string: [{ name: 'greeting', value: 'hello' }] } } },
      { id: 'c', name: 'Get todo', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [400, 0], parameters: { url: 'https://jsonplaceholder.typicode.com/todos/1', method: 'GET' } },
    ],
    connections: { 'When clicking': { main: [[{ node: 'Set fields', type: 'main', index: 0 }]] }, 'Set fields': { main: [[{ node: 'Get todo', type: 'main', index: 0 }]] } },
  };
  const r = await http('POST', '/api/import/n8n', { token: tk, body: { workflow: n8n, json: n8n, name: 'QA imported' } });
  ok(r.status === 201 || r.status === 200, `import: ${r.status} ${show(r.data)}`);
  const id = r.data.workflow?.id ?? r.data.id;
  ok(id, `no workflow id in ${show(r.data)}`);
  created.push([tk, id]);
  const run = await runWf(tk, id);
  ok(run.data.status === 'success', `imported workflow run: ${show(run.data.error ?? run.data)}`);
  const all = Object.values(run.data.results ?? {});
  const todo = all.flatMap((x) => x.output?.[0] ?? []).map((i) => i.json).find((j) => j?.title);
  ok(todo?.id === 1, `the imported HTTP node did not fetch the todo: ${show(all)}`);
  return `imported (${show(r.data.report ?? r.data.warnings ?? 'no report', 80)}), ran, fetched "${todo.title.slice(0, 30)}"`;
});

journey('J07', 'Housekeeping: duplicate, rename, delete; runs of a deleted workflow are gone', async (tk) => {
  const nodes = [node('t', 'trigger.manual', 'Start'), node('n', 'logic.noop', 'Nothing')];
  const wf = await createWf(tk, 'QA housekeeping', nodes, chain(nodes));
  await runWf(tk, wf.id);
  const dup = await http('POST', `/api/workflows/${wf.id}/duplicate`, { token: tk });
  ok(dup.status === 201 && dup.data.name.includes('(copy)'), `duplicate: ${dup.status} ${show(dup.data)}`);
  created.push([tk, dup.data.id]);
  const ren = await http('PUT', `/api/workflows/${dup.data.id}`, { token: tk, body: { name: '  Renamed  ' } });
  ok(ren.status === 200 && ren.data.name === 'Renamed', `rename should trim spaces: ${ren.status} "${ren.data.name}"`);
  const empty = await http('PUT', `/api/workflows/${dup.data.id}`, { token: tk, body: { name: '   ' } });
  ok(empty.status === 200 && empty.data.name === 'Renamed', `a blank name must keep the old one: "${empty.data.name}"`);
  const del = await http('DELETE', `/api/workflows/${wf.id}`, { token: tk });
  ok(del.status === 204, `delete: ${del.status}`);
  const gone = await http('GET', `/api/workflows/${wf.id}`, { token: tk });
  ok(gone.status === 404, `deleted workflow still readable: ${gone.status}`);
  const ex = await http('GET', `/api/executions?workflowId=${wf.id}`, { token: tk });
  const left = (Array.isArray(ex.data) ? ex.data : ex.data.executions ?? []).filter((e) => (e.workflowId ?? e.workflow_id) === wf.id);
  ok(left.length === 0, `${left.length} runs of a deleted workflow remain`);
  return `copy named "${dup.data.name}", rename kept "${empty.data.name}", delete removed runs`;
});

journey('J08', 'Privacy between accounts: a second user cannot see or touch the first one\'s things', async (tk) => {
  const other = await login(`qa-other-${Date.now()}@example.com`, 'other-pass-123', 'Other');
  const nodes = [node('t', 'trigger.manual', 'Start')];
  const wf = await createWf(tk, 'QA private', nodes, []);
  const c = await http('POST', '/api/credentials', { token: tk, body: { name: 'QA private cred', type: 'httpBearer', data: { token: 'x' } } });
  const checks = {
    readWf: await http('GET', `/api/workflows/${wf.id}`, { token: other }),
    runWf: await http('POST', `/api/workflows/${wf.id}/run`, { token: other, body: {} }),
    delWf: await http('DELETE', `/api/workflows/${wf.id}`, { token: other }),
    readCred: await http('GET', `/api/credentials/${c.data.id}`, { token: other }),
    listWf: await http('GET', '/api/workflows', { token: other }),
    noToken: await http('GET', '/api/workflows'),
    badToken: await http('GET', '/api/workflows', { token: 'abc.def.ghi' }),
  };
  await http('DELETE', `/api/credentials/${c.data.id}`, { token: tk });
  ok([checks.readWf, checks.runWf, checks.delWf, checks.readCred].every((x) => x.status === 404), `cross-account access: ${Object.entries(checks).map(([k, v]) => `${k}=${v.status}`).join(' ')}`);
  ok(!JSON.stringify(checks.listWf.data).includes(wf.id), 'other user lists my workflow');
  ok(checks.noToken.status === 401 && checks.badToken.status === 401, 'unauthenticated access not refused');
  return Object.entries(checks).map(([k, v]) => `${k}=${v.status}`).join(' ');
});

journey('J09', 'Data editing at scale: 2,000 items through Code -> Edit Fields -> Remove Duplicates -> Sort in one run', async (tk) => {
  const nodes = [
    node('t', 'trigger.manual', 'Start'),
    node('gen', 'data.code', 'Generate', { mode: 'runOnce', code: 'return Array.from({ length: 2000 }, (_, i) => ({ sku: "SKU-" + (i % 500), price: (i * 7) % 113, qty: i % 9 }));' }),
    node('set', 'data.set', 'Total', { fields: [{ name: 'total', value: '{{ $json.price * $json.qty }}' }], keepOthers: true }),
    node('uni', 'tools.unique', 'One per SKU', { field: 'sku' }),
    node('srt', 'tools.sort', 'Biggest first', { field: 'total', direction: 'desc', kind: 'number' }),
    node('agg', 'data.aggregate', 'All rows', { field: 'rows' }), // the run record keeps only 100 items per block; one item holds them all
  ];
  const wf = await createWf(tk, 'QA scale', nodes, chain(nodes));
  const t0 = Date.now();
  const r = await runWf(tk, wf.id);
  const ms = Date.now() - t0;
  ok(r.data.status === 'success', `run: ${show(r.data.error ?? r.data)}`);
  const rows = out(r, 'agg')[0]?.rows ?? [];
  ok(out(r, 'srt').length === 100, `the run record should keep 100 items of a big block, kept ${out(r, 'srt').length}`);
  ok(rows.length === 500, `500 unique SKUs expected, got ${rows.length}`);
  ok(rows.every((x, i) => i === 0 || rows[i - 1].total >= x.total), 'not sorted');
  ok(rows.every((x) => x.total === x.price * x.qty), 'wrong totals');
  return `2,000 -> 500 rows in ${ms} ms, top total ${rows[0].total}`;
});

journey('J10', 'Mistakes a user makes: bad URL, bad JSON settings, expression typo, cycle, missing trigger', async (tk) => {
  const res = {};
  const one = async (label, n) => {
    const nodes = [node('t', 'trigger.manual', 'Start'), n];
    const wf = await createWf(tk, `QA mistake ${label}`, nodes, chain(nodes));
    const r = await runWf(tk, wf.id);
    res[label] = { status: r.status, run: r.data.status, msg: show(r.data.error?.message ?? r.data.error ?? '', 110) };
  };
  await one('deadHost', node('h', 'http.request', 'Dead', { url: 'https://no-such-host-liteforeflow.invalid/x' }));
  await one('notUrl', node('h', 'http.request', 'Not a URL', { url: 'just some words' }));
  await one('badJson', node('h', 'http.request', 'Bad headers', { url: 'https://postman-echo.com/get', headers: '{ not json' }));
  await one('typo', node('s', 'data.set', 'Typo', { fields: [{ name: 'x', value: '{{ $json.a.b.c }}' }] }));
  await one('http404', node('h', 'http.request', '404', { url: 'https://jsonplaceholder.typicode.com/nope-404' }));
  const cyc = await http('POST', '/api/workflows', { token: tk, body: { name: 'QA cycle', definition: { nodes: [node('t', 'trigger.manual', 'Start'), node('a', 'logic.noop', 'A'), node('b', 'logic.noop', 'B')], connections: [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')] } } });
  if (cyc.data?.id) created.push([tk, cyc.data.id]);
  const cycRun = cyc.data?.id ? await runWf(tk, cyc.data.id) : cyc;
  res.cycle = { status: cycRun.status, msg: show(cycRun.data.error ?? cycRun.data, 110) };
  const noTrig = await http('POST', '/api/workflows', { token: tk, body: { name: 'QA no trigger', definition: { nodes: [node('a', 'logic.noop', 'A')], connections: [] } } });
  if (noTrig.data?.id) created.push([tk, noTrig.data.id]);
  const noTrigRun = noTrig.data?.id ? await runWf(tk, noTrig.data.id) : noTrig;
  res.noTrigger = { status: noTrigRun.status, msg: show(noTrigRun.data.error ?? noTrigRun.data, 110) };
  const problems = [];
  if (!/no-such-host-liteforeflow\.invalid/.test(res.deadHost.msg) || /^fetch failed$/.test(res.deadHost.msg)) problems.push(`deadHost must name the host and why: ${res.deadHost.msg}`);
  for (const k of ['deadHost', 'notUrl', 'badJson', 'http404']) if (res[k].run !== 'error' || !res[k].msg || /undefined|\[object|TypeError|stack/i.test(res[k].msg)) problems.push(`${k}: ${JSON.stringify(res[k])}`);
  if (res.typo.run !== 'error' && res.typo.run !== 'success') problems.push(`typo: ${JSON.stringify(res.typo)}`);
  if (res.cycle.status !== 400 || !/cycle|loop/i.test(res.cycle.msg)) problems.push(`cycle: ${JSON.stringify(res.cycle)}`);
  if (res.noTrigger.status !== 400 || !/trigger/i.test(res.noTrigger.msg)) problems.push(`noTrigger: ${JSON.stringify(res.noTrigger)}`);
  ok(!problems.length, problems.join('\n      '));
  return Object.entries(res).map(([k, v]) => `${k}: ${v.msg || v.run}`).join(' | ');
});

/** A tiny SMTP server on this computer that keeps what it receives: real email sending without any outside account. */
async function smtpSink() {
  const net = await import('node:net');
  const mails = [];
  const server = net.createServer((sock) => {
    let buf = ''; let inData = false; let cur = { rcpt: [], body: '' };
    const say = (s) => sock.write(`${s}\r\n`);
    say('220 qa-sink ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; mails.push(cur); cur = { rcpt: [], body: '' }; say('250 queued'); } else cur.body += `${line.replace(/^\.\./, '.')}\n`;
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') say('250 qa-sink');
        else if (cmd === 'MAIL') { cur.from = line; say('250 ok'); } else if (cmd === 'RCPT') { cur.rcpt.push(line); say('250 ok'); } else if (cmd === 'DATA') { inData = true; say('354 go ahead'); } else if (cmd === 'QUIT') { say('221 bye'); sock.end(); } else say('250 ok');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, mails, close: () => server.close() };
}

journey('J11', 'Email: a form submission sends a real email through SMTP (local mail server), one per recipient', async (tk) => {
  const sink = await smtpSink();
  try {
    const c = await http('POST', '/api/credentials', { token: tk, body: { name: 'QA local SMTP', type: 'smtp', data: { host: '127.0.0.1', port: String(sink.port), from: 'robot@example.com' } } });
    ok(c.status === 201, `SMTP credential: ${c.status} ${show(c.data)}`);
    const noPort = await http('POST', '/api/credentials', { token: tk, body: { name: 'QA SMTP no port', type: 'smtp', data: { host: 'smtp.example.com', from: 'robot@example.com' } } });
    ok(noPort.status === 201, `an empty port must be allowed (587 is used): ${noPort.status} ${show(noPort.data)}`);
    await http('DELETE', `/api/credentials/${noPort.data.id}`, { token: tk });
    const nodes = [
      node('t', 'trigger.manual', 'Start'),
      node('people', 'data.code', 'Recipients', { mode: 'runOnce', code: 'return [{ name: "Ada", email: "ada@example.com" }, { name: "Linus", email: "linus@example.com" }];' }),
      node('mail', 'app.email', 'Send', { credential: c.data.id, to: '{{ $json.email }}', subject: 'Hello {{ $json.name }}', text: 'Your order #{{ $itemIndex + 1 }} has shipped.' }),
    ];
    const wf = await createWf(tk, 'QA email', nodes, chain(nodes));
    const r = await runWf(tk, wf.id);
    await http('DELETE', `/api/credentials/${c.data.id}`, { token: tk });
    ok(r.data.status === 'success', `run: ${show(r.data.error ?? r.data)}`);
    ok(sink.mails.length === 2, `2 emails expected, the server got ${sink.mails.length}`);
    const [a, b] = sink.mails;
    ok(/Subject: Hello Ada/.test(a.body) && /ada@example\.com/.test(a.rcpt[0]) && /order #1 has shipped/.test(a.body), `first email wrong: ${show(a, 300)}`);
    ok(/Subject: Hello Linus/.test(b.body) && /order #2 has shipped/.test(b.body), `second email wrong: ${show(b, 300)}`);
    ok(/robot@example\.com/.test(a.from), `From not used: ${a.from}`);
    return `2 emails delivered to the local server (${out(r, 'mail').map((m) => m.accepted?.[0]).join(', ')})`;
  } finally { sink.close(); }
});

/* --------------------------------------------------------------------------------------------- runner */
const tk = await login(EMAIL, PASSWORD, 'QA Tester');
const tally = {};
for (let round = 1; round <= ROUNDS; round += 1) {
  console.log(`\n== round ${round}/${ROUNDS}`);
  for (const j of J) {
    if (ONLY && !ONLY.includes(j.id)) continue;
    const t0 = Date.now();
    tally[j.id] ??= { pass: 0, fail: 0, title: j.title, errors: [] };
    try {
      const note = await j.fn(tk);
      tally[j.id].pass += 1;
      console.log(`  ✔ ${j.id} ${j.title} (${Date.now() - t0} ms)\n      ${note}`);
    } catch (e) {
      tally[j.id].fail += 1;
      tally[j.id].errors.push(e.message);
      console.log(`  ✘ ${j.id} ${j.title} (${Date.now() - t0} ms)\n      ${e.message}`);
    }
  }
  for (const [t, id] of created.splice(0)) await http('DELETE', `/api/workflows/${id}`, { token: t });
}
const pass = Object.values(tally).reduce((s, x) => s + x.pass, 0);
const fail = Object.values(tally).reduce((s, x) => s + x.fail, 0);
console.log(`\nJOURNEYS ${Object.keys(tally).length} x ${ROUNDS} rounds  PASS ${pass}  FAIL ${fail}`);
for (const [id, x] of Object.entries(tally)) if (x.fail) console.log(`  flaky/failing ${id}: ${x.pass} pass, ${x.fail} fail`);
process.exitCode = fail ? 1 : 0;
