// The forge's state and domain logic: repositories (an in-memory git object store plus
// refs), issues and pull requests sharing one number sequence per repository, labels and
// comments. Everything the REST, git-HTTP, GraphQL and MCP surfaces serve comes from here,
// so the four surfaces can never disagree about an object.
//
// Determinism: a logical clock seeded from MAKEFUN_TRIAL_NOW stamps every created_at and
// every forge-authored commit, so a replayed trial sees identical bytes. Pushed git objects
// are stored and re-served byte-exact; the forge never rewrites them.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseIdentity,
  parseTree,
  peelToCommit,
  type GitObj,
  type TreeEntry,
} from './gitobj.ts';

/** The one login the trial token names (wire.ts's sealed scenario viewer). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const DEFAULT_BRANCH = 'main';

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
  createdAt: string;
}

export interface IssueRec {
  kind: 'issue';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  kind: 'pull';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  labels: string[];
  comments: CommentRec[];
  seq: number;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
}

export type ItemRec = IssueRec | PullRec;

export interface RepoRec {
  id: number;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  items: Map<number, ItemRec>;
  nextNumber: number;
  labels: Map<string, LabelRec>;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  private nextRepoId = 5000;
  private nextItemId = 1_000_000;
  private nextCommentId = 5_000_000;
  private seq = 0;
  private clockMs: number;

  constructor() {
    const seeded = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '');
    this.clockMs = Number.isFinite(seeded) ? seeded : Date.parse('2026-01-01T00:00:00.000Z');
  }

  /** Advance the logical clock and return the new instant as an ISO string. */
  nowIso(): string {
    this.clockMs += 1000;
    return new Date(this.clockMs).toISOString();
  }

  nowSeconds(): number {
    return Math.floor(this.clockMs / 1000);
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // -------------------------------------------------------------- repositories

  createRepo(name: string, init: { private: boolean; description: string }): RepoRec {
    const stamp = this.nowIso();
    const repo: RepoRec = {
      id: this.nextRepoId,
      name,
      private: init.private,
      description: init.description,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      items: new Map(),
      nextNumber: 1,
      labels: new Map(),
      seq: this.nextSeq(),
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.nextRepoId += 1;
    this.repos.set(name.toLowerCase(), repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(name.toLowerCase());
  }

  repoById(id: number): RepoRec | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(repo.name.toLowerCase());
  }

  // -------------------------------------------------------------- object store

  putObject(repo: RepoRec, obj: GitObj): string {
    const oid = hashObject(obj.type, obj.data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    return oid;
  }

  getObject(repo: RepoRec, oid: string): GitObj | undefined {
    return repo.objects.get(oid);
  }

  /** The commit oid a ref names, following annotated tags; null when unborn/missing. */
  refCommit(repo: RepoRec, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return null;
    return peelToCommit((candidate) => repo.objects.get(candidate), oid);
  }

  branchTip(repo: RepoRec, branch: string): string | null {
    return this.refCommit(repo, `refs/heads/${branch}`);
  }

  commitInfo(repo: RepoRec, oid: string) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommit(obj.data);
  }

  /** Ancestors of a commit (including itself) with BFS distance, for merge bases. */
  ancestorDistances(repo: RepoRec, tip: string): Map<string, number> {
    const distances = new Map<string, number>();
    let frontier = [tip];
    let depth = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (distances.has(oid)) continue;
        distances.set(oid, depth);
        const info = this.commitInfo(repo, oid);
        if (info !== null) next.push(...info.parents);
      }
      frontier = next;
      depth += 1;
    }
    return distances;
  }

  isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
    return this.ancestorDistances(repo, descendant).has(ancestor);
  }

  mergeBase(repo: RepoRec, a: string, b: string): string | null {
    const fromA = this.ancestorDistances(repo, a);
    const seen = new Set<string>();
    let frontier = [b];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (fromA.has(oid)) return oid;
        const info = this.commitInfo(repo, oid);
        if (info !== null) next.push(...info.parents);
      }
      frontier = next;
    }
    return null;
  }

  /** History of a tip, newest first (committer timestamp, then discovery order). */
  history(repo: RepoRec, tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      order.push(oid);
      const info = this.commitInfo(repo, oid);
      if (info !== null) {
        for (let index = info.parents.length - 1; index >= 0; index -= 1) {
          stack.push(info.parents[index] as string);
        }
      }
    }
    const stamp = (oid: string): number => {
      const info = this.commitInfo(repo, oid);
      return info === null ? 0 : parseIdentity(info.committer).timestamp;
    };
    return order
      .map((oid, index) => ({ oid, index, stamp: stamp(oid) }))
      .sort((x, y) => y.stamp - x.stamp || x.index - y.index)
      .map((entry) => entry.oid);
  }

  // -------------------------------------------------------------- trees

  /** Flatten a tree (recursively) into path -> {mode, oid}. */
  flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, TreeEntry & { path: string }>()): Map<string, TreeEntry & { path: string }> {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') {
        this.flattenTree(repo, entry.oid, path, out);
      } else {
        out.set(path, { ...entry, path });
      }
    }
    return out;
  }

  treeOfCommit(repo: RepoRec, commitOid: string): string | null {
    const info = this.commitInfo(repo, commitOid);
    return info === null ? null : info.tree;
  }

  flatTreeOfCommit(repo: RepoRec, commitOid: string): Map<string, TreeEntry & { path: string }> {
    const tree = this.treeOfCommit(repo, commitOid);
    if (tree === null) return new Map();
    return this.flattenTree(repo, tree);
  }

  /** Build (and store) nested trees from a flat path map; returns the root tree oid. */
  buildTreeFromFlat(repo: RepoRec, flat: Map<string, { mode: string; oid: string }>): string {
    interface Dir {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        let child = dir.dirs.get(part);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          dir.dirs.set(part, child);
        }
        dir = child;
      }
      dir.files.set(parts[parts.length - 1] as string, entry);
    }
    const emit = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
      return this.putObject(repo, { type: 'tree', data: buildTree(entries) });
    };
    return emit(root);
  }

  /** The entries of one directory inside a commit's tree (for contents listings). */
  listDirectory(
    repo: RepoRec,
    commitOid: string,
    dirPath: string,
  ): Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string; mode: string }> | null {
    const tree = this.treeOfCommit(repo, commitOid);
    if (tree === null) return null;
    let current = tree;
    if (dirPath !== '') {
      for (const part of dirPath.split('/')) {
        const obj = repo.objects.get(current);
        if (obj === undefined || obj.type !== 'tree') return null;
        const entry = parseTree(obj.data).find((candidate) => candidate.name === part);
        if (entry === undefined || !(entry.mode === '40000' || entry.mode === '040000')) return null;
        current = entry.oid;
      }
    }
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    return parseTree(obj.data).map((entry) => ({
      name: entry.name,
      path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
      type: entry.mode === '40000' || entry.mode === '040000' ? ('dir' as const) : ('file' as const),
      oid: entry.oid,
      mode: entry.mode,
    }));
  }

  // -------------------------------------------------------------- commits the forge authors

  forgeIdentity(): string {
    return `${VIEWER.name} <${VIEWER.email}> ${this.nowSeconds()} +0000`;
  }

  /** Create a commit on a branch from a flat tree; moves the ref and returns the commit oid. */
  commitFlatTree(
    repo: RepoRec,
    branch: string,
    flat: Map<string, { mode: string; oid: string }>,
    message: string,
    parent: string | null,
  ): string {
    const tree = this.buildTreeFromFlat(repo, flat);
    const identity = this.forgeIdentity();
    const commit = buildCommit({
      tree,
      parents: parent === null ? [] : [parent],
      author: identity,
      committer: identity,
      message,
    });
    const oid = this.putObject(repo, { type: 'commit', data: commit });
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.updatedAt = this.nowIso();
    return oid;
  }

  // -------------------------------------------------------------- merges and diffs

  /**
   * Three-way tree merge at path granularity: a path changed on both sides with
   * different results conflicts; otherwise the changed side wins. Returns the merged
   * flat tree, or the first conflicting path.
   */
  mergeFlatTrees(
    repo: RepoRec,
    baseCommit: string,
    oursCommit: string,
    theirsCommit: string,
  ): { flat: Map<string, { mode: string; oid: string }> } | { conflict: string } {
    const base = this.flatTreeOfCommit(repo, baseCommit);
    const ours = this.flatTreeOfCommit(repo, oursCommit);
    const theirs = this.flatTreeOfCommit(repo, theirsCommit);
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const merged = new Map<string, { mode: string; oid: string }>();
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid;
      if (same(o, t)) {
        if (o !== undefined) merged.set(path, { mode: o.mode, oid: o.oid });
      } else if (same(b, o)) {
        if (t !== undefined) merged.set(path, { mode: t.mode, oid: t.oid });
      } else if (same(b, t)) {
        if (o !== undefined) merged.set(path, { mode: o.mode, oid: o.oid });
      } else {
        return { conflict: path };
      }
    }
    return { flat: merged };
  }

  /** Dry-run mergeability of a pull request: merged flat tree or a conflict path. */
  planMerge(repo: RepoRec, pull: PullRec): { flat: Map<string, { mode: string; oid: string }>; baseTip: string; headTip: string } | { conflict: string } | { error: string } {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === null || headTip === null) return { error: 'a branch is missing' };
    const mergeBase = this.mergeBase(repo, baseTip, headTip);
    if (mergeBase === null) return { error: 'no common ancestor' };
    const merged = this.mergeFlatTrees(repo, mergeBase, baseTip, headTip);
    if ('conflict' in merged) return merged;
    return { flat: merged.flat, baseTip, headTip };
  }

  /** Merge a pull request (squash = one commit on the base; merge = a two-parent commit). */
  mergePull(repo: RepoRec, pull: PullRec, method: 'merge' | 'squash'): { sha: string } | { conflict: string } | { error: string } {
    const plan = this.planMerge(repo, pull);
    if ('conflict' in plan || 'error' in plan) return plan;
    const tree = this.buildTreeFromFlat(repo, plan.flat);
    const identity = this.forgeIdentity();
    const message =
      method === 'squash'
        ? `${pull.title} (#${pull.number})\n${pull.body === '' ? '' : `\n${pull.body}\n`}`
        : `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const commit = buildCommit({
      tree,
      parents: method === 'squash' ? [plan.baseTip] : [plan.baseTip, plan.headTip],
      author: identity,
      committer: identity,
      message,
    });
    const sha = this.putObject(repo, { type: 'commit', data: commit });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedSeq = this.nextSeq();
    pull.updatedAt = pull.mergedAt;
    repo.updatedAt = pull.updatedAt;
    return { sha };
  }

  /** Line-diff counts between two flat trees (LCS over lines), per changed path. */
  diffFlatTrees(
    repo: RepoRec,
    baseFlat: Map<string, TreeEntry & { path: string }>,
    headFlat: Map<string, TreeEntry & { path: string }>,
  ): Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> {
    const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
    const files: Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      if (b?.oid === h?.oid) continue;
      const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
      const baseLines = b === undefined ? [] : blobLines(repo, b.oid);
      const headLines = h === undefined ? [] : blobLines(repo, h.oid);
      const { additions, deletions } = lineDiffCounts(baseLines, headLines);
      files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return files;
  }

  /** The changed files of a pull request: diff of merge-base tree to head tree. */
  pullFiles(repo: RepoRec, pull: PullRec) {
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const mergeBase = this.mergeBase(repo, baseTip, headTip) ?? baseTip;
    return this.diffFlatTrees(repo, this.flatTreeOfCommit(repo, mergeBase), this.flatTreeOfCommit(repo, headTip));
  }

  // -------------------------------------------------------------- issues and pulls

  createIssue(repo: RepoRec, init: { title: string; body: string; labels: string[] }): IssueRec {
    const stamp = this.nowIso();
    const issue: IssueRec = {
      kind: 'issue',
      number: repo.nextNumber,
      id: this.nextItemId,
      title: init.title,
      body: init.body,
      state: 'open',
      labels: [...init.labels],
      comments: [],
      seq: this.nextSeq(),
      updatedSeq: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    issue.updatedSeq = issue.seq;
    repo.nextNumber += 1;
    this.nextItemId += 1;
    repo.items.set(issue.number, issue);
    return issue;
  }

  createPull(repo: RepoRec, init: { title: string; body: string; headRef: string; baseRef: string; headSha: string; baseSha: string }): PullRec {
    const stamp = this.nowIso();
    const pull: PullRec = {
      kind: 'pull',
      number: repo.nextNumber,
      id: this.nextItemId,
      title: init.title,
      body: init.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: init.headRef,
      baseRef: init.baseRef,
      headSha: init.headSha,
      baseSha: init.baseSha,
      labels: [],
      comments: [],
      seq: this.nextSeq(),
      updatedSeq: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    pull.updatedSeq = pull.seq;
    repo.nextNumber += 1;
    this.nextItemId += 1;
    repo.items.set(pull.number, pull);
    return pull;
  }

  addComment(repo: RepoRec, item: ItemRec, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextCommentId, body, seq: this.nextSeq(), createdAt: this.nowIso() };
    this.nextCommentId += 1;
    item.comments.push(comment);
    item.updatedSeq = comment.seq;
    item.updatedAt = comment.createdAt;
    void repo;
    return comment;
  }
}

function blobLines(repo: RepoRec, oid: string): string[] {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'blob') return [];
  if (obj.data.includes(0)) return []; // binary: no line counts
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  return text.split('\n');
}

/** Additions/deletions between two line arrays, by longest common subsequence. */
export function lineDiffCounts(a: string[], b: string[]): { additions: number; deletions: number } {
  const n = a.length;
  const m = b.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS length with two rows (files in this forge are small).
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      curr[j] = a[i] === b[j] ? (prev[j + 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, curr[j + 1] ?? 0);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[0] ?? 0;
  return { additions: m - lcs, deletions: n - lcs };
}
