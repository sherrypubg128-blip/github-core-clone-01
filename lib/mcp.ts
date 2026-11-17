// MCP endpoint for the github-core-clone-01 forge: JSON-RPC 2.0 over
// Streamable HTTP at POST /mcp, plain application/json answers (no SSE).
//
// Speaks both protocol eras the suite accepts:
//   modern 2026-07-28: `server/discover` answers supportedVersions (a
//           non-empty list of YYYY-MM-DD revisions), capabilities and identity;
//           no handshake, no session.
//   legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`,
//           with an optional Mcp-Session-Id (accepted, never required).
//
// Auth: no Authorization header (or a wrong token) is exactly 401. A body
// that is not JSON is HTTP 400 with JSON-RPC -32700. An unknown tool is
// -32601, missing required arguments are -32602, a malformed JSON-RPC
// request (no method, bad id) is -32600. tools/list is one fixed,
// deterministically serialized list, byte-identical on every call.
//
// All tools act on the same Store as REST/GraphQL/git, so objects created
// over MCP read back over /api/v3 with the same ids and numbers.
//
// Determinism: no Date.now / Math.random; timestamps from store.nowIso().

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, type Issue, type PullRequest, type Repo } from './store.ts';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function gid(type: string, id: number | string): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

// ---------------------------------------------------------------------------
// Store helpers (same objects / counters as REST and GraphQL)
// ---------------------------------------------------------------------------

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

/** Squash-merge, exactly like REST PUT /pulls/{n}/merge (merge_method=squash). */
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
  const mergeSha = store.buildCommit(repo, merged.treeSha, [baseSha], `Merge pull request #${pr.number} from ${store.viewerLogin}/${pr.headRef}\n\n${pr.title}`, `${store.viewerLogin} <${store.viewerLogin}@example.invalid>`);
  setRef(repo, pr.baseRef, mergeSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = now;
  pr.merge_commit_sha = mergeSha;
  pr.updated_at = now;
  repo.updated_at = now;
  return { ok: true, sha: mergeSha };
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

function createPullInStore(store: Store, repo: Repo, baseRefName: string, headRefName: string, title: string, body: string): PullRequest {
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
  repo.pulls.push(pr);
  repo.updated_at = now;
  return pr;
}

// ---------------------------------------------------------------------------
// REST-shaped JSON views (what the tools' text content carries)
// ---------------------------------------------------------------------------

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === store.viewerLogin ? store.viewerId : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user, id: issue.user === store.viewerLogin ? store.viewerId : 0, type: 'User' },
    labels: issue.labels,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    comments: issue.comments.length,
    repository: `${repo.owner}/${repo.name}`,
  };
}

function pullJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: gid('PullRequest', pr.id),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    mergeable: pr.mergeable,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: pr.user, id: pr.user === store.viewerLogin ? store.viewerId : 0, type: 'User' },
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
  };
}

// ---------------------------------------------------------------------------
// Tools: one fixed list, serialized deterministically (byte-identical calls)
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

const TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login (defaults to the authenticated user).' }),
        name: Object.freeze({ type: 'string', description: 'Repository name.' }),
        description: Object.freeze({ type: 'string', description: 'Repository description.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full repository name as owner/repo.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full repository name as owner/repo.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full repository name as owner/repo.' }),
        title: Object.freeze({ type: 'string', description: 'Issue title.' }),
        body: Object.freeze({ type: 'string', description: 'Issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full repository name as owner/repo.' }),
        issue_number: Object.freeze({ type: 'integer', description: 'Issue number.' }),
        number: Object.freeze({ type: 'integer', description: 'Issue number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'issue_number']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full repository name as owner/repo.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state filter: open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full repository name as owner/repo.' }),
        title: Object.freeze({ type: 'string', description: 'Pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'Pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'Head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'Base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full repository name as owner/repo.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'Pull request number.' }),
        number: Object.freeze({ type: 'integer', description: 'Pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

// ---------------------------------------------------------------------------
// Argument resolution: owner/repo, or full_name "owner/repo", plus synonyms
// ---------------------------------------------------------------------------

function splitFullName(value: unknown): { owner: string; repo: string } | null {
  if (typeof value !== 'string') return null;
  const idx = value.indexOf('/');
  if (idx <= 0 || idx === value.length - 1) return null;
  return { owner: value.slice(0, idx), repo: value.slice(idx + 1) };
}

function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = asString(args.owner) ?? asString(args.owner_login) ?? asString(args.org);
  let repo = asString(args.repo) ?? asString(args.repository) ?? asString(args.repository_name) ?? asString(args.repo_name);
  if ((owner === null || repo === null)) {
    const full = splitFullName(args.full_name) ?? splitFullName(args.repo_full_name);
    if (full !== null) {
      owner = owner ?? full.owner;
      repo = repo ?? full.repo;
    }
  }
  if (owner === null || repo === null) return null;
  return { owner, repo };
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run one tool. Returns { result } or { rpcError: {code, message} }. */
function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { result: Record<string, unknown> } | { rpcError: { code: number; message: string } } {
  const missing = (field: string): { rpcError: { code: number; message: string } } => ({
    rpcError: { code: -32602, message: `Missing required argument: ${field}` },
  });

  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name) ?? asString(args.repo) ?? asString(args.repository);
      if (repoName === null) return missing('name');
      const owner = asString(args.owner) ?? splitFullName(args.full_name)?.owner ?? store.viewerLogin;
      if (store.getRepo(owner, repoName) !== undefined) {
        return { result: toolError(`Repository already exists: ${owner}/${repoName}`) };
      }
      const repo = store.createRepo(owner, repoName, {
        description: asString(args.description) ?? '',
        private: args.private === true,
        default_branch: 'main',
      });
      return { result: toolOk(repoJson(store, repo)) };
    }
    case 'get_repo': {
      const target = resolveOwnerRepo(args);
      if (target === null) return missing('owner/repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return { result: toolError(`Repository not found: ${target.owner}/${target.repo}`) };
      return { result: toolOk(repoJson(store, repo)) };
    }
    case 'create_issue': {
      const target = resolveOwnerRepo(args);
      if (target === null) return missing('owner/repo');
      const title = asString(args.title);
      if (title === null) return missing('title');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return { result: toolError(`Repository not found: ${target.owner}/${target.repo}`) };
      const issue = createIssueInStore(store, repo, title, asString(args.body) ?? '');
      return { result: toolOk(issueJson(store, repo, issue)) };
    }
    case 'get_issue': {
      const target = resolveOwnerRepo(args);
      if (target === null) return missing('owner/repo');
      const number = asNumber(args.issue_number) ?? asNumber(args.number);
      if (number === null) return missing('issue_number');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return { result: toolError(`Repository not found: ${target.owner}/${target.repo}`) };
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) return { result: toolError(`Issue not found: #${number}`) };
      return { result: toolOk(issueJson(store, repo, issue)) };
    }
    case 'list_issues': {
      const target = resolveOwnerRepo(args);
      if (target === null) return missing('owner/repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return { result: toolError(`Repository not found: ${target.owner}/${target.repo}`) };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'all';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { result: toolOk(issues.map((issue) => issueJson(store, repo, issue))) };
    }
    case 'create_pull_request': {
      const target = resolveOwnerRepo(args);
      if (target === null) return missing('owner/repo');
      const title = asString(args.title);
      if (title === null) return missing('title');
      const head = asString(args.head) ?? asString(args.head_branch) ?? asString(args.head_ref);
      if (head === null) return missing('head');
      const base = asString(args.base) ?? asString(args.base_branch) ?? asString(args.base_ref);
      if (base === null) return missing('base');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return { result: toolError(`Repository not found: ${target.owner}/${target.repo}`) };
      const pr = createPullInStore(store, repo, base, head, title, asString(args.body) ?? '');
      return { result: toolOk(pullJson(store, repo, pr)) };
    }
    case 'merge_pull_request': {
      const target = resolveOwnerRepo(args);
      if (target === null) return missing('owner/repo');
      const number = asNumber(args.pull_number) ?? asNumber(args.number);
      if (number === null) return missing('pull_number');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return { result: toolError(`Repository not found: ${target.owner}/${target.repo}`) };
      const pr = repo.pulls.find((entry) => entry.number === number);
      if (pr === undefined) return { result: toolError(`Pull request not found: #${number}`) };
      const merged = squashMerge(store, repo, pr);
      if (!merged.ok) return { result: toolError(merged.reason) };
      return { result: toolOk(pullJson(store, repo, pr)) };
    }
    default:
      return { rpcError: { code: -32601, message: `Method not found: unknown tool "${name}"` } };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

const KNOWN_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Handle one parsed JSON-RPC request object.
 * Returns null for a notification (no response body; the caller answers 202).
 */
function dispatch(store: Store, request: unknown): Record<string, unknown> | null {
  if (!isRecord(request)) {
    return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  }
  const id = 'id' in request ? request.id : undefined;
  const hasId = id !== undefined && id !== null;
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    // A notification with no method is dropped silently; a request gets -32600.
    if (!hasId) return null;
    return rpcError(id, -32600, 'Invalid Request: missing method');
  }
  if (typeof id !== 'string' && typeof id !== 'number' && hasId) {
    return rpcError(null, -32600, 'Invalid Request: id must be a string or number');
  }
  const isNotification = !hasId;
  if (isNotification) {
    // Notifications (notifications/initialized and friends) get no response.
    return null;
  }
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'GitHub-compatible git forge: repositories, issues and pull requests over MCP tools.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const protocolVersion = requested !== null && KNOWN_REVISIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : null;
    if (toolName === null || toolName === '') {
      return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name');
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const outcome = callTool(store, toolName, args);
    if ('rpcError' in outcome) {
      return rpcError(id, outcome.rpcError.code, outcome.rpcError.message);
    }
    return rpcResult(id, outcome.result);
  }

  if (method.startsWith('notifications/')) {
    return null;
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  if (req.method === 'DELETE') {
    // A legacy client closing its session: nothing is held, so just accept it.
    res.writeHead(204);
    res.end();
    return true;
  }
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
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: body is not valid JSON'));
    return true;
  }
  if (Array.isArray(parsed)) {
    // A JSON-RPC batch: one response per request, in order (notifications dropped).
    const responses: unknown[] = [];
    for (const entry of parsed) {
      const response = dispatch(store, entry);
      if (response !== null) responses.push(response);
    }
    sendJson(res, 200, responses);
    return true;
  }
  const response = dispatch(store, parsed);
  if (response === null) {
    // A notification: HTTP 202 with no body.
    res.writeHead(202);
    res.end();
    return true;
  }
  sendJson(res, 200, response);
  return true;
}
