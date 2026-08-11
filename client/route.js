const ROOT_KEY_PATTERN = /^r_[A-Za-z0-9_-]{22}$/;

function isRootKey(value) {
  return typeof value === 'string' && ROOT_KEY_PATTERN.test(value);
}

export function isMarkdownPath(value) {
  return typeof value === 'string' && /\.(?:md|markdown)$/i.test(value);
}

const IGNORED_QUERY_PARAMETERS = new Set(['lab']);

function decodeSegment(segment) {
  if (!segment) return null;
  try {
    const decoded = decodeURIComponent(segment);
    // A decoded separator would erase the boundary that made segment-wise
    // decoding safe and cannot name one filesystem path segment portably.
    if (!isSafeSegment(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isSafeSegment(segment) {
  return Boolean(segment)
    && segment !== '.'
    && segment !== '..'
    && !segment.includes('/')
    && !segment.includes('\\');
}

function parseInput(input) {
  try {
    return input instanceof URL ? input : new URL(input, 'http://showmd.local');
  } catch {
    return null;
  }
}

// WHATWG URL parsing removes dot segments before exposing pathname. Inspect
// string inputs first so malformed routes cannot silently change identity.
function hasRawDotSegment(input) {
  if (typeof input !== 'string') return false;
  const beforeQuery = input.split(/[?#]/, 1)[0];
  const absolute = beforeQuery.match(/^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/]*(\/.*)?$/);
  const rawPath = absolute ? (absolute[1] || '/') : beforeQuery;
  for (const segment of rawPath.split('/')) {
    try {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..') return true;
    } catch {
      // The regular pathname decoder reports malformed escapes.
    }
  }
  return false;
}

function pathSegments(pathname) {
  if (!pathname.startsWith('/')) return null;
  const raw = pathname.slice(1).split('/');
  if (raw.at(-1) === '') raw.pop();
  if (raw.some((segment) => segment === '')) return null;
  const decoded = raw.map(decodeSegment);
  return decoded.includes(null) ? null : decoded;
}

function decodeRouteValue(value) {
  if (typeof value !== 'string' || !value) return null;
  const segments = value.split('/');
  return segments.every(isSafeSegment) ? value : null;
}

function semanticQuery(searchParams, supported) {
  for (const key of searchParams.keys()) {
    if (!supported.has(key) && !IGNORED_QUERY_PARAMETERS.has(key)) return null;
  }
  const values = {};
  for (const key of supported) {
    const all = searchParams.getAll(key);
    if (all.length > 1) return null;
    if (all.length === 1) values[key] = all[0];
  }
  return values;
}

function optionalRoot(searchParams) {
  const query = semanticQuery(searchParams, new Set(['root']));
  if (!query || (query.root !== undefined && !isRootKey(query.root))) return null;
  return { valid: true, rootKey: query.root };
}

/**
 * Parse one URL-addressable application space. Invalid routes return null.
 * @param {string | URL} input
 * @returns {import('../types/showmd').RouteContext | null}
 */
export function parseRouteContext(input) {
  if (hasRawDotSegment(input)) return null;
  const url = parseInput(input);
  if (!url) return null;
  const segments = pathSegments(url.pathname);
  if (!segments?.length) return null;

  if (segments[0] === 'home') {
    return segments.length === 1 && semanticQuery(url.searchParams, new Set())
      ? { space: 'home' }
      : null;
  }

  if (segments[0] === 'r') {
    if (segments.length < 2 || !isRootKey(segments[1])) return null;
    const query = semanticQuery(url.searchParams, new Set(['scope']));
    if (!query) return null;
    const context = { space: 'root', rootKey: segments[1] };
    if (query.scope !== undefined) {
      const scopePath = decodeRouteValue(query.scope);
      if (!scopePath) return null;
      context.scopePath = scopePath;
    }
    if (segments.length > 2) context.documentPath = segments.slice(2).join('/');
    return context;
  }

  if (segments[0] === 'skills') {
    const query = semanticQuery(url.searchParams, new Set(['scope', 'root', 'context']));
    if (!query) return null;
    const selectors = ['scope', 'root', 'context'].filter((key) => query[key] !== undefined);
    if (selectors.length > 1) return null;
    const context = { space: 'skills', selection: 'global' };
    if (query.scope !== undefined) {
      if (query.scope !== 'all') return null;
      context.selection = 'all';
    } else if (query.root !== undefined) {
      if (!isRootKey(query.root)) return null;
      context.selection = 'root';
      context.rootKey = query.root;
    } else if (query.context !== undefined) {
      if (!query.context) return null;
      context.selection = 'context';
      context.contextKey = query.context;
    }
    if (segments.length > 1) context.documentRoute = segments.slice(1).join('/');
    return context;
  }

  if (segments[0] === 'agents') {
    if (segments.length < 2) return null;
    const selectedRoot = optionalRoot(url.searchParams);
    if (!selectedRoot) return null;
    const context = { space: 'agents', agentKey: segments[1] };
    if (selectedRoot.rootKey) context.rootKey = selectedRoot.rootKey;
    if (segments.length > 2) context.documentRoute = segments.slice(2).join('/');
    return context;
  }

  if (segments[0] === 'settings') {
    if (segments.length !== 1) return null;
    const selectedRoot = optionalRoot(url.searchParams);
    if (!selectedRoot) return null;
    return selectedRoot.rootKey
      ? { space: 'settings', rootKey: selectedRoot.rootKey }
      : { space: 'settings' };
  }

  return null;
}

function encodeRoute(route, field) {
  if (typeof route !== 'string' || !route) throw new TypeError(`${field} must not be empty`);
  const segments = route.split('/');
  if (!segments.every(isSafeSegment)) {
    throw new TypeError(`${field} must contain safe, non-empty path segments`);
  }
  return segments.map(encodeURIComponent).join('/');
}

function requireRootKey(rootKey) {
  if (!isRootKey(rootKey)) throw new TypeError('invalid rootKey');
  return rootKey;
}

function requireExactFields(context, fields) {
  if (Object.keys(context).some((key) => !fields.includes(key))) {
    throw new TypeError('route context has unsupported fields');
  }
}

function appendQuery(pathname, entries) {
  if (!entries.length) return pathname;
  const query = new URLSearchParams(entries);
  return `${pathname}?${query}`;
}

function validateRouteValue(value, field) {
  if (!decodeRouteValue(value)) throw new TypeError(`${field} must contain safe, non-empty path segments`);
  return value;
}

/**
 * Format an application space as its canonical URL.
 * @param {import('../types/showmd').RouteContext} context
 * @returns {string}
 */
export function formatRouteContext(context) {
  if (!context || typeof context !== 'object') throw new TypeError('invalid route context');

  if (context.space === 'home') {
    requireExactFields(context, ['space']);
    return '/home/';
  }

  if (context.space === 'root') {
    requireExactFields(context, ['space', 'rootKey', 'scopePath', 'documentPath']);
    const base = `/r/${requireRootKey(context.rootKey)}/`;
    const pathname = context.documentPath === undefined
      ? base
      : `${base}${encodeRoute(context.documentPath, 'documentPath')}`;
    const entries = context.scopePath === undefined
      ? []
      : [['scope', validateRouteValue(context.scopePath, 'scopePath')]];
    return appendQuery(pathname, entries);
  }

  if (context.space === 'skills') {
    requireExactFields(context, ['space', 'selection', 'rootKey', 'contextKey', 'documentRoute']);
    const pathname = context.documentRoute === undefined
      ? '/skills/'
      : `/skills/${encodeRoute(context.documentRoute, 'documentRoute')}`;
    if (context.selection === 'global') {
      if (context.rootKey !== undefined || context.contextKey !== undefined) throw new TypeError('invalid global selection');
      return pathname;
    }
    if (context.selection === 'all') {
      if (context.rootKey !== undefined || context.contextKey !== undefined) throw new TypeError('invalid all selection');
      return appendQuery(pathname, [['scope', 'all']]);
    }
    if (context.selection === 'root') {
      if (context.contextKey !== undefined) throw new TypeError('invalid root selection');
      return appendQuery(pathname, [['root', requireRootKey(context.rootKey)]]);
    }
    if (context.selection === 'context') {
      if (context.rootKey !== undefined || typeof context.contextKey !== 'string' || !context.contextKey) {
        throw new TypeError('invalid context selection');
      }
      return appendQuery(pathname, [['context', context.contextKey]]);
    }
    throw new TypeError('unknown skills selection');
  }

  if (context.space === 'agents') {
    requireExactFields(context, ['space', 'agentKey', 'rootKey', 'documentRoute']);
    const agentKey = encodeRoute(context.agentKey, 'agentKey');
    if (agentKey.includes('/')) throw new TypeError('agentKey must be one path segment');
    const pathname = context.documentRoute === undefined
      ? `/agents/${agentKey}/`
      : `/agents/${agentKey}/${encodeRoute(context.documentRoute, 'documentRoute')}`;
    const entries = context.rootKey === undefined ? [] : [['root', requireRootKey(context.rootKey)]];
    return appendQuery(pathname, entries);
  }

  if (context.space === 'settings') {
    requireExactFields(context, ['space', 'rootKey']);
    const entries = context.rootKey === undefined ? [] : [['root', requireRootKey(context.rootKey)]];
    return appendQuery('/settings/', entries);
  }

  throw new TypeError('unknown route space');
}
