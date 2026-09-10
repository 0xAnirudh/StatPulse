import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'node:dns/promises';
import {
  isBlockedAddress,
  parseTarget,
  resolveTarget,
  assertSafeTarget,
  pinnedLookup,
  UnsafeTargetError,
  v6ToBytes,
} from '../../packages/core/src/util/ssrf.js';

afterEach(() => vi.restoreAllMocks());

describe('blocked address ranges', () => {
  const blocked = [
    ['loopback', '127.0.0.1'],
    ['loopback, the far end of the /8', '127.255.255.254'],
    ['cloud metadata', '169.254.169.254'],
    ['link-local generally', '169.254.1.1'],
    ['RFC1918 ten', '10.0.0.1'],
    ['RFC1918 ten, high', '10.255.255.255'],
    ['RFC1918 172.16', '172.16.0.1'],
    ['RFC1918 172.31 - the top of the /12', '172.31.255.255'],
    ['RFC1918 192.168', '192.168.1.1'],
    ['CGNAT', '100.64.0.1'],
    ['this network', '0.0.0.0'],
    ['multicast', '224.0.0.1'],
    ['reserved', '240.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unspecified', '::'],
    ['IPv6 unique local', 'fc00::1'],
    ['IPv6 unique local, fd', 'fd12:3456::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped metadata', '::ffff:169.254.169.254'],
  ];

  for (const [label, ip] of blocked) {
    it(`blocks ${label} (${ip})`, () => {
      expect(isBlockedAddress(ip)).toBe(true);
    });
  }

  const allowed = [
    ['a public resolver', '8.8.8.8'],
    ['another', '1.1.1.1'],
    ['an ordinary host', '93.184.216.34'],
    ['just outside 172.16/12', '172.32.0.1'],
    ['just below 172.16/12', '172.15.255.255'],
    ['just outside CGNAT', '100.128.0.1'],
    ['a public IPv6', '2606:4700:4700::1111'],
  ];

  for (const [label, ip] of allowed) {
    it(`allows ${label} (${ip})`, () => {
      expect(isBlockedAddress(ip)).toBe(false);
    });
  }

  it('refuses anything that is not an address at all', () => {
    // Fails closed. An unparseable answer is not a licence to connect.
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('v6ToBytes', () => {
  it('expands compressed, full and mapped forms alike', () => {
    expect(Array.from(v6ToBytes('::1')).at(-1)).toBe(1);
    expect(Array.from(v6ToBytes('fe80::1')).slice(0, 2)).toEqual([0xfe, 0x80]);
    expect(Array.from(v6ToBytes('2606:4700:4700::1111')).slice(0, 4)).toEqual([
      0x26, 0x06, 0x47, 0x00,
    ]);
  });

  it('ignores a zone id', () => {
    expect(Array.from(v6ToBytes('fe80::1%en0')).slice(0, 2)).toEqual([0xfe, 0x80]);
  });
});

describe('parseTarget', () => {
  const rejected = [
    ['a file URL', 'file:///etc/passwd', 'scheme'],
    ['a gopher URL', 'gopher://example.com/', 'scheme'],
    ['a data URL', 'data:text/plain,hello', 'scheme'],
    ['an ftp URL', 'ftp://example.com/', 'scheme'],
    ['credentials in the URL', 'http://admin:hunter2@example.com/', 'credentials'],
    ['a username alone', 'http://admin@example.com/', 'credentials'],
    ['the ssh port', 'http://example.com:22/', 'port'],
    ['the redis port', 'http://example.com:6379/', 'port'],
    ['the postgres port', 'http://example.com:5432/', 'port'],
    ['the mongo port', 'http://example.com:27017/', 'port'],
    ['the smtp port', 'http://example.com:25/', 'port'],
    ['nonsense', 'not a url at all', 'malformed'],
  ];

  for (const [label, url, reason] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => parseTarget(url)).toThrow(UnsafeTargetError);
      try {
        parseTarget(url);
      } catch (err) {
        expect(err.reason).toBe(reason);
      }
    });
  }

  const accepted = [
    'http://example.com/health',
    'https://api.example.com/v1/status',
    'https://example.com:8443/healthz',
    'http://example.com:3000/',
  ];

  for (const url of accepted) {
    it(`accepts ${url}`, () => {
      expect(() => parseTarget(url)).not.toThrow();
    });
  }
});

describe('resolveTarget', () => {
  it('refuses a literal private address without consulting DNS', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    await expect(
      resolveTarget(new URL('http://169.254.169.254/latest/meta-data/')),
    ).rejects.toThrow(/not a permitted address/);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves into private space', async () => {
    // The shape of a real attack: a name the attacker controls, pointed
    // at the metadata endpoint.
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(resolveTarget(new URL('http://evil.example.com/'))).rejects.toThrow(
      /resolves to 169\.254\.169\.254/,
    );
  });

  it('refuses when only ONE of several answers is private', async () => {
    // Checking just the first answer would let this through, and then
    // the connection goes to whichever the resolver returns next.
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(resolveTarget(new URL('http://mixed.example.com/'))).rejects.toThrow(
      /not a permitted address/,
    );
  });

  it('allows a public host', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(resolveTarget(new URL('http://example.com/'))).resolves.toEqual(['93.184.216.34']);
  });

  it('can be told to allow private space for a self-hosted install', async () => {
    const url = new URL('http://10.0.0.5/health');
    await expect(resolveTarget(url, { allowPrivate: true })).resolves.toEqual(['10.0.0.5']);
  });

  it('treats an unresolvable name as unsafe, not as an error to ignore', async () => {
    vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
    await expect(resolveTarget(new URL('http://nope.invalid/'))).rejects.toThrow(UnsafeTargetError);
  });
});

describe('DNS rebinding', () => {
  it('pins the connection to the address that was approved', async () => {
    // The gap that defeats most hand-written filters: validate the
    // hostname, then hand the *hostname* to the HTTP client, which
    // resolves it a second time and gets a different answer.
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const { lookup } = await assertSafeTarget('http://rebind.example.com/health');

    // Whatever DNS says a moment later, the agent is told this.
    const resolved = await new Promise((done) =>
      lookup('rebind.example.com', {}, (_err, address) => done(address)),
    );
    expect(resolved).toBe('93.184.216.34');
  });

  it('hands back every approved address when asked for all of them', async () => {
    const lookup = pinnedLookup(['93.184.216.34', '93.184.216.35']);
    const all = await new Promise((done) =>
      lookup('example.com', { all: true }, (_err, addresses) => done(addresses)),
    );
    expect(all).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ]);
  });
});
