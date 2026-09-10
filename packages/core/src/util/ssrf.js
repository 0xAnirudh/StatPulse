import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Refusing to fetch things we should not fetch.
 *
 * This is the sharpest edge in the product. An administrator types a URL
 * and this server fetches it - from inside the production network, every
 * sixty seconds, forever. Without a guard that is a port scanner with a
 * pleasant UI, and a way to read the cloud metadata endpoint, which on
 * most providers hands out credentials to anyone who asks from the right
 * place.
 *
 * The rules below are a belt. The braces are running the ping worker in
 * a subnet with no route to anything private, which is an infrastructure
 * task and the real long-term fix - see plan §7.2.
 */

/* ---- address ranges -------------------------------------------------- */

const V4_BLOCKED = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local - includes 169.254.169.254, the metadata endpoint
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

const V6_BLOCKED = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];

const v4ToInt = (ip) => ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);

function v4InRange(ip, [base, bits]) {
  // >>> 0 keeps the shift unsigned; a /8 mask otherwise comes out
  // negative and every comparison against it silently fails.
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0;
}

/** Expand any IPv6 form - compressed, mixed, mapped - into 16 bytes. */
export function v6ToBytes(ip) {
  let address = ip.split('%')[0]; // strip a zone id

  // A trailing IPv4 part (::ffff:127.0.0.1) becomes two hextets.
  const v4 = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    const hex = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    address = address.slice(0, v4.index) + hex;
  }

  const [head, tail] = address.split('::');
  const left = head ? head.split(':').filter(Boolean) : [];
  const right = tail !== undefined && tail ? tail.split(':').filter(Boolean) : [];
  const middle = new Array(8 - left.length - right.length).fill('0');
  const hextets = tail !== undefined ? [...left, ...middle, ...right] : left;

  const bytes = new Uint8Array(16);
  hextets.slice(0, 8).forEach((h, i) => {
    const value = parseInt(h || '0', 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  });
  return bytes;
}

function v6InRange(ip, [base, bits]) {
  const a = v6ToBytes(ip);
  const b = v6ToBytes(base);
  const fullBytes = Math.floor(bits / 8);
  const spareBits = bits % 8;

  for (let i = 0; i < fullBytes; i += 1) if (a[i] !== b[i]) return false;
  if (spareBits === 0) return true;

  const mask = (0xff << (8 - spareBits)) & 0xff;
  return (a[fullBytes] & mask) === (b[fullBytes] & mask);
}

/**
 * Is this address one we refuse to connect to?
 *
 * IPv4-mapped IPv6 is unwrapped first. `::ffff:127.0.0.1` is loopback
 * wearing a hat, and a filter that only knows about v6 ranges waves it
 * straight through - it is one of the two or three most common ways a
 * hand-written SSRF check is defeated.
 */
export function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return V4_BLOCKED.some((range) => v4InRange(ip, range));

  if (net.isIPv6(ip)) {
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isBlockedAddress(mapped[1]);
    return V6_BLOCKED.some((range) => v6InRange(ip, range));
  }

  // Not an address we can reason about, so not one we will connect to.
  return true;
}

/* ---- ports ----------------------------------------------------------- */

/**
 * Nobody's public health check runs on these.
 *
 * Allowing them turns a status page into a convenient way to probe which
 * internal services are listening, and an HTTP request to a Redis port
 * is a well-known way to make Redis execute commands.
 */
const BLOCKED_PORTS = new Set([22, 23, 25, 110, 143, 445, 3306, 5432, 6379, 9200, 11211, 27017]);

/* ---- the check ------------------------------------------------------- */

export class UnsafeTargetError extends Error {
  constructor(reason, detail) {
    super(detail);
    this.name = 'UnsafeTargetError';
    this.reason = reason;
  }
}

/**
 * Everything that can be decided without asking DNS.
 *
 * Split out so that a component can be validated at the moment an admin
 * saves it, with a useful error, rather than only failing silently on
 * the next check.
 */
export function parseTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeTargetError('malformed', 'That is not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeTargetError(
      'scheme',
      `Only http and https are allowed, not ${url.protocol.replace(':', '')}`,
    );
  }

  // file:, gopher: and friends are handled above; credentials are
  // separate. A URL carrying a password would put it in the database, in
  // logs, and on the wire on every check.
  if (url.username || url.password) {
    throw new UnsafeTargetError('credentials', 'Credentials in the URL are not allowed');
  }

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (BLOCKED_PORTS.has(port)) {
    throw new UnsafeTargetError('port', `Port ${port} is not allowed`);
  }

  return url;
}

/**
 * Resolve, and refuse if any answer is an address we will not visit.
 *
 * Every address is checked, not just the first. A hostname that resolves
 * to one public and one private address would otherwise pass validation
 * and then connect to whichever the resolver felt like returning first.
 */
export async function resolveTarget(url, { allowPrivate = false } = {}) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  // A literal address needs no resolution - and must not get a free pass
  // by skipping the check.
  if (net.isIP(hostname)) {
    if (!allowPrivate && isBlockedAddress(hostname)) {
      throw new UnsafeTargetError('private_address', `${hostname} is not a permitted address`);
    }
    return [hostname];
  }

  let answers;
  try {
    answers = await dns.lookup(hostname, { all: true });
  } catch {
    throw new UnsafeTargetError('dns', `Could not resolve ${hostname}`);
  }

  const addresses = answers.map((a) => a.address);
  if (addresses.length === 0) {
    throw new UnsafeTargetError('dns', `${hostname} resolved to nothing`);
  }

  if (!allowPrivate) {
    const blocked = addresses.find((ip) => isBlockedAddress(ip));
    if (blocked) {
      throw new UnsafeTargetError(
        'private_address',
        `${hostname} resolves to ${blocked}, which is not a permitted address`,
      );
    }
  }

  return addresses;
}

/**
 * A DNS lookup that only ever returns addresses we already approved.
 *
 * This closes the gap that defeats most hand-written SSRF filters.
 * Validating a hostname and then handing that *hostname* to the HTTP
 * client means two separate resolutions: an attacker controlling the DNS
 * record answers with a public address for the check and 169.254.169.254
 * for the fetch a millisecond later. Nothing in the validation is wrong;
 * it simply validated a different answer than the one used.
 *
 * Pinning the approved addresses onto the agent means the connection
 * goes to what was checked, or nowhere.
 */
export function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const family = net.isIPv6(addresses[0]) ? 6 : 4;

    if (typeof options === 'object' && options?.all) {
      return done(
        null,
        addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 })),
      );
    }
    return done(null, addresses[0], family);
  };
}

/**
 * The whole check, as one call.
 *
 * Returns the parsed URL and the addresses the connection is pinned to.
 * Callers must use the returned lookup - validating and then connecting
 * by hostname puts the rebinding gap straight back.
 */
export async function assertSafeTarget(rawUrl, { allowPrivate = false } = {}) {
  const url = parseTarget(rawUrl);
  const addresses = await resolveTarget(url, { allowPrivate });
  return { url, addresses, lookup: pinnedLookup(addresses) };
}
