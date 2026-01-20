export type PageParams = {
  deviceParam: string | null;
  wsServer: string;
};

export type HashAction =
  | { action: 'shell'; params: URLSearchParams }
  | { action: 'list-files'; params: URLSearchParams }
  | { action: undefined; params: URLSearchParams };

const DEFAULT_FALLBACK_PORT = 11000;

function normalizeWsUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      throw new Error('bad ws protocol');
    }
    if (!u.pathname || u.pathname === '') u.pathname = '/';
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    throw new Error('Invalid ws= value. Example: ws://127.0.0.1:11000/');
  }
}

function guessWsServer(search: string): string {
  const params = new URLSearchParams(search);

  const wsOverride = params.get('ws');
  if (wsOverride) return normalizeWsUrl(wsOverride);

  const portParam = params.get('port');
  if (portParam) {
    const p = Number(portParam);
    if (!Number.isFinite(p) || p <= 0 || p >= 65536) {
      throw new Error('Invalid port=. Must be 1..65535');
    }
    return `ws://127.0.0.1:${p}/`;
  }

  // ✅ default luôn 11000, không phụ thuộc port trang đang serve (5500)
  return `ws://127.0.0.1:${DEFAULT_FALLBACK_PORT}/`;
}

export function readPageParams(): PageParams {
  const params = new URLSearchParams(window.location.search);

  // Support both query param (?device=xxx) and path param (/device=xxx)
  // Example: http://localhost:5500/device=emulator-5554
  let deviceParam = params.get('device');
  if (!deviceParam) {
    const path = window.location.pathname || '';
    // split by '/' and find a segment like "device=xxx"
    const segs = path.split('/').filter(Boolean);
    const seg = segs.find((s) => s.startsWith('device='));
    if (seg) {
      const raw = seg.slice('device='.length);
      try {
        deviceParam = decodeURIComponent(raw);
      } catch {
        deviceParam = raw;
      }
    }
  }

  let wsServer: string;
  try {
    wsServer = guessWsServer(window.location.search);
  } catch (e) {
    console.error(e);
    wsServer = `ws://127.0.0.1:${DEFAULT_FALLBACK_PORT}/`;
  }

  return { deviceParam, wsServer };
}

/**
 * Parse hash in the form `#!action=shell&udid=xxx&...`
 */
export function readHashAction(): HashAction {
  const raw = window.location.hash || '';
  if (!raw.startsWith('#!')) {
    return { action: undefined, params: new URLSearchParams() };
  }
  const params = new URLSearchParams(raw.slice(2));
  const action = params.get('action') || undefined;
  if (action === 'shell') {
    return { action, params };
  }
  if (action === 'list-files') {
    return { action, params };
  }
  return { action: undefined, params };
}
