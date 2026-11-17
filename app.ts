// app.ts — the forge's HTTP server: one shared Store, four surfaces.
//
// The router reads the request body once (as a raw Buffer — the git surface
// needs binary packfiles, the others JSON) and hands it to each surface
// handler in turn. A handler returns true when the path is its own and it
// answered; false falls through to the next surface, then a JSON 404.
//
// Surfaces, in dispatch order:
//   GET /healthz            — the env's boot probe (200 {"ok":true}).
//   /{owner}/{repo}.git/*   — git smart HTTP (lib/git.ts).
//   /api/v3/*               — REST v3 (lib/rest.ts).
//   /api/graphql            — GraphQL v4 (lib/graphql.ts).
//   /mcp                    — MCP over Streamable HTTP (lib/mcp.ts).
//
// The Store is created once per process and shared by all four surfaces, so
// a repo/issue/PR created over any one of them reads back over the others
// with the same ids. Nothing here uses Date.now or Math.random; the store's
// deterministic clock is the only source of timestamps.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './lib/store.ts';
import { handleGit } from './lib/git.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** One shared store for the whole process: every surface sees the same state. */
const store = new Store();

/** Answer one request with a JSON body. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Read the whole request body as one Buffer (empty when there is no body). */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Dispatch one request: health probe, then the four surfaces, then a JSON 404. */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const body = await readBody(req);
  if (await handleGit(store, req, res, body)) return;
  if (await handleRest(store, req, res, body)) return;
  if (await handleGraphql(store, req, res, body)) return;
  if (await handleMcp(store, req, res, body)) return;

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch((err: unknown) => {
      // A request must never take the process down: answer 500 (or drop the
      // socket when the headers are already gone) and keep serving.
      process.stderr.write(`[app] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.destroy();
      } catch {
        // Nothing left to do for this socket.
      }
    });
  });
}
