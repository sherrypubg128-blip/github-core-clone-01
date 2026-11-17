// GraphQL v4 surface for the github-core-clone-01 forge.
//
// Hand-written executor (stdlib only, no GraphQL library): a small lexer/parser
// for the documents gh / github-mcp-server send, a validation pass against a
// static field-type table, and resolvers over the shared Store. All state lives
// in the Store, so REST, git, GraphQL and MCP see the same objects.
//
// Paths: POST /api/graphql only. Auth: Bearer MAKEFUN_SHOP_TOKEN; missing or
// wrong token is exactly 401 JSON. Malformed JSON body is 400. A document
// naming an unknown field is HTTP 200 with an errors array naming it. An
// unknown repository is data.repository = null with no errors. A JSON array
// body is operation batching: one result per operation, in order.
//
// Determinism: no Date.now / Math.random anywhere; timestamps come from
// store.nowIso(), global ids are base64("<Type>:<numeric id>").

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, type Issue, type IssueComment, type PullRequest, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// HTTP + auth helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function expectedToken(): string | null {
  const t = process.env.MAKEFUN_SHOP_TOKEN;
  return t !== undefined && t !== '' ? t : null;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  const expected = expectedToken();
  if (expected !== null) return header === `Bearer ${expected}`;
  return header.startsWith('Bearer ') && header.length > 7;
}

// ---------------------------------------------------------------------------
// Global ids + store helpers
// ---------------------------------------------------------------------------

function gid(type: string, id: number | string): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

interface DecodedId {
  type: string;
  id: string;
}

function decodeGid(value: unknown): DecodedId | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const idx = text.indexOf(':');
    if (idx <= 0) return null;
    return { type: text.slice(0, idx), id: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

/** The ref key for a branch, trying the store's `refs/heads/<branch>` form first. */
function refKey(repo: Repo, branch: string): string | null {
  const full = `refs/heads/${branch}`;
  if (repo.refs.has(full)) return full;
  if (repo.refs.has(branch)) return branch;
  for (const key of repo.refs.keys()) {
    if (key.endsWith(`/${branch}`)) return key;
  }
  return null;
}

function resolveRef(repo: Repo, branch: string): string | null {
  const key = refKey(repo, branch);
  return key === null ? null : (repo.refs.get(key) ?? null);
}

function setRef(repo: Repo, branch: string, sha: string): void {
  const key = refKey(repo, branch) ?? `refs/heads/${branch}`;
  repo.refs.set(key, sha);
}

interface CommitInfo {
  tree: string;
  parents: string[];
}

function parseCommit(repo: Repo, sha: string | null): CommitInfo | null {
  if (sha === null || sha === '') return null;
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  if (tree === '') return null;
  return { tree, parents };
}

function commitTreeSha(repo: Repo, sha: string | null): string | null {
  return parseCommit(repo, sha)?.tree ?? null;
}

/** Nearest common ancestor commit of a and b (BFS over parents), or null. */
function mergeBase(repo: Repo, a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  const ancestorsA = new Set<string>();
  const queueA: string[] = [a];
  while (queueA.length > 0) {
    const sha = queueA.shift() as string;
    if (ancestorsA.has(sha)) continue;
    ancestorsA.add(sha);
    const info = parseCommit(repo, sha);
    if (info !== null) queueA.push(...info.parents);
  }
  const queueB: string[] = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const sha = queueB.shift() as string;
    if (seenB.has(sha)) continue;
    seenB.add(sha);
    if (ancestorsA.has(sha)) return sha;
    const info = parseCommit(repo, sha);
    if (info !== null) queueB.push(...info.parents);
  }
  return null;
}

/** MERGEABLE / CONFLICTING / UNKNOWN for a pull request, from a 3-way tree merge. */
function mergeableState(store: Store, repo: Repo, pr: PullRequest): string {
  try {
    const baseTree = commitTreeSha(repo, pr.baseSha);
    const headTree = commitTreeSha(repo, pr.headSha);
    if (baseTree === null || headTree === null) return 'UNKNOWN';
    const ancestor = mergeBase(repo, pr.baseSha, pr.headSha);
    const ancestorTree = ancestor === null ? null : commitTreeSha(repo, ancestor);
    const merged = store.mergeTrees(repo, baseTree, headTree, ancestorTree);
    return merged.conflict ? 'CONFLICTING' : 'MERGEABLE';
  } catch {
    return 'UNKNOWN';
  }
}

interface DiffLine {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function blobLines(repo: Repo, sha: string | null): string[] {
  if (sha === null) return [];
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'blob') return [];
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Small LCS line diff counts (files in the fixtures are tiny). */
function lineDiff(oldLines: string[], newLines: string[]): { additions: number; deletions: number } {
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lcs = dp[0]![0]!;
  return { additions: m - lcs, deletions: n - lcs };
}

/** Changed files of a PR: head tree vs base tree. */
function prFiles(store: Store, repo: Repo, pr: PullRequest): DiffLine[] {
  const baseTree = commitTreeSha(repo, pr.baseSha);
  const headTree = commitTreeSha(repo, pr.headSha);
  const baseMap = baseTree === null ? new Map() : store.readTree(repo, baseTree);
  const headMap = headTree === null ? new Map() : store.readTree(repo, headTree);
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  const out: DiffLine[] = [];
  for (const path of [...paths].sort()) {
    const base = baseMap.get(path);
    const head = headMap.get(path);
    if (head !== undefined && base === undefined) {
      const lines = blobLines(repo, head.sha);
      out.push({ path, status: 'added', additions: lines.length, deletions: 0, changes: lines.length });
    } else if (head === undefined && base !== undefined) {
      const lines = blobLines(repo, base.sha);
      out.push({ path, status: 'removed', additions: 0, deletions: lines.length, changes: lines.length });
    } else if (head !== undefined && base !== undefined && head.sha !== base.sha) {
      const diff = lineDiff(blobLines(repo, base.sha), blobLines(repo, head.sha));
      out.push({ path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store mutations shared with the REST view (same objects, same counters)
// ---------------------------------------------------------------------------

function findRepoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

function findIssueById(store: Store, id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of store.repos.values()) {
    const issue = repo.issues.find((entry) => entry.id === id);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function findPullById(store: Store, id: number): { repo: Repo; pr: PullRequest } | null {
  for (const repo of store.repos.values()) {
    const pr = repo.pulls.find((entry) => entry.id === id);
    if (pr !== undefined) return { repo, pr };
  }
  return null;
}

function createIssueInStore(store: Store, repo: Repo, title: string, body: string): Issue {
  const now = store.nowIso();
  const issue: Issue = {
    id: store.nextGlobalId++,
    number: repo.nextIssue++,
    title,
    body: body ?? '',
    state: 'open',
    labels: [],
    user: store.viewerLogin,
    created_at: now,
    updated_at: now,
    comments: [],
  };
  repo.issues.push(issue);
  repo.updated_at = now;
  return issue;
}

function createPullInStore(
  store: Store,
  repo: Repo,
  baseRefName: string,
  headRefName: string,
  title: string,
  body: string,
): PullRequest {
  const now = store.nowIso();
  const pr: PullRequest = {
    id: store.nextGlobalId++,
    number: repo.nextPull++,
    title,
    body: body ?? '',
    state: 'open',
    merged: false,
    mergeable: true,
    headRef: headRefName,
    baseRef: baseRefName,
    headSha: resolveRef(repo, headRefName) ?? '',
    baseSha: resolveRef(repo, baseRefName) ?? '',
    user: store.viewerLogin,
    created_at: now,
    updated_at: now,
    merged_at: null,
    merge_commit_sha: null,
  };
  try {
    pr.mergeable = mergeableState(store, repo, pr) !== 'CONFLICTING';
  } catch {
    pr.mergeable = true;
  }
  repo.pulls.push(pr);
  repo.updated_at = now;
  return pr;
}

/** Squash-merge a PR exactly like REST PUT /pulls/{n}/merge (merge_method=squash). */
function squashMerge(store: Store, repo: Repo, pr: PullRequest): { ok: true; sha: string } | { ok: false; reason: string } {
  if (pr.merged) return { ok: true, sha: pr.merge_commit_sha ?? '' };
  // REST reads the live base tip (the ref may have moved since the PR opened).
  const baseSha = resolveRef(repo, pr.baseRef) ?? (pr.baseSha !== '' ? pr.baseSha : null);
  const headSha = pr.headSha !== '' ? pr.headSha : resolveRef(repo, pr.headRef);
  if (baseSha === null || baseSha === '' || headSha === null || headSha === '') {
    return { ok: false, reason: 'cannot merge: the base or head branch has no commit' };
  }
  const baseTree = commitTreeSha(repo, baseSha);
  const headTree = commitTreeSha(repo, headSha);
  if (baseTree === null || headTree === null) return { ok: false, reason: 'cannot merge: the base or head commit is missing' };
  const ancestor = mergeBase(repo, headSha, baseSha);
  const ancestorTree = ancestor === null ? null : commitTreeSha(repo, ancestor);
  let merged;
  try {
    merged = store.mergeTrees(repo, baseTree, headTree, ancestorTree);
  } catch (err) {
    return { ok: false, reason: `cannot merge: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (merged.conflict) {
    pr.mergeable = false;
    return { ok: false, reason: 'Merge conflict' };
  }
  const now = store.nowIso();
  const message = `Merge pull request #${pr.number} from ${store.viewerLogin}/${pr.headRef}\n\n${pr.title}`;
  const mergeSha = store.buildCommit(repo, merged.treeSha, [baseSha], message, `${store.viewerLogin} <${store.viewerLogin}@example.invalid>`);
  setRef(repo, pr.baseRef, mergeSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = now;
  pr.merge_commit_sha = mergeSha;
  pr.updated_at = now;
  repo.updated_at = now;
  return { ok: true, sha: mergeSha };
}

// ---------------------------------------------------------------------------
// Static schema: field -> result type (drives validation + execution), and
// the introspection tables __type/__schema answer from.
// ---------------------------------------------------------------------------

type FieldMap = Record<string, string>;

const FIELD_TYPES: Record<string, FieldMap> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', description: 'String',
    private: 'Boolean', isPrivate: 'Boolean', url: 'String', resourcePath: 'String',
    owner: 'User', defaultBranchRef: 'Ref', defaultBranch: 'Ref',
    viewerPermission: 'String', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
    createdAt: 'String', updatedAt: 'String',
  },
  Issue: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'String',
    createdAt: 'String', updatedAt: 'String', author: 'User', labels: 'LabelConnection',
    comments: 'IssueCommentConnection', url: 'String', resourcePath: 'String',
    closed: 'Boolean', repository: 'Repository',
  },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'String',
    merged: 'Boolean', mergeable: 'String', headRefName: 'String', baseRefName: 'String',
    headRef: 'Ref', baseRef: 'Ref', files: 'PullRequestChangedFileConnection',
    author: 'User', createdAt: 'String', updatedAt: 'String', mergedAt: 'String',
    url: 'String', resourcePath: 'String', repository: 'Repository',
    additions: 'Int', deletions: 'Int', changedFiles: 'Int',
  },
  User: { id: 'ID', login: 'String', name: 'String', databaseId: 'Int', url: 'String' },
  Ref: { id: 'ID', name: 'String' },
  Node: { id: 'ID' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile', cursor: 'String' },
  PullRequestChangedFile: { path: 'String', filename: 'String', status: 'String', additions: 'Int', deletions: 'Int', changes: 'Int' },
  LabelConnection: { nodes: 'Label', edges: 'LabelEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  LabelEdge: { node: 'Label', cursor: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'String', updatedAt: 'String', url: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', comment: 'IssueComment', clientMutationId: 'String' },
  __Type: { name: 'String', kind: 'String', description: 'String', fields: '__Field', enumValues: '__EnumValue', possibleTypes: '__Type', inputFields: '__InputValue' },
  __Field: { name: 'String', description: 'String', type: '__Type', args: '__InputValue', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __EnumValue: { name: 'String', description: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', types: '__Type', directives: '__Directive' },
  __InputValue: { name: 'String', description: 'String', type: '__Type', defaultValue: 'String' },
  __Directive: { name: 'String', description: 'String', locations: 'String', args: '__InputValue' },
};

const SCALARS = new Set(['String', 'Int', 'ID', 'Boolean', 'Float']);

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'isPrivate', 'url', 'resourcePath', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'resourcePath', 'closed', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'url', 'resourcePath', 'repository', 'additions', 'deletions', 'changedFiles'],
  User: ['id', 'login', 'name', 'databaseId', 'url'],
  Ref: ['id', 'name'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Label: ['id', 'name', 'color', 'description'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'status', 'additions', 'deletions', 'changes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function schemaKind(name: string): string {
  if (INTROSPECTION_ENUMS[name] !== undefined) return 'ENUM';
  if (name === 'Node') return 'INTERFACE';
  if (FIELD_TYPES[name] !== undefined) return 'OBJECT';
  return 'SCALAR';
}

// ---------------------------------------------------------------------------
// Lexer / parser for the GraphQL documents the clients send
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc ?? '';
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface DirectiveNode {
  name: string;
  args: Record<string, ValueNode>;
}

interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  directives: DirectiveNode[];
  selection: Selection[] | null;
}

interface InlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selection: Selection[];
}

interface Spread {
  kind: 'spread';
  name: string;
  directives: DirectiveNode[];
}

type Selection = FieldSelection | InlineFragment | Spread;

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Record<string, ValueNode | null>;
  selection: Selection[];
}

interface FragmentDef {
  typeCondition: string;
  selection: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected "${value}" in GraphQL document, got ${token.value}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name in GraphQL document, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`Expected "${value}" in GraphQL document, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variableDefinitions: {}, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const type = this.next().value as Operation['type'];
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value;
        const variableDefinitions: Record<string, ValueNode | null> = {};
        if (this.peek()?.value === '(') {
          this.next();
          while (this.peek() !== undefined && this.peek()?.value !== ')') {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseTypeName();
            let defaultValue: ValueNode | null = null;
            if (this.peek()?.value === '=') {
              this.next();
              defaultValue = this.parseValue();
            }
            variableDefinitions[varName] = defaultValue;
          }
          this.expectPunct(')');
        }
        // Operation directives (rare in these documents): skip them.
        while (this.peek()?.value === '@') this.parseDirective();
        operations.push({ type, name, variableDefinitions, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Unexpected token ${token.value} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseTypeName(): void {
    const token = this.peek();
    if (token?.value === '[') {
      this.next();
      this.parseTypeName();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    while (this.peek()?.value === '!') this.next();
  }

  private parseDirective(): DirectiveNode {
    this.expectPunct('@');
    const name = this.expectName();
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() !== undefined && this.peek()?.value !== ')') {
        const key = this.expectName();
        this.expectPunct(':');
        args[key] = this.parseValue();
      }
      this.expectPunct(')');
    }
    return { name, args };
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (this.peek() !== undefined && this.peek()?.value !== '}') {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek() as Token;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives: DirectiveNode[] = [];
        while (this.peek()?.value === '@') directives.push(this.parseDirective());
        return { kind: 'inline', typeCondition, directives, selection: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        const directives: DirectiveNode[] = [];
        while (this.peek()?.value === '@') directives.push(this.parseDirective());
        return { kind: 'spread', name, directives };
      }
      const directives: DirectiveNode[] = [];
      while (this.peek()?.value === '@') directives.push(this.parseDirective());
      return { kind: 'inline', typeCondition: null, directives, selection: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() !== undefined && this.peek()?.value !== ')') {
        const key = this.expectName();
        this.expectPunct(':');
        args[key] = this.parseValue();
      }
      this.expectPunct(')');
    }
    const directives: DirectiveNode[] = [];
    while (this.peek()?.value === '@') directives.push(this.parseDirective());
    let selection: Selection[] | null = null;
    if (this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, directives, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== undefined && this.peek()?.value !== ']') items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== undefined && this.peek()?.value !== '}') {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'int') return { kind: 'literal', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'literal', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.value };
    }
    throw new Error(`Unexpected value token ${token.value} in GraphQL document`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  if (node.kind === 'var') return variables[node.name] ?? null;
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'list') return node.items.map((item) => resolveValue(item, variables));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Wrapped values (each carries its concrete __typename for fragments/node)
// ---------------------------------------------------------------------------

type Wrapped = Record<string, unknown> & { __typename: string };

function userValue(store: Store, login: string): Wrapped {
  const id = login === store.viewerLogin ? store.viewerId : 0;
  return { __typename: 'User', __login: login, __id: id };
}

function repoValue(repo: Repo): Wrapped {
  return { __typename: 'Repository', __repo: repo };
}

function issueValue(repo: Repo, issue: Issue): Wrapped {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullValue(repo: Repo, pr: PullRequest): Wrapped {
  return { __typename: 'PullRequest', __repo: repo, __pr: pr };
}

function commentValue(repo: Repo, comment: IssueComment): Wrapped {
  return { __typename: 'IssueComment', __repo: repo, __comment: comment };
}

function labelValue(name: string, color: string, description: string): Wrapped {
  return { __typename: 'Label', __name: name, __color: color, __description: description };
}

function refValue(name: string): Wrapped {
  return { __typename: 'Ref', __name: name };
}

interface Page<T> {
  items: T[];
  indices: number[];
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
  totalCount: number;
}

function encodeCursor(index: number): string {
  return Buffer.from(`offset:${index}`).toString('base64');
}

function decodeCursor(after: unknown): number | null {
  if (typeof after !== 'string' || after === '') return null;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const match = /^offset:(\d+)$/.exec(text);
    if (match !== null) return Number.parseInt(match[1], 10);
    return null;
  } catch {
    return null;
  }
}

function paginate<T>(items: T[], first: unknown, after: unknown): Page<T> {
  const startIndex = decodeCursor(after);
  const start = startIndex === null ? 0 : startIndex + 1;
  const count = typeof first === 'number' && Number.isFinite(first) && first >= 0 ? Math.trunc(first) : items.length;
  const pageItems = items.slice(start, start + count);
  const indices: number[] = [];
  for (let i = 0; i < pageItems.length; i += 1) indices.push(start + i);
  return {
    items: pageItems,
    indices,
    hasNextPage: start + pageItems.length < items.length,
    endCursor: indices.length > 0 ? encodeCursor(indices[indices.length - 1] as number) : null,
    startCursor: indices.length > 0 ? encodeCursor(indices[0] as number) : null,
    totalCount: items.length,
  };
}

function connectionValue(typeName: string, page: Page<Wrapped>): Wrapped {
  return { __typename: typeName, __page: page };
}

function edgeValue(typeName: string, node: Wrapped, cursor: string): Wrapped {
  return { __typename: typeName, __node: node, __cursor: cursor };
}

// ---------------------------------------------------------------------------
// Execution context, validation, executor
// ---------------------------------------------------------------------------

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: { message: string; path?: (string | number)[] }[];
}

function concreteType(value: unknown): string | null {
  if (value !== null && typeof value === 'object' && typeof (value as Wrapped).__typename === 'string') {
    return (value as Wrapped).__typename;
  }
  return null;
}

function directivesSkip(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    const raw = directive.args['if'];
    if (raw === undefined) continue;
    const value = resolveValue(raw, variables);
    if (directive.name === 'skip' && value === true) return true;
    if (directive.name === 'include' && value === false) return true;
  }
  return false;
}

function validateSelection(type: string, selections: Selection[], ctx: ExecCtx, path: (string | number)[]): void {
  const fields = FIELD_TYPES[type];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      if (fields === undefined || fields[selection.name] === undefined) {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${type}".`, path: [...path, selection.alias ?? selection.name] });
        continue;
      }
      if (selection.selection !== null) {
        const child = fields[selection.name] as string;
        if (!SCALARS.has(child) && FIELD_TYPES[child] !== undefined) {
          validateSelection(child, selection.selection, ctx, [...path, selection.alias ?? selection.name]);
        }
      }
    } else if (selection.kind === 'inline') {
      const target = selection.typeCondition ?? type;
      if (target === type || type === 'Node' || selection.typeCondition === null) {
        validateSelection(target, selection.selection, ctx, path);
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      validateSelection(fragment.typeCondition, fragment.selection, ctx, path);
    }
  }
}

function executeSelection(type: string, value: unknown, selections: Selection[], ctx: ExecCtx, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      const concrete = concreteType(value);
      if (selection.typeCondition !== null && concrete !== null && selection.typeCondition !== concrete) continue;
      if (directivesSkip(selection.directives, ctx.variables)) continue;
      const target = selection.typeCondition ?? type;
      Object.assign(out, executeSelection(target, value, selection.selection, ctx, path));
      continue;
    }
    if (selection.kind === 'spread') {
      if (directivesSkip(selection.directives, ctx.variables)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      const concrete = concreteType(value);
      if (concrete !== null && fragment.typeCondition !== concrete && type !== 'Node') continue;
      Object.assign(out, executeSelection(fragment.typeCondition, value, fragment.selection, ctx, path));
      continue;
    }
    if (directivesSkip(selection.directives, ctx.variables)) continue;
    const key = selection.alias ?? selection.name;
    const fieldPath = [...path, key];
    if (selection.name === '__typename') {
      out[key] = concreteType(value) ?? type;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argNode] of Object.entries(selection.args)) args[argName] = resolveValue(argNode, ctx.variables);
    let raw: unknown;
    try {
      raw = resolveField(type, value, selection.name, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[key] = null;
      continue;
    }
    if (raw === null || raw === undefined) {
      out[key] = null;
      continue;
    }
    if (selection.selection === null) {
      out[key] = raw;
      continue;
    }
    const childType = FIELD_TYPES[type]?.[selection.name];
    if (childType === undefined || SCALARS.has(childType)) {
      out[key] = raw;
      continue;
    }
    if (Array.isArray(raw)) {
      out[key] = raw.map((entry) => {
        if (entry === null || typeof entry !== 'object') return entry;
        const concrete = concreteType(entry) ?? childType;
        return executeSelection(concrete, entry, selection.selection as Selection[], ctx, fieldPath);
      });
      continue;
    }
    if (typeof raw === 'object') {
      const concrete = concreteType(raw) ?? childType;
      out[key] = executeSelection(concrete, raw, selection.selection, ctx, fieldPath);
      continue;
    }
    out[key] = raw;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field resolvers
// ---------------------------------------------------------------------------

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const list = [...issues];
  const order = (orderBy !== null && typeof orderBy === 'object' ? (orderBy as Record<string, unknown>) : null) ?? null;
  const field = typeof order?.field === 'string' ? order.field : 'CREATED_AT';
  const direction = order?.direction === 'ASC' ? 1 : -1;
  const keyOf = (issue: Issue): string | number => {
    if (field === 'UPDATED_AT') return issue.updated_at;
    if (field === 'COMMENTS') return issue.comments.length;
    return issue.created_at;
  };
  list.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka < kb) return -1 * direction;
    if (ka > kb) return 1 * direction;
    return (a.number - b.number) * direction;
  });
  return list;
}

function issueConnection(store: Store, repo: Repo, args: Record<string, unknown>): Wrapped {
  let list = [...repo.issues];
  if (Array.isArray(args.states)) {
    const wanted = new Set(args.states.map((s) => String(s).toUpperCase()));
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const sorted = sortIssues(list, args.orderBy ?? null);
  const wrapped = sorted.map((issue) => issueValue(repo, issue));
  return connectionValue('IssueConnection', paginate(wrapped, args.first, args.after));
}

function pullConnection(store: Store, repo: Repo, args: Record<string, unknown>): Wrapped {
  const sorted = [...repo.pulls].sort((a, b) => b.number - a.number);
  const wrapped = sorted.map((pr) => pullValue(repo, pr));
  return connectionValue('PullRequestConnection', paginate(wrapped, args.first, args.after));
}

function resolveNode(store: Store, id: unknown): Wrapped | null {
  const decoded = decodeGid(id);
  if (decoded === null) return null;
  const numeric = Number.parseInt(decoded.id, 10);
  if (decoded.type === 'Repository' && Number.isFinite(numeric)) {
    const repo = findRepoById(store, numeric);
    return repo === null ? null : repoValue(repo);
  }
  if (decoded.type === 'Issue' && Number.isFinite(numeric)) {
    const found = findIssueById(store, numeric);
    return found === null ? null : issueValue(found.repo, found.issue);
  }
  if (decoded.type === 'PullRequest' && Number.isFinite(numeric)) {
    const found = findPullById(store, numeric);
    return found === null ? null : pullValue(found.repo, found.pr);
  }
  if (decoded.type === 'User') {
    if (Number.isFinite(numeric) && numeric === store.viewerId) return userValue(store, store.viewerLogin);
    if (!Number.isFinite(numeric) && decoded.id !== '') return userValue(store, decoded.id);
    return null;
  }
  if (decoded.type === 'IssueComment' && Number.isFinite(numeric)) {
    for (const repo of store.repos.values()) {
      for (const issue of repo.issues) {
        const comment = issue.comments.find((entry) => entry.id === numeric);
        if (comment !== undefined) return commentValue(repo, comment);
      }
    }
    return null;
  }
  return null;
}

function resolveField(type: string, value: unknown, name: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const store = ctx.store;
  const wrapped = value as Wrapped;

  if (type === 'Query') {
    if (name === 'viewer') return userValue(store, store.viewerLogin);
    if (name === 'repository') {
      const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? store.getRepo(args.owner, args.name) : undefined;
      return repo === undefined ? null : repoValue(repo);
    }
    if (name === 'node') return resolveNode(store, args.id);
    if (name === '__type') {
      const typeName = args.name;
      if (typeof typeName !== 'string') return null;
      if (FIELD_TYPES[typeName] === undefined && INTROSPECTION_ENUMS[typeName] === undefined && !SCALARS.has(typeName)) return null;
      return { __typename: '__Type', __typeName: typeName };
    }
    if (name === '__schema') return { __typename: '__Schema' };
    throw new Error(`Cannot query field "${name}" on type "Query".`);
  }

  if (type === 'Mutation') {
    const input = (args.input !== null && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const decoded = decodeGid(input.repositoryId);
      let repo: Repo | null = null;
      if (decoded !== null && decoded.type === 'Repository') {
        const numeric = Number.parseInt(decoded.id, 10);
        repo = Number.isFinite(numeric) ? findRepoById(store, numeric) : null;
      }
      if (repo === null) throw new Error('createIssue: repository not found');
      if (typeof input.title !== 'string' || input.title === '') throw new Error('createIssue: title is required');
      const issue = createIssueInStore(store, repo, input.title, typeof input.body === 'string' ? input.body : '');
      return { __typename: 'CreateIssuePayload', __issue: issueValue(repo, issue), __clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
    }
    if (name === 'closeIssue') {
      const decoded = decodeGid(input.issueId);
      const numeric = decoded === null ? Number.NaN : Number.parseInt(decoded.id, 10);
      const found = decoded !== null && decoded.type === 'Issue' && Number.isFinite(numeric) ? findIssueById(store, numeric) : null;
      if (found === null) throw new Error('closeIssue: issue not found');
      found.issue.state = 'closed';
      found.issue.updated_at = store.nowIso();
      return { __typename: 'CloseIssuePayload', __issue: issueValue(found.repo, found.issue), __clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
    }
    if (name === 'createPullRequest') {
      const decoded = decodeGid(input.repositoryId);
      let repo: Repo | null = null;
      if (decoded !== null && decoded.type === 'Repository') {
        const numeric = Number.parseInt(decoded.id, 10);
        repo = Number.isFinite(numeric) ? findRepoById(store, numeric) : null;
      }
      if (repo === null) throw new Error('createPullRequest: repository not found');
      if (typeof input.baseRefName !== 'string' || typeof input.headRefName !== 'string') {
        throw new Error('createPullRequest: baseRefName and headRefName are required');
      }
      if (typeof input.title !== 'string' || input.title === '') throw new Error('createPullRequest: title is required');
      const pr = createPullInStore(store, repo, input.baseRefName, input.headRefName, input.title, typeof input.body === 'string' ? input.body : '');
      return { __typename: 'CreatePullRequestPayload', __pr: pullValue(repo, pr), __clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
    }
    if (name === 'mergePullRequest') {
      const decoded = decodeGid(input.pullRequestId);
      const numeric = decoded === null ? Number.NaN : Number.parseInt(decoded.id, 10);
      const found = decoded !== null && decoded.type === 'PullRequest' && Number.isFinite(numeric) ? findPullById(store, numeric) : null;
      if (found === null) throw new Error('mergePullRequest: pull request not found');
      const merged = squashMerge(store, found.repo, found.pr);
      if (!merged.ok) throw new Error(merged.reason);
      return { __typename: 'MergePullRequestPayload', __pr: pullValue(found.repo, found.pr), __clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
    }
    if (name === 'addComment') {
      const decoded = decodeGid(input.subjectId);
      const numeric = decoded === null ? Number.NaN : Number.parseInt(decoded.id, 10);
      const found = decoded !== null && decoded.type === 'Issue' && Number.isFinite(numeric) ? findIssueById(store, numeric) : null;
      if (found === null) throw new Error('addComment: subject not found');
      if (typeof input.body !== 'string' || input.body === '') throw new Error('addComment: body is required');
      const now = store.nowIso();
      const comment: IssueComment = {
        id: store.nextCommentId++,
        body: input.body,
        user: store.viewerLogin,
        created_at: now,
        updated_at: now,
      };
      found.issue.comments.push(comment);
      found.issue.updated_at = now;
      return { __typename: 'AddCommentPayload', __comment: commentValue(found.repo, comment), __clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
    }
    throw new Error(`Cannot query field "${name}" on type "Mutation".`);
  }

  if (type === 'Repository') {
    const repo = wrapped.__repo as Repo;
    switch (name) {
      case 'id': return gid('Repository', repo.id);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'description': return repo.description;
      case 'private': return repo.private;
      case 'isPrivate': return repo.private;
      case 'url': return '';
      case 'resourcePath': return `/${repo.owner}/${repo.name}`;
      case 'owner': return userValue(store, repo.owner);
      case 'defaultBranchRef': return refValue(repo.default_branch);
      case 'defaultBranch': return refValue(repo.default_branch);
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'createdAt': return repo.created_at;
      case 'updatedAt': return repo.updated_at;
      case 'issue': {
        const issue = repo.issues.find((entry) => entry.number === args.number);
        return issue === undefined ? null : issueValue(repo, issue);
      }
      case 'issues': return issueConnection(store, repo, args);
      case 'pullRequests': return pullConnection(store, repo, args);
      case 'pullRequest': {
        const pr = repo.pulls.find((entry) => entry.number === args.number);
        return pr === undefined ? null : pullValue(repo, pr);
      }
      default: throw new Error(`Cannot query field "${name}" on type "Repository".`);
    }
  }

  if (type === 'Issue') {
    const repo = wrapped.__repo as Repo;
    const issue = wrapped.__issue as Issue;
    switch (name) {
      case 'id': return gid('Issue', issue.id);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'createdAt': return issue.created_at;
      case 'updatedAt': return issue.updated_at;
      case 'author': return userValue(store, issue.user);
      case 'closed': return issue.state === 'closed';
      case 'url': return '';
      case 'resourcePath': return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'repository': return repoValue(repo);
      case 'labels': {
        const labels = issue.labels.map((labelName) => {
          const stored = repo.labels.get(labelName);
          return labelValue(labelName, stored?.color ?? '', stored?.description ?? '');
        });
        return connectionValue('LabelConnection', paginate(labels, args.first, args.after));
      }
      case 'comments': {
        const comments = issue.comments.map((comment) => commentValue(repo, comment));
        return connectionValue('IssueCommentConnection', paginate(comments, args.first, args.after));
      }
      default: throw new Error(`Cannot query field "${name}" on type "Issue".`);
    }
  }

  if (type === 'PullRequest') {
    const repo = wrapped.__repo as Repo;
    const pr = wrapped.__pr as PullRequest;
    switch (name) {
      case 'id': return gid('PullRequest', pr.id);
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'body': return pr.body;
      case 'state': return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged': return pr.merged;
      case 'mergeable': return mergeableState(store, repo, pr);
      case 'headRefName': return pr.headRef;
      case 'baseRefName': return pr.baseRef;
      case 'headRef': return refValue(pr.headRef);
      case 'baseRef': return refValue(pr.baseRef);
      case 'author': return userValue(store, pr.user);
      case 'createdAt': return pr.created_at;
      case 'updatedAt': return pr.updated_at;
      case 'mergedAt': return pr.merged_at;
      case 'url': return '';
      case 'resourcePath': return `/${repo.owner}/${repo.name}/pull/${pr.number}`;
      case 'repository': return repoValue(repo);
      case 'files': {
        const files = prFiles(store, repo, pr).map((file) => ({ __typename: 'PullRequestChangedFile', __file: file }));
        return connectionValue('PullRequestChangedFileConnection', paginate(files, args.first, args.after));
      }
      case 'additions': return prFiles(store, repo, pr).reduce((sum, file) => sum + file.additions, 0);
      case 'deletions': return prFiles(store, repo, pr).reduce((sum, file) => sum + file.deletions, 0);
      case 'changedFiles': return prFiles(store, repo, pr).length;
      default: throw new Error(`Cannot query field "${name}" on type "PullRequest".`);
    }
  }

  if (type === 'User') {
    switch (name) {
      case 'id': return gid('User', wrapped.__id as number);
      case 'login': return wrapped.__login as string;
      case 'name': return wrapped.__login as string;
      case 'databaseId': return wrapped.__id as number;
      case 'url': return '';
      default: throw new Error(`Cannot query field "${name}" on type "User".`);
    }
  }

  if (type === 'Ref') {
    switch (name) {
      case 'id': return gid('Ref', wrapped.__name as string);
      case 'name': return wrapped.__name as string;
      default: throw new Error(`Cannot query field "${name}" on type "Ref".`);
    }
  }

  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'PullRequestChangedFileConnection' || type === 'LabelConnection' || type === 'IssueCommentConnection') {
    const page = wrapped.__page as Page<Wrapped>;
    switch (name) {
      case 'nodes': return page.items;
      case 'edges': {
        const edgeType = type === 'IssueConnection' ? 'IssueEdge'
          : type === 'PullRequestConnection' ? 'PullRequestEdge'
          : type === 'PullRequestChangedFileConnection' ? 'PullRequestChangedFileEdge'
          : type === 'LabelConnection' ? 'LabelEdge' : 'IssueCommentEdge';
        return page.items.map((item, i) => edgeValue(edgeType, item, encodeCursor(page.indices[i] as number)));
      }
      case 'pageInfo': return { __typename: 'PageInfo', __page: page };
      case 'totalCount': return page.totalCount;
      default: throw new Error(`Cannot query field "${name}" on type "${type}".`);
    }
  }

  if (type === 'IssueEdge' || type === 'PullRequestEdge' || type === 'PullRequestChangedFileEdge' || type === 'LabelEdge' || type === 'IssueCommentEdge') {
    switch (name) {
      case 'node': return wrapped.__node as Wrapped;
      case 'cursor': return wrapped.__cursor as string;
      default: throw new Error(`Cannot query field "${name}" on type "${type}".`);
    }
  }

  if (type === 'PullRequestChangedFile') {
    const file = wrapped.__file as DiffLine;
    switch (name) {
      case 'path': return file.path;
      case 'filename': return file.path;
      case 'status': return file.status;
      case 'additions': return file.additions;
      case 'deletions': return file.deletions;
      case 'changes': return file.changes;
      default: throw new Error(`Cannot query field "${name}" on type "PullRequestChangedFile".`);
    }
  }

  if (type === 'Label') {
    switch (name) {
      case 'id': return gid('Label', wrapped.__name as string);
      case 'name': return wrapped.__name as string;
      case 'color': return wrapped.__color as string;
      case 'description': return wrapped.__description as string;
      default: throw new Error(`Cannot query field "${name}" on type "Label".`);
    }
  }

  if (type === 'IssueComment') {
    const comment = wrapped.__comment as IssueComment;
    switch (name) {
      case 'id': return gid('IssueComment', comment.id);
      case 'body': return comment.body;
      case 'author': return userValue(store, comment.user);
      case 'createdAt': return comment.created_at;
      case 'updatedAt': return comment.updated_at;
      case 'url': return '';
      default: throw new Error(`Cannot query field "${name}" on type "IssueComment".`);
    }
  }

  if (type === 'PageInfo') {
    const page = wrapped.__page as Page<Wrapped>;
    switch (name) {
      case 'hasNextPage': return page.hasNextPage;
      case 'hasPreviousPage': return false;
      case 'startCursor': return page.startCursor;
      case 'endCursor': return page.endCursor;
      default: throw new Error(`Cannot query field "${name}" on type "PageInfo".`);
    }
  }

  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (name === 'issue') return wrapped.__issue as Wrapped;
    if (name === 'clientMutationId') return wrapped.__clientMutationId ?? null;
    throw new Error(`Cannot query field "${name}" on type "${type}".`);
  }

  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return wrapped.__pr as Wrapped;
    if (name === 'clientMutationId') return wrapped.__clientMutationId ?? null;
    throw new Error(`Cannot query field "${name}" on type "${type}".`);
  }

  if (type === 'AddCommentPayload') {
    if (name === 'commentEdge') return edgeValue('IssueCommentEdge', wrapped.__comment as Wrapped, '');
    if (name === 'comment') return wrapped.__comment as Wrapped;
    if (name === 'clientMutationId') return wrapped.__clientMutationId ?? null;
    throw new Error(`Cannot query field "${name}" on type "${type}".`);
  }

  if (type === '__Type') {
    const typeName = wrapped.__typeName as string;
    switch (name) {
      case 'name': return typeName;
      case 'kind': return schemaKind(typeName);
      case 'description': return null;
      case 'fields': {
        if (schemaKind(typeName) !== 'OBJECT' && schemaKind(typeName) !== 'INTERFACE') return null;
        const names = INTROSPECTION_FIELDS[typeName] ?? Object.keys(FIELD_TYPES[typeName] ?? {});
        return names.map((fieldName) => ({ __typename: '__Field', __name: fieldName, __parentType: typeName }));
      }
      case 'enumValues': {
        const values = INTROSPECTION_ENUMS[typeName];
        if (values === undefined) return null;
        return values.map((enumName) => ({ __typename: '__EnumValue', __name: enumName }));
      }
      case 'possibleTypes': {
        if (typeName !== 'Node') return null;
        return ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment'].map((possible) => ({ __typename: '__Type', __typeName: possible }));
      }
      case 'inputFields': return null;
      default: throw new Error(`Cannot query field "${name}" on type "__Type".`);
    }
  }

  if (type === '__Field') {
    switch (name) {
      case 'name': return wrapped.__name as string;
      case 'description': return null;
      case 'type': {
        const parent = wrapped.__parentType as string;
        const fieldName = wrapped.__name as string;
        return { __typename: '__Type', __typeName: FIELD_TYPES[parent]?.[fieldName] ?? 'String' };
      }
      case 'args': return [];
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: throw new Error(`Cannot query field "${name}" on type "__Field".`);
    }
  }

  if (type === '__EnumValue') {
    switch (name) {
      case 'name': return wrapped.__name as string;
      case 'description': return null;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: throw new Error(`Cannot query field "${name}" on type "__EnumValue".`);
    }
  }

  if (type === '__Schema') {
    switch (name) {
      case 'queryType': return { __typename: '__Type', __typeName: 'Query' };
      case 'mutationType': return { __typename: '__Type', __typeName: 'Mutation' };
      case 'subscriptionType': return null;
      case 'types': {
        const names = [...Object.keys(FIELD_TYPES), ...Object.keys(INTROSPECTION_ENUMS), 'String', 'Int', 'ID', 'Boolean', 'Float'];
        return names.map((typeName) => ({ __typename: '__Type', __typeName: typeName }));
      }
      case 'directives': return [];
      default: throw new Error(`Cannot query field "${name}" on type "__Schema".`);
    }
  }

  if (type === '__InputValue') {
    switch (name) {
      case 'name': return wrapped.__name as string;
      case 'description': return null;
      case 'type': return { __typename: '__Type', __typeName: 'String' };
      case 'defaultValue': return null;
      default: throw new Error(`Cannot query field "${name}" on type "__InputValue".`);
    }
  }

  if (type === 'Node') {
    if (name === 'id') {
      const concrete = concreteType(value);
      if (concrete === 'Repository') return gid('Repository', (wrapped.__repo as Repo).id);
      if (concrete === 'Issue') return gid('Issue', (wrapped.__issue as Issue).id);
      if (concrete === 'PullRequest') return gid('PullRequest', (wrapped.__pr as PullRequest).id);
      if (concrete === 'User') return gid('User', wrapped.__id as number);
      if (concrete === 'IssueComment') return gid('IssueComment', (wrapped.__comment as IssueComment).id);
      return null;
    }
    throw new Error(`Cannot query field "${name}" on type "Node".`);
  }

  throw new Error(`Cannot query field "${name}" on type "${type}".`);
}

// ---------------------------------------------------------------------------
// One operation -> {data, errors?}
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function executeOperation(store: Store, operation: unknown): Record<string, unknown> {
  if (!isRecord(operation) || typeof operation.query !== 'string') {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a query string' }] };
  }
  const variables = isRecord(operation.variables) ? operation.variables : {};
  let document: Document;
  try {
    document = new Parser(lex(operation.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation in GraphQL document' }] };
  }
  let selected = document.operations[0] as Operation;
  if (typeof operation.operationName === 'string' && operation.operationName !== '') {
    const named = document.operations.find((entry) => entry.name === operation.operationName);
    if (named === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operation.operationName}"` }] };
    }
    selected = named;
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const [name, defaultNode] of Object.entries(selected.variableDefinitions)) {
    if (!(name in mergedVariables) && defaultNode !== null) {
      mergedVariables[name] = resolveValue(defaultNode, variables);
    }
  }
  const ctx: ExecCtx = { store, variables: mergedVariables, fragments: document.fragments, errors: [] };
  const rootType = selected.type === 'mutation' ? 'Mutation' : 'Query';
  validateSelection(rootType, selected.selection, ctx, []);
  if (ctx.errors.length > 0) {
    return { data: null, errors: ctx.errors };
  }
  const rootValue: Wrapped = { __typename: rootType };
  const data = executeSelection(rootType, rootValue, selected.selection, ctx, []);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export async function handleGraphql(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<boolean> {
  if (pathOf(req) !== '/api/graphql') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { message: 'Malformed JSON body' });
    return true;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => executeOperation(store, entry)));
    return true;
  }
  if (!isRecord(parsed) || typeof parsed.query !== 'string') {
    sendJson(res, 400, { message: 'Request body must be a JSON object with a query string' });
    return true;
  }
  sendJson(res, 200, executeOperation(store, parsed));
  return true;
}
