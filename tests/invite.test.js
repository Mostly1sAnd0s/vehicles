// LAN addressing helpers: what the "Host address" field means, invite links, and which interface a
// host should advertise. Pure module → pure tests (no sockets, no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCode, joinCodeFromHash, parseHostInput, buildWsUrl, buildInvite, formatHostPort,
  pickLanInterfaces, buildServerInfo,
} from '../src/net/invite.js';

const ORIGIN = 'http://192.168.68.67:8080';

test('normalizeCode: uppercases, sanitizes, needs all 6 characters', () => {
  assert.equal(normalizeCode('k7m2qf'), 'K7M2QF');
  assert.equal(normalizeCode(' k7m-2qf '), 'K7M2QF'); // separators stripped
  assert.equal(normalizeCode('ABC12'), null);          // too short is not a code
  assert.equal(normalizeCode(''), null);
  assert.equal(normalizeCode(null), null);
});

test('joinCodeFromHash: invite fragments', () => {
  assert.equal(joinCodeFromHash('#join=K7M2QF'), 'K7M2QF');
  assert.equal(joinCodeFromHash('join=k7m2qf'), 'K7M2QF');
  assert.equal(joinCodeFromHash('#code=ABCDEF'), 'ABCDEF');
  assert.equal(joinCodeFromHash('?join=ABCDEF'), 'ABCDEF');
  assert.equal(joinCodeFromHash('#K7M2QF'), 'K7M2QF');   // bare fragment
  assert.equal(joinCodeFromHash('#other=K7M2QF'), null); // unrelated fragment
  assert.equal(joinCodeFromHash('#join=AB'), null);      // partial → no auto-join
  assert.equal(joinCodeFromHash(''), null);
  assert.equal(joinCodeFromHash(null), null);
});

test('parseHostInput: empty field means "the server that served this page"', () => {
  for (const raw of ['', '   ', 'auto', 'same']) {
    const r = parseHostInput(raw, { origin: ORIGIN });
    assert.equal(r.ok, true, raw);
    assert.deepEqual({ host: r.host, port: r.port, secure: r.secure, source: r.source },
      { host: '192.168.68.67', port: 8080, secure: false, source: 'origin' });
  }
});

test('parseHostInput: no origin (file://) has nothing to default to, and says so', () => {
  for (const origin of [undefined, null, 'file:///Users/x/public/index.html']) {
    const r = parseHostInput('', { origin });
    assert.equal(r.ok, false, String(origin));
    assert.match(r.error, /type the host/i);
  }
});

test('parseHostInput: bare host gets the page port (the app, not port 80)', () => {
  const r = parseHostInput('192.168.1.20', { origin: ORIGIN });
  assert.equal(r.ok, true);
  assert.deepEqual({ host: r.host, port: r.port, source: r.source },
    { host: '192.168.1.20', port: 8080, source: 'input' });
});

test('parseHostInput: accepts host:port, Bonjour names, and any scheme', () => {
  const cases = [
    ['192.168.1.20:9000', { host: '192.168.1.20', port: 9000, secure: false }],
    ['adams-macbook-pro.local', { host: 'adams-macbook-pro.local', port: 8080, secure: false }],
    ['ws://10.0.0.5:8090', { host: '10.0.0.5', port: 8090, secure: false }],
    ['http://10.0.0.5', { host: '10.0.0.5', port: 8080, secure: false }],
    ['http://192.168.68.67:8080/', { host: '192.168.68.67', port: 8080, secure: false }],
    ['wss://rooms.example.com', { host: 'rooms.example.com', port: 443, secure: true }],
  ];
  for (const [raw, want] of cases) {
    const r = parseHostInput(raw, { origin: ORIGIN });
    assert.equal(r.ok, true, raw);
    assert.deepEqual({ host: r.host, port: r.port, secure: r.secure }, want, raw);
  }
});

test('parseHostInput: a whole invite URL is a valid thing to paste (and yields its code)', () => {
  const r = parseHostInput('http://192.168.1.44:8080/#join=K7M2QF', { origin: ORIGIN });
  assert.equal(r.ok, true);
  assert.deepEqual({ host: r.host, port: r.port, code: r.code },
    { host: '192.168.1.44', port: 8080, code: 'K7M2QF' });
  // …and the same link without a code-bearing fragment still resolves the host.
  assert.equal(parseHostInput('http://192.168.1.44:8080/index.html', { origin: ORIGIN }).host, '192.168.1.44');
});

test('parseHostInput: rejects junk with a usable message', () => {
  const bad = [
    ['not a host', /not a valid host/i],
    ['192.168.1.20:abc', /port number/i],
    ['192.168.1.20:99999', /port number/i],
    ['fe80::1%en0', /IPv6 needs brackets/i],
    ['http://bad host/', /not a valid host/i],
    ['http://:8080', /address like/i],
  ];
  for (const [raw, re] of bad) {
    const r = parseHostInput(raw, { origin: ORIGIN });
    assert.equal(r.ok, false, raw);
    assert.match(r.error, re, raw);
  }
});

test('parseHostInput: https pages get secure sockets by default', () => {
  const r = parseHostInput('', { origin: 'https://rooms.example.com' });
  assert.equal(r.ok, true);
  assert.deepEqual({ host: r.host, port: r.port, secure: r.secure },
    { host: 'rooms.example.com', port: 443, secure: true });
  assert.equal(buildWsUrl(r), 'wss://rooms.example.com:443');
});

test('buildInvite is the round-trip: parse(build(x)) == x', () => {
  const invite = buildInvite({ host: '192.168.1.44', port: 8080, code: 'K7M2QF' });
  assert.equal(invite, 'http://192.168.1.44:8080/#join=K7M2QF');
  const r = parseHostInput(invite, { origin: 'http://localhost:8080' });
  assert.deepEqual({ host: r.host, port: r.port, code: r.code },
    { host: '192.168.1.44', port: 8080, code: 'K7M2QF' });
  assert.equal(formatHostPort(r), '192.168.1.44:8080');
});

// A macOS laptop on Wi-Fi with VPN up: naive "first IPv4" picks a utun tunnel, which nobody can
// join. Ranking must land on en0 and hide the plumbing entirely.
const MAC_IFACES = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
  en0: [{ address: '192.168.68.67', family: 'IPv4', internal: false, cidr: '192.168.68.67/24' }],
  awdl0: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
  llw0: [{ address: 'fe80::2', family: 'IPv6', internal: false }],
  utun0: [{ address: '10.255.1.1', family: 'IPv4', internal: false }],
  utun1: [{ address: '172.20.10.5', family: 'IPv4', internal: false }],
  'bridge0': [{ address: '169.254.172.5', family: 'IPv4', internal: false }],
  'vmnet1': [{ address: '192.168.99.1', family: 'IPv4', internal: false }],
  en1: [{ address: '10.1.1.7', family: 'IPv4', internal: false }],
  en5: [{ address: '169.254.9.9', family: 'IPv4', internal: false }], // Thunderbolt: link-local, useless
  ap1: [{ address: '192.168.2.1', family: 'IPv4', internal: false }],
};

test('pickLanInterfaces: prefers en0, drops VPN/Apple/container/link-local plumbing', () => {
  const picked = pickLanInterfaces(MAC_IFACES);
  assert.deepEqual(picked.map((p) => p.address), ['192.168.68.67', '10.1.1.7']); // en0 then en1
  const names = picked.map((p) => p.name);
  for (const junk of ['utun0', 'utun1', 'bridge0', 'vmnet1', 'ap1', 'lo0', 'awdl0', 'en5']) {
    assert.ok(!names.includes(junk), `must not advertise ${junk}`);
  }
  assert.equal(picked[0].cidr, '192.168.68.67/24');
});

test('pickLanInterfaces: tolerates numeric families, array input, empties, and honours limits', () => {
  assert.deepEqual(pickLanInterfaces({ en0: [{ address: '10.0.0.2', family: 4 }] }),
    [{ name: 'en0', address: '10.0.0.2', cidr: undefined, netmask: undefined }]);
  assert.deepEqual(pickLanInterfaces([{ name: 'eth0', addrs: [{ address: '10.0.0.3', family: 'IPv4' }] }])
    .map((p) => p.address), ['10.0.0.3']);
  assert.deepEqual(pickLanInterfaces(undefined), []);
  assert.deepEqual(pickLanInterfaces({ en0: [], en1: null }), []);
  assert.equal(pickLanInterfaces({
    en0: [{ address: '10.0.0.2', family: 'IPv4' }], en1: [{ address: '10.0.1.2', family: 'IPv4' }],
    en2: [{ address: '10.0.2.2', family: 'IPv4' }], en3: [{ address: '10.0.3.2', family: 'IPv4' }],
  }, { limit: 2 }).length, 2);
  assert.deepEqual(pickLanInterfaces({ en0: [{ address: '127.0.0.2', family: 'IPv4' }] }), []); // loopback range
});

test('pickLanInterfaces: Linux-style predictable names rank sensibly', () => {
  const picked = pickLanInterfaces({
    docker0: [{ address: '172.17.0.1', family: 'IPv4' }],
    veth1a: [{ address: '172.17.0.2', family: 'IPv4' }],
    enp0s3: [{ address: '192.168.1.50', family: 'IPv4' }],
    wlan0: [{ address: '192.168.1.51', family: 'IPv4' }],
  });
  assert.deepEqual(picked.map((p) => p.address), ['192.168.1.51', '192.168.1.50']); // wlan0, enp0s3
});

test('buildServerInfo: advertises one shareable host plus name alternates', () => {
  const info = buildServerInfo({ hostname: 'Adams-MacBook-Pro.local', interfaces: MAC_IFACES, port: 8080 });
  assert.equal(info.host, '192.168.68.67');
  assert.equal(info.port, 8080);
  assert.equal(info.origin, 'http://192.168.68.67:8080');
  assert.equal(info.wsUrl, 'ws://192.168.68.67:8080');
  assert.deepEqual(info.hostnames, ['Adams-MacBook-Pro.local']);
  assert.equal(buildInvite({ host: info.host, port: info.port, code: 'ABC123' }),
    'http://192.168.68.67:8080/#join=ABC123');
  // A bare hostname gets the .local alternate appended, deduped.
  assert.deepEqual(buildServerInfo({ hostname: 'sim-lab', interfaces: {}, port: 8080 }).hostnames,
    ['sim-lab', 'sim-lab.local']);
  // Nothing usable → honest fallback rather than a crash.
  assert.equal(buildServerInfo({ interfaces: {}, port: 8080 }).host, '127.0.0.1');
});
