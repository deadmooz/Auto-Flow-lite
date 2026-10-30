# End-to-end QA, real-world testing and product review

Date: 31 October 2026 · Branch: `qa-e2e` (on top of `code-review-optimizations`) · Windows 11, Node 24, SQLite.
Test account: `test@example.com` (created through the sign-up page and used for the workflows below).

Everything marked **verified** was executed. Anything not executed says so.

## 1. What was tested

| Area | How | Result |
|---|---|---|
| Sign-up, sign-in, sign-out, wrong password, short password, bad email, duplicate email (any case), login rate limit | Browser + API | verified, all correct |
| Templates: browse, "Use template", run (Weather alert, live Open-Meteo) | Browser | verified |
| Editor: add block from palette (auto-connects), Test this step (live Hacker News, 500 items), Data tab, Settings, Save (button + Ctrl+S), activate/deactivate, leave with unsaved changes | Browser | verified; 2 bugs found and fixed |
| Executions list, status filter, execution details | Browser + API | verified |
| Credentials: create (UI and API), Test connection, rename keeping secrets, delete, secrets never sent back | Browser + API | verified; 1 bug found and fixed |
| Plugins page, Usage & plan page | Browser | verified (content renders, numbers match usage) |
| Phone width (375 px) and narrow pane: list, editor, sidebar | Browser | verified; 1 bug found and fixed |
| Dark mode | Browser | verified; 1 bug found and fixed |
| 11 user journeys with live services ([journeys-qa.mjs](../server/test/qa/journeys-qa.mjs)) | API, 7 rounds in total | see 2 |
| 10 edge and abuse cases ([edge-qa.mjs](../server/test/qa/edge-qa.mjs)) | API, 2 rounds | see 2 |
| Existing automated suites (unit, 200-case QA, plugins, unit QA, install/launchers, live-API, sandbox) | 3 full cycles | see 3 |

### The 11 journeys (live services, nothing faked)
J01 lead-capture webhook with a secret, validation and 201/400 answers · J02 weather for 3 cities (Open-Meteo) with IF branches ·
J03 JSONPlaceholder posts → Split Out → Filter → Sort → Limit → Aggregate · J04 bearer credential sent to Postman Echo, hidden in the
UI, kept on rename, clear error after delete · J05 failing workflow starts its Error workflow with the message · J06 import an n8n
export and run it · J07 duplicate / rename / delete, runs removed with the workflow · J08 a second account cannot read, run or delete
the first one's things · J09 2,000 items through Code → Edit Fields → Remove Duplicates → Sort · J10 user mistakes (dead host, not a
URL, bad JSON, expression typo, HTTP 404, loop, no trigger) · J11 real email through SMTP to a local mail server, one per recipient.

### The 10 edge cases
HTML / emoji / right-to-left / 500-character names · 60 simultaneous webhook calls · 6 MB webhook body · sandbox escape attempts
(process, require, constructor tricks) in expressions and Code · endless loop in Code · two workflows on one webhook path ·
201 nodes / malformed definition · executions status filter · a real every-minute schedule firing by itself · login guessing.

## 2. Runs and results

| Run | Pass | Fail | Notes |
|---|---|---|---|
| Journeys, round 1 (before fixes) | 8 | 2 | both failures were wrong assumptions in the new test (see 4), not product bugs |
| Journeys, 3 rounds after fixing the test | 30 | 0 | |
| Journeys J10-J11 after the SMTP and message fixes | 2 | 0 | |
| Journeys, 3 rounds, final code | 33 | 0 | no flaky journey in 7 rounds |
| Edge cases, 2 rounds | 20 | 0 | schedule fired in 24 s; 60/60 burst answers correct in 109 ms |
| 3 automated cycles + 4 extra runs of the 200-case suite | see 3 | | |

## 3. Regression (automated suites)

Pass / fail / blocked (blocked = cannot run on this machine, see 5).

| Suite | Cycle 1 (before fixes) | Cycle 2 (fixes) | Cycle 3 (final code) |
|---|---|---|---|
| Unit tests (`npm test`) | 62 / 0 | 65 / 0 | 65 / 0 |
| 200-case QA (`npm run qa`) | 184 / 0 / 16 | 184 / 0 / 16 | **stopped at WF-07: its server process exited** (see 5); then 4 reruns: 184 / 0 / 16 each |
| Plugins QA | 71 / 0 | 71 / 0 | 71 / 0 |
| Unit QA | 16 / 0 | 16 / 0 | 16 / 0 |
| Install, launchers, settings (fork QA) | 36 / 0 / 3 | 35 / 0 / 4 (port 3000 reserved by Windows that run) | 36 / 0 / 3 |
| Live services (realworld QA) | 8 / 1 / 2 (RW-07: Ollama off) | 10 / 1 (RW-09, see below) | 9 / 0 / 2 (Ollama off) |
| Sandbox safety | all pass | all pass | all pass |

RW-09 in cycle 2: the workflow worked and the reply was parsed, but the 4-billion-parameter local model answered `"mood": "mixed"`
instead of one of the three allowed words. The test now checks LiteForeFlow's part (a parsed object with both fields) and reports
whether the model kept to the list. Ollama was off again in cycle 3, so the changed RW-09 has **not** run against a model yet.

## 4. Bugs found and fixed

| # | Severity | Bug | Fix | Proof |
|---|---|---|---|---|
| 1 | **High** | Unsaved changes in the editor were thrown away **without any warning** when leaving through "← Workflows", a sidebar link or Sign out (only closing the tab asked). Reproduced: a block added, "← Workflows" clicked, the block was gone. | The editor asks "Leave without saving?" before any in-app navigation while there are unsaved changes ([Editor.jsx](../web/src/pages/Editor.jsx)). | Browser: Cancel keeps you in the editor (sidebar link, "← Workflows", Sign out); after Save nothing is asked; the saved workflow has the new block. |
| 2 | Medium | Below 860 px wide (tablet, phone, narrow window) **Sign out and the workspace switcher were hidden** (`display: none`). | Compact footer instead of hiding it ([styles.css](../web/src/styles.css)). | Browser at 375 px: Sign out visible and working. |
| 3 | Medium | Any unreachable service (HTTP Request and every app block: Slack, Telegram, Notion, …) failed with just **"fetch failed"**. | One place ([http.js](../server/src/http.js)) now says which host and why: "Could not reach no-such-host…: no server has that name - check the address", "…the connection was refused - is the service running on that port?", "…no answer within 30 seconds", certificate problems. Timeouts and cancelled runs still behave as before; the Ollama and REST-connector messages keep working. | Unit test + J10 + RW-06/RW-07. |
| 4 | Medium | SMTP credential: the Port box showed "587" (a placeholder) so it looked filled, but saving/testing failed with **"Missing field: Port"**. With "Use TLS" ticked and no port, 587 was used, where TLS needs 465. | Port is optional; empty means 587, or 465 with TLS ([credentialTypes.js](../server/src/credentialTypes.js), [apps.js](../server/src/nodes/apps.js)). | Unit test + J11 (real email). |
| 5 | Low | Dark mode: the canvas minimap and the zoom buttons were bright white (the canvas library's stylesheet loads after ours and won). | Colours set through the library's own variables. | Browser: both use the dark surface colour. |
| 6 | Low | Names were not trimmed and a name of only spaces was accepted (workflows and credentials), giving blank-looking rows; renaming a credential answered with the untrimmed, uncut name. | Trimmed; blank keeps the old name (or "Untitled workflow"). | Unit test + J07. |
| 7 | Low | An HTTP error with an empty body read "HTTP 404 Not Found: {}". | The ": {}" is left out. | Unit test + J10. |
| 8 | Test suite | RW-07 failed whenever Ollama was not running, although RW-09/RW-10 skip in that case. | Without Ollama it now checks that the error tells the user to start it. | RW-07 passes. |

New automated guards: 3 unit tests in [perf.test.mjs](../server/test/perf.test.mjs) (65 unit tests in total), plus the two new
end-to-end scripts.

## 5. Outstanding issues and blockers

**Not fixed (product decisions or features, deliberately left alone during QA):**
- Activating a workflow does not check for missing credentials or required fields: the Weather template was switched on with no SMTP
  credential and would only fail on the first freezing morning.
- Editor ("manual") runs and Test step count towards the monthly run quota (140 of the Free plan's 1,000 used in this QA session).
- The HTTP Request block returns a JSON list as one item `{ data: [...] }` (a Split Out is needed), while the Hacker News block
  returns one item per entry. Not a bug, but every list journey needed an extra block.
- SMTP has no automatic "Test connection" (it says so).
- Deleting a credential that workflows use only warns in general terms; the runs then fail with "Credential not found".
- Two people editing one workflow: last save wins, silently (already listed by the earlier QA).

**Not covered / unverified:**
- The browser Back button with unsaved changes (the app uses a router that cannot block it; my attempt to test it was inconclusive).
- **Intermittent silent server exit (open, medium until explained).** Twice a server process ended with no log line: the manually
  started QA server during cycle 1 (exit code 127), and the 200-case suite's server at WF-07 in cycle 3. Windows logged no crash
  (no Application Error for node.exe), and every deliberate exit path in the server prints a message first, so the process was
  most likely ended from outside. A plausible but unproven cause is Windows PID reuse with the test suites' `taskkill /T`. Not
  reproduced in 4 further full runs or by the QA server, which then ran for hours. The 200-case suite now prints the exit code and
  the server's last output if this happens again ([lib.mjs](../server/test/qa/lib.mjs)).

**Blocked (needs accounts or services that are not available here):** live Slack, Telegram, Discord, Notion, Airtable, Stripe,
HubSpot, Google Sheets, OpenAI/Anthropic (the 200-case suite covers them against fake servers); Ollama AI scenarios (Ollama not
running today); Postgres/Redis scale-out (16 blocked cases in the 200-case suite, as before); signals and disk-full on Windows.

## 6. Status

**Release readiness: ready for a beta, with one open item to watch.** No open critical or high bug. The one high bug (silent loss of
unsaved work) is fixed and verified, and every suite passes on the final code. The open item is the unexplained silent server exit
(2 times in roughly 20 server lifetimes, not reproduced since). Before a wider launch: the activation pre-flight check (item 1
below), and an explanation for that exit from the new diagnostics.

## 7. Product review (senior PM)

Ranked by priority (impact first, then effort).

| # | Recommendation | Impact | Effort | Why (evidence from this QA) |
|---|---|---|---|---|
| 1 | **Pre-flight check on activation**: list blocks with a missing credential or empty required field, and refuse (or warn) before switching on; show the same list as a badge on the block. | High | Low | The Weather template activated without an email account. The failure would surface days later, at the worst moment, and erode trust in "set and forget". |
| 2 | **Don't count editor runs and Test step against the run quota** (count only trigger, webhook and schedule runs). | High | Low | One evening of building used 14% of the Free plan. New users hit the limit while still learning, right when they decide whether to stay; n8n counts production executions only. |
| 3 | **"Email me when this fails" switch** per workflow (workspace default address, uses the server's mail settings) as a shortcut to the Error-workflow concept. | High | Medium | Today a user must build a second workflow with an Error Trigger plus an email account to hear about failures. Most will not, so silent failures go unnoticed; this is the main retention risk for automation tools. |
| 4 | **"Split list into items" option on HTTP Request** (on by default when the answer is a top-level list). | Medium | Low | Every list API in the journeys needed an extra Split Out, unlike the Hacker News block; n8n users expect one item per entry. Fewer blocks, fewer "why is there only 1 item?" moments. |
| 5 | **Credential usage map**: "used by 3 workflows" in Credentials, the names in the delete dialog, and a real SMTP test (connect + login). | Medium | Low | Deleting a credential breaks workflows with "Credential not found"; SMTP is the one common credential that cannot be tested before the first real send. |

Worth considering next: workflow version history with one-click restore (protects against last-save-wins and bad edits; Medium impact,
Medium effort); a "what changed since the last run" diff on failures; and leaning into the differentiators the product already has and
competitors lack together: flat pricing per run (not per step), one-command self-hosting with no Docker, and local AI through Ollama
("private AI automations that never leave your machine") as the headline for the landing page and templates.
