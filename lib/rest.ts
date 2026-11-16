// The GitHub REST v3 surface: repositories, branches, git refs, commits, contents,
// labels, issues, comments and pull requests, served from the shared Forge store.
// Every reply is JSON with a string `message` on errors, exactly as the suite's
// protocol checks require; statuses follow GitHub (201 creates, 204 deletes,
// 409 on a stale contents sha, 405 on an unmergeable pull request, 422 on
// validation failures).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isOid, parseCommit, parseIdentity } from './gitobj.ts';
import { isRecord, parseJsonBody, sendError, sendJson } from './http.ts';
import { VIEWER, type Forge, type IssueRec, type ItemRec, type PullRec, type RepoRec } from './store.ts';

// ---------------------------------------------------------------- serializers

export function userObject() {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email };
}

export function repoObject(repo: RepoRec) {
  return {
    id: repo.id,
    node_id: nodeId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: userObject(),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pull_requests: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    html_url: `https://forge.local/${VIEWER.login}/${repo.name}`,
    clone_url: `https://forge.local/${VIEWER.login}/${repo.name}.git`,
    ssh_url: `git@forge.local:${VIEWER.login}/${repo.name}.git`,
  };
}

export function labelObject(repo: RepoRec, name: string) {
  const label = repo.labels.get(name);
  return {
    id: 7000 + [...repo.labels.keys()].indexOf(name),
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueObject(repo: RepoRec, item: ItemRec) {
  const base: Record<string, unknown> = {
    id: item.id,
    node_id: nodeId(item.kind === 'issue' ? 'Issue' : 'PullRequest', String(repo.id), String(item.number)),
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    locked: false,
    labels: item.labels.map((name) => labelObject(repo, name)),
    user: userObject(),
    author: userObject(),
    comments: item.comments.length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.state === 'closed' ? item.updatedAt : null,
  };
  if (item.kind === 'pull') {
    base.pull_request = {
      url: `/api/v3/repos/${VIEWER.login}/${repo.name}/pulls/${item.number}`,
      html_url: `https://forge.local/${VIEWER.login}/${repo.name}/pull/${item.number}`,
      diff_url: `https://forge.local/${VIEWER.login}/${repo.name}/pull/${item.number}.diff`,
      patch_url: `https://forge.local/${VIEWER.login}/${repo.name}/pull/${item.number}.patch`,
      merged_at: item.mergedAt,
    };
  }
  return base;
}

export function pullObject(forge: Forge, repo: RepoRec, pull: PullRec) {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', String(repo.id), String(pull.number)),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    locked: false,
    labels: pull.labels.map((name) => labelObject(repo, name)),
    user: userObject(),
    author: userObject(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { label: `${VIEWER.login}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: userObject() },
    base: { label: `${VIEWER.login}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: userObject() },
    comments: pull.comments.length,
  };
}

export function commentObject(item: ItemRec, comment: { id: number; body: string; createdAt: string }) {
  void item;
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', String(comment.id)),
    body: comment.body,
    user: userObject(),
    author: userObject(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

/** An opaque, stable global id (never the plain database id). */
export function nodeId(...parts: string[]): string {
  return Buffer.from(parts.join(':'), 'utf8').toString('base64');
}

export function decodeNodeId(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- helpers

function notFound(res: ServerResponse): void {
  sendError(res, 404, 'Not Found');
}

function resolveCommitRef(forge: Forge, repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === '') return forge.branchTip(repo, repo.defaultBranch);
  const asBranch = forge.branchTip(repo, ref);
  if (asBranch !== null) return asBranch;
  const asTag = forge.refCommit(repo, `refs/tags/${ref}`);
  if (asTag !== null) return asTag;
  if (isOid(ref)) {
    const obj = forge.getObject(repo, ref);
    if (obj?.type === 'commit') return ref;
    if (obj?.type === 'tag') return forge.refCommit(repo, `refs/tags/${ref}`) ?? null;
  }
  return null;
}

function pagination(url: URL): { perPage: number; page: number } {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

function pageSlice<T>(items: T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(req: IncomingMessage, url: URL, perPage: number, page: number, total: number): Record<string, string> {
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${url.pathname}`;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  const make = (target: number, rel: string) => `<${base}?per_page=${perPage}&page=${target}>; rel="${rel}"`;
  if (page < lastPage) {
    links.push(make(page + 1, 'next'));
    links.push(make(lastPage, 'last'));
  }
  if (page > 1) {
    links.push(make(1, 'first'));
    links.push(make(page - 1, 'prev'));
  }
  return links.length > 0 ? { link: links.join(', ') } : {};
}

/** Label names out of a request value: strings or {name} objects both accepted. */
function labelNames(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
    else return null;
  }
  return names;
}

// ---------------------------------------------------------------- the handler

export function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): boolean {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((part) => part !== '');
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2).map((part) => decodeURIComponent(part));

  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, {
      installed_version: 'github-core-clone 1.0.0',
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      hooks: [],
      issue_search: true,
      pull_request_search: true,
      repository_search: true,
    });
    return true;
  }

  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, userObject());
    return true;
  }

  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = pagination(url);
      const all = forge.listRepos();
      const slice = pageSlice(all, perPage, page);
      sendJson(res, 200, slice.map(repoObject), linkHeader(req, url, perPage, page, all.length));
      return true;
    }
    if (method === 'POST') {
      const data = parseJsonBody(res, body);
      if (data === undefined) return true;
      const name = typeof data.name === 'string' ? data.name : '';
      if (name === '') {
        sendError(res, 422, 'Validation Failed: name is required');
        return true;
      }
      if (forge.getRepo(VIEWER.login, name) !== undefined) {
        sendError(res, 422, 'name already exists on this account');
        return true;
      }
      const repo = forge.createRepo(name, {
        private: data.private === true,
        description: typeof data.description === 'string' ? data.description : '',
      });
      if (data.auto_init === true) {
        forge.commitFlatTree(repo, repo.defaultBranch, new Map(), 'Initial commit', null);
      }
      sendJson(res, 201, repoObject(repo));
      return true;
    }
    return false;
  }

  if (rest.length >= 3 && rest[0] === 'repos') {
    const repo = forge.getRepo(rest[1] ?? '', rest[2] ?? '');
    if (repo === undefined) {
      notFound(res);
      return true;
    }
    return handleRepo(forge, req, res, url, body, repo, rest.slice(3));
  }

  return false;
}

function handleRepo(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  repo: RepoRec,
  parts: string[],
): boolean {
  const method = req.method ?? 'GET';

  // /repos/{owner}/{repo}
  if (parts.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoObject(repo));
      return true;
    }
    if (method === 'PATCH') {
      const data = parseJsonBody(res, body);
      if (data === undefined) return true;
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.private === 'boolean') repo.private = data.private;
      if (typeof data.default_branch === 'string' && data.default_branch !== '') repo.defaultBranch = data.default_branch;
      if (typeof data.name === 'string' && data.name !== '' && data.name !== repo.name) {
        forge.repos.delete(repo.name.toLowerCase());
        repo.name = data.name;
        forge.repos.set(repo.name.toLowerCase(), repo);
      }
      repo.updatedAt = forge.nowIso();
      sendJson(res, 200, repoObject(repo));
      return true;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': 'forge-delete' });
      res.end();
      return true;
    }
    return false;
  }

  // /branches and /branches/{name...}
  if (parts[0] === 'branches') {
    if (parts.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({
          name,
          commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '', url: '' },
          protected: false,
        }));
      sendJson(res, 200, branches);
      return true;
    }
    if (parts.length >= 2 && method === 'GET') {
      const name = parts.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (sha === undefined) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { name, commit: { sha, url: '' }, protected: false });
      return true;
    }
    return false;
  }

  // /git/refs, /git/refs/{ref...}, POST /git/refs
  if (parts[0] === 'git' && parts[1] === 'refs') {
    if (parts.length === 2 && method === 'GET') {
      const all = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => ({
        ref,
        node_id: nodeId('Ref', ref),
        url: '',
        object: { type: forge.getObject(repo, sha)?.type ?? 'commit', sha, url: '' },
      }));
      sendJson(res, 200, all);
      return true;
    }
    if (parts.length === 2 && method === 'POST') {
      const data = parseJsonBody(res, body);
      if (data === undefined) return true;
      const ref = typeof data.ref === 'string' ? data.ref : '';
      const sha = typeof data.sha === 'string' ? data.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha) || forge.getObject(repo, sha) === undefined) {
        sendError(res, 422, 'Validation Failed: ref or sha is invalid');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: nodeId('Ref', ref), url: '', object: { type: forge.getObject(repo, sha)?.type ?? 'commit', sha, url: '' } });
      return true;
    }
    if (parts.length >= 3 && method === 'GET') {
      const ref = `refs/${parts.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ref, node_id: nodeId('Ref', ref), url: '', object: { type: forge.getObject(repo, sha)?.type ?? 'commit', sha, url: '' } });
      return true;
    }
    return false;
  }

  // /commits and /commits/{sha}
  if (parts[0] === 'commits') {
    if (parts.length === 1 && method === 'GET') {
      const tip = resolveCommitRef(forge, repo, url.searchParams.get('sha'));
      if (tip === null) {
        sendJson(res, 200, []);
        return true;
      }
      const { perPage, page } = pagination(url);
      const all = forge.history(repo, tip).map((oid) => commitObject(repo, oid));
      sendJson(res, 200, pageSlice(all, perPage, page));
      return true;
    }
    if (parts.length === 2 && method === 'GET') {
      const oid = parts[1] ?? '';
      if (!isOid(oid) || forge.getObject(repo, oid)?.type !== 'commit') {
        notFound(res);
        return true;
      }
      sendJson(res, 200, commitObject(repo, oid));
      return true;
    }
    return false;
  }

  // /contents/{path...}
  if (parts[0] === 'contents') {
    const path = parts.slice(1).join('/');
    return handleContents(forge, req, res, url, body, repo, path);
  }

  // /labels
  if (parts[0] === 'labels' && parts.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.keys()].sort().map((name) => labelObject(repo, name)));
      return true;
    }
    if (method === 'POST') {
      const data = parseJsonBody(res, body);
      if (data === undefined) return true;
      const name = typeof data.name === 'string' ? data.name : '';
      if (name === '') {
        sendError(res, 422, 'Validation Failed: name is required');
        return true;
      }
      if (repo.labels.has(name)) {
        sendError(res, 422, 'Validation Failed: name already exists');
        return true;
      }
      repo.labels.set(name, {
        name,
        color: typeof data.color === 'string' && data.color !== '' ? data.color : 'ededed',
        description: typeof data.description === 'string' ? data.description : null,
      });
      sendJson(res, 201, labelObject(repo, name));
      return true;
    }
    return false;
  }

  // /issues, /issues/{n}, /issues/{n}/comments
  if (parts[0] === 'issues') {
    return handleIssues(forge, req, res, url, body, repo, parts.slice(1));
  }

  // /pulls, /pulls/{n}, /pulls/{n}/files, /pulls/{n}/merge
  if (parts[0] === 'pulls') {
    return handlePulls(forge, req, res, url, body, repo, parts.slice(1));
  }

  return false;
}

function commitObject(repo: RepoRec, oid: string) {
  const obj = repo.objects.get(oid);
  const info = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const author = info !== null ? parseIdentity(info.author) : { name: '', email: '', timestamp: 0 };
  const committer = info !== null ? parseIdentity(info.committer) : { name: '', email: '', timestamp: 0 };
  const iso = (ts: number) => new Date(ts * 1000).toISOString();
  return {
    sha: oid,
    node_id: nodeId('Commit', oid),
    commit: {
      author: { name: author.name, email: author.email, date: iso(author.timestamp) },
      committer: { name: committer.name, email: committer.email, date: iso(committer.timestamp) },
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? '', url: '' },
      url: '',
      comment_count: 0,
    },
    url: '',
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent, url: '' })),
    author: null,
    committer: null,
  };
}

// ---------------------------------------------------------------- contents

function handleContents(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  repo: RepoRec,
  path: string,
): boolean {
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const commit = resolveCommitRef(forge, repo, url.searchParams.get('ref'));
    if (commit === null) {
      notFound(res);
      return true;
    }
    const flat = forge.flatTreeOfCommit(repo, commit);
    const file = flat.get(path);
    if (path !== '' && file !== undefined) {
      const blob = forge.getObject(repo, file.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      const base64 = data.toString('base64').replace(/.{60}(?=.)/g, '$&\n');
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: base64,
        sha: file.oid,
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
      });
      return true;
    }
    const listing = forge.listDirectory(repo, commit, path);
    if (listing === null) {
      notFound(res);
      return true;
    }
    sendJson(
      res,
      200,
      listing.map((entry) => ({
        type: entry.type === 'dir' ? 'dir' : 'file',
        name: entry.name,
        path: entry.path,
        sha: entry.oid,
        size: 0,
      })),
    );
    return true;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const data = parseJsonBody(res, body);
    if (data === undefined) return true;
    if (path === '') {
      sendError(res, 422, 'Validation Failed: path is required');
      return true;
    }
    const branch = typeof data.branch === 'string' && data.branch !== '' ? data.branch : repo.defaultBranch;
    const message = typeof data.message === 'string' && data.message !== '' ? data.message : method === 'PUT' ? `Update ${path}` : `Delete ${path}`;
    let parent = forge.branchTip(repo, branch);
    if (parent === null && branch !== repo.defaultBranch) {
      // Creating a branch by writing to it (the MCP setup's fallback): fork the default.
      parent = forge.branchTip(repo, repo.defaultBranch);
    }
    const flat = parent !== null ? forge.flatTreeOfCommit(repo, parent) : new Map<string, { mode: string; oid: string; path: string; name: string }>();
    const existing = flat.get(path);
    const givenSha = typeof data.sha === 'string' ? data.sha : undefined;

    if (method === 'DELETE') {
      if (existing === undefined) {
        notFound(res);
        return true;
      }
      if (givenSha !== existing.oid) {
        sendError(res, 409, 'sha does not match');
        return true;
      }
      flat.delete(path);
      const commit = forge.commitFlatTree(repo, branch, flat, message, parent);
      sendJson(res, 200, { content: null, commit: { sha: commit, message } });
      return true;
    }

    // PUT
    if (existing !== undefined && givenSha !== existing.oid) {
      sendError(res, 409, 'sha does not match');
      return true;
    }
    if (typeof data.content !== 'string') {
      sendError(res, 422, 'Validation Failed: content is required');
      return true;
    }
    const bytes = Buffer.from(data.content.replace(/\s+/g, ''), 'base64');
    const blobOid = forge.putObject(repo, { type: 'blob', data: bytes });
    flat.set(path, { mode: '100644', oid: blobOid, path, name: path.split('/').pop() ?? path });
    const commit = forge.commitFlatTree(repo, branch, flat, message, parent);
    sendJson(res, existing !== undefined ? 200 : 201, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: bytes.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commit, message },
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------- issues

function handleIssues(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  repo: RepoRec,
  parts: string[],
): boolean {
  const method = req.method ?? 'GET';

  if (parts.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let items = [...repo.items.values()];
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { perPage, page } = pagination(url);
      sendJson(res, 200, pageSlice(items, perPage, page).map((item) => issueObject(repo, item)));
      return true;
    }
    if (method === 'POST') {
      const data = parseJsonBody(res, body);
      if (data === undefined) return true;
      const title = typeof data.title === 'string' ? data.title : '';
      if (title === '') {
        sendError(res, 422, 'Validation Failed: title is required');
        return true;
      }
      const names = labelNames(data.labels);
      if (names === null) {
        sendError(res, 422, 'Validation Failed: labels are invalid');
        return true;
      }
      for (const name of names) {
        if (!repo.labels.has(name)) {
          sendError(res, 422, `Validation Failed: label '${name}' does not exist`);
          return true;
        }
      }
      const issue = forge.createIssue(repo, {
        title,
        body: typeof data.body === 'string' ? data.body : '',
        labels: names,
      });
      sendJson(res, 201, issueObject(repo, issue));
      return true;
    }
    return false;
  }

  const number = Number(parts[0]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (item === undefined) {
    notFound(res);
    return true;
  }

  if (parts.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueObject(repo, item));
      return true;
    }
    if (method === 'PATCH') {
      const data = parseJsonBody(res, body);
      if (data === undefined) return true;
      if (typeof data.title === 'string') item.title = data.title;
      if (typeof data.body === 'string') item.body = data.body;
      if (data.state === 'closed' || data.state === 'open') {
        item.state = data.state;
      }
      if (data.labels !== undefined) {
        const names = labelNames(data.labels);
        if (names === null) {
          sendError(res, 422, 'Validation Failed: labels are invalid');
          return true;
        }
        for (const name of names) {
          if (!repo.labels.has(name)) {
            sendError(res, 422, `Validation Failed: label '${name}' does not exist`);
            return true;
          }
        }
        item.labels = names;
      }
      item.updatedSeq = forge.nextSeq();
      item.updatedAt = forge.nowIso();
      sendJson(res, 200, issueObject(repo, item));
      return true;
    }
    return false;
  }

  if (parts.length === 2 && parts[1] === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, item.comments.map((comment) => commentObject(item, comment)));
      return true;
    }
    if (method === 'POST') {
      const data = parseJsonBody(res, body);
      if (data === undefined) return true;
      const text = typeof data.body === 'string' ? data.body : '';
      if (text === '') {
        sendError(res, 422, 'Validation Failed: body is required');
        return true;
      }
      const comment = forge.addComment(repo, item, text);
      sendJson(res, 201, commentObject(item, comment));
      return true;
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------- pulls

function handlePulls(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  repo: RepoRec,
  parts: string[],
): boolean {
  const method = req.method ?? 'GET';

  if (parts.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.seq - a.seq);
      const { perPage, page } = pagination(url);
      sendJson(res, 200, pageSlice(pulls, perPage, page).map((pull) => pullObject(forge, repo, pull)));
      return true;
    }
    if (method === 'POST') {
      const data = parseJsonBody(res, body);
      if (data === undefined) return true;
      const title = typeof data.title === 'string' ? data.title : '';
      const stripOwner = (value: unknown): string => {
        if (typeof value !== 'string') return '';
        const colon = value.lastIndexOf(':');
        return colon >= 0 ? value.slice(colon + 1) : value;
      };
      const headRef = stripOwner(data.head);
      const baseRef = stripOwner(data.base);
      const headSha = headRef === '' ? null : forge.branchTip(repo, headRef);
      const baseSha = baseRef === '' ? null : forge.branchTip(repo, baseRef);
      if (title === '' || headSha === null || baseSha === null) {
        sendError(res, 422, 'Validation Failed: title, head and base must name existing branches');
        return true;
      }
      const duplicate = [...repo.items.values()].some(
        (item) => item.kind === 'pull' && item.state === 'open' && item.headRef === headRef && item.baseRef === baseRef,
      );
      if (duplicate) {
        sendError(res, 422, `A pull request already exists for ${headRef} into ${baseRef}`);
        return true;
      }
      const pull = forge.createPull(repo, {
        title,
        body: typeof data.body === 'string' ? data.body : '',
        headRef,
        baseRef,
        headSha,
        baseSha,
      });
      sendJson(res, 201, pullObject(forge, repo, pull));
      return true;
    }
    return false;
  }

  const number = Number(parts[0]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  const pull = item !== undefined && item.kind === 'pull' ? item : undefined;
  if (pull === undefined) {
    notFound(res);
    return true;
  }

  if (parts.length === 1 && method === 'GET') {
    sendJson(res, 200, pullObject(forge, repo, pull));
    return true;
  }

  if (parts.length === 2 && parts[1] === 'files' && method === 'GET') {
    const files = forge.pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    sendJson(res, 200, files);
    return true;
  }

  if (parts.length === 2 && parts[1] === 'merge' && method === 'PUT') {
    const data = body.length > 0 ? parseJsonBody(res, body) : {};
    if (data === undefined) return true;
    if (pull.merged || pull.state !== 'open') {
      sendError(res, 405, 'Pull Request is not mergeable');
      return true;
    }
    const methodWanted = typeof data.merge_method === 'string' ? data.merge_method : 'merge';
    const result = forge.mergePull(repo, pull, methodWanted === 'squash' ? 'squash' : 'merge');
    if ('conflict' in result) {
      sendError(res, 405, `Pull Request is not mergeable: conflict in ${result.conflict}`);
      return true;
    }
    if ('error' in result) {
      sendError(res, 405, `Pull Request is not mergeable: ${result.error}`);
      return true;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }

  return false;
}
