// The git smart-HTTP protocol, implemented in-process (no git binary): ref
// advertisement (protocol v0 and v2), ls-refs, fetch with shallow/deepen support
// over both protocol versions, and receive-pack with fast-forward enforcement and
// report-status. Objects are stored and served byte-exact; packs the forge sends
// carry no deltas, packs it receives are resolved including OFS/REF deltas and
// thin-pack bases the store already holds.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  isOid,
  parseIdentity,
  parseTag,
  parseTree,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  sidebandWrap,
  writePack,
  type GitObj,
} from './gitobj.ts';
import { sendBytes, sendError } from './http.ts';
import { VIEWER, type Forge, type RepoRec } from './store.ts';

const AGENT = 'forge/1.0';

// ---------------------------------------------------------------- pkt stream

interface PktItem {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Decode a whole pkt-line stream (unlike the prefix decoder, flush does not stop it). */
function decodeAll(body: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      items.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      items.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    items.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return items;
}

// ---------------------------------------------------------------- advertisements

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headRef(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function advertisementV2(res: ServerResponse): void {
  const parts = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-advertisement');
}

function advertisementV0(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', res: ServerResponse): void {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=${AGENT} symref=HEAD:${headRef(repo)}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headRef(repo));
  let first = true;
  const pushLine = (oid: string, name: string) => {
    if (first) {
      lines.push(pktLine(Buffer.concat([Buffer.from(`${oid} ${name}\0${caps}`, 'utf8')])));
      first = false;
    } else {
      lines.push(pktLine(`${oid} ${name}\n`));
    }
  };
  if (refs.length === 0) {
    pushLine(ZERO_OID, 'capabilities^{}');
  } else {
    if (headOid !== undefined) pushLine(headOid, 'HEAD');
    else pushLine(ZERO_OID, 'capabilities^{}');
    for (const [name, oid] of refs) {
      pushLine(oid, name);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') {
        const target = parseTag(obj.data).object;
        lines.push(pktLine(`${target} ${name}^{}\n`));
      }
    }
  }
  lines.push(pktFlush());
  sendBytes(res, 200, Buffer.concat(lines), `application/x-${service}-advertisement`);
}

// ---------------------------------------------------------------- ls-refs

function handleLsRefs(forge: Forge, repo: RepoRec, items: PktItem[], res: ServerResponse): void {
  void forge;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const item of items) {
    if (item.kind !== 'data') continue;
    const line = item.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const head = headRef(repo);
  const headOid = repo.refs.get(head);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${head}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD symref-target:${head}\n`));
    } else {
      lines.push(pktLine(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${head}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(pktFlush());
  sendBytes(res, 200, Buffer.concat(lines), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- fetch planning

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
  commonHaves: string[];
}

function planFetch(forge: Forge, repo: RepoRec, args: FetchArgs): FetchPlan {
  const get = (oid: string) => repo.objects.get(oid);
  // A want may name a tag object (a clone wants every ref tip): the tag itself is
  // sent, and its history is planned from the commit it peels to.
  const extraObjects: GitObj[] = [];
  const wants: string[] = [];
  for (const oid of new Set(args.wants)) {
    const obj = get(oid);
    if (obj?.type === 'commit') wants.push(oid);
    else if (obj?.type === 'tag') {
      extraObjects.push(obj);
      const peeled = peelToCommit(get, oid);
      if (peeled !== null) wants.push(peeled);
    }
  }
  const clientShallow = new Set(args.clientShallow);

  // What the client already holds: the closure of its haves, not traversing the
  // parents of its shallow boundary (it does not have those).
  const heldCommits = new Set<string>();
  const heldObjects = new Set<string>();
  {
    const stack = [...args.haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (heldCommits.has(oid)) continue;
      const obj = get(oid);
      if (obj?.type !== 'commit') continue;
      heldCommits.add(oid);
      collectObjects(forge, repo, oid, heldObjects);
      if (clientShallow.has(oid)) continue;
      const info = forge.commitInfo(repo, oid);
      if (info !== null) stack.push(...info.parents);
    }
  }

  // Inclusion: distance from the wants, cut by depth / deepen-since / deepen-not.
  const notAncestors = new Set<string>();
  for (const not of args.deepenNot) {
    for (const oid of forge.ancestorDistances(repo, not).keys()) notAncestors.add(oid);
  }
  const included = new Map<string, number>();
  {
    let frontier = [...wants];
    let depth = 0;
    const seen = new Set<string>();
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        const info = forge.commitInfo(repo, oid);
        if (info === null) continue;
        let include = true;
        if (args.depth !== null && depth >= args.depth) include = false;
        if (include && args.deepenSince !== null) {
          const ts = parseIdentity(info.committer).timestamp;
          if (!(ts > args.deepenSince)) include = false;
        }
        if (include && notAncestors.has(oid)) include = false;
        if (!include) continue;
        included.set(oid, depth);
        next.push(...info.parents);
      }
      frontier = next;
      depth += 1;
    }
  }

  // The shallow boundary: included commits with a parent that exists but is not included.
  const boundary = new Set<string>();
  for (const oid of included.keys()) {
    const info = forge.commitInfo(repo, oid);
    if (info === null) continue;
    for (const parent of info.parents) {
      if (!included.has(parent) && get(parent)?.type === 'commit') boundary.add(oid);
    }
  }

  const sendObjects = new Set<string>();
  const objects: GitObj[] = [];
  const addObject = (oid: string) => {
    if (sendObjects.has(oid) || heldObjects.has(oid)) return;
    const obj = get(oid);
    if (obj === undefined) return;
    sendObjects.add(oid);
    objects.push(obj);
  };
  for (const oid of included.keys()) {
    if (heldCommits.has(oid)) continue;
    addObject(oid);
    const info = forge.commitInfo(repo, oid);
    if (info !== null) collectTreeObjects(forge, repo, info.tree, sendObjects, heldObjects, objects);
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  const shallowActive = args.depth !== null || args.deepenSince !== null || args.deepenNot.length > 0 || clientShallow.size > 0;
  if (shallowActive) {
    for (const oid of boundary) {
      if (!heldCommits.has(oid) || clientShallow.has(oid)) shallow.push(oid);
    }
    for (const oid of clientShallow) {
      if (included.has(oid) && !boundary.has(oid)) unshallow.push(oid);
    }
  }

  for (const obj of extraObjects) {
    const oid = args.wants.find((want) => get(want) === obj);
    if (oid !== undefined && !heldObjects.has(oid) && !sendObjects.has(oid)) {
      sendObjects.add(oid);
      objects.push(obj);
    }
  }

  const commonHaves = args.haves.filter((oid) => get(oid)?.type === 'commit');
  return { objects, shallow, unshallow, commonHaves };
}

/** Add a commit's tree closure (tree + subtrees + blobs) to `into`. */
function collectObjects(forge: Forge, repo: RepoRec, commitOid: string, into: Set<string>): void {
  const info = forge.commitInfo(repo, commitOid);
  if (info === null) return;
  into.add(commitOid);
  const walk = (treeOid: string) => {
    if (into.has(treeOid)) return;
    const obj = repo.objects.get(treeOid);
    if (obj?.type !== 'tree') return;
    into.add(treeOid);
    for (const entry of parseTreeEntries(repo, treeOid)) {
      if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid);
      else into.add(entry.oid);
    }
  };
  walk(info.tree);
}

function collectTreeObjects(
  forge: Forge,
  repo: RepoRec,
  treeOid: string,
  sendObjects: Set<string>,
  heldObjects: Set<string>,
  objects: GitObj[],
): void {
  const add = (oid: string) => {
    if (sendObjects.has(oid) || heldObjects.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    sendObjects.add(oid);
    objects.push(obj);
  };
  const walk = (oid: string) => {
    add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type !== 'tree') return;
    for (const entry of parseTreeEntries(repo, oid)) walk(entry.oid);
  };
  walk(treeOid);
}

function parseTreeEntries(repo: RepoRec, treeOid: string) {
  const obj = repo.objects.get(treeOid);
  if (obj?.type !== 'tree') return [];
  return parseTree(obj.data);
}

// ---------------------------------------------------------------- fetch handlers

function parseFetchArgs(items: PktItem[], v2: boolean): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const item of items) {
    if (item.kind !== 'data') continue;
    const line = item.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] ?? '';
      if (isOid(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) args.clientShallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) args.depth = Math.trunc(n);
    } else if (line.startsWith('deepen-since ')) {
      const n = Number(line.slice('deepen-since '.length).trim());
      if (Number.isFinite(n)) args.deepenSince = Math.trunc(n);
    } else if (line.startsWith('deepen-not ')) {
      const oid = line.slice('deepen-not '.length).trim();
      if (isOid(oid)) args.deepenNot.push(oid);
    }
  }
  void v2;
  return args;
}

function handleFetchV2(forge: Forge, repo: RepoRec, items: PktItem[], res: ServerResponse): void {
  const args = parseFetchArgs(items, true);
  const plan = planFetch(forge, repo, args);
  const parts: Buffer[] = [];
  let sections = 0;
  const beginSection = () => {
    if (sections > 0) parts.push(pktDelim());
    sections += 1;
  };
  if (args.haves.length > 0) {
    beginSection();
    parts.push(pktLine('acknowledgments\n'));
    if (plan.commonHaves.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const oid of plan.commonHaves) parts.push(pktLine(`ACK ${oid} common\n`));
      if (plan.objects.length > 0) parts.push(pktLine('ready\n'));
    }
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    beginSection();
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  if (plan.objects.length > 0) {
    beginSection();
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandWrap(writePack(plan.objects), 1));
  }
  parts.push(pktFlush());
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(forge: Forge, repo: RepoRec, items: PktItem[], res: ServerResponse): void {
  const args = parseFetchArgs(items, false);
  const plan = planFetch(forge, repo, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.commonHaves.length > 0) parts.push(pktLine(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`));
  else parts.push(pktLine('NAK\n'));
  if (plan.objects.length > 0) parts.push(sidebandWrap(writePack(plan.objects), 1));
  parts.push(pktFlush());
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleUploadPack(forge: Forge, repo: RepoRec, body: Buffer, res: ServerResponse): void {
  const items = decodeAll(body);
  const first = items.find((item) => item.kind === 'data');
  const firstLine = first?.payload.toString('utf8').replace(/\n$/, '') ?? '';
  if (firstLine === 'command=ls-refs') {
    handleLsRefs(forge, repo, items, res);
    return;
  }
  if (firstLine === 'command=fetch') {
    handleFetchV2(forge, repo, items, res);
    return;
  }
  if (firstLine.startsWith('want ') || firstLine === '') {
    handleFetchV0(forge, repo, items, res);
    return;
  }
  // An unrecognized command: answer a protocol error in-band, never crash.
  sendBytes(res, 200, pktFlush(), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(forge: Forge, repo: RepoRec, body: Buffer, res: ServerResponse): void {
  // Commands are pkt-lines up to the first flush; everything after is the pack.
  let offset = 0;
  const commandLines: string[] = [];
  let capabilities = '';
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    let line = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1).replace(/\n$/, '');
      line = line.slice(0, nul);
    }
    commandLines.push(line.replace(/\n$/, ''));
  }
  const pack = body.subarray(offset);

  const commands: PushCommand[] = [];
  for (const line of commandLines) {
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match) commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => repo.objects.get(oid));
      for (const obj of objects.values()) forge.putObject(repo, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} stale ref\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const obj = repo.objects.get(command.newOid);
    if (obj === undefined) {
      reportLines.push(`ng ${command.ref} invalid object\n`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (obj.type !== 'commit') {
        reportLines.push(`ng ${command.ref} invalid object\n`);
        continue;
      }
      if (current !== ZERO_OID && !forge.isAncestor(repo, current, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  const reportStream = Buffer.concat([...reportLines.map((line) => pktLine(line)), pktFlush()]);
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const payload = useSideband ? Buffer.concat([sidebandWrap(reportStream, 1), pktFlush()]) : reportStream;
  sendBytes(res, 200, payload, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------- entry point

export function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  owner: string,
  repoName: string,
  tail: string,
): boolean {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined || owner !== VIEWER.login) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (tail === 'info/refs' && (req.method ?? 'GET') === 'GET') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 400, 'Invalid service');
      return true;
    }
    const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack' && version2) advertisementV2(res);
    else advertisementV0(repo, service, res);
    return true;
  }
  if (tail === 'git-upload-pack' && (req.method ?? 'GET') === 'POST') {
    handleUploadPack(forge, repo, body, res);
    return true;
  }
  if (tail === 'git-receive-pack' && (req.method ?? 'GET') === 'POST') {
    handleReceivePack(forge, repo, body, res);
    return true;
  }
  sendError(res, 404, 'Not Found');
  return true;
}
