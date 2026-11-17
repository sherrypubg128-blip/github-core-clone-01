// GitHub REST v3 surface under /api/v3: repositories, branches, commits,
// contents, labels, issues, comments and pull requests (with squash merges).
//
// `handleRest` answers a request and returns true when the path is under
// /api/v3; anything else returns false so the caller can route it elsewhere
// (health probe, git smart HTTP, GraphQL, MCP). Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors are JSON {"message": string}.
//
// Auth: every /api/v3 route requires `Authorization: Bearer <token>` with the
// token from MAKEFUN_SHOP_TOKEN; anything else is 401. A repository under an
// owner other than the viewer login is 404, never 403.
//
// Performance: everything is Map lookups over the in-memory store. The hot
// read path (GET /issues/{n}) is a direct index into the repo's issue array
// plus one small object literal — nothing per-request scans all repos.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, parseCommit, type Issue, type IssueComment, type Label, type PullRequest, type Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SCOPES = 'repo, read:org';
const IDENTITY = 'adaiversen <adaiversen@example.invalid>';
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

let requestCounter = 0;

type JsonObj = Record<string, unknown>;

function nodeId(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isoFromEpoch(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

/** The number of lines in a blob (a trailing newline does not add a line). */
function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Added/removed line counts between two blobs, by multiset line difference. */
function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const count = (data: Buffer): Map<string, number> => {
    const map = new Map<string, number>();
    if (data.length === 0) return map;
    const text = data.toString('utf8');
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = count(oldData);
  const newLines = count(newData);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  if (additions === 0 && deletions === 0 && !oldData.equals(newData)) additions = 1;
  return { additions, deletions };
}

export async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase();
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  const rawSegments = url.pathname.split('/').filter((s) => s.length > 0);
  if (rawSegments.length < 2 || rawSegments[0] !== 'api' || rawSegments[1] !== 'v3') return false;
  const segments = rawSegments.slice(2).map(decodeSegment);
  const query = url.searchParams;
  const host = req.headers.host ?? 'localhost';
  const requestId = `req-${++requestCounter}`;

  const send = (status: number, value: unknown, extra: Record<string, string> = {}): void => {
    if (status === 204) {
      res.writeHead(204, { 'x-github-request-id': requestId, 'x-oauth-scopes': SCOPES, 'content-type': JSON_TYPE, ...extra });
      res.end();
      return;
    }
    const text = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': requestId,
      'x-oauth-scopes': SCOPES,
      ...extra,
    });
    res.end(text);
  };
  const sendError = (status: number, message: string): void => send(status, { message });
  const notFound = (): void => sendError(404, 'Not Found');

  // ---- auth: every /api/v3 route needs the bearer token -------------------
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const auth = req.headers.authorization ?? '';
  if (token === '' || auth !== `Bearer ${token}`) {
    sendError(401, 'Requires authentication');
    return true;
  }

  // ---- body: malformed JSON is a 400 ---------------------------------------
  let parsed: JsonObj = {};
  if (method !== 'GET' && method !== 'HEAD' && body !== undefined && body !== null && body.length > 0) {
    try {
      const value: unknown = JSON.parse(body.toString('utf8'));
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed = value as JsonObj;
      else if (Array.isArray(value)) parsed = { __array: value };
    } catch {
      sendError(400, 'Malformed JSON in request body');
      return true;
    }
  }
  const strField = (value: unknown): string => (typeof value === 'string' ? value : '');

  // ---- serializers ----------------------------------------------------------
  const userJson = (): JsonObj => ({
    login: store.viewerLogin,
    id: store.viewerId,
    node_id: nodeId('User', store.viewerId),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${store.viewerLogin}`,
    html_url: `https://github.com/${store.viewerLogin}`,
    type: 'User',
    site_admin: false,
  });

  const openIssuesCount = (repo: Repo): number => {
    let n = 0;
    for (const issue of repo.issues) if (issue.state === 'open') n += 1;
    for (const pull of repo.pulls) if (pull.state === 'open') n += 1;
    return n;
  };

  const repoJson = (repo: Repo): JsonObj => ({
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    watchers: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    forks: 0,
    open_issues_count: openIssuesCount(repo),
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.default_branch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  });

  const labelJson = (label: Label): JsonObj => ({
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: `https://api.github.com/repos/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  });

  const issueLabelsJson = (repo: Repo, issue: Issue): JsonObj[] => {
    const out: JsonObj[] = [];
    for (const name of issue.labels) {
      const label = repo.labels.get(name);
      if (label !== undefined) out.push(labelJson(label));
    }
    return out;
  };

  // Fast path for the timed read workload: one small object literal, no scans.
  const issueJson = (repo: Repo, issue: Issue): JsonObj => ({
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issueLabelsJson(repo, issue),
    user: userJson(),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    author_association: 'OWNER',
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    labels_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
  });

  const commentJson = (repo: Repo, issue: Issue, comment: IssueComment): JsonObj => ({
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  });

  const pullJson = (repo: Repo, pull: PullRequest): JsonObj => {
    const side = (ref: string, sha: string): JsonObj => ({
      label: `${repo.owner}:${ref}`,
      ref,
      sha,
      user: userJson(),
      repo: repoJson(repo),
    });
    return {
      id: pull.id,
      node_id: nodeId('PullRequest', pull.id),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      locked: false,
      draft: false,
      head: side(pull.headRef, pull.headSha),
      base: side(pull.baseRef, pull.baseSha),
      merged: pull.merged,
      mergeable: pull.mergeable,
      merge_commit_sha: pull.merge_commit_sha,
      merged_at: pull.merged_at,
      merged_by: null,
      user: userJson(),
      assignee: null,
      assignees: [],
      requested_reviewers: [],
      labels: [],
      milestone: null,
      created_at: pull.created_at,
      updated_at: pull.updated_at,
      closed_at: pull.state === 'closed' ? pull.updated_at : null,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    };
  };

  const commitJson = (repo: Repo, sha: string): JsonObj => {
    const obj = repo.objects.get(sha);
    const parsed = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
    const treeSha = parsed?.tree ?? EMPTY_TREE_SHA;
    const message = parsed?.message ?? '';
    const authorName = parsed?.authorName ?? store.viewerLogin;
    const authorEmail = parsed?.authorEmail ?? `${store.viewerLogin}@example.invalid`;
    const authorEpoch = parsed?.authorEpoch ?? 1735689600;
    const committerName = parsed?.committerName ?? authorName;
    const committerEmail = parsed?.committerEmail ?? authorEmail;
    const committerEpoch = parsed?.committerEpoch ?? authorEpoch;
    return {
      sha,
      node_id: nodeId('Commit', sha),
      commit: {
        author: { name: authorName, email: authorEmail, date: isoFromEpoch(authorEpoch) },
        committer: { name: committerName, email: committerEmail, date: isoFromEpoch(committerEpoch) },
        message,
        tree: { sha: treeSha, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${treeSha}` },
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
        comment_count: 0,
        verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
      },
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${sha}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
      author: userJson(),
      committer: userJson(),
      parents: (parsed?.parents ?? []).map((p) => ({
        sha: p,
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${p}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${p}`,
      })),
    };
  };

  // ---- git helpers -----------------------------------------------------------
  const resolveRef = (repo: Repo, ref: string): string | undefined => {
    const direct = repo.refs.get(`refs/heads/${ref}`);
    if (direct !== undefined) return direct;
    const full = repo.refs.get(ref);
    if (full !== undefined) return full;
    const obj = repo.objects.get(ref);
    if (obj !== undefined && obj.type === 'commit') return ref;
    return undefined;
  };

  const treeShaOfCommit = (repo: Repo, commitSha: string): string => {
    const obj = repo.objects.get(commitSha);
    if (obj === undefined || obj.type !== 'commit') return EMPTY_TREE_SHA;
    return parseCommit(obj.data).tree;
  };

  const walkCommits = (repo: Repo, tip: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = tip;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (obj === undefined || obj.type !== 'commit') break;
      out.push(cur);
      cur = parseCommit(obj.data).parents[0];
    }
    return out;
  };

  const mergeBase = (repo: Repo, a: string, b: string): string | null => {
    const ancestors = new Set<string>(walkCommits(repo, a));
    for (const sha of walkCommits(repo, b)) {
      if (ancestors.has(sha)) return sha;
    }
    return null;
  };

  const paginate = <T>(items: T[]): { page: T[]; link: string | null } => {
    const perPageRaw = Number(query.get('per_page') ?? '30');
    const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.floor(perPageRaw))) : 30;
    const pageRaw = Number(query.get('page') ?? '1');
    const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    const start = (page - 1) * perPage;
    const slice = items.slice(start, start + perPage);
    let link: string | null = null;
    if (page < totalPages) {
      const base = `http://${host}${url.pathname}`;
      const params = new URLSearchParams(url.searchParams);
      params.set('per_page', String(perPage));
      params.set('page', String(page + 1));
      const nextUrl = `${base}?${params.toString()}`;
      params.set('page', String(totalPages));
      const lastUrl = `${base}?${params.toString()}`;
      link = `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`;
    }
    return { page: slice, link };
  };
  const sendPage = <T>(items: T[], toJson: (item: T) => unknown): void => {
    const { page, link } = paginate(items);
    send(200, page.map(toJson), link === null ? {} : { link });
  };

  // ---- root / meta / user ------------------------------------------------------
  if (segments.length === 0) {
    if (method !== 'GET') return notFound(), true;
    send(200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: '/api/v3/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    });
    return true;
  }

  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return notFound(), true;
    send(200, { installed_version: '1.0.0' });
    return true;
  }

  if (segments.length === 1 && segments[0] === 'rate_limit') {
    if (method !== 'GET') return notFound(), true;
    send(200, {
      resources: {
        core: { limit: 60, remaining: 59, reset: 1735689600, used: 1 },
        search: { limit: 30, remaining: 30, reset: 1735689600, used: 0 },
        graphql: { limit: 5000, remaining: 5000, reset: 1735689600, used: 0 },
      },
      rate: { limit: 60, remaining: 59, reset: 1735689600, used: 1 },
    });
    return true;
  }

  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return notFound(), true;
      send(200, userJson());
      return true;
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const owned: Repo[] = [];
        for (const repo of store.repos.values()) {
          if (repo.owner === store.viewerLogin) owned.push(repo);
        }
        owned.sort((a, b) => a.id - b.id);
        sendPage(owned, repoJson);
        return true;
      }
      if (method === 'POST') {
        const name = strField(parsed.name).trim();
        if (name === '') {
          sendError(422, 'Repository name is required');
          return true;
        }
        if (store.getRepo(store.viewerLogin, name) !== undefined) {
          sendError(422, 'Repository creation failed: name already exists on this account');
          return true;
        }
        const repo = store.createRepo(store.viewerLogin, name, {
          description: strField(parsed.description),
          private: parsed.private === true,
          default_branch: typeof parsed.default_branch === 'string' && parsed.default_branch !== '' ? parsed.default_branch : undefined,
        });
        send(201, repoJson(repo));
        return true;
      }
      return notFound(), true;
    }
    return notFound(), true;
  }

  // ---- /repos/{owner}/{name}/... ----------------------------------------------
  if (segments[0] !== 'repos' || segments.length < 3) return notFound(), true;
  const owner = segments[1] ?? '';
  const repoName = segments[2] ?? '';
  // A repository under any owner but the viewer is 404, never 403.
  if (owner !== store.viewerLogin) return notFound(), true;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound(), true;
  const rest = segments.slice(3);

  // ---- the repository itself ---------------------------------------------------
  if (rest.length === 0) {
    if (method === 'GET') {
      send(200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      if (typeof parsed.description === 'string') repo.description = parsed.description;
      if (typeof parsed.default_branch === 'string' && parsed.default_branch !== '') repo.default_branch = parsed.default_branch;
      repo.updated_at = store.nowIso();
      send(200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      send(204, null);
      return true;
    }
    return notFound(), true;
  }

  // ---- git refs ------------------------------------------------------------------
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = strField(parsed.ref);
      const sha = strField(parsed.sha);
      if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
        sendError(422, 'Invalid ref: expected refs/heads/<branch>');
        return true;
      }
      const target = repo.objects.get(sha);
      if (target === undefined || target.type !== 'commit') {
        sendError(422, 'Object does not exist or is not a commit');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      send(201, {
        ref,
        node_id: nodeId('Ref', ref),
        url: `https://api.github.com/repos/${owner}/${repoName}/git/${ref}`,
        object: { sha, type: 'commit', url: `https://api.github.com/repos/${owner}/${repoName}/git/commits/${sha}` },
      });
      return true;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).join('/');
      const sha = repo.refs.get(ref) ?? repo.refs.get(`refs/${ref}`);
      if (sha === undefined) return notFound(), true;
      const fullRef = repo.refs.has(ref) ? ref : `refs/${ref}`;
      send(200, {
        ref: fullRef,
        node_id: nodeId('Ref', fullRef),
        url: `https://api.github.com/repos/${owner}/${repoName}/git/${fullRef}`,
        object: { sha, type: 'commit', url: `https://api.github.com/repos/${owner}/${repoName}/git/commits/${sha}` },
      });
      return true;
    }
    return notFound(), true;
  }

  // ---- branches --------------------------------------------------------------------
  if (rest[0] === 'branches' && rest.length === 1) {
    if (method !== 'GET') return notFound(), true;
    const out: JsonObj[] = [];
    for (const [ref, sha] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      out.push({
        name: ref.slice('refs/heads/'.length),
        commit: { sha, url: `https://api.github.com/repos/${owner}/${repoName}/commits/${sha}` },
        protected: false,
      });
    }
    send(200, out);
    return true;
  }

  // ---- commits -----------------------------------------------------------------------
  if (rest[0] === 'commits' && rest.length === 1) {
    if (method !== 'GET') return notFound(), true;
    const refParam = query.get('sha') ?? query.get('ref');
    let tip: string | undefined;
    if (refParam !== null && refParam !== '') {
      tip = resolveRef(repo, refParam);
      if (tip === undefined) return notFound(), true;
    } else {
      tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
    }
    if (tip === undefined) {
      send(200, []);
      return true;
    }
    send(200, walkCommits(repo, tip).map((sha) => commitJson(repo, sha)));
    return true;
  }

  // ---- contents ------------------------------------------------------------------------
  if (rest[0] === 'contents') {
    const contentPath = rest.slice(1).join('/');
    const fileUrl = (path: string): string =>
      `https://api.github.com/repos/${owner}/${repoName}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

    if (method === 'GET') {
      const refParam = query.get('ref');
      let tip: string | undefined;
      if (refParam !== null && refParam !== '') {
        tip = resolveRef(repo, refParam);
        if (tip === undefined) return notFound(), true;
      } else {
        tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
      }
      if (tip === undefined) return notFound(), true;
      const tree = store.readTree(repo, treeShaOfCommit(repo, tip));
      const branchName = refParam ?? repo.default_branch;
      const direct = contentPath === '' ? undefined : tree.get(contentPath);
      if (direct !== undefined) {
        const blob = repo.objects.get(direct.sha);
        const data = blob?.data ?? Buffer.alloc(0);
        send(200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: contentPath.split('/').pop() ?? contentPath,
          path: contentPath,
          sha: direct.sha,
          content: data.toString('base64'),
          url: fileUrl(contentPath),
          html_url: `https://github.com/${owner}/${repoName}/blob/${branchName}/${contentPath}`,
          git_url: `https://api.github.com/repos/${owner}/${repoName}/git/blobs/${direct.sha}`,
          download_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${branchName}/${contentPath}`,
        });
        return true;
      }
      // Directory listing: immediate children of contentPath ("" = the root).
      const prefix = contentPath === '' ? '' : `${contentPath}/`;
      const children = new Map<string, { isDir: boolean; sha: string; size: number }>();
      for (const [path, entry] of tree) {
        if (!path.startsWith(prefix)) continue;
        const restPath = path.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash === -1) {
          const blob = repo.objects.get(entry.sha);
          children.set(restPath, { isDir: false, sha: entry.sha, size: blob?.data.length ?? 0 });
        } else {
          const dir = restPath.slice(0, slash);
          if (!children.has(dir)) {
            const under = [...tree.entries()]
              .filter(([p]) => p.startsWith(`${prefix}${dir}/`))
              .map(([p, e]) => ({ path: p.slice(prefix.length + dir.length + 1), mode: e.mode, sha: e.sha }));
            children.set(dir, { isDir: true, sha: store.buildTree(repo, under), size: 0 });
          }
        }
      }
      if (children.size === 0) return notFound(), true;
      const listing: JsonObj[] = [...children.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([name, child]) => {
          const path = prefix + name;
          const entry: JsonObj = {
            type: child.isDir ? 'dir' : 'file',
            size: child.size,
            name,
            path,
            sha: child.sha,
            url: fileUrl(path),
            html_url: `https://github.com/${owner}/${repoName}/tree/${branchName}/${path}`,
            git_url: `https://api.github.com/repos/${owner}/${repoName}/git/trees/${child.sha}`,
          };
          if (!child.isDir) {
            entry.download_url = `https://raw.githubusercontent.com/${owner}/${repoName}/${branchName}/${path}`;
          }
          return entry;
        });
      send(200, listing);
      return true;
    }

    if (method === 'PUT') {
      if (contentPath === '') {
        sendError(422, 'A file path is required');
        return true;
      }
      const branchName = typeof parsed.branch === 'string' && parsed.branch !== '' ? parsed.branch : repo.default_branch;
      let tip = repo.refs.get(`refs/heads/${branchName}`);
      if (tip === undefined && repo.refs.size > 0) {
        sendError(404, 'Branch not found');
        return true;
      }
      const tree = tip === undefined ? new Map<string, { mode: string; sha: string }>() : store.readTree(repo, treeShaOfCommit(repo, tip));
      const current = tree.get(contentPath);
      const givenSha = typeof parsed.sha === 'string' ? parsed.sha : '';
      if (current !== undefined && givenSha === '') {
        sendError(422, 'File already exists: pass its sha to update it');
        return true;
      }
      if (givenSha !== '' && (current === undefined || current.sha !== givenSha)) {
        sendError(409, 'The file sha does not match the current blob');
        return true;
      }
      if (typeof parsed.content !== 'string') {
        sendError(422, 'content (base64) is required');
        return true;
      }
      const data = Buffer.from(parsed.content.replace(/[\r\n\t ]+/g, ''), 'base64');
      const blobSha = store.putObject(repo, 'blob', data);
      const entries = [...tree.entries()].map(([path, entry]) => ({ path, mode: entry.mode, sha: entry.sha }));
      const at = entries.findIndex((entry) => entry.path === contentPath);
      if (at === -1) entries.push({ path: contentPath, mode: '100644', sha: blobSha });
      else entries[at] = { path: contentPath, mode: '100644', sha: blobSha };
      const treeSha = store.buildTree(repo, entries);
      const message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : `Update ${contentPath}`;
      const commitSha = store.buildCommit(repo, treeSha, tip === undefined ? [] : [tip], message, IDENTITY);
      repo.refs.set(`refs/heads/${branchName}`, commitSha);
      const stamp = store.nowIso();
      repo.updated_at = stamp;
      send(current !== undefined ? 200 : 201, {
        content: {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: contentPath.split('/').pop() ?? contentPath,
          path: contentPath,
          sha: blobSha,
          content: data.toString('base64'),
          url: fileUrl(contentPath),
          html_url: `https://github.com/${owner}/${repoName}/blob/${branchName}/${contentPath}`,
          git_url: `https://api.github.com/repos/${owner}/${repoName}/git/blobs/${blobSha}`,
          download_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${branchName}/${contentPath}`,
        },
        commit: commitJson(repo, commitSha),
      });
      return true;
    }

    if (method === 'DELETE') {
      if (contentPath === '') return notFound(), true;
      const branchName = typeof parsed.branch === 'string' && parsed.branch !== '' ? parsed.branch : repo.default_branch;
      const tip = repo.refs.get(`refs/heads/${branchName}`);
      if (tip === undefined) return notFound(), true;
      const tree = store.readTree(repo, treeShaOfCommit(repo, tip));
      const current = tree.get(contentPath);
      if (current === undefined) return notFound(), true;
      const givenSha = typeof parsed.sha === 'string' ? parsed.sha : '';
      if (givenSha !== '' && givenSha !== current.sha) {
        sendError(409, 'The file sha does not match the current blob');
        return true;
      }
      const entries = [...tree.entries()]
        .filter(([path]) => path !== contentPath)
        .map(([path, entry]) => ({ path, mode: entry.mode, sha: entry.sha }));
      const treeSha = store.buildTree(repo, entries);
      const message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : `Delete ${contentPath}`;
      const commitSha = store.buildCommit(repo, treeSha, [tip], message, IDENTITY);
      repo.refs.set(`refs/heads/${branchName}`, commitSha);
      repo.updated_at = store.nowIso();
      send(200, { content: null, commit: commitJson(repo, commitSha) });
      return true;
    }
    return notFound(), true;
  }

  // ---- labels ----------------------------------------------------------------------------
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      send(200, [...repo.labels.values()].map(labelJson));
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const name = strField(parsed.name).trim();
      if (name === '') {
        sendError(422, 'Label name is required');
        return true;
      }
      if (repo.labels.has(name)) {
        sendError(422, 'Label already exists');
        return true;
      }
      const label: Label = {
        id: store.nextLabelId++,
        name,
        color: typeof parsed.color === 'string' && parsed.color !== '' ? parsed.color : 'ededed',
        description: typeof parsed.description === 'string' ? parsed.description : '',
      };
      repo.labels.set(name, label);
      send(201, labelJson(label));
      return true;
    }
    return notFound(), true;
  }

  // ---- issues ------------------------------------------------------------------------------
  if (rest[0] === 'issues') {
    const findIssue = (n: number): Issue | undefined => {
      const fast = repo.issues[n - 1];
      if (fast !== undefined && fast.number === n) return fast;
      return repo.issues.find((issue) => issue.number === n);
    };
    const labelNames = (value: unknown): string[] | null => {
      if (!Array.isArray(value)) return [];
      const names: string[] = [];
      for (const item of value) {
        if (typeof item === 'string') names.push(item);
        else if (typeof item === 'object' && item !== null && typeof (item as JsonObj).name === 'string') {
          names.push((item as JsonObj).name as string);
        }
      }
      return names;
    };

    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = repo.issues;
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        const sorted = [...list];
        if (sort === 'created' || sort === 'updated') {
          const key = sort === 'created' ? 'created_at' : 'updated_at';
          sorted.sort((a, b) => {
            const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : a.number - b.number;
            return direction === 'asc' ? cmp : -cmp;
          });
        }
        sendPage(sorted, (issue) => issueJson(repo, issue));
        return true;
      }
      if (method === 'POST') {
        const title = strField(parsed.title);
        if (title === '') {
          sendError(422, 'Issue title is required');
          return true;
        }
        const names = labelNames(parsed.labels);
        for (const name of names) {
          if (!repo.labels.has(name)) {
            sendError(422, `Label does not exist: ${name}`);
            return true;
          }
        }
        const stamp = store.nowIso();
        const issue: Issue = {
          id: store.nextGlobalId++,
          number: repo.nextIssue++,
          title,
          body: typeof parsed.body === 'string' ? parsed.body : '',
          state: 'open',
          labels: names,
          user: store.viewerLogin,
          created_at: stamp,
          updated_at: stamp,
          comments: [],
        };
        repo.issues.push(issue);
        send(201, issueJson(repo, issue));
        return true;
      }
      return notFound(), true;
    }

    if (rest.length === 2) {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return notFound(), true;
      const issue = findIssue(number);
      if (issue === undefined) return notFound(), true;
      if (method === 'GET') {
        send(200, issueJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof parsed.title === 'string') issue.title = parsed.title;
        if (typeof parsed.body === 'string') issue.body = parsed.body;
        if (parsed.labels !== undefined) {
          const names = labelNames(parsed.labels);
          if (names === null) {
            sendError(422, 'Invalid labels');
            return true;
          }
          for (const name of names) {
            if (!repo.labels.has(name)) {
              sendError(422, `Label does not exist: ${name}`);
              return true;
            }
          }
          issue.labels = names;
        }
        if (parsed.state === 'open' || parsed.state === 'closed') issue.state = parsed.state;
        issue.updated_at = store.nowIso();
        send(200, issueJson(repo, issue));
        return true;
      }
      return notFound(), true;
    }

    if (rest.length === 3 && rest[2] === 'comments') {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return notFound(), true;
      const issue = findIssue(number);
      if (issue === undefined) return notFound(), true;
      if (method === 'GET') {
        send(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
        return true;
      }
      if (method === 'POST') {
        const stamp = store.nowIso();
        const comment: IssueComment = {
          id: store.nextCommentId++,
          body: typeof parsed.body === 'string' ? parsed.body : '',
          user: store.viewerLogin,
          created_at: stamp,
          updated_at: stamp,
        };
        issue.comments.push(comment);
        send(201, commentJson(repo, issue, comment));
        return true;
      }
      return notFound(), true;
    }
    return notFound(), true;
  }

  // ---- pull requests -------------------------------------------------------------------------
  if (rest[0] === 'pulls') {
    const findPull = (n: number): PullRequest | undefined => {
      const fast = repo.pulls[n - 1];
      if (fast !== undefined && fast.number === n) return fast;
      return repo.pulls.find((pull) => pull.number === n);
    };

    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = repo.pulls;
        if (state !== 'all') list = list.filter((pull) => pull.state === state);
        const sorted = [...list].sort((a, b) => b.number - a.number);
        sendPage(sorted, (pull) => pullJson(repo, pull));
        return true;
      }
      if (method === 'POST') {
        const title = strField(parsed.title);
        const headRef = strField(parsed.head);
        const baseRef = strField(parsed.base);
        if (title === '' || headRef === '' || baseRef === '') {
          sendError(422, 'A pull request needs a title, head and base');
          return true;
        }
        const headSha = resolveRef(repo, headRef);
        const baseSha = resolveRef(repo, baseRef);
        if (headSha === undefined || baseSha === undefined) {
          sendError(422, 'Head or base branch does not exist');
          return true;
        }
        const stamp = store.nowIso();
        const pull: PullRequest = {
          id: store.nextGlobalId++,
          number: repo.nextPull++,
          title,
          body: typeof parsed.body === 'string' ? parsed.body : '',
          state: 'open',
          merged: false,
          mergeable: true,
          headRef,
          baseRef,
          headSha,
          baseSha,
          user: store.viewerLogin,
          created_at: stamp,
          updated_at: stamp,
          merged_at: null,
          merge_commit_sha: null,
        };
        repo.pulls.push(pull);
        send(201, pullJson(repo, pull));
        return true;
      }
      return notFound(), true;
    }

    if (rest.length === 2) {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return notFound(), true;
      const pull = findPull(number);
      if (pull === undefined) return notFound(), true;
      if (method === 'GET') {
        send(200, pullJson(repo, pull));
        return true;
      }
      return notFound(), true;
    }

    if (rest.length === 3 && rest[2] === 'files') {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return notFound(), true;
      const pull = findPull(number);
      if (pull === undefined) return notFound(), true;
      if (method !== 'GET') return notFound(), true;
      const baseTree = store.readTree(repo, treeShaOfCommit(repo, pull.baseSha));
      const headTree = store.readTree(repo, treeShaOfCommit(repo, pull.headSha));
      const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
      const files: JsonObj[] = [];
      for (const path of [...paths].sort()) {
        const b = baseTree.get(path);
        const h = headTree.get(path);
        if (b !== undefined && h !== undefined && b.sha === h.sha) continue;
        const oldData = b === undefined ? Buffer.alloc(0) : (repo.objects.get(b.sha)?.data ?? Buffer.alloc(0));
        const newData = h === undefined ? Buffer.alloc(0) : (repo.objects.get(h.sha)?.data ?? Buffer.alloc(0));
        let status: string;
        let additions: number;
        let deletions: number;
        if (b === undefined) {
          status = 'added';
          additions = lineCount(newData);
          deletions = 0;
        } else if (h === undefined) {
          status = 'removed';
          additions = 0;
          deletions = lineCount(oldData);
        } else {
          status = 'modified';
          ({ additions, deletions } = lineDiff(oldData, newData));
        }
        files.push({
          sha: h?.sha ?? b?.sha ?? '',
          filename: path,
          status,
          additions,
          deletions,
          changes: additions + deletions,
          blob_url: `https://github.com/${owner}/${repoName}/blob/${pull.headSha}/${path}`,
          raw_url: `https://github.com/${owner}/${repoName}/raw/${pull.headSha}/${path}`,
          contents_url: `https://api.github.com/repos/${owner}/${repoName}/contents/${path}?ref=${pull.headSha}`,
        });
      }
      send(200, files);
      return true;
    }

    if (rest.length === 3 && rest[2] === 'merge') {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return notFound(), true;
      const pull = findPull(number);
      if (pull === undefined) return notFound(), true;
      if (method !== 'PUT') return notFound(), true;
      if (pull.merged || pull.state === 'closed') {
        sendError(405, 'Pull request is already merged or closed');
        return true;
      }
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      const baseTreeSha = treeShaOfCommit(repo, baseTip);
      const headTreeSha = treeShaOfCommit(repo, pull.headSha);
      const ancestor = mergeBase(repo, pull.headSha, baseTip);
      const ancestorTreeSha = ancestor === null ? null : treeShaOfCommit(repo, ancestor);
      const { treeSha, conflict } = store.mergeTrees(repo, baseTreeSha, headTreeSha, ancestorTreeSha);
      if (conflict) {
        pull.mergeable = false;
        sendError(405, 'Merge conflict: the pull request cannot be merged cleanly');
        return true;
      }
      const message = `Merge pull request #${pull.number} from ${store.viewerLogin}/${pull.headRef}\n\n${pull.title}`;
      const squashSha = store.buildCommit(repo, treeSha, [baseTip], message, IDENTITY);
      repo.refs.set(`refs/heads/${pull.baseRef}`, squashSha);
      const stamp = store.nowIso();
      repo.updated_at = stamp;
      pull.state = 'closed';
      pull.merged = true;
      pull.merged_at = stamp;
      pull.merge_commit_sha = squashSha;
      pull.updated_at = stamp;
      send(200, { sha: squashSha, merged: true, message: 'Pull request successfully merged' });
      return true;
    }
    return notFound(), true;
  }

  return notFound(), true;
}
