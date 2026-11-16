// Git object primitives for the forge: SHA-1 object ids, commit/tree/tag parsing and
// building, packfile reading (with OFS/REF delta resolution and thin-pack bases) and
// writing, and the pkt-line codec of the smart-HTTP protocol. Pure node:crypto and
// node:zlib: no git binary, no dependencies, no I/O.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The git object id: SHA-1 over "<type> <size>\0" followed by the raw bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. Header continuation lines (gpgsig) are folded away. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  let lastKey = '';
  for (const line of head.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation of the previous header
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    lastKey = key;
    if (key === 'tree') tree = value.trim();
    else if (key === 'parent') parents.push(value.trim());
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    void lastKey;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const parent of info.parents) head += `parent ${parent}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n\n`;
  return Buffer.from(head + info.message, 'utf8');
}

/** The unix timestamp inside an author/committer line ("Name <mail> 1700000000 +0000"), or 0. */
export function identityTimestamp(line: string): number {
  const match = /> (\d+) [+-]\d{4}$/.exec(line.trim());
  return match ? Number(match[1]) : 0;
}

/** Split an identity line into name/email/timestamp for REST commit objects. */
export function parseIdentity(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (!match) return { name: line.trim(), email: '', timestamp: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', timestamp: Number(match[3]) };
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string; // as stored: '40000' for a directory, '100644', '100755', '120000', '160000'
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: bytewise by name, directories compared as if suffixed with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

// ------------------------------------------------------------------ tags

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

/** Follow tag objects to the commit they name (one or more hops); null when it never lands. */
export function peelToCommit(
  get: (oid: string) => GitObj | undefined,
  oid: string,
  depth = 0,
): string | null {
  if (depth > 10) return null;
  const obj = get(oid);
  if (obj === undefined) return null;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') return peelToCommit(get, parseTag(obj.data).object, depth + 1);
  return null;
}

// ------------------------------------------------------------------ packs

/** Serialize objects into a complete packfile (no deltas: every object stored whole). */
export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(encodePackObjectHeader(TYPE_CODES[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function encodePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

interface PackEntry {
  type: ObjType;
  data: Buffer;
}

/** Apply a git delta (the format shared by OFS_DELTA and REF_DELTA payloads) to a base. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      value |= (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} vs ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= (delta[offset] ?? 0) * 2 ** (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= (delta[offset] ?? 0) * 2 ** (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

/**
 * Read a packfile into fully resolved objects. Delta bases may come from the pack itself
 * or, for thin packs, from `resolveExternal` (an object the receiving side already holds).
 * Returns a map of every resolved object by id, including external bases that were used.
 */
export function readPack(
  pack: Buffer,
  resolveExternal?: (oid: string) => GitObj | undefined,
): Map<string, GitObj> {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    kind: 'whole' | 'ofs' | 'ref';
    type: ObjType;
    data: Buffer; // whole: the object bytes; delta kinds: the delta payload
    baseOffset: number; // ofs: absolute offset of the base entry
    baseOid: string; // ref: the base object's id
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] ?? 0;
      offset += 1;
      size |= (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    void size;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base entry, in git's offset encoding.
      let back = pack[offset] ?? 0;
      offset += 1;
      let baseBack = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset] ?? 0;
        offset += 1;
        baseBack = ((baseBack + 1) << 7) | (back & 0x7f);
      }
      const inflated = inflateSync(pack.subarray(offset));
      offset += compressedLength(pack, offset, inflated.length);
      raw.push({ offset: start, kind: 'ofs', type: 'blob', data: inflated, baseOffset: start - baseBack, baseOid: '' });
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateSync(pack.subarray(offset));
      offset += compressedLength(pack, offset, inflated.length);
      raw.push({ offset: start, kind: 'ref', type: 'blob', data: inflated, baseOffset: 0, baseOid });
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateSync(pack.subarray(offset));
      offset += compressedLength(pack, offset, inflated.length);
      raw.push({ offset: start, kind: 'whole', type, data: inflated, baseOffset: 0, baseOid: '' });
    }
    byOffset.set(start, raw.length - 1);
  }

  const resolved = new Map<string, GitObj>();
  const resolvedByIndex = new Map<number, GitObj>();
  const resolveIndex = (index: number, guard: Set<number>): GitObj => {
    const cached = resolvedByIndex.get(index);
    if (cached !== undefined) return cached;
    if (guard.has(index)) throw new Error('delta cycle in pack');
    guard.add(index);
    const entry = raw[index];
    if (entry === undefined) throw new Error('pack entry index out of range');
    let obj: GitObj;
    if (entry.kind === 'whole') {
      obj = { type: entry.type, data: entry.data };
    } else {
      let base: GitObj;
      if (entry.kind === 'ofs') {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
        base = resolveIndex(baseIndex, guard);
      } else {
        const inPack = [...raw.entries()].find(
          ([, candidate]) => candidate.kind === 'whole' && hashObject(candidate.type, candidate.data) === entry.baseOid,
        );
        if (inPack !== undefined) base = resolveIndex(inPack[0], guard);
        else {
          const external = resolveExternal?.(entry.baseOid);
          if (external === undefined) throw new Error(`ref-delta base ${entry.baseOid} not available`);
          base = external;
          resolved.set(entry.baseOid, base);
        }
      }
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolvedByIndex.set(index, obj);
    resolved.set(hashObject(obj.type, obj.data), obj);
    return obj;
  };
  for (let index = 0; index < raw.length; index += 1) resolveIndex(index, new Set());
  return resolved;
}

/** How many compressed bytes the zlib stream starting at `offset` occupies. */
function compressedLength(pack: Buffer, offset: number, inflatedLength: number): number {
  // Inflate a growing window until the stream completes; packs here are small enough
  // that a binary search over the end is cheap and exact.
  let lo = 1;
  let hi = pack.length - offset;
  // First confirm the full remainder inflates (it must: the pack parsed its trailer).
  inflateSync(pack.subarray(offset));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const out = inflateSync(pack.subarray(offset, offset + mid));
      if (out.length === inflatedLength) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

// ------------------------------------------------------------------ pkt-lines

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

const PKT_MAX = 65520;

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new Error('pkt-line too long');
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Frame a byte stream as sideband pkt-lines (the band byte counts toward the 65516 payload cap). */
export function sidebandWrap(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = PKT_MAX - 4 - 1;
  if (data.length === 0) return Buffer.alloc(0);
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, offset + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

/**
 * Decode pkt-lines from the front of `buffer`. Returns the packets and how many bytes
 * they consumed; stops cleanly at the first incomplete packet (callers that hold the
 * whole request body treat a short tail as an error where the protocol demands one).
 */
export function decodePktLines(buffer: Buffer, start = 0): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const headerText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) break;
    const length = parseInt(headerText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset - start };
}
