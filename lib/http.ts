// Shared HTTP plumbing for the forge's surfaces: body reading, JSON answers with the
// headers the protocol checks require (a JSON content type and a non-empty
// X-GitHub-Request-Id on every API response), and the bearer-token rule: the token is
// the process's MAKEFUN_SHOP_TOKEN, and a request with no token or a different one is
// unauthenticated.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A unique, non-empty request id for the X-GitHub-Request-Id header. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

/** Whether the request carries the trial's bearer token. */
export function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return header === `Bearer ${expected}`;
  // No token configured (local development only): any bearer token authenticates,
  // but a request with none is still unauthenticated.
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

/** Read a whole request body. Bodies in this suite are small; the cap is a guard rail. */
export function readBody(req: IncomingMessage, cap = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Answer with a JSON body and the forge's standard API headers. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with raw bytes (git protocol responses carry their own content type). */
export function sendBytes(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    'cache-control': 'no-cache',
    ...headers,
  });
  res.end(body);
}

/** GitHub's error shape: a JSON object with a non-empty string message. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Parse a JSON request body; on failure answer 400 and return undefined. */
export function parseJsonBody(res: ServerResponse, body: Buffer): Record<string, unknown> | undefined {
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendError(res, 400, 'Problems parsing JSON');
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
