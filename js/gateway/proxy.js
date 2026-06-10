import { BlockList, isIP } from 'node:net';

import '../utils/env-loader.js';

const HTTP_PROXY_KEYS = ['http_proxy', 'HTTP_PROXY'];
const HTTPS_PROXY_KEYS = ['https_proxy', 'HTTPS_PROXY'];
const ALL_PROXY_KEYS = ['all_proxy', 'ALL_PROXY'];
const NO_PROXY_KEYS = ['no_proxy', 'NO_PROXY'];

function envValue(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  return '';
}

function normalizeProxyUrl(proxyUrl) {
  if (!proxyUrl) {
    return '';
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(proxyUrl)) {
    return proxyUrl;
  }

  return `http://${proxyUrl}`;
}

function normalizeHostname(hostname) {
  return String(hostname || '')
    .trim()
    .replace(/^\[/u, '')
    .replace(/\]$/u, '')
    .replace(/\.$/u, '')
    .toLowerCase();
}

function defaultPortForProtocol(protocol) {
  if (protocol === 'https:') {
    return '443';
  }

  if (protocol === 'http:') {
    return '80';
  }

  return '';
}

function cidrMatchesHost(networkHost, cidr, targetHost) {
  const networkVersion = isIP(networkHost);
  const targetVersion = isIP(targetHost);
  const prefix = Number(cidr);
  if (!networkVersion || networkVersion !== targetVersion || !Number.isInteger(prefix)) {
    return false;
  }

  const addressType = networkVersion === 4 ? 'ipv4' : 'ipv6';
  const maxPrefix = networkVersion === 4 ? 32 : 128;
  if (prefix < 0 || prefix > maxPrefix) {
    return false;
  }

  const blockList = new BlockList();
  blockList.addSubnet(networkHost, prefix, addressType);
  return blockList.check(targetHost, addressType);
}

function splitNoProxyEntries(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }

  return value
    .split(/[,\s]+/u)
    .map(function normalizeEntry(entry) {
      return entry.trim();
    })
    .filter(Boolean);
}

function noProxyEntries(env = process.env) {
  return splitNoProxyEntries(
    NO_PROXY_KEYS
      .map(function readValue(name) {
        return env?.[name] || '';
      })
      .filter(Boolean)
      .join(',')
  );
}

function parseNoProxyEntry(entry) {
  let value = String(entry || '').trim().toLowerCase();
  if (!value || value === '*') {
    return {
      cidr: '',
      host: value,
      port: '',
    };
  }

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '');
  const slashIndex = value.indexOf('/');
  let cidr = '';
  if (slashIndex !== -1) {
    const hostPart = value.slice(0, slashIndex);
    const suffix = value.slice(slashIndex + 1);
    const normalizedHostPart = normalizeHostname(hostPart);
    if (/^\d{1,3}$/u.test(suffix) && isIP(normalizedHostPart)) {
      cidr = suffix;
    }

    value = hostPart;
  }

  if (value.startsWith('[')) {
    const bracketEnd = value.indexOf(']');
    if (bracketEnd !== -1) {
      const host = value.slice(1, bracketEnd);
      const port = value.slice(bracketEnd + 1).replace(/^:/u, '');
      return { cidr, host: normalizeHostname(host), port };
    }
  }

  const colonCount = (value.match(/:/gu) || []).length;
  if (colonCount === 1) {
    const [host, port] = value.split(':');
    return { cidr, host: normalizeHostname(host), port };
  }

  return { cidr, host: normalizeHostname(value), port: '' };
}

function noProxyHostMatches(patternHost, targetHost) {
  if (!patternHost) {
    return false;
  }

  if (patternHost === '*') {
    return true;
  }

  if (patternHost.startsWith('*.')) {
    const suffix = patternHost.slice(2);
    return targetHost === suffix || targetHost.endsWith(`.${suffix}`);
  }

  if (patternHost.startsWith('.')) {
    const suffix = patternHost.slice(1);
    return targetHost === suffix || targetHost.endsWith(patternHost);
  }

  return targetHost === patternHost || targetHost.endsWith(`.${patternHost}`);
}

function noProxyEntryMatchesUrl(entry, targetHost, targetPort) {
  const parsed = parseNoProxyEntry(entry);
  if (parsed.cidr) {
    return cidrMatchesHost(parsed.host, parsed.cidr, targetHost);
  }

  if (parsed.port && parsed.port !== targetPort) {
    return false;
  }

  return noProxyHostMatches(parsed.host, targetHost);
}

function noProxyEntryCoversHost(entry, targetHost) {
  const parsed = parseNoProxyEntry(entry);
  if (parsed.cidr) {
    return cidrMatchesHost(parsed.host, parsed.cidr, targetHost);
  }

  return !parsed.port && noProxyHostMatches(parsed.host, targetHost);
}

export function proxyEnvConfigured(env = process.env) {
  return Boolean(envValue(env, [...HTTP_PROXY_KEYS, ...HTTPS_PROXY_KEYS, ...ALL_PROXY_KEYS]));
}

export function noProxyMatchesUrl(targetUrl, env = process.env) {
  const url = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
  const targetHost = normalizeHostname(url.hostname);
  const targetPort = url.port || defaultPortForProtocol(url.protocol);

  return noProxyEntries(env).some(function matchesEntry(entry) {
    return noProxyEntryMatchesUrl(entry, targetHost, targetPort);
  });
}

export function proxyUrlForTarget(targetUrl, env = process.env) {
  const url = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
  if (noProxyMatchesUrl(url, env)) {
    return '';
  }

  if (url.protocol === 'https:') {
    return normalizeProxyUrl(envValue(env, [...HTTPS_PROXY_KEYS, ...ALL_PROXY_KEYS]));
  }

  if (url.protocol === 'http:') {
    return normalizeProxyUrl(envValue(env, [...HTTP_PROXY_KEYS, ...ALL_PROXY_KEYS]));
  }

  return '';
}

export function proxyExclusionEnvForHost(gatewayHost, env = process.env) {
  if (!proxyEnvConfigured(env)) {
    return {};
  }

  const host = normalizeHostname(gatewayHost);
  if (!host) {
    return {};
  }

  const entries = noProxyEntries(env);
  const alreadyCovered = entries.some(function entryMatchesHost(entry) {
    return noProxyEntryCoversHost(entry, host);
  });

  const seen = new Set();
  const mergedEntries = [...entries, ...(alreadyCovered ? [] : [host])].filter(
    function dedupeEntry(entry) {
      const normalized = String(entry).trim().toLowerCase();
      if (!normalized || seen.has(normalized)) {
        return false;
      }

      seen.add(normalized);
      return true;
    }
  );
  const merged = mergedEntries.join(',');
  if (env?.NO_PROXY === merged && env?.no_proxy === merged) {
    return {};
  }

  return {
    NO_PROXY: merged,
    no_proxy: merged,
  };
}
