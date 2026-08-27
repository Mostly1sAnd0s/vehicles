/**
 * Co-op addressing helpers (LAN hosting). Pure: no Node APIs, no DOM, no `ws` — safe to import from
 * the browser (`public/src` symlinks `src/`) and to unit-test under `node --test`.
 *
 * Why this exists: the co-op gateway is merged into the static server (one port, one process), so
 * "the address of the host" is *usually* just "the address that served this page". The remaining
 * cases — a joiner whose page came from somewhere else, a host that needs to learn its own LAN IP,
 * an invite link pasted into the address field — are all string plumbing, and all of it lives here
 * so the panel stays DOM glue.
 *
 * The one thing a browser genuinely cannot know is its own LAN IP (mDNS/ICE obfuscation), so the
 * server answers `GET /info` and `pickLanInterfaces()` decides which interface to advertise.
 */

export const DEFAULT_PORT = 8080;
export const CODE_LEN = 6;

/** A world code is exactly 6 unambiguous alphanumerics (see gateway's CODE_ALPHABET). */
export function normalizeCode(raw) {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
  return code.length === CODE_LEN ? code : null;
}

/**
 * Read a join code out of a URL fragment: `#join=K7M2QF`, `?join=…` in a query string, `#code=…`,
 * or a bare 6-char fragment (`#K7M2QF`). Returns null for anything that isn't a full code, so a
 * stale/typo'd fragment falls back to the normal Host/Join form instead of a doomed auto-join.
 */
export function joinCodeFromHash(hash) {
  const raw = String(hash ?? '').replace(/^[#?]+/, '');
  if (!raw) return null;
  for (const part of raw.split(/[&?]/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key === 'join' || key === 'code' || key === 'world') {
      const code = normalizeCode(decodeURIComponent(part.slice(eq + 1)));
      if (code) return code;
    }
  }
  return /^[A-Za-z0-9]{6}$/.test(raw) ? normalizeCode(raw) : null;
}

/** `{protocol, hostname, port}` from a URL string or object; null when there is no usable origin. */
function originParts(origin) {
  if (!origin) return null;
  let p = origin;
  if (typeof origin === 'string') {
    const m = /^(?:(wss|https?):)?\/\/([^/?#]*)/.exec(origin.trim());
    if (!m) return null;
    const { host: hostish, port } = splitHostPort(m[2]);
    if (!hostish) return null;
    p = { protocol: m[1] ? m[1] + ':' : null, hostname: hostish, port: port ?? '' };
  }
  const hostname = String(p.hostname ?? '').replace(/^\[|\]$/g, '');
  if (!hostname || p.protocol === 'file:') return null;
  const secure = p.protocol ? /wss|https/.test(p.protocol) : false;
  const port = String(p.port ?? '').replace(/^:/, '');
  return { hostname, port: port || (secure ? '443' : '80'), secure };
}

/** `host:port` / `[::1]:8080` → `{host, port|null}` (bracketed IPv6 keeps its colons). */
function splitHostPort(s) {
  const str = String(s ?? '').trim();
  if (!str) return { host: '', port: null };
  if (str.startsWith('[')) {
    const close = str.indexOf(']');
    if (close < 0) return { host: str.replace(/^\[/, ''), port: null };
    const host = str.slice(1, close);
    const rest = str.slice(close + 1);
    return { host, port: rest.startsWith(':') ? rest.slice(1) : '' };
  }
  const i = str.lastIndexOf(':');
  if (i < 0) return { host: str, port: null };
  // A bare IPv6 fragment (more than one colon, no brackets) is not something to type into this field.
  if (str.indexOf(':') !== i) return { host: str, port: null, tooManyColons: true };
  return { host: str.slice(0, i), port: str.slice(i + 1) };
}

const HOST_RE = /^[A-Za-z0-9._-]+$/; // IPv4, DNS names, and `foo.local` Bonjour names

/**
 * Resolve what the "Host address" field means into a concrete `{host, port, secure}`.
 *
 * Accepts (all equivalent for a LAN with one server per machine):
 *   '' (empty)                 → the origin that served this page (the normal case: the joiner
 *                                followed an invite link, so the answer is already in the URL bar)
 *   '192.168.1.20'             → that host, defaultPort
 *   '192.168.1.20:8080'        → host + port
 *   'adams-macbook-pro.local'  → Bonjour name
 *   'http://192.168.1.20:8080' | 'ws://…' | 'wss://host'  → scheme honoured (secure from wss/https)
 *   'http://192.168.1.20:8080/#join=K7M2QF'                → full invite; code is extracted too
 *
 * @param {string} raw           field value (may be empty)
 * @param {{origin?:string|{protocol?:string,hostname?:string,port?:string}, defaultPort?:number}} [opts]
 * @returns {{ok:true, host:string, port:number, secure:boolean, source:'input'|'origin', code:string|null}
 *          | {ok:false, error:string, source:'input'|'origin'}}
 */
export function parseHostInput(raw, { origin, defaultPort = DEFAULT_PORT } = {}) {
  const fromOrigin = () => {
    const o = originParts(origin);
    if (!o) {
      return {
        ok: false,
        source: 'origin',
        error: 'no server address — this page was not loaded from a server, so type the host\u2019s IP (Advanced)',
      };
    }
    return { ok: true, host: o.hostname, port: Number(o.port) || defaultPort, secure: o.secure, source: 'origin', code: null };
  };

  let str = String(raw ?? '').trim().replace(/^["'<]|["'>]$/g, '');
  if (!str || /^(auto|same|origin|-)$/i.test(str)) return fromOrigin();

  // An invite URL carries the code in its fragment: keep it, then strip the rest of the URL.
  let code = null;
  const hashAt = str.indexOf('#');
  if (hashAt >= 0) {
    code = joinCodeFromHash(str.slice(hashAt + 1));
    str = str.slice(0, hashAt);
  }
  str = str.split('?')[0];

  let secure = null;
  const scheme = /^(wss|ws|https?):\/\/(.*)$/i.exec(str);
  if (scheme) {
    secure = /wss|https/i.test(scheme[1]);
    str = scheme[2];
  }
  str = str.replace(/\/+$/, '').split('/')[0]; // drop any path: only host[:port] is meaningful here

  const { host, port, tooManyColons } = splitHostPort(str);
  if (!host) return { ok: false, source: 'input', error: 'enter an address like 192.168.1.20:8080' };
  if (tooManyColons) {
    return { ok: false, source: 'input', error: 'IPv6 needs brackets, e.g. [fe80::1]:8080 — an IPv4 address or *.local name is easier' };
  }
  if (!HOST_RE.test(host)) return { ok: false, source: 'input', error: `"${host}" is not a valid host name or IP address` };

  let outPort;
  if (port) {
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      return { ok: false, source: 'input', error: `"${port}" is not a port number (1-65535)` };
    }
    outPort = Number(port);
  } else {
    // No port typed. A URL whose host is the page's own host keeps the page's port; an explicit
    // secure scheme means its standard port; otherwise assume "the app on that machine" — which on
    // a LAN is served on the same port as this page, not on 80.
    const o = originParts(origin);
    if (scheme && o && o.hostname === host) outPort = Number(o.port);
    else if (scheme && secure) outPort = 443;
    else outPort = Number(defaultPort) || DEFAULT_PORT;
  }
  if (secure === null) secure = originParts(origin)?.secure ?? false;
  return { ok: true, host, port: outPort, secure, source: 'input', code };
}

export const buildWsUrl = ({ host, port, secure = false } = {}) =>
  `${secure ? 'wss' : 'ws'}://${host}:${port}`;

/** The one string a host shares: opening it serves the app *from that host* and joins the world. */
export const buildInvite = ({ host, port, code, secure = false } = {}) =>
  `${secure ? 'https' : 'http'}://${host}:${port}/#join=${code}`;

export const formatHostPort = ({ host, port }) => `${host}:${port}`;

// --- LAN interface selection (server side; pure over injected os.networkInterfaces() output) ----

// Interfaces that are never a LAN address worth advertising: loopback, VPN tunnels, Apple
// AWDL/awdl/llw (AirDrop), Thunderbolt bridges, hotspot APs, container/VM plumbing.
const EXCLUDE_PREFIXES = [
  'lo', 'utun', 'awdl', 'llw', 'ap', 'an', 'bridge', 'vmnet', 'vnic', 'docker', 'veth',
  'br-', 'vbox', 'virbr', 'tun', 'tap', 'ppp', 'ipsec', 'zt', 'tailscale', 'gif', 'stf',
  'pktap', 'feth', 'gpd', 'lladdr',
];
// Likely-real LAN hardware, in the order a person usually means it (macOS Wi-Fi is en0).
const PREFERRED = ['en0', 'en1', 'en2', 'en3', 'eth0', 'eth1', 'wlan0', 'wlan1', 'ens', 'enp', 'em', 'igb'];

const isExcludedName = (name) => {
  const n = String(name ?? '').toLowerCase();
  return EXCLUDE_PREFIXES.some((p) => n.startsWith(p));
};

const isLinkLocalOrLoopback = (addr) => {
  const a = String(addr ?? '');
  return !a || a.startsWith('127.') || a.startsWith('169.254.') || a.startsWith('::')
    || /^fe80/i.test(a);
};

// Node <18 reported family as 4/6, newer as 'IPv4'/'IPv6'; some callers hand us a bare address.
const familyOf = (a) => {
  const f = String(a?.family ?? '').toUpperCase();
  if (f === 'IPV4' || f === '4') return 'IPv4';
  if (f === 'IPV6' || f === '6') return 'IPv6';
  return String(a?.address ?? '').includes(':') ? 'IPv6' : 'IPv4';
};

/**
 * Pick the interface(s) to advertise on a LAN, best first.
 * @param {Record<string, Array<{address:string, family:*, internal?:boolean}>>|Array<{name:string,addrs:Array<object>}>} ifaces
 * @param {{family?:'IPv4'|'IPv6', limit?:number}} [opts]
 * @returns {Array<{name:string, address:string, cidr?:string, netmask?:string}>}
 */
export function pickLanInterfaces(ifaces, { family = 'IPv4', limit = 4 } = {}) {
  const entries = Array.isArray(ifaces)
    ? ifaces.map((e) => [e?.name, e?.addrs ?? []])
    : Object.entries(ifaces ?? {});
  const rows = [];
  for (const [name, list] of entries) {
    if (!name || isExcludedName(name)) continue;
    for (const a of list ?? []) {
      if (!a || a.internal) continue;
      if (familyOf(a) !== family) continue;
      if (isLinkLocalOrLoopback(a.address)) continue;
      rows.push({ name, address: a.address, cidr: a.cidr, netmask: a.netmask });
    }
  }
  const rank = (row) => {
    const n = String(row.name).toLowerCase();
    const exact = PREFERRED.indexOf(n);
    if (exact >= 0) return exact;
    const partial = PREFERRED.findIndex((p) => n.startsWith(p)); // enp0s3, ens192, …
    return partial >= 0 ? PREFERRED.length + partial : PREFERRED.length * 2;
  };
  return rows
    .sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)))
    .slice(0, Math.max(1, limit | 0));
}

/**
 * Body for `GET /info`: the address the host should share, plus every plausible alternate so a
 * machine with Wi-Fi + Ethernet + VPN can pick the right one in the panel.
 */
export function buildServerInfo({ hostname, interfaces, port, secure = false } = {}) {
  const lan = pickLanInterfaces(interfaces);
  const host = lan[0]?.address ?? '127.0.0.1';
  const hostnames = [];
  const h = String(hostname ?? '').trim();
  if (h) {
    hostnames.push(h);
    const bonjour = /\.local$/i.test(h) ? h : `${h.replace(/\..*$/, '')}.local`;
    if (bonjour && !hostnames.includes(bonjour)) hostnames.push(bonjour);
  }
  return {
    port,
    secure,
    lan,                    // [{name,address,cidr}] best-first
    host,                   // what to put in an invite
    hostnames,              // e.g. ['Adams-MacBook-Pro.local'] for people who prefer names
    origin: `${secure ? 'https' : 'http'}://${host}:${port}`,
    wsUrl: `${secure ? 'wss' : 'ws'}://${host}:${port}`,
  };
}

export default parseHostInput;
