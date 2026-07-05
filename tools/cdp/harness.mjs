// Reusable CDP verification harness (CLAUDE.md §7's "second half of the
// gate" — real Electron process, not a bare browser tab: contextBridge's
// window.api only exists here). Plain ESM, zero dependencies: Node >=22
// supplies global `fetch`/`WebSocket`, so no `ws`/CDP client package.
//
// Mechanism only. Every assertion, selector, and expected value lives in a
// per-task probe script that imports this module — probes are throwaway
// (scratchpad/tmp, never committed); this file must not gain app-specific
// knowledge. Not part of the pnpm workspace (see pnpm-workspace.yaml) and
// out of apps/desktop/tsconfig.e2e.json's `include` — it never enters the
// build or the Playwright typecheck.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const ELECTRON_BIN = path.join(REPO_ROOT, 'apps/desktop/node_modules/.bin/electron');
const VITE_DEV_SERVER_URL = 'http://localhost:5173';
const DEFAULT_PORT = 9240;

// launchApp() only checks for the dev server; it must never start or kill
// Vite itself (the maintainer often keeps one running — killing it would
// pull the rug out from under other work).
async function assertViteRunning() {
  try {
    const res = await fetch(VITE_DEV_SERVER_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(
      `Vite dev server not reachable at ${VITE_DEV_SERVER_URL} — launchApp() ` +
        `never starts/kills it (CLAUDE.md §7). Start it yourself first, e.g. ` +
        `\`pnpm --filter @copilot-budget/ui dev\`, then retry. (${err.message})`,
    );
  }
}

async function findPageTarget(port, { timeoutMs = 15_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(VITE_DEV_SERVER_URL),
      );
      if (page) return page;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `No page target for ${VITE_DEV_SERVER_URL} at 127.0.0.1:${port}/json/list within ${timeoutMs}ms` +
      (lastErr ? ` (last error: ${lastErr.message})` : ''),
  );
}

let nextMessageId = 1;

function sendCdp(ws, method, params = {}) {
  const id = nextMessageId++;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(`${method} failed: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Launch the real Electron app (main + preload + contextBridge), isolated
 * from any other run, with CDP wired up and console collection started.
 *
 * @param {{ port?: number }} opts
 * @returns {Promise<Handle>}
 */
export async function launchApp(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;

  await assertViteRunning();

  // Both isolation dirs are non-optional: skip either and PAT/DB state
  // leaks across runs (the Task 3.1 bug class). COPILOT_BUDGET_DB_PATH is
  // this app's own env override; --user-data-dir is Electron's built-in
  // flag and the only way to isolate safeStorage's backing file.
  const dbDir = mkdtempSync(path.join(tmpdir(), 'cdp-harness-db-'));
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'cdp-harness-userdata-'));
  const dbPath = path.join(dbDir, 'copilot-budget.sqlite');

  const child = spawn(
    ELECTRON_BIN,
    ['apps/desktop', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, COPILOT_BUDGET_DB_PATH: dbPath },
      stdio: 'ignore',
    },
  );

  const target = await findPageTarget(port);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (event) => reject(new Error(`CDP WebSocket error: ${event.message ?? event}`)), {
      once: true,
    });
  });

  const consoleEntries = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleEntries.push({
        type: msg.params.type,
        text: msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
      });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const ex = msg.params.exceptionDetails;
      consoleEntries.push({ type: 'exception', text: ex.exception?.description ?? ex.text });
    } else if (msg.method === 'Log.entryAdded') {
      const entry = msg.params.entry;
      if (entry.level === 'error' || entry.level === 'warning') {
        consoleEntries.push({ type: entry.level, text: entry.text });
      }
    }
  });

  await Promise.all([sendCdp(ws, 'Runtime.enable'), sendCdp(ws, 'Log.enable'), sendCdp(ws, 'Page.enable')]);

  let closed = false;

  async function evaluate(expression) {
    const result = await sendCdp(ws, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const ex = result.exceptionDetails;
      throw new Error(`evaluate() threw: ${ex.exception?.description ?? ex.text}`);
    }
    return result.result.value;
  }

  async function screenshot(filePath) {
    const { data } = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    writeFileSync(filePath, Buffer.from(data, 'base64'));
    return filePath;
  }

  // Returns the collected entries; the caller judges what "clean" means for
  // its task (this harness carries no app-specific pass/fail opinion).
  function consoleErrors() {
    return consoleEntries.filter((e) => e.type === 'error' || e.type === 'exception');
  }

  // Returns raw evidence for contextIsolation/sandbox/bridge exposure; the
  // caller asserts (e.g. processUndefined === true, apiMethods.length >= N).
  async function boundaryProof() {
    return evaluate(`(() => ({
      processUndefined: typeof process === 'undefined',
      requireUndefined: typeof require === 'undefined',
      apiMethods: typeof window.api === 'object' && window.api !== null
        ? Object.keys(window.api).filter((k) => typeof window.api[k] === 'function')
        : [],
    }))()`);
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      ws.close();
    } catch {
      // already gone
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 5000);
      });
    }
    for (const dir of [dbDir, userDataDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return { evaluate, screenshot, consoleErrors, boundaryProof, close };
}
