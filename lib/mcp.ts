// The Model Context Protocol endpoint (POST /mcp, streamable HTTP, JSON answers):
// the 2026-07-28 revision's `server/discover`, the legacy `initialize` handshake,
// and six github-mcp-server-shaped tools that act on the same Forge store as the
// REST surface. Unknown tools answer JSON-RPC -32602, a non-JSON body answers
// HTTP 400 with -32700, a tool called without its required arguments answers
// isError, and every request without the trial token is 401 before anything else.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authed, isRecord, sendJson } from './http.ts';
import { VIEWER, type Forge, type RepoRec } from './store.ts';
import { issueObject, pullObject, repoObject } from './rest.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function repoArg(forge: Forge, args: Record<string, unknown>): RepoRec {
  const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  if (repo === undefined) throw new Error(`repository ${String(args.owner)}/${String(args.repo)} not found`);
  return repo;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    run: (forge, args) => {
      const name = String(args.name ?? '');
      if (name === '') throw new Error('name is required');
      if (forge.getRepo(VIEWER.login, name) !== undefined) throw new Error(`a repository named ${name} already exists`);
      const repo = forge.createRepo(name, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return repoObject(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
    run: (forge, args) => repoObject(repoArg(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      const issue = forge.createIssue(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      });
      return issueObject(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      return items.map((item) => issueObject(repo, item));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      const headRef = String(args.head ?? '');
      const baseRef = String(args.base ?? '');
      const headSha = forge.branchTip(repo, headRef);
      const baseSha = forge.branchTip(repo, baseRef);
      if (headSha === null || baseSha === null) throw new Error('head and base must name existing branches');
      const pull = forge.createPull(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        headRef,
        baseRef,
        headSha,
        baseSha,
      });
      return pullObject(forge, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
      merge_method: { type: 'string', description: 'The merge method: merge or squash.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      const item = repo.items.get(Number(args.pull_number));
      if (item === undefined || item.kind !== 'pull') throw new Error(`pull request ${String(args.pull_number)} not found`);
      if (!item.merged) {
        const result = forge.mergePull(repo, item, args.merge_method === 'merge' ? 'merge' : 'squash');
        if ('conflict' in result) throw new Error(`Pull Request is not mergeable: conflict in ${result.conflict}`);
        if ('error' in result) throw new Error(`Pull Request is not mergeable: ${result.error}`);
      }
      return pullObject(forge, repo, item);
    },
  },
];

/** The tools/list payload: a constant, so two calls answer byte-identical lists. */
const TOOLS_LIST = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
      additionalProperties: false,
    },
  })),
};

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolOk(payload: unknown) {
  const text = JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError: false };
}

function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function dispatch(forge: Forge, message: Record<string, unknown>): unknown | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const isNotification = id === undefined;
  const params = isRecord(message.params) ? message.params : {};

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return rpcError(id, -32602, `Tool ${name} not found`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return rpcResult(id, toolError(`missing required argument(s): ${missing.join(', ')}`));
      try {
        return rpcResult(id, toolOk(tool.run(forge, args)));
      } catch (err) {
        return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      if (isNotification || method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => (isRecord(entry) ? dispatch(forge, entry) : rpcError(null, -32600, 'Invalid Request')))
      .filter((answer) => answer !== null);
    sendJson(res, 200, answers);
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  const answer = dispatch(forge, parsed);
  if (answer === null) {
    // A notification: accepted, no body.
    res.writeHead(202, { 'x-github-request-id': 'forge-mcp' });
    res.end();
    return true;
  }
  sendJson(res, 200, answer);
  return true;
}
