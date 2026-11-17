// lib/git.ts — git smart HTTP for the forge.
//
// Routes (all under /{owner}/{repo}.git):
//   GET  /info/refs?service=git-upload-pack   (protocol v2 when Git-Protocol: version=2, else v0)
//   GET  /info/refs?service=git-receive-pack  (v0 only)
//   POST /git-upload-pack                     (protocol v2 ls-refs / fetch; v0 fetch fallback)
//   POST /git-receive-pack                    (v0 push, report-status in side-band-64k)
//
// Implemented from scratch on the stdlib only (node:zlib, node:crypto). No git binary.
// Pushed objects are stored byte-exactly and returned verbatim, so commits round-trip.
// Packfiles we send are plain (undeltad) objects; packfiles we receive may carry
// OFS_DELTA / REF_DELTA (including thin packs whose base lives in the store).
// Deterministic: no Date.now / Math.random anywhere in this file.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';
import { Store, type GitObject, type ObjType, type Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);

const AGENT = 'makefun-git-forge/1.0';
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
/** Largest sideband payload per pkt-line: 65520 total - 4 header - 1 band byte. */
const SIDEBAND_CHUNK = 65515;

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const FLUSH_PKT = Buffer.from('0000', 'ascii');
const DELIM_PKT = Buffer.from('0001', 'ascii');
const HEX4 = /^[0-9a-fA-F]{4}$/;

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH_PKT);
    else if (item === 'delim') parts.push(DELIM_PKT);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines; throws on a malformed header or trailing bytes. */
function decodePackets(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
    } else if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
    } else if (len === 3 || len > 65520 || off + len > buf.length) {
      throw new Error('invalid pkt-line length');
    } else {
      packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return packets;
}

/** Decode pkt-lines up to and including the first flush; returns the offset just past it. */
function decodeUntilFlush(buf: Buffer): { packets: Packet[]; endOffset: number } {
  const packets: Packet[] = [];
  let off = 0;
  for (;;) {
    if (off + 4 > buf.length) throw new Error('pkt-line stream ends before flush');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      return { packets, endOffset: off + 4 };
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
    } else if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
    } else if (len === 3 || len > 65520 || off + len > buf.length) {
      throw new Error('invalid pkt-line length');
    } else {
      packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// object model
// ---------------------------------------------------------------------------------------------

function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

function parseCommit(data: Buffer): { tree: string; parents: string[] } {
  const blank = data.indexOf('\n\n');
  const head = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return { tree, parents };
}

function parseTag(data: Buffer): { object: string; type: string } {
  const blank = data.indexOf('\n\n');
  const head = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  let object = '';
  let type = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
  }
  return { object, type };
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(off, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

/** Follow annotated tags to their ultimate (non-tag) target; a missing object stops the walk. */
function peel(repo: Repo, oid: string): string {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag' || seen.has(cur)) return cur;
    seen.add(cur);
    cur = parseTag(obj.data).object;
  }
}

// ---------------------------------------------------------------------------------------------
// packfile write (plain objects, no deltas)
// ---------------------------------------------------------------------------------------------

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

interface PackEntry {
  oid: string;
  type: ObjType;
  data: Buffer;
}

function buildPack(entries: readonly PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  for (const entry of entries) {
    parts.push(packObjectHeader(TYPE_CODE[entry.type], entry.data.length));
    parts.push(deflateSync(entry.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// packfile read (OFS_DELTA / REF_DELTA, thin packs resolved against the store)
// ---------------------------------------------------------------------------------------------

function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buf.subarray(offset, end), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolved?: { type: ObjType; data: Buffer; oid: string };
}

function readPack(pack: Buffer, repo: Repo): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let off = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = off;
    if (off >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = pack[off];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    off += 1;
    while (byte & 0x80) {
      if (off >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = pack[off++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (off >= trailerStart) throw new Error('ofs-delta has no base offset');
      let b = pack[off];
      let value = b & 0x7f;
      off += 1;
      while (b & 0x80) {
        if (off >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        b = pack[off++];
        value = (value + 1) * 128 + (b & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (off + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, off, trailerStart);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      let baseEntry = resolvedByOid.get(wanted);
      if (!baseEntry) {
        // A REF_DELTA base may sit later in the pack; resolve entries in order until it appears.
        for (const candidate of raw) {
          if (candidate.resolved) continue;
          try {
            resolve(candidate);
          } catch {
            // Its own base may not be ready yet; the loop below reports the real failure.
          }
          baseEntry = resolvedByOid.get(wanted);
          if (baseEntry) break;
        }
      }
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = repo.objects.get(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    entry.resolved = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/** Add a tree and everything under it (blobs and subtrees; gitlinks skipped) to `out`. */
function addTreeObjects(repo: Repo, treeSha: string, out: Set<string>): void {
  const stack: string[] = [treeSha];
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type !== 'tree') continue;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '160000') continue;
      const child = repo.objects.get(entry.oid);
      if (!child) continue;
      if (child.type === 'tree') stack.push(entry.oid);
      else out.add(entry.oid);
    }
  }
}

/**
 * Full reachability from `roots`. When `stopExpand` names commits, those commits (and their
 * trees) are included but their parents are not walked — that is how a shallow client's
 * held set is modelled: it holds the boundary commit, not the history behind it.
 */
function walkFull(repo: Repo, roots: Iterable<string>, stopExpand?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      addTreeObjects(repo, commit.tree, out);
      if (!stopExpand?.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      addTreeObjects(repo, oid, out);
    }
  }
  return out;
}

/**
 * Depth-limited walk from `roots`: root commits are depth 1, their parents depth 2, and so on.
 * Returns the objects and, per depth, the commits at that depth (the depth-D set is the new
 * shallow boundary).
 */
function walkDepth(
  repo: Repo,
  roots: Iterable<string>,
  maxDepth: number,
): { objects: Set<string>; byDepth: Map<number, Set<string>> } {
  const objects = new Set<string>();
  const byDepth = new Map<number, Set<string>>();
  const queue: Array<[string, number]> = [];
  for (const root of roots) {
    const obj = repo.objects.get(root);
    if (!obj) continue;
    if (obj.type === 'tag') {
      objects.add(root);
      const target = peel(repo, root);
      const targetObj = repo.objects.get(target);
      if (!targetObj) continue;
      if (targetObj.type === 'commit') queue.push([target, 1]);
      else {
        objects.add(target);
        if (targetObj.type === 'tree') addTreeObjects(repo, target, objects);
      }
    } else if (obj.type === 'commit') {
      queue.push([root, 1]);
    } else {
      objects.add(root);
      if (obj.type === 'tree') addTreeObjects(repo, root, objects);
    }
  }
  const seenCommit = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const [oid, depth] = queue[head++]!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    objects.add(oid);
    let atDepth = byDepth.get(depth);
    if (!atDepth) {
      atDepth = new Set<string>();
      byDepth.set(depth, atDepth);
    }
    atDepth.add(oid);
    const commit = parseCommit(obj.data);
    addTreeObjects(repo, commit.tree, objects);
    if (depth < maxDepth) for (const parent of commit.parents) queue.push([parent, depth + 1]);
  }
  return { objects, byDepth };
}

function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  const wanted = peel(repo, ancestor);
  if (wanted === peel(repo, tip)) return true;
  const stack: string[] = [peel(repo, tip)];
  const seen = new Set<string>();
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === wanted) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// refs / advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.default_branch || 'main'}`;
}

/** The commit a tag ref peels to, or null when it does not peel to a commit. */
function peeledCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const peeled = peel(repo, oid);
  const target = repo.objects.get(peeled);
  return target?.type === 'commit' ? peeled : null;
}

function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'server-option\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const target = headTarget(repo);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k shallow thin-pack ofs-delta agent=${AGENT} symref=HEAD:${target} object-format=sha1`
      : `report-status side-band-64k delete-refs agent=${AGENT} symref=HEAD:${target} object-format=sha1`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(target) ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = peeledCommit(repo, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, options: LsRefsOptions): Buffer {
  const target = headTarget(repo);
  const keep = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headOid = repo.refs.get(target);
  if (keep('HEAD')) {
    const symref = options.symrefs ? ` symref-target:${target}` : '';
    lines.push(headOid ? `${headOid} HEAD${symref}\n` : `unborn HEAD${symref}\n`);
  }
  for (const name of sortedRefNames(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (options.peel) {
      const peeled = peeledCommit(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return pktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: fetch (v2 and v0 share the object selection)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function computeFetch(repo: Repo, args: FetchArgs): {
  entries: PackEntry[];
  shallowOut: string[];
  unshallowOut: string[];
} {
  const shallowSet = new Set(args.shallow);
  let wanted: Set<string>;
  let shallowOut: string[] = [];
  let unshallowOut: string[] = [];
  if (args.depth !== undefined) {
    const { objects, byDepth } = walkDepth(repo, args.wants, args.depth);
    wanted = objects;
    shallowOut = [...(byDepth.get(args.depth) ?? [])].sort();
    const interior = new Set<string>();
    for (const [depth, commits] of byDepth) {
      if (depth < args.depth) for (const oid of commits) interior.add(oid);
    }
    unshallowOut = args.shallow.filter((oid) => interior.has(oid));
  } else {
    wanted = walkFull(repo, args.wants, shallowSet.size ? shallowSet : undefined);
  }
  const held = args.haves.length
    ? walkFull(repo, args.haves, shallowSet.size ? shallowSet : undefined)
    : new Set<string>();
  const entries: PackEntry[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) entries.push({ oid, type: obj.type, data: obj.data });
  }
  entries.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  return { entries, shallowOut, unshallowOut };
}

/** Frame a packfile as sideband channel-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const { entries, shallowOut, unshallowOut } = computeFetch(repo, args);
  const pack = buildPack(entries);
  // Protocol v2: sections are separated by delim (0001); only the final section ends
  // with flush. The acknowledgments section is sent only when the client sent `have`
  // lines (a fresh clone sends none, and real git rejects an unexpected section there).
  const parts: Buffer[] = [];
  if (args.haves.length) {
    const acked = args.haves.filter((have) => args.wants.some((want) => isAncestor(repo, have, want)));
    parts.push(pktLine('acknowledgments\n'));
    if (acked.length) {
      for (const oid of acked) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(DELIM_PKT);
  }
  if (shallowOut.length || unshallowOut.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM_PKT);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const { entries, shallowOut, unshallowOut } = computeFetch(repo, args);
  const pack = buildPack(entries);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const packets = decodePackets(body);
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind === 'flush' || packet.kind === 'response-end') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).trim();
    } else {
      args.push(line);
    }
  }
  if (command === 'ls-refs') {
    const options: LsRefsOptions = { peel: false, symrefs: false, prefixes: [] };
    for (const raw of args) {
      const line = raw.trim();
      if (line === 'peel') options.peel = true;
      else if (line === 'symrefs') options.symrefs = true;
      else if (line.startsWith('ref-prefix ')) options.prefixes.push(line.slice('ref-prefix '.length));
    }
    return lsRefsResponse(repo, options);
  }
  if (command === 'fetch') {
    const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [] };
    for (const raw of args) {
      const line = raw.trim();
      if (line.startsWith('want ')) fetchArgs.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) fetchArgs.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) fetchArgs.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const depth = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(depth) && depth >= 0) fetchArgs.depth = depth;
      }
    }
    return fetchV2Response(repo, fetchArgs);
  }
  throw new Error(`unknown upload-pack command ${JSON.stringify(command)}`);
}

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const packets = decodePackets(body);
  const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const packet of packets) {
    if (packet.kind === 'flush' || packet.kind === 'delim' || packet.kind === 'response-end') continue;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    const tokens = line.split(' ');
    if (tokens[0] === 'want' && tokens[1]) fetchArgs.wants.push(tokens[1]);
    else if (tokens[0] === 'have' && tokens[1]) fetchArgs.haves.push(tokens[1]);
    else if (tokens[0] === 'shallow' && tokens[1]) fetchArgs.shallow.push(tokens[1]);
    else if (tokens[0] === 'deepen' && tokens[1]) {
      const depth = Number.parseInt(tokens[1], 10);
      if (Number.isFinite(depth) && depth >= 0) fetchArgs.depth = depth;
    }
  }
  return fetchV0Response(repo, fetchArgs);
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, endOffset } = decodeUntilFlush(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.trim();
    if (!line) continue;
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error('malformed receive-pack command');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new Error('receive-pack sent no commands');

  const packBytes = body.subarray(endOffset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  let unpacked: Map<string, GitObject> | null = null;
  if (packBytes.length > 0) {
    try {
      unpacked = readPack(packBytes, repo);
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message.replace(/\s+/g, ' ').trim() || 'unpack failed';
    }
  }
  if (unpackOk && unpacked) {
    for (const [oid, obj] of unpacked) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }

  const report: string[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      report.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) report.push(`ng ${command.ref} ref does not exist`);
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} object not found`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) report.push(`ng ${command.ref} already exists`);
      else {
        repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}`);
      }
      continue;
    }
    // Update.
    if (current === undefined) {
      report.push(`ng ${command.ref} ref does not exist`);
    } else if (current !== command.oldOid) {
      report.push(`ng ${command.ref} non-fast-forward`);
    } else if (command.oldOid === command.newOid) {
      report.push(`ok ${command.ref}`);
    } else if (command.ref.startsWith('refs/tags/')) {
      report.push(`ng ${command.ref} already exists`);
    } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward`);
    } else {
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}`);
    }
  }

  // report-status, pkt-lined inside sideband channel 1.
  const inner = pktLines([`unpack ${unpackOk ? 'ok' : unpackDetail}\n`, ...report.map((line) => `${line}\n`), 'flush']);
  const outer: Buffer[] = [];
  for (let off = 0; off < inner.length; off += SIDEBAND_CHUNK) {
    const chunk = inner.subarray(off, Math.min(inner.length, off + SIDEBAND_CHUNK));
    outer.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  outer.push(FLUSH_PKT);
  return Buffer.concat(outer);
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing / entry point
// ---------------------------------------------------------------------------------------------

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendBuffer(res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), 'application/json; charset=utf-8');
}

function sendText(res: ServerResponse, status: number, text: string): void {
  sendBuffer(res, status, Buffer.from(text, 'utf8'), 'text/plain; charset=utf-8');
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isVersion2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  const value = Array.isArray(header) ? header[0] : header;
  return (value ?? '').trim().toLowerCase() === 'version=2';
}

/**
 * Handle one git smart-HTTP request. Returns true when the path is a git route and the
 * request was answered (including error answers); false when the path is not a git route
 * and another handler should answer it.
 */
export async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<boolean> {
  let pathname: string;
  let service: string | null;
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    service = url.searchParams.get('service');
  } catch {
    return false;
  }
  const match = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!match) return false;
  const owner = decodeSegment(match[1]);
  const repoName = decodeSegment(match[2]);
  const route = match[3];
  const method = req.method ?? 'GET';
  const isInfo = route === 'info/refs';
  if ((isInfo && method !== 'GET') || (!isInfo && method !== 'POST')) return false;

  try {
    // Auth: the suite sends Bearer <MAKEFUN_SHOP_TOKEN> on git requests. A request
    // without the token (when one is configured) is 401; a present token that does
    // not match is 401 too. With no token configured (local practice) allow all.
    const expectedToken = process.env.MAKEFUN_SHOP_TOKEN;
    if (expectedToken) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${expectedToken}`) {
        sendJson(res, 401, { message: 'Unauthorized' });
        return true;
      }
    }
    if (owner !== store.viewerLogin) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    if (isInfo) {
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (service === 'git-upload-pack' && isVersion2(req)) {
        sendBuffer(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendBuffer(res, 200, v0Advertisement(repo, service), `application/x-${service}-advertisement`);
      }
      return true;
    }

    if (route === 'git-upload-pack') {
      let out: Buffer;
      try {
        out = isVersion2(req) ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
      } catch {
        sendText(res, 400, 'Bad Request');
        return true;
      }
      sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
      return true;
    }

    // git-receive-pack (v0 only).
    let out: Buffer;
    try {
      out = handleReceivePack(repo, body);
    } catch {
      sendText(res, 400, 'Bad Request');
      return true;
    }
    sendBuffer(res, 200, out, 'application/x-git-receive-pack-result');
    return true;
  } catch {
    if (!res.headersSent && !res.writableEnded) sendJson(res, 500, { message: 'Internal Server Error' });
    return true;
  }
}
