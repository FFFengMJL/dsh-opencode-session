/**
 * dsh-opencode-session
 *
 * OpenCode Go requires a stable `x-opencode-session` per conversation. pi-ai
 * adds it inside its built-in `opencode` / `opencode-go` providers, but a
 * hand-declared route (for example `opencode-go-extra`) is built by DSH from
 * parts and misses that wrapper. A static header in `cordis.patch.yml` works,
 * but every DSH conversation then shares one routing / cache id.
 *
 * This plugin keeps the header dynamic through the pi-ai request-header
 * waterfall introduced in DSH 0.2.2:
 *
 *   llm-pi-ai/request-headers (request, headers, next)
 *     -> request carries provider / model / sessionId / purpose / baseURL
 *     -> a matching provider + OpenCode endpoint gets
 *        `x-opencode-session: dsh-<sessionId>`
 *     -> every other request passes through untouched
 *
 * The hook is synchronous and per request, so it needs no AsyncLocalStorage
 * and no process-wide fetch wrapper. It never overwrites an existing header,
 * so a static-header route keeps working during migration.
 *
 * The endpoint matcher is configurable (`host`, `pathPrefix`) so a reverse
 * proxy in front of OpenCode can use the same plugin.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

export const name = 'opencode-session';
export const inject = ['llm'];

const DEFAULT_PROVIDERS = ['opencode-go-extra'];
const DEFAULT_HEADER = 'x-opencode-session';
const DEFAULT_PREFIX = 'dsh-';
const DEFAULT_HOST = 'opencode.ai';
const DEFAULT_PATH_PREFIX = '/inference/go/';

/** RFC 9110 `token`: the only legal shape for a header name. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Printable ASCII means no controls and no non-ASCII bytes in a header value. */
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
/** Session ids that need no escaping: short enough for a readable header value. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** The digest namespace. A safe id with this shape must also be hashed. */
const DIGEST_NAMESPACE = /^h-[0-9a-f]{64}$/;
const MAX_PREFIX_LENGTH = 64;

/** Throw a configuration error that names the offending field. */
function invalid(field, message) {
  throw new TypeError(`opencode-session: invalid "${field}": ${message}`);
}

/**
 * Normalize the configured endpoint host.
 *
 * A bare hostname, `hostname:port`, or a full HTTP(S) URL is accepted. Only
 * the hostname is kept: the scheme and port never participate in matching.
 */
function normalizeHost(value) {
  if (value === undefined || value === null) return DEFAULT_HOST;
  if (typeof value !== 'string') invalid('host', 'expected a hostname or URL string');

  const trimmed = value.trim();
  if (trimmed === '') invalid('host', 'must not be empty');

  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed);
  let url;
  try {
    url = new URL(hasScheme ? trimmed : `http://${trimmed}`);
  } catch {
    invalid('host', `cannot parse ${JSON.stringify(value)} as a hostname or URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    invalid('host', 'only http and https URLs are supported');
  }
  if (url.hostname === '') invalid('host', 'hostname is empty');
  if (url.username !== '' || url.password !== '') {
    invalid('host', 'must not contain credentials');
  }
  if (!hasScheme && (url.pathname !== '/' || url.search !== '' || url.hash !== '')) {
    invalid('host', 'a bare host must not contain a path, query, or fragment; use a full URL');
  }
  return url.hostname.toLowerCase();
}

/**
 * Normalize the endpoint path prefix.
 *
 * Matching is a literal `pathname.startsWith()`, so a prefix meant to cover
 * one path segment needs its trailing slash (`/v1/`, not `/v1`).
 */
function normalizePathPrefix(value) {
  if (value === undefined || value === null) return DEFAULT_PATH_PREFIX;
  if (typeof value !== 'string') invalid('pathPrefix', 'expected a string');

  const trimmed = value.trim();
  if (trimmed === '') return DEFAULT_PATH_PREFIX;
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (/[^\x21-\x7E]/.test(prefixed)) {
    invalid('pathPrefix', 'must contain printable ASCII without spaces or control characters');
  }
  if (prefixed.includes('?') || prefixed.includes('#')) {
    invalid('pathPrefix', 'must be a pathname prefix without a query or fragment');
  }
  return prefixed;
}

/** Normalize the route list; an omitted or empty list keeps the default. */
function normalizeProviders(value) {
  if (value === undefined || value === null) return [...DEFAULT_PROVIDERS];
  if (!Array.isArray(value)) invalid('providers', 'expected an array of route names');
  if (value.length === 0) return [...DEFAULT_PROVIDERS];

  return value.map((provider, index) => {
    if (typeof provider !== 'string' || provider.trim() === '') {
      invalid(`providers[${index}]`, 'expected a non-empty route name');
    }
    return provider.trim();
  });
}

/** Validate the header name at load time instead of failing inside a request. */
function normalizeHeaderName(value) {
  if (value === undefined || value === null) return DEFAULT_HEADER;
  if (typeof value !== 'string') invalid('headerName', 'expected a string');

  const trimmed = value.trim();
  if (trimmed === '') invalid('headerName', 'must not be empty');
  if (!HEADER_NAME.test(trimmed)) {
    invalid('headerName', `expected an HTTP token, got ${JSON.stringify(value)}`);
  }
  return trimmed;
}

/** Validate the literal prefix prepended to the session id. */
function normalizePrefix(value) {
  if (value === undefined || value === null) return DEFAULT_PREFIX;
  if (typeof value !== 'string') invalid('prefix', 'expected a string');
  if (value.length > MAX_PREFIX_LENGTH) {
    invalid('prefix', `must be at most ${MAX_PREFIX_LENGTH} characters`);
  }
  if (!PRINTABLE_ASCII.test(value)) {
    invalid('prefix', 'must contain printable ASCII characters only');
  }
  if (value !== value.trim()) {
    invalid('prefix', 'must not start or end with whitespace');
  }
  return value;
}

/** Validate the optional diagnostic log path. */
function normalizeDebugLog(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    invalid('debugLog', 'expected a non-empty file path');
  }
  return value;
}

/**
 * Normalize the plugin row config. Keeping this dependency-free makes the
 * plugin loadable without the profile's DSH packages.
 * @param raw - the row config from cordis.patch.yml.
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const providerList = normalizeProviders(source.providers);
  return {
    providers: new Set(providerList),
    providerList,
    headerName: normalizeHeaderName(source.headerName),
    prefix: normalizePrefix(source.prefix),
    host: normalizeHost(source.host),
    pathPrefix: normalizePathPrefix(source.pathPrefix),
    debugLog: normalizeDebugLog(source.debugLog),
    fallbackSessionId: `aux-${randomUUID()}`,
  };
}

/** True only for the configured OpenCode endpoint (host + literal path prefix). */
function isOpenCodeEndpoint(rawUrl, config) {
  if (typeof rawUrl !== 'string' && !(rawUrl instanceof URL)) return false;
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.hostname === config.host && url.pathname.startsWith(config.pathPrefix);
}

/** A header-safe, stable value derived from the DSH session id. */
function headerValue(sessionId, config) {
  // Safe ids stay readable and keep the value produced by earlier releases.
  // The digest namespace is reserved: a safe id that already looks like
  // `h-<sha256>` is hashed too, otherwise it could equal the digest of a
  // different unsafe id.
  if (SAFE_SESSION_ID.test(sessionId) && !DIGEST_NAMESPACE.test(sessionId)) {
    return `${config.prefix}${sessionId}`;
  }

  // Anything else is canonicalized to a digest of the complete id. Replacing
  // characters or truncating would make different ids collide deterministically.
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  return `${config.prefix}h-${digest}`;
}

/**
 * Resolve the per-session header for one request.
 * @param request - pi-ai request identity (provider, sessionId, baseURL, ...).
 * @param config - normalized plugin config.
 * @returns the header value, or undefined when this request is out of scope.
 */
function sessionHeader(request, config) {
  if (!config.providers.has(request.provider)) return undefined;
  if (!isOpenCodeEndpoint(request.baseURL, config)) return undefined;

  const raw = request.sessionId;
  const sessionId =
    raw === undefined || raw === null || raw === ''
      ? config.fallbackSessionId
      : String(raw);
  return headerValue(sessionId, config);
}

/** Escape one field so a diagnostic line always stays on a single line. */
function escapeField(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

/**
 * Append one diagnostic line. The waterfall is synchronous, so this uses a
 * synchronous write; the option is off in normal use and a failed diagnostic
 * write must never fail the model request.
 */
function writeDebugLog(config, request, value) {
  if (config.debugLog === undefined) return;
  try {
    appendFileSync(
      config.debugLog,
      `${new Date().toISOString()}\t${escapeField(request.provider)}\t${escapeField(request.sessionId ?? '')}\t${escapeField(value)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // Diagnostics are best effort only.
  }
}

/**
 * Cordis entry point.
 * @param ctx - the plugin context.
 * @param rawConfig - the plugin row config.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);

  ctx.effect(() => {
    const off = ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
      // Let downstream listeners finish first, then layer our header on top.
      const base = next();
      const value = sessionHeader(request, config);
      if (value === undefined) return base;

      const out = new Headers(base);
      // An existing header wins, so a static route keeps working during migration.
      if (out.has(config.headerName)) return out;
      out.set(config.headerName, value);
      writeDebugLog(config, request, value);
      return out;
    });

    ctx.logger?.('opencode-session')?.debug?.(
      `per-session ${config.headerName} for ${config.providerList.join(', ')} at ${config.host}${config.pathPrefix}`,
    );

    return () => {
      if (typeof off === 'function') off();
    };
  }, 'opencode-session: per-session header');
}
