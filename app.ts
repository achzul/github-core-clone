// The forge's HTTP server: one process serving the env's boot probe, the GitHub
// REST v3 surface (/api/v3), the GraphQL v4 endpoint (/api/graphql), the MCP
// endpoint (/mcp) and the git smart-HTTP protocol (/<owner>/<repo>.git/...), all
// backed by one in-memory Forge store (lib/store.ts). main.ts owns the lifecycle;
// this file only routes. Every API reply is JSON with a non-empty
// X-GitHub-Request-Id; anything unrouted is GitHub's 404 body, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { authed, readBody, sendError, sendJson } from './lib/http.ts';
import { Forge } from './lib/store.ts';
import { handleRest } from './lib/rest.ts';
import { handleGit } from './lib/githttp.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function route(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendError(res, 404, 'Not Found');
    return;
  }
  const path = url.pathname;

  // The env's boot probe: no auth, called twice.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? await readBody(req) : Buffer.alloc(0);

  if (path === '/mcp') {
    handleMcp(forge, req, res, body);
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    handleGraphQL(forge, req, res, body);
    return;
  }

  if (path === '/api/v3' || path === '/api/v3/') {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues',
          pull_request_search_url: '/api/v3/search/issues',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (path.startsWith('/api/v3/')) {
    const isPublic = method === 'GET' && (path === '/api/v3/meta' || path === '/api/v3/meta/');
    if (!isPublic && !authed(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    if (handleRest(forge, req, res, url, body)) return;
    sendError(res, 404, 'Not Found');
    return;
  }

  const gitMatch = GIT_ROUTE.exec(path);
  if (gitMatch) {
    if (!authed(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    handleGit(forge, req, res, url, body, decodeURIComponent(gitMatch[1] as string), decodeURIComponent(gitMatch[2] as string), gitMatch[3] as string);
    return;
  }

  sendError(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(forge, req, res).catch((err: unknown) => {
      // A handler failure must still answer JSON, never hang or crash the process.
      process.stderr.write(`[entry] handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      try {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      } catch {
        // The socket is already gone; nothing more can be said.
      }
    });
  });
}
