# LiteForeFlow (lite fork) - QA report

What was tested: the new fork surface (install, launchers, ports, settings, data, sandbox modes, optional extras, prebuilt UI), the full regression suites on both sandboxes, the Postgres + Redis scale-up path, and the beginner journey in a real browser (desktop, phone width, light and dark).

| Suite | Scenarios | Passed | Failed | Not testable here |
|---|---|---|---|---|
| Fork scenarios A-F (scripted) | 39 | 25 | 10 | 4 |
| Beginner journey + UI in browser | 25 | 22 | 3 | 0 |
| Basic-sandbox crash probe (3 payloads x 2 sandboxes) | 6 | 3 | 3 | 0 |
| Scale-up: Postgres + Redis + workers, once the extras are installed by hand | 41 | 41 | 0 | 0 |
| Scale-up: `npm run scale-up` itself | 1 | 0 | 1 | 0 |
| Regression: integration tests (strong sandbox / basic sandbox) | 30 | 30 | 0 | 0 |
| Regression: white-box checks | 16 | 16 | 0 | 0 |
| Regression: 200-scenario QA suite, strong sandbox | 200 | 184 | 0 | 16 |
| Regression: 200-scenario QA suite, basic sandbox (server crash tolerated) | 200 | 183 | 0 | 17 |

Some scenarios fail for the same root cause, so there are **11 distinct problems**, listed below. The 16 "not testable" scenarios are the same as before (vendor apps need real accounts, live Stripe, token expiry, retention clock, Windows signals).

## Problems found

### Default port 3000 cannot be used when Windows reserves it
- **Scenarios:** B-17 (also breaks B-14b, C-18d)
- **Severity:** High for Windows beginners
- **Why:** The server only falls back to the next port on EADDRINUSE. Windows (Hyper-V / WSL / Docker Desktop) reserves port ranges, and then listening fails with EACCES; here 2915-3014 (includes 3000) and 3101-3639 were reserved. The app prints `listen EACCES: permission denied 0.0.0.0:3000` and exits - every launcher fails, and a beginner has no idea what to do. Fix: treat EACCES like EADDRINUSE when no port was chosen explicitly (and explain it when one was).

### `npm run scale-up` installs nothing
- **Scenarios:** E-33 (npm run scale-up)
- **Severity:** High for anyone scaling up
- **Why:** pg, bullmq and ioredis are declared as optional *peer* dependencies, so `npm install pg bullmq ioredis` answers "up to date" and adds nothing (also with --no-save / --legacy-peer-deps / --force). The documented path to Postgres + Redis is therefore broken. After removing the peerDependencies block the same command installs them and the whole production stack passes (15/15, 15/15, 3/3, 8/8). Fix: drop peerDependencies from package.json.

### Code that returns a rejected promise kills the whole server
- **Scenarios:** Basic sandbox: rejected promise (crash probe)
- **Severity:** High in basic mode only
- **Why:** In the basic (`node:vm`) fallback sandbox, `return Promise.reject(...)`, an `async` function that throws, or `return import("fs")` leave an unhandled rejection that terminates the Node process (3 of 3 payloads; every later request fails). The strong sandbox is unaffected (3 of 3 survive). Any user of a server running in basic mode can take it down with one line. Fix: attach a no-op handler to returned promises and add a process-level `unhandledRejection` logger.

### Starting the app twice on the same data folder is allowed
- **Scenarios:** B-15
- **Severity:** Medium
- **Why:** A beginner who double-clicks `start.bat` twice gets two servers on one SQLite database. Both register the schedules, so cron/RSS triggers fire twice, and a second port silently appears. Fix: a lock file in `data/` and a "LiteForeFlow is already running at http://localhost:PORT" message.

### A `.env` saved with a UTF-8 BOM is ignored
- **Scenarios:** C-18d
- **Severity:** Medium (security-relevant)
- **Why:** Windows Notepad can save a BOM; Node then reads the first key as `\uFEFFPORT`, so the first setting is silently lost - for example `ALLOW_SIGNUP=false` placed first stays off and signup stays open. CRLF files, comments, quotes and typos elsewhere in the file are fine. Fix: strip the BOM before `loadEnvFile` (or parse the file ourselves).

### After losing `data/.secret`, saved credentials fail with a cryptic message
- **Scenarios:** C-20
- **Severity:** Low-Medium
- **Why:** The run fails with "Unsupported state or unable to authenticate data" (raw AES-GCM error). Fix: catch it and say "this credential cannot be decrypted - the secret key changed; re-enter it".

### A partly deleted install shows a Node stack trace
- **Scenarios:** A-03b
- **Severity:** Low-Medium
- **Why:** The launchers only repair a missing `express`; if another package (e.g. bcryptjs) is missing the app prints `ERR_MODULE_NOT_FOUND` with a stack trace instead of "run npm install". Fix: check a few core packages in the launchers/preflight, or catch the import error and print a fix-it line.

### Startup failures print raw stack traces
- **Scenarios:** A-05, C-23, E-31, E-31b
- **Severity:** Low
- **Why:** An unusable data folder, a corrupted database file, `DATABASE_URL` without `pg`, and `REDIS_URL` without `bullmq` all fail while modules are being imported, before the friendly handler exists, so the user sees a stack trace (the useful sentence, e.g. "run npm run scale-up", is buried in it). The corrupted file is correctly left untouched. Fix: wrap startup (db/config/queue load) in one try/catch that prints the message only.

### Dialogs do not take keyboard focus
- **Scenarios:** F-38a
- **Severity:** Low (accessibility)
- **Why:** After opening a dialog `document.activeElement` stays on the page behind it; there is no focus trap and focus is not returned on close. Role/aria-modal/labels, keyboard reachability and Escape are fine.

### Light-mode secondary text is 4.39:1
- **Scenarios:** F-38f
- **Severity:** Low (accessibility)
- **Why:** Grey "muted" text on the page background misses the WCAG AA 4.5:1 line by 0.11. Dark mode passes everywhere.

### Eight small controls on a phone
- **Scenarios:** F-37c
- **Severity:** Low (mobile)
- **Why:** On a 375 px screen eight links/buttons (mostly text-style row actions) are shorter than 28 px, which is hard to tap.

## Not testable on this machine

- Browser auto-open (a real tab cannot be observed), double-clicking `start.bat` in Explorer, a real Mac/Linux, graceful Ctrl+C on Windows.
- Disk-full behaviour, 512 MB hosts, vendor apps and Stripe.

## Fork scenarios A-F

- OK   **A-01** Clean copy installs with plain `npm install` in < 60 s, < 40 MB, with no warnings - 19.4 s, 23 MB (npm cache was warm)
- OK   **A-07** Only the lite set of packages is installed (no pg, bullmq, ioredis, vite, react) - 91 top-level packages
- OK   **A-02** Install without internet: launcher explains the problem, leaves no half install, and the next start with internet recovers
- OK   **A-03** Partial install (a core package is missing) is repaired automatically on the next start
- FAIL **A-03b** Partial install where a LESS obvious package is missing (bcryptjs) gives a fix-it message, not a stack trace - start failed with raw error: | node:internal/modules/package_json_reader:301 |   throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null); |         ^
- OK   **A-04** Works from a folder whose path has spaces AND non-ASCII characters (all four launchers)
- FAIL **A-05** Unusable data folder (path is a file) gives a plain-language error and non-zero exit, not a stack trace - raw stack trace shown: | node:fs:1411 |   const result = binding.mkdir( |                          ^
- OK   **A-06** Running `npm install` again is harmless: data, accounts and workflows survive
- OK   **B-08** Every launcher starts the app and serves the UI (HTML shell + JS bundle + health) - ok via npm, bat, py, node, sh
- OK   **B-09** Launchers work when started from a different working directory
- OK   **B-10** run.py: --help is readable; --port and --no-open are honoured
- OK   **B-11** Old Node versions get the friendly fix-it message and exit code 1; supported versions are silent
- OK   **B-12** Node.js missing from PATH: python launcher and start.bat explain what to install and exit non-zero - start.bat checked with the browser-opening line stubbed out (so no tab opens on this machine)
- OK   **B-13** Hard kill then immediate restart on the same port: port is free again, data intact
- n/a  **B-13b** Graceful Ctrl+C / SIGTERM shutdown - Windows cannot deliver SIGINT/SIGTERM to a Node child (it is terminated abruptly); verified earlier on Linux containers
- OK   **B-14** An explicit PORT that is busy gives a plain-language error and a non-zero exit
- n/a  **B-14c** Busy default port 3000: the next free port is chosen automatically - port 3000 cannot be bound on this machine at all (Windows reserved it) - see B-17
- FAIL **B-17** Default port 3000 unusable because the OS reserves it (Windows excluded port range / EACCES): the app falls back to another port and tells the user - port 3000 is unavailable (EACCES) and the app refused to start: | LiteForeFlow could not start: listen EACCES: permission denied 0.0.0.0:3000
- FAIL **B-14b** Two copies started at once get different ports and both work - node did not start : |  |   LiteForeFlow could not start: listen EACCES: permission denied 0.0.0.0:3000 | 
- FAIL **B-15** Starting the app twice on the SAME data (double-click twice) must not run schedules twice or corrupt data - a second copy started on the same data (port 4722) instead of saying "already running"
- n/a  **B-16** Browser auto-open - opening a real browser tab cannot be observed here; all launches ran with LITEFOREFLOW_OPEN=0
- OK   **C-17** .env: PORT, ALLOW_SIGNUP, BLOCK_PRIVATE_NETWORK and SAVE_SUCCESS_DATA each take effect
- OK   **C-18** Real environment variables beat the .env file
- OK   **C-18b** .env with comments, quotes and inline comments is read correctly
- OK   **C-18c** A typo in .env (a line without "=", an unclosed quote) must not silently drop the OTHER settings (e.g. ALLOW_SIGNUP=false)
- FAIL **C-18d** .env saved with a UTF-8 BOM (what Windows Notepad adds) is read correctly - node did not start : |  |   LiteForeFlow could not start: listen EACCES: permission denied 0.0.0.0:3000 | 
- OK   **C-18e** .env with Windows (CRLF) line endings is read correctly
- OK   **C-19** Moving the whole data folder (incl. .secret) to another copy keeps accounts, saved credentials and webhooks working
- FAIL **C-20** Losing data/.secret: the app still starts and the failure on saved credentials is explained in plain words - unhelpful message: "Unsupported state or unable to authenticate data"
- OK   **C-22** Upgrade: data created by the very first version opens in the current one without loss
- FAIL **C-23** A corrupted database file gives a plain-language message (and does not delete the file) - raw stack trace shown: | file:///C:/Users/Mooz/AppData/Local/Temp/forkqa-xSs4Hg/c23/server/src/db.js:73 |   db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_size_limit = 8388608; PRAGMA cache_size = -4096;'); |      ^
- n/a  **C-24** Disk full while running - cannot fill a disk safely here
- OK   **D-25** /api/health reports the sandbox; LITEFOREFLOW_SANDBOX=vm forces the basic one and code still runs
- OK   **D-30** isolated-vm genuinely missing: app starts in basic mode, prints ONE short notice, everything still works
- OK   **D-26** Basic sandbox: escape payloads, regex, loops and results match the strong sandbox (full engine suite in section G)
- FAIL **E-31** DATABASE_URL set without the extras installed: clear "npm run scale-up" message, no stack trace, non-zero exit - raw stack trace shown: | file:///C:/Users/Mooz/AppData/Local/Temp/forkqa-xSs4Hg/E-31/server/src/db.js:99 |   try { pg = (await import('pg')).default; } catch { throw new Error('Postgres support is not installed. Run:  npm run scale-up'); } |                                                            ^
- FAIL **E-31b** REDIS_URL set without the extras installed: clear "npm run scale-up" message, no stack trace, non-zero exit - raw stack trace shown: | file:///C:/Users/Mooz/AppData/Local/Temp/forkqa-xSs4Hg/E-31b/server/src/queue.js:86 |   try { bull = await import('bullmq'); ({ default: IORedis } = await import('ioredis')); } catch { throw new Error('Redis queue support is not installed. Run:  npm run scale-up'); } |                                                                                                        
- OK   **E-32** The Postgres node without the extra package explains how to enable it
- OK   **F-34** The committed web/dist is exactly what the current source builds (no stale UI shipped)

## Beginner journey and UI scenarios

- OK   **F-35** All pages render their content with zero CSP violations
- OK   **F-37a** Phone width (375 px): no page needs sideways scrolling
- OK   **F-37b** Phone width: table rows become labelled cards
- FAIL **F-37c** Phone width: touch targets are at least 28 px tall
- OK   **F-37d** Phone width: editor canvas is usable and drawers do not cover it when closed
- OK   **F-37e** Phone width: "+ Nodes" drawer opens; adding a block shows its settings drawer
- FAIL **F-38a** Opening a dialog moves keyboard focus into it
- OK   **F-38b** Dialogs are announced (role=dialog, aria-modal, accessible name)
- OK   **F-38c** Every control in a dialog is reachable by keyboard
- OK   **F-38d** Escape closes the dialog
- OK   **F-38e** Dark-mode colour contrast >= 4.5:1
- FAIL **F-38f** Light-mode colour contrast >= 4.5:1
- OK   **F-39a** Editor deep link opens on a hard load while signed in
- OK   **F-39b** Browser Back/Forward never show a blank screen
- OK   **F-39c** Unknown address inside the app returns to Workflows
- OK   **F-39d** Private deep link while signed out goes to the login page
- OK   **H-51a** Landing page shows the login form with "Create an account"
- OK   **H-51b** Signup lands on the empty Workflows page pointing to Templates / New workflow
- OK   **H-51c** Using a template opens the editor with nodes and connections drawn
- OK   **H-52a** Clicking the palette builds a connected workflow with no dragging
- OK   **H-52b** Run works on sample webhook data and shows green nodes
- OK   **H-52c** Switching on shows the webhook URL
- OK   **H-52d** Calling the shown URL returns the workflow result
- OK   **H-52e** The webhook call appears on the Executions page
- OK   **H-53a** A template run without credentials fails with an actionable message
