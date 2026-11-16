// Entry point for the forge. This file owns only the conversation with the
// make.fun trial env: the env names its own origin in MAKEFUN_ENV_URL, we
// start the forge on a port the kernel chooses, report that port back, and
// then stay alive until the env says the trial is over. Everything the forge
// itself does lives behind createApp() in app.ts; nothing here knows about
// git, REST, GraphQL or MCP.

import { createApp } from './app.ts';

/** Where the env lives, trailing slashes stripped; '' when not configured. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** One register or poll request may take at most this long before we drop it. */
const REQUEST_LIMIT_MS = 30_000;

/** Retry waits start at the floor and double up to the ceiling. */
const RETRY_FLOOR_MS = 250;
const RETRY_CEILING_MS = 2_000;

/**
 * A register reply that no amount of retrying will fix (HTTP 400 or 405):
 * the request itself breaks the contract, so the run aborts instead of
 * looping. Distinguished from transient failures by type, not by message.
 */
class RegisterRefused extends Error {}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** How long to wait before retry number `attempt` (counting from 0). */
function backoffMs(attempt: number): number {
  const doubled = RETRY_FLOOR_MS * 2 ** Math.min(attempt, 8);
  return Math.min(RETRY_CEILING_MS, doubled);
}

/**
 * Announce our port to the env and return once it has accepted the news.
 * 200 is the plain yes. 409 also ends the loop: an earlier process already
 * registered and won, and the env will dial that address rather than ours,
 * which is not ours to argue with. Every other outcome — a different
 * status, a refused connection, a request that ran past its limit — is
 * treated as the env still starting up and is retried after a backoff.
 */
async function announcePort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new RegisterRefused(
          `register answered HTTP ${reply.status}: ${await reply.text()}`,
        );
      }
    } catch (err) {
      if (err instanceof RegisterRefused) throw err;
      // A network failure or a timed-out request: retry below.
    }
    await pause(backoffMs(attempt));
  }
}

/**
 * Poll the env's /done until it answers {"done": true}. The env replies
 * immediately while the trial runs ({"done": false}), so this is a loop of
 * short questions, not one long-held request; a poll that fails or times
 * out simply means "not done yet" and is asked again after a backoff.
 */
async function waitForTrialEnd(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Unreachable and slow both read as "not done": keep polling.
    }
    await pause(backoffMs(attempt));
  }
}

/** Bind the port, announce it, then hold until the env ends the trial. */
async function serve(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForTrialEnd();
  server.close();
  process.stdout.write('[entry] done\n');
}

// With no env origin there is nobody to register with and nothing to run
// for, so the process ends before the server is even created.
if (envOrigin === '') {
  process.stderr.write(
    '[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n',
  );
  process.exit(1);
}

try {
  await serve();
  process.exit(0);
} catch (err) {
  process.stderr.write(
    `[entry] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
