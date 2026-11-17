// The shared in-memory store for the forge: repositories, git objects, issues,
// pull requests and labels. Everything lives in Maps; nothing touches the disk,
// the clock or the network, so a replay of the same requests is byte-identical.
//
// Deterministic time: `nowIso()` ticks a fixed clock (2025-01-01T00:00:00Z + 1s
// per call) instead of reading the wall clock. Commit epochs come from the same
// clock. The viewer is fixed: the scenario's bearer token always names
// login "adaiversen", id 1000; the stranger is "olgabauer".

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  /** Raw content WITHOUT the "<type> <len>\0" header. */
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  created_at: string;
  updated_at: string;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  user: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  /** Full ref name ("refs/heads/main") -> commit sha. */
  refs: Map<string, string>;
  /** Object sha -> object. */
  objects: Map<string, GitObject>;
  /** Label name -> label. */
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
}

/** A parsed git commit object (header lines + message). */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
  committerName: string;
  committerEmail: string;
  committerEpoch: number;
  message: string;
}

const IDENTITY = 'adaiversen <adaiversen@example.invalid>';

/** Parse a raw commit object into its header fields and message. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const rawMessage = blank === -1 ? '' : text.slice(blank + 2);
  const out: ParsedCommit = {
    tree: '',
    parents: [],
    authorName: 'adaiversen',
    authorEmail: 'adaiversen@example.invalid',
    authorEpoch: 1735689600,
    committerName: 'adaiversen',
    committerEmail: 'adaiversen@example.invalid',
    committerEpoch: 1735689600,
    message: rawMessage.endsWith('\n') ? rawMessage.slice(0, -1) : rawMessage,
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ') || line.startsWith('committer ')) {
      const who = line.startsWith('author ') ? 'author' : 'committer';
      const rest = line.slice(who.length + 1);
      const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(rest);
      if (match !== null) {
        const name = match[1] ?? '';
        const email = match[2] ?? '';
        const epoch = Number(match[3] ?? 0);
        if (who === 'author') {
          out.authorName = name;
          out.authorEmail = email;
          out.authorEpoch = epoch;
        } else {
          out.committerName = name;
          out.committerEmail = email;
          out.committerEpoch = epoch;
        }
      }
    }
  }
  return out;
}

export class Store {
  /** THE authenticated user: the scenario's viewer, always. */
  readonly viewerLogin = 'adaiversen';
  readonly viewerId = 1000;

  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextGlobalId = 100000;
  nextCommentId = 200000;
  nextLabelId = 300000;

  /** 2025-01-01T00:00:00Z; deterministic timestamps (NEVER Date.now). */
  private clock = 1735689600;

  nowIso(): string {
    this.clock += 1;
    return new Date(this.clock * 1000).toISOString();
  }

  static objectSha(type: ObjType, data: Buffer): string {
    const h = createHash('sha1');
    h.update(`${type} ${data.length}\0`);
    h.update(data);
    return h.digest('hex');
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const sha = Store.objectSha(type, data);
    repo.objects.set(sha, { type, data });
    return sha;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(
    owner: string,
    name: string,
    opts: { description?: string; private?: boolean; default_branch?: string } = {},
  ): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: opts.default_branch ?? 'main',
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
      refs: new Map<string, string>(),
      objects: new Map<string, GitObject>(),
      labels: new Map<string, Label>(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /**
   * Build a nested tree object from flat path entries (mode '100644' for files,
   * '40000' for directories) and store it; return the tree sha. Tree entries are
   * `<mode> <name>\0<20-byte sha>`, sorted by name with directories sorting as
   * if their name ended with '/'.
   */
  buildTree(repo: Repo, entries: { path: string; mode: string; sha: string }[]): string {
    const buildLevel = (items: { path: string; mode: string; sha: string }[]): string => {
      const files: { mode: string; name: string; sha: string }[] = [];
      const dirs = new Map<string, { path: string; mode: string; sha: string }[]>();
      for (const item of items) {
        const slash = item.path.indexOf('/');
        if (slash === -1) {
          files.push({ mode: item.mode, name: item.path, sha: item.sha });
        } else {
          const dir = item.path.slice(0, slash);
          const rest = item.path.slice(slash + 1);
          const bucket = dirs.get(dir);
          if (bucket === undefined) dirs.set(dir, [{ path: rest, mode: item.mode, sha: item.sha }]);
          else bucket.push({ path: rest, mode: item.mode, sha: item.sha });
        }
      }
      const all: { mode: string; name: string; sha: string; sortKey: string }[] = files.map((f) => ({
        ...f,
        sortKey: f.name,
      }));
      for (const [dir, sub] of dirs) {
        all.push({ mode: '40000', name: dir, sha: buildLevel(sub), sortKey: `${dir}/` });
      }
      all.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
      const parts: Buffer[] = [];
      for (const entry of all) {
        parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'ascii'));
        parts.push(Buffer.from(entry.sha, 'hex'));
      }
      return this.putObject(repo, 'tree', Buffer.concat(parts));
    };
    return buildLevel(entries);
  }

  /**
   * Build a commit object (`tree`, `parent`s, author/committer lines, message)
   * and store it; return the commit sha. The author/committer identity is the
   * viewer and the epoch comes from the store clock, never the wall clock.
   */
  buildCommit(repo: Repo, treeSha: string, parents: string[], message: string, author: string = IDENTITY): string {
    const epoch = this.clock;
    let text = `tree ${treeSha}\n`;
    for (const parent of parents) text += `parent ${parent}\n`;
    text += `author ${author} ${epoch} +0000\n`;
    text += `committer ${author} ${epoch} +0000\n`;
    text += `\n${message}\n`;
    return this.putObject(repo, 'commit', Buffer.from(text, 'utf8'));
  }

  /** Flatten a tree object to full paths (recursive). Missing tree -> empty map. */
  readTree(repo: Repo, treeSha: string): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    const walk = (sha: string, prefix: string): void => {
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'tree') return;
      const data = obj.data;
      let i = 0;
      while (i < data.length) {
        const space = data.indexOf(0x20, i);
        if (space === -1) break;
        const nul = data.indexOf(0x00, space);
        if (nul === -1 || nul + 21 > data.length) break;
        const mode = data.subarray(i, space).toString('ascii');
        const name = data.subarray(space + 1, nul).toString('utf8');
        const shaHex = data.subarray(nul + 1, nul + 21).toString('hex');
        i = nul + 21;
        if (mode === '40000') walk(shaHex, `${prefix}${name}/`);
        else out.set(`${prefix}${name}`, { mode, sha: shaHex });
      }
    };
    walk(treeSha, '');
    return out;
  }

  /**
   * Three-way merge at the file level. A file changed on only one side wins;
   * changed identically on both wins; changed differently on both (or
   * deleted-vs-modified) is a conflict. Returns the merged tree sha (built
   * from the winning entries) and whether any path conflicted.
   */
  mergeTrees(
    repo: Repo,
    baseTreeSha: string,
    headTreeSha: string,
    ancestorTreeSha: string | null,
  ): { treeSha: string; conflict: boolean } {
    const base = this.readTree(repo, baseTreeSha);
    const head = this.readTree(repo, headTreeSha);
    const ancestor = ancestorTreeSha === null ? new Map<string, { mode: string; sha: string }>() : this.readTree(repo, ancestorTreeSha);
    const merged = new Map<string, { mode: string; sha: string }>();
    let conflict = false;
    const paths = new Set<string>([...base.keys(), ...head.keys(), ...ancestor.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const a = ancestor.get(path);
      const shaOf = (entry: { sha: string } | undefined): string | null => (entry === undefined ? null : entry.sha);
      if (shaOf(h) === shaOf(a)) {
        if (b !== undefined) merged.set(path, b);
      } else if (shaOf(b) === shaOf(a)) {
        if (h !== undefined) merged.set(path, h);
      } else if (shaOf(b) === shaOf(h)) {
        if (b !== undefined) merged.set(path, b);
      } else {
        conflict = true;
        if (b !== undefined) merged.set(path, b);
      }
    }
    const entries = [...merged.entries()].map(([path, value]) => ({ path, mode: value.mode, sha: value.sha }));
    return { treeSha: this.buildTree(repo, entries), conflict };
  }
}
