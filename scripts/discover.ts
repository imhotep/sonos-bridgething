#!/usr/bin/env bun
/**
 * SSDP discovery for Sonos speakers on the local network. Sonos speakers
 * announce themselves via UPnP multicast; any machine on the LAN can find
 * them, so `push` bakes the result into the bundle (public/sonos-seeds.json)
 * and the webapp never needs a manually entered IP.
 *
 * Run standalone with `bun run discover` to refresh the seed list.
 */
import dgram from 'node:dgram';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const QUERY = [
  'M-SEARCH * HTTP/1.1',
  `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
  'MAN: "ssdp:discover"',
  'MX: 2',
  'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
  '',
  '',
].join('\r\n');

/** Multicast one M-SEARCH and collect every answering ZonePlayer IP. */
export function discoverSonosIps(timeoutMs = 4000): Promise<string[]> {
  return new Promise(resolvePromise => {
    const ips = new Set<string>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const timer = setTimeout(done, timeoutMs);

    function done() {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolvePromise([...ips]);
    }

    socket.on('error', done);
    socket.on('message', msg => {
      const location = /^location:\s*(\S+)$/im.exec(msg.toString())?.[1];
      // Sonos players serve their description on :1400; ignore anything else
      const ip = location ? /^https?:\/\/([^:/]+):1400\//.exec(location)?.[1] : undefined;
      if (ip) ips.add(ip);
    });
    socket.bind(() => {
      socket.send(QUERY, SSDP_PORT, SSDP_ADDR, err => err && done());
    });
  });
}

export function seedsPath(repoDir: string): string {
  return resolve(repoDir, 'public', 'sonos-seeds.json');
}

export function writeSeedsFile(repoDir: string, ips: string[]): void {
  writeFileSync(seedsPath(repoDir), JSON.stringify({ ips }, null, 2) + '\n');
}

if (import.meta.main) {
  const repoDir = resolve(dirname(new URL(import.meta.url).pathname), '..');
  const ips = await discoverSonosIps();
  console.log(ips.length ? `found ${ips.length} speakers:\n${ips.join('\n')}` : 'no speakers found on this network');
  writeSeedsFile(repoDir, ips);
  console.log(`wrote ${seedsPath(repoDir)}`);
}
