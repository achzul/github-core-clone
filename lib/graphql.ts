// The GitHub GraphQL v4 surface: a small self-contained GraphQL parser and executor
// (operations, variables, aliases, inline and named fragments, input objects, enum
// lists, operation batching) over the shared Forge store, implementing exactly the
// schema the suite's documents touch — viewer, repository, issues and pull requests
// with cursor connections, the gh feature-detection introspection probes, node(id:),
// and the create/close/merge/comment mutations. An unknown field is a 200 with an
// `errors` array naming it; an unknown repository is data.repository = null.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authed, isRecord, sendJson } from './http.ts';
import { VIEWER, type Forge, type ItemRec, type PullRec, type RepoRec } from './store.ts';
import { decodeNodeId, nodeId } from './rest.ts';

// ------------------------------------------------------------------ lexer

type Tok =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      toks.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        toks.push({ kind: 'string', value: text });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] ?? '';
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"', "'": "'" };
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      toks.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let float = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') float = true;
        j += 1;
      }
      toks.push({ kind: float ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  toks.push({ kind: 'eof' });
  return toks;
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<[string, ValueNode]> };

type Selection =
  | { kind: 'field'; alias: string | null; name: string; args: Array<[string, ValueNode]>; selection: Selection[] | null }
  | { kind: 'inline'; typeCondition: string | null; selection: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefaults: Map<string, ValueNode>;
  selection: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selection: Selection[] }>;
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok {
    return this.toks[this.pos] as Tok;
  }

  private next(): Tok {
    const tok = this.toks[this.pos] as Tok;
    this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected '${value}'`);
  }

  private skipPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error('expected a name');
    return tok.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selection: Selection[] }>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ type: 'query', name: null, varDefaults: new Map(), selection: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind !== 'name') throw new Error('expected a definition');
      if (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const varDefaults = new Map<string, ValueNode>();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.parseVariableDefinitions(varDefaults);
        }
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        operations.push({ type: tok.value === 'mutation' ? 'mutation' : 'query', name, varDefaults, selection });
        continue;
      }
      if (tok.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onTok = this.next();
        if (onTok.kind !== 'name' || onTok.value !== 'on') throw new Error('expected `on` in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unsupported definition ${tok.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Map<string, ValueNode>): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) defaults.set(name, this.parseValue(true));
      this.skipDirectives();
    }
  }

  private parseType(): void {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.next();
        while (!this.skipPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue(false);
        }
      }
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.skipPunct('}')) {
      const tok = this.peek();
      if (tok.kind === 'spread') {
        this.next();
        const nextTok = this.peek();
        if (nextTok.kind === 'name' && nextTok.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.expectName() });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      const args: Array<[string, ValueNode]> = [];
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.next();
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push([argName, this.parseValue(false)]);
        }
      }
      this.skipDirectives();
      let selection: Selection[] | null = null;
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
        selection = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    return selections;
  }

  private parseValue(constOnly: boolean): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      if (constOnly) throw new Error('variable in constant value');
      return { kind: 'var', name: this.expectName() };
    }
    if (tok.kind === 'int') return { kind: 'int', value: Number(tok.value) };
    if (tok.kind === 'float') return { kind: 'float', value: Number(tok.value) };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue(constOnly));
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<[string, ValueNode]> = [];
      while (!this.skipPunct('}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push([fieldName, this.parseValue(constOnly)]);
      }
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'bool', value: true };
      if (tok.value === 'false') return { kind: 'bool', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error('unexpected value token');
  }
}

// ------------------------------------------------------------------ schema

class GqlError extends Error {}

type Source = Record<string, unknown> & { __type: string };

interface FieldDef {
  /** Object type to complete into, when the field returns an object (or list of them). */
  ofType?: string;
  list?: boolean;
  resolve: (forge: Forge, source: Source, args: Record<string, unknown>) => unknown;
}

const src = (type: string, data: Record<string, unknown> = {}): Source => ({ __type: type, ...data });

function repoSource(repo: RepoRec): Source {
  return src('Repository', { repo });
}

function itemSource(repo: RepoRec, item: ItemRec): Source {
  return src(item.kind === 'issue' ? 'Issue' : 'PullRequest', { repo, item });
}

function userSource(): Source {
  return src('User');
}

interface ConnectionItem {
  seq: number;
  updatedSeq: number;
  source: Source;
}

function connectionSource(type: string, items: ConnectionItem[], args: Record<string, unknown>): Source {
  return src(type, { items, args });
}

function pageSliceOf(source: Source): { slice: ConnectionItem[]; hasNextPage: boolean; hasPreviousPage: boolean; startIndex: number } {
  const items = source.items as ConnectionItem[];
  const args = source.args as Record<string, unknown>;
  const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : 30;
  let startIndex = 0;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null) {
    const seq = decodeCursor(after);
    const index = seq === null ? -1 : items.findIndex((item) => item.seq === seq);
    startIndex = index >= 0 ? index + 1 : items.length;
  }
  const slice = items.slice(startIndex, startIndex + first);
  return { slice, hasNextPage: startIndex + slice.length < items.length, hasPreviousPage: startIndex > 0, startIndex };
}

function cursorOf(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function orderItems<T extends { seq: number; updatedSeq: number; comments: number }>(
  items: T[],
  orderBy: unknown,
): T[] {
  const spec = isRecord(orderBy) ? orderBy : {};
  const field = typeof spec.field === 'string' ? spec.field : 'CREATED_AT';
  const direction = typeof spec.direction === 'string' ? spec.direction : 'DESC';
  const key = (item: T): number => (field === 'UPDATED_AT' ? item.updatedSeq : field === 'COMMENTS' ? item.comments : item.seq);
  const sign = direction === 'ASC' ? 1 : -1;
  return [...items].sort((a, b) => sign * (key(a) - key(b)) || sign * (a.seq - b.seq));
}

function issueStateGraphql(item: ItemRec): string {
  return item.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGraphql(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { ofType: 'User', resolve: () => userSource() },
    repository: {
      ofType: 'Repository',
      resolve: (forge, _s, args) => {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoSource(repo);
      },
    },
    node: {
      ofType: 'Node',
      resolve: (forge, _s, args) => resolveNode(forge, String(args.id ?? '')),
    },
    __type: {
      ofType: '__Type',
      resolve: (_f, _s, args) => {
        const name = String(args.name ?? '');
        return TYPE_DEFS[name] !== undefined ? src('__Type', { name }) : null;
      },
    },
    __schema: { ofType: '__Schema', resolve: () => src('__Schema') },
  },
  Mutation: {
    createIssue: {
      ofType: 'CreateIssuePayload',
      resolve: (forge, _s, args) => {
        const input = isRecord(args.input) ? args.input : {};
        const repo = repoFromNodeId(forge, String(input.repositoryId ?? ''));
        if (repo === undefined) throw new GqlError('Could not resolve repository');
        const issue = forge.createIssue(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          labels: [],
        });
        return src('CreateIssuePayload', { repo, item: issue, clientMutationId: input.clientMutationId ?? null });
      },
    },
    closeIssue: {
      ofType: 'CloseIssuePayload',
      resolve: (forge, _s, args) => {
        const input = isRecord(args.input) ? args.input : {};
        const found = itemFromNodeId(forge, String(input.issueId ?? ''));
        if (found === undefined) throw new GqlError('Could not resolve issue');
        found.item.state = 'closed';
        found.item.updatedSeq = forge.nextSeq();
        found.item.updatedAt = forge.nowIso();
        return src('CloseIssuePayload', { repo: found.repo, item: found.item, clientMutationId: input.clientMutationId ?? null });
      },
    },
    createPullRequest: {
      ofType: 'CreatePullRequestPayload',
      resolve: (forge, _s, args) => {
        const input = isRecord(args.input) ? args.input : {};
        const repo = repoFromNodeId(forge, String(input.repositoryId ?? ''));
        if (repo === undefined) throw new GqlError('Could not resolve repository');
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        const headSha = forge.branchTip(repo, headRef);
        const baseSha = forge.branchTip(repo, baseRef);
        if (headSha === null || baseSha === null) throw new GqlError('Head or base ref does not exist');
        const pull = forge.createPull(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          headRef,
          baseRef,
          headSha,
          baseSha,
        });
        return src('CreatePullRequestPayload', { repo, item: pull, clientMutationId: input.clientMutationId ?? null });
      },
    },
    mergePullRequest: {
      ofType: 'MergePullRequestPayload',
      resolve: (forge, _s, args) => {
        const input = isRecord(args.input) ? args.input : {};
        const found = itemFromNodeId(forge, String(input.pullRequestId ?? ''));
        if (found === undefined || found.item.kind !== 'pull') throw new GqlError('Could not resolve pull request');
        const pull = found.item;
        if (!pull.merged) {
          const method = String(input.mergeMethod ?? 'SQUASH');
          const result = forge.mergePull(found.repo, pull, method === 'MERGE' ? 'merge' : 'squash');
          if ('conflict' in result) throw new GqlError(`Pull Request is not mergeable: conflict in ${result.conflict}`);
          if ('error' in result) throw new GqlError(`Pull Request is not mergeable: ${result.error}`);
        }
        return src('MergePullRequestPayload', { repo: found.repo, item: pull, clientMutationId: input.clientMutationId ?? null });
      },
    },
    addComment: {
      ofType: 'AddCommentPayload',
      resolve: (forge, _s, args) => {
        const input = isRecord(args.input) ? args.input : {};
        const found = itemFromNodeId(forge, String(input.subjectId ?? ''));
        if (found === undefined) throw new GqlError('Could not resolve subject');
        const comment = forge.addComment(found.repo, found.item, String(input.body ?? ''));
        return src('AddCommentPayload', {
          repo: found.repo,
          item: found.item,
          comment,
          clientMutationId: input.clientMutationId ?? null,
        });
      },
    },
  },
  User: {
    id: { resolve: () => nodeId('User', String(VIEWER.id)) },
    login: { resolve: () => VIEWER.login },
    name: { resolve: () => VIEWER.name },
    email: { resolve: () => VIEWER.email },
  },
  Repository: {
    id: { resolve: (_f, s) => nodeId('Repository', String((s.repo as RepoRec).id)) },
    databaseId: { resolve: (_f, s) => (s.repo as RepoRec).id },
    name: { resolve: (_f, s) => (s.repo as RepoRec).name },
    nameWithOwner: { resolve: (_f, s) => `${VIEWER.login}/${(s.repo as RepoRec).name}` },
    owner: { ofType: 'User', resolve: () => userSource() },
    defaultBranchRef: {
      ofType: 'Ref',
      resolve: (forge, s) => {
        const repo = s.repo as RepoRec;
        return forge.branchTip(repo, repo.defaultBranch) !== null ? src('Ref', { name: repo.defaultBranch }) : null;
      },
    },
    viewerPermission: { resolve: () => 'ADMIN' },
    hasIssuesEnabled: { resolve: () => true },
    isPrivate: { resolve: (_f, s) => (s.repo as RepoRec).private },
    description: { resolve: (_f, s) => (s.repo as RepoRec).description },
    createdAt: { resolve: (_f, s) => (s.repo as RepoRec).createdAt },
    updatedAt: { resolve: (_f, s) => (s.repo as RepoRec).updatedAt },
    url: { resolve: (_f, s) => `https://forge.local/${VIEWER.login}/${(s.repo as RepoRec).name}` },
    issue: {
      ofType: 'Issue',
      resolve: (_f, s, args) => {
        const repo = s.repo as RepoRec;
        const item = repo.items.get(Number(args.number));
        return item !== undefined && item.kind === 'issue' ? itemSource(repo, item) : null;
      },
    },
    issues: {
      ofType: 'IssueConnection',
      resolve: (_f, s, args) => {
        const repo = s.repo as RepoRec;
        let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
        const states = Array.isArray(args.states) ? args.states.map(String) : null;
        if (states !== null) items = items.filter((item) => states.includes(issueStateGraphql(item)));
        const ordered = orderItems(
          items.map((item) => ({ seq: item.seq, updatedSeq: item.updatedSeq, comments: item.comments.length, item })),
          args.orderBy,
        );
        return connectionSource(
          'IssueConnection',
          ordered.map((entry) => ({ seq: entry.item.seq, updatedSeq: entry.item.updatedSeq, source: itemSource(repo, entry.item) })),
          args,
        );
      },
    },
    pullRequest: {
      ofType: 'PullRequest',
      resolve: (_f, s, args) => {
        const repo = s.repo as RepoRec;
        const item = repo.items.get(Number(args.number));
        return item !== undefined && item.kind === 'pull' ? itemSource(repo, item) : null;
      },
    },
    pullRequests: {
      ofType: 'PullRequestConnection',
      resolve: (_f, s, args) => {
        const repo = s.repo as RepoRec;
        let items = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
        const states = Array.isArray(args.states) ? args.states.map(String) : null;
        if (states !== null) items = items.filter((item) => states.includes(pullStateGraphql(item)));
        const ordered = orderItems(
          items.map((item) => ({ seq: item.seq, updatedSeq: item.updatedSeq, comments: item.comments.length, item })),
          args.orderBy,
        );
        return connectionSource(
          'PullRequestConnection',
          ordered.map((entry) => ({ seq: entry.item.seq, updatedSeq: entry.item.updatedSeq, source: itemSource(repo, entry.item) })),
          args,
        );
      },
    },
  },
  Ref: {
    name: { resolve: (_f, s) => s.name },
    prefix: { resolve: () => 'refs/heads/' },
  },
  Issue: {
    id: { resolve: (_f, s) => nodeId('Issue', String((s.repo as RepoRec).id), String((s.item as ItemRec).number)) },
    number: { resolve: (_f, s) => (s.item as ItemRec).number },
    title: { resolve: (_f, s) => (s.item as ItemRec).title },
    body: { resolve: (_f, s) => (s.item as ItemRec).body },
    state: { resolve: (_f, s) => issueStateGraphql(s.item as ItemRec) },
    createdAt: { resolve: (_f, s) => (s.item as ItemRec).createdAt },
    updatedAt: { resolve: (_f, s) => (s.item as ItemRec).updatedAt },
    author: { ofType: 'User', resolve: () => userSource() },
    repository: { ofType: 'Repository', resolve: (_f, s) => repoSource(s.repo as RepoRec) },
    url: {
      resolve: (_f, s) => `https://forge.local/${VIEWER.login}/${(s.repo as RepoRec).name}/issues/${(s.item as ItemRec).number}`,
    },
  },
  PullRequest: {
    id: { resolve: (_f, s) => nodeId('PullRequest', String((s.repo as RepoRec).id), String((s.item as ItemRec).number)) },
    number: { resolve: (_f, s) => (s.item as ItemRec).number },
    title: { resolve: (_f, s) => (s.item as ItemRec).title },
    body: { resolve: (_f, s) => (s.item as ItemRec).body },
    state: { resolve: (_f, s) => pullStateGraphql(s.item as PullRec) },
    merged: { resolve: (_f, s) => (s.item as PullRec).merged },
    mergeable: {
      resolve: (forge, s) => {
        const pull = s.item as PullRec;
        if (pull.merged) return 'UNKNOWN';
        const plan = forge.planMerge(s.repo as RepoRec, pull);
        if ('conflict' in plan) return 'CONFLICTING';
        if ('error' in plan) return 'UNKNOWN';
        return 'MERGEABLE';
      },
    },
    headRefName: { resolve: (_f, s) => (s.item as PullRec).headRef },
    baseRefName: { resolve: (_f, s) => (s.item as PullRec).baseRef },
    createdAt: { resolve: (_f, s) => (s.item as ItemRec).createdAt },
    updatedAt: { resolve: (_f, s) => (s.item as ItemRec).updatedAt },
    author: { ofType: 'User', resolve: () => userSource() },
    repository: { ofType: 'Repository', resolve: (_f, s) => repoSource(s.repo as RepoRec) },
    url: {
      resolve: (_f, s) => `https://forge.local/${VIEWER.login}/${(s.repo as RepoRec).name}/pull/${(s.item as ItemRec).number}`,
    },
    files: {
      ofType: 'PullRequestChangedFileConnection',
      resolve: (forge, s, args) => {
        const repo = s.repo as RepoRec;
        const pull = s.item as PullRec;
        const files = forge.pullFiles(repo, pull);
        return src('PullRequestChangedFileConnection', { files, args });
      },
    },
  },
  PullRequestChangedFileConnection: {
    nodes: {
      ofType: 'PullRequestChangedFile',
      list: true,
      resolve: (_f, s) => {
        const files = s.files as ReturnType<Forge['pullFiles']>;
        const args = s.args as Record<string, unknown>;
        const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : files.length;
        return files.slice(0, first).map((file) => src('PullRequestChangedFile', { file }));
      },
    },
    totalCount: { resolve: (_f, s) => (s.files as unknown[]).length },
  },
  PullRequestChangedFile: {
    path: { resolve: (_f, s) => (s.file as { filename: string }).filename },
    additions: { resolve: (_f, s) => (s.file as { additions: number }).additions },
    deletions: { resolve: (_f, s) => (s.file as { deletions: number }).deletions },
    changes: { resolve: (_f, s) => (s.file as { changes: number }).changes },
    changeType: {
      resolve: (_f, s) => {
        const status = (s.file as { status: string }).status;
        return status === 'added' ? 'ADDED' : status === 'removed' ? 'DELETED' : 'MODIFIED';
      },
    },
  },
  IssueConnection: {
    nodes: {
      ofType: 'Issue',
      list: true,
      resolve: (_f, s) => pageSliceOf(s).slice.map((entry) => entry.source),
    },
    pageInfo: { ofType: 'PageInfo', resolve: (_f, s) => src('PageInfo', { connection: s }) },
    totalCount: { resolve: (_f, s) => (s.items as unknown[]).length },
  },
  PullRequestConnection: {
    nodes: {
      ofType: 'PullRequest',
      list: true,
      resolve: (_f, s) => pageSliceOf(s).slice.map((entry) => entry.source),
    },
    pageInfo: { ofType: 'PageInfo', resolve: (_f, s) => src('PageInfo', { connection: s }) },
    totalCount: { resolve: (_f, s) => (s.items as unknown[]).length },
  },
  PageInfo: {
    hasNextPage: { resolve: (_f, s) => pageSliceOf(s.connection as Source).hasNextPage },
    hasPreviousPage: { resolve: (_f, s) => pageSliceOf(s.connection as Source).hasPreviousPage },
    startCursor: {
      resolve: (_f, s) => {
        const { slice } = pageSliceOf(s.connection as Source);
        return slice.length > 0 ? cursorOf((slice[0] as ConnectionItem).seq) : null;
      },
    },
    endCursor: {
      resolve: (_f, s) => {
        const { slice } = pageSliceOf(s.connection as Source);
        return slice.length > 0 ? cursorOf((slice[slice.length - 1] as ConnectionItem).seq) : null;
      },
    },
  },
  IssueComment: {
    id: {
      resolve: (_f, s) =>
        nodeId('IssueComment', String((s.repo as RepoRec).id), String((s.item as ItemRec).number), String((s.comment as { id: number }).id)),
    },
    body: { resolve: (_f, s) => (s.comment as { body: string }).body },
    createdAt: { resolve: (_f, s) => (s.comment as { createdAt: string }).createdAt },
    author: { ofType: 'User', resolve: () => userSource() },
  },
  CreateIssuePayload: {
    issue: { ofType: 'Issue', resolve: (_f, s) => itemSource(s.repo as RepoRec, s.item as ItemRec) },
    clientMutationId: { resolve: (_f, s) => s.clientMutationId ?? null },
  },
  CloseIssuePayload: {
    issue: { ofType: 'Issue', resolve: (_f, s) => itemSource(s.repo as RepoRec, s.item as ItemRec) },
    clientMutationId: { resolve: (_f, s) => s.clientMutationId ?? null },
  },
  CreatePullRequestPayload: {
    pullRequest: { ofType: 'PullRequest', resolve: (_f, s) => itemSource(s.repo as RepoRec, s.item as ItemRec) },
    clientMutationId: { resolve: (_f, s) => s.clientMutationId ?? null },
  },
  MergePullRequestPayload: {
    pullRequest: { ofType: 'PullRequest', resolve: (_f, s) => itemSource(s.repo as RepoRec, s.item as ItemRec) },
    clientMutationId: { resolve: (_f, s) => s.clientMutationId ?? null },
  },
  AddCommentPayload: {
    commentEdge: {
      ofType: 'CommentEdge',
      resolve: (_f, s) => src('CommentEdge', { repo: s.repo, item: s.item, comment: s.comment }),
    },
    clientMutationId: { resolve: (_f, s) => s.clientMutationId ?? null },
  },
  CommentEdge: {
    node: {
      ofType: 'IssueComment',
      resolve: (_f, s) => src('IssueComment', { repo: s.repo, item: s.item, comment: s.comment }),
    },
    cursor: { resolve: () => cursorOf(0) },
  },
  __Schema: {
    queryType: { ofType: '__Type', resolve: () => src('__Type', { name: 'Query' }) },
    mutationType: { ofType: '__Type', resolve: () => src('__Type', { name: 'Mutation' }) },
    subscriptionType: { resolve: () => null },
    types: {
      ofType: '__Type',
      list: true,
      resolve: () => Object.keys(TYPE_DEFS).map((name) => src('__Type', { name })),
    },
    directives: { list: true, resolve: () => [] },
  },
  __Type: {
    name: { resolve: (_f, s) => s.name },
    kind: { resolve: (_f, s) => TYPE_DEFS[String(s.name)]?.kind ?? 'OBJECT' },
    description: { resolve: () => null },
    fields: {
      ofType: '__Field',
      list: true,
      resolve: (_f, s) => {
        const def = TYPE_DEFS[String(s.name)];
        if (def?.kind !== 'OBJECT') return null;
        return (def.fields ?? []).map((name) => src('__Field', { name }));
      },
    },
    enumValues: {
      ofType: '__EnumValue',
      list: true,
      resolve: (_f, s) => {
        const def = TYPE_DEFS[String(s.name)];
        if (def?.kind !== 'ENUM') return null;
        return (def.enumValues ?? []).map((name) => src('__EnumValue', { name }));
      },
    },
    inputFields: { list: true, resolve: () => null },
    possibleTypes: { list: true, resolve: () => null },
    ofType: { resolve: () => null },
    specifiedByURL: { resolve: () => null },
  },
  __Field: {
    name: { resolve: (_f, s) => s.name },
    description: { resolve: () => null },
    args: { list: true, resolve: () => [] },
    type: { resolve: () => null },
    isDeprecated: { resolve: () => false },
    deprecationReason: { resolve: () => null },
  },
  __EnumValue: {
    name: { resolve: (_f, s) => s.name },
    description: { resolve: () => null },
    isDeprecated: { resolve: () => false },
    deprecationReason: { resolve: () => null },
  },
};

const TYPE_DEFS: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: Object.keys(SCHEMA.Query ?? {}) },
  Mutation: { kind: 'OBJECT', fields: Object.keys(SCHEMA.Mutation ?? {}) },
  User: { kind: 'OBJECT', fields: Object.keys(SCHEMA.User ?? {}) },
  Repository: { kind: 'OBJECT', fields: Object.keys(SCHEMA.Repository ?? {}) },
  Ref: { kind: 'OBJECT', fields: Object.keys(SCHEMA.Ref ?? {}) },
  Issue: { kind: 'OBJECT', fields: Object.keys(SCHEMA.Issue ?? {}) },
  PullRequest: { kind: 'OBJECT', fields: Object.keys(SCHEMA.PullRequest ?? {}) },
  IssueConnection: { kind: 'OBJECT', fields: Object.keys(SCHEMA.IssueConnection ?? {}) },
  PullRequestConnection: { kind: 'OBJECT', fields: Object.keys(SCHEMA.PullRequestConnection ?? {}) },
  PageInfo: { kind: 'OBJECT', fields: Object.keys(SCHEMA.PageInfo ?? {}) },
  PullRequestChangedFile: { kind: 'OBJECT', fields: Object.keys(SCHEMA.PullRequestChangedFile ?? {}) },
  IssueComment: { kind: 'OBJECT', fields: Object.keys(SCHEMA.IssueComment ?? {}) },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'TEAM'] },
};

function repoFromNodeId(forge: Forge, id: string): RepoRec | undefined {
  const parts = decodeNodeId(id);
  if (parts === null || parts[0] !== 'Repository') return undefined;
  return forge.repoById(Number(parts[1]));
}

function itemFromNodeId(forge: Forge, id: string): { repo: RepoRec; item: ItemRec } | undefined {
  const parts = decodeNodeId(id);
  if (parts === null || (parts[0] !== 'Issue' && parts[0] !== 'PullRequest')) return undefined;
  const repo = forge.repoById(Number(parts[1]));
  if (repo === undefined) return undefined;
  const item = repo.items.get(Number(parts[2]));
  return item === undefined ? undefined : { repo, item };
}

function resolveNode(forge: Forge, id: string): Source | null {
  const parts = decodeNodeId(id);
  if (parts === null) return null;
  if (parts[0] === 'Repository') {
    const repo = forge.repoById(Number(parts[1]));
    return repo === undefined ? null : repoSource(repo);
  }
  if (parts[0] === 'Issue' || parts[0] === 'PullRequest') {
    const found = itemFromNodeId(forge, id);
    return found === undefined ? null : itemSource(found.repo, found.item);
  }
  if (parts[0] === 'User') return userSource();
  return null;
}

// ------------------------------------------------------------------ executor

interface ExecCtx {
  forge: Forge;
  doc: Document;
  vars: Map<string, unknown>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

function evalValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'var':
      return ctx.vars.get(node.name) ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = evalValue(value, ctx);
      return out;
    }
  }
}

function executeSelectionSet(
  typeName: string,
  source: Source,
  selections: Selection[],
  ctx: ExecCtx,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === source.__type || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(selection.typeCondition ?? typeName, source, selection.selection, ctx, path));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.doc.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === source.__type)) {
        Object.assign(out, executeSelectionSet(fragment.typeCondition ?? typeName, source, fragment.selection, ctx, path));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = source.__type;
      continue;
    }
    const def = SCHEMA[typeName]?.[selection.name] ?? (typeName === 'Node' ? SCHEMA[source.__type]?.[selection.name] : undefined);
    if (def === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName === 'Node' ? source.__type : typeName}'`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, valueNode] of selection.args) args[argName] = evalValue(valueNode, ctx);
    let raw: unknown;
    try {
      raw = def.resolve(ctx.forge, source, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(def, raw, selection.selection, ctx, [...path, key]);
  }
  return out;
}

function completeValue(
  def: FieldDef,
  raw: unknown,
  selection: Selection[] | null,
  ctx: ExecCtx,
  path: Array<string | number>,
): unknown {
  if (raw === null || raw === undefined) return null;
  if (def.ofType === undefined || selection === null) return raw;
  if (def.list === true) {
    if (!Array.isArray(raw)) return null;
    return raw.map((entry, index) => {
      if (entry === null || entry === undefined) return null;
      const source = entry as Source;
      const typeName = def.ofType === 'Node' ? source.__type : (def.ofType as string);
      return executeSelectionSet(typeName, source, selection, ctx, [...path, index]);
    });
  }
  const source = raw as Source;
  const typeName = def.ofType === 'Node' ? source.__type : def.ofType;
  return executeSelectionSet(typeName, source, selection, ctx, path);
}

function executeOperation(
  forge: Forge,
  body: Record<string, unknown>,
): { data: unknown; errors?: Array<{ message: string; path?: Array<string | number> }> } {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = isRecord(body.variables) ? body.variables : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let doc: Document;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation =
    doc.operations.find((op) => (operationName === null ? true : op.name === operationName)) ??
    doc.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation found' }] };
  const vars = new Map<string, unknown>();
  for (const [name, value] of Object.entries(variables)) vars.set(name, value);
  const ctx: ExecCtx = { forge, doc, vars, errors: [] };
  for (const [name, defaultNode] of operation.varDefaults) {
    if (!vars.has(name)) vars.set(name, evalValue(defaultNode, ctx));
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, src(rootType), operation.selection, ctx, []);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// ------------------------------------------------------------------ HTTP

export function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => (isRecord(entry) ? executeOperation(forge, entry) : { data: null, errors: [{ message: 'Invalid operation' }] }));
    sendJson(res, 200, results);
    return true;
  }
  if (isRecord(parsed)) {
    sendJson(res, 200, executeOperation(forge, parsed));
    return true;
  }
  sendJson(res, 400, { errors: [{ message: 'Invalid request body' }] });
  return true;
}
