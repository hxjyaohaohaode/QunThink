import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';

function isBlockedIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

export function isBlockedAddress(address) {
  const normalized = String(address || '').toLowerCase().split('%')[0];
  const family = net.isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family !== 6) return true;

  if (normalized.startsWith('::ffff:')) {
    return isBlockedIpv4(normalized.slice('::ffff:'.length));
  }
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('2001:db8:');
}

function parseExternalUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Base URL 格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Base URL 仅支持 HTTP(S)');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Base URL 不允许包含用户名或密码');
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('生产环境的 Base URL 必须使用 HTTPS');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Base URL 不允许指向本机或内部网络');
  }
  if (net.isIP(hostname) && isBlockedAddress(hostname)) {
    throw new Error('Base URL 不允许指向私有、保留或链路本地地址');
  }
  return parsed;
}

function lookupAll(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return reject(error);
      resolve(addresses);
    });
  });
}

export async function assertSafeExternalUrl(rawUrl) {
  const parsed = parseExternalUrl(rawUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(hostname)) {
    const addresses = await lookupAll(hostname);
    if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
      throw new Error('Base URL 的域名解析到了私有、保留或链路本地地址');
    }
  }
  return parsed.toString();
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error);
    if (Array.isArray(address)) {
      if (address.some(item => isBlockedAddress(item.address))) {
        return callback(new Error('目标域名解析到了受保护的网络地址'));
      }
      return callback(null, address);
    }
    if (isBlockedAddress(address)) {
      return callback(new Error('目标域名解析到了受保护的网络地址'));
    }
    return callback(null, address, family);
  });
}

const httpAgent = new http.Agent({ keepAlive: true, lookup: safeLookup });
const httpsAgent = new https.Agent({ keepAlive: true, lookup: safeLookup });

export async function getSafeExternalRequestOptions(rawUrl) {
  await assertSafeExternalUrl(rawUrl);
  return {
    maxRedirects: 0,
    proxy: false,
    httpAgent,
    httpsAgent
  };
}
