import type { BridgethingClient } from '@bridgething/client';

/**
 * Minimal Sonos UPnP client. All traffic goes through `client.net.fetch`,
 * which tunnels HTTP through the companion phone (the device itself has no
 * network). Sonos speakers speak plain HTTP SOAP on port 1400.
 */

export type Speaker = { uuid: string; name: string; ip: string };

export type SonosGroup = {
  coordinator: Speaker;
  members: Speaker[];
};

export type TransportState = 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED' | 'TRANSITIONING' | string;

export type NowPlaying = {
  title: string;
  artist: string;
  album: string;
  /** Artwork reference: absolute URL or speaker-local path (prefix with http://{ip}:1400). */
  artUri: string;
  durationMs: number;
  positionMs: number;
};

const EMPTY_NOW: NowPlaying = { title: '', artist: '', album: '', artUri: '', durationMs: 0, positionMs: 0 };

export type Favorite = {
  title: string;
  uri: string;
  /** Raw DIDL-Lite metadata string (r:resMD) used for SetAVTransportURI. */
  metadata: string;
};

const SERVICES = {
  topology: { urn: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1', path: '/ZoneGroupTopology/Control' },
  avTransport: { urn: 'urn:schemas-upnp-org:service:AVTransport:1', path: '/MediaRenderer/AVTransport/Control' },
  contentDirectory: { urn: 'urn:schemas-upnp-org:service:ContentDirectory:1', path: '/MediaServer/ContentDirectory/Control' },
  renderingControl: { urn: 'urn:schemas-upnp-org:service:RenderingControl:1', path: '/MediaRenderer/RenderingControl/Control' },
  groupRenderingControl: {
    urn: 'urn:schemas-upnp-org:service:GroupRenderingControl:1',
    path: '/MediaRenderer/GroupRenderingControl/Control',
  },
} as const;

type Service = keyof typeof SERVICES;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Namespace-agnostic element lookup: matches any prefix (s:Body, dc:title, r:resMD, ...). */
function byTag(parent: Element | Document, localName: string): Element[] {
  const out: Element[] = [];
  const walk = (node: Element | Document) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const local = (el.localName ?? el.tagName)?.split(':').pop();
      if (local === localName) out.push(el);
      walk(el);
    }
  };
  walk(parent);
  return out;
}

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (byTag(doc, 'parsererror').length > 0) {
    throw new Error('invalid XML from speaker');
  }
  return doc;
}

/** One SOAP call. Returns the parsed response body element. */
async function soap(
  client: BridgethingClient,
  ip: string,
  service: Service,
  action: string,
  args: Record<string, string> = {},
  timeoutMs = 6000,
): Promise<Element> {
  const { urn, path } = SERVICES[service];
  const argXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join('');
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"` +
    ` s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${urn}">${argXml}</u:${action}></s:Body></s:Envelope>`;

  const result = await client.net.fetch({
    request: {
      url: `http://${ip}:1400${path}`,
      method: 'POST',
      headers: [
        { name: 'Content-Type', value: 'text/xml; charset="utf-8"' },
        { name: 'SOAPACTION', value: `"${urn}#${action}"` },
      ],
      body: new TextEncoder().encode(envelope),
      timeoutMs,
      redirect: 'error',
    },
  });
  if (!result.ok) {
    const netErr = result.kind === 'domain' ? result.error.error : null;
    const detail = netErr
      ? netErr.type === 'requestFailed'
        ? `request failed (${netErr.data.reason})`
        : netErr.type // 'timeout' | 'unavailable' | 'noGateway'
      : result.kind;
    throw new Error(`${action} to ${ip} failed: ${detail}`);
  }

  const { status, body } = result.response.response;
  const text = new TextDecoder().decode(body);
  const doc = parseXml(text);
  const fault = byTag(doc, 'Fault')[0];
  if (fault) {
    const detail = byTag(fault, 'errorDescription')[0]?.textContent;
    throw new Error(`${action} fault: ${detail ?? fault.textContent ?? 'unknown'}`);
  }
  if (status < 200 || status >= 300) throw new Error(`${action} returned HTTP ${status}`);
  const response = byTag(doc, 'Body')[0]?.firstElementChild;
  if (!response) throw new Error(`${action}: empty SOAP response`);
  return response;
}

function textOf(parent: Element | Document, localName: string): string {
  return byTag(parent, localName)[0]?.textContent?.trim() ?? '';
}

/** Discover the household from one answering seed speaker. */
async function discoverFrom(client: BridgethingClient, ip: string): Promise<SonosGroup[]> {
  // short timeout: discovery waits for every seed, so stale cached IPs must
  // fail fast instead of stalling startup
  const response = await soap(client, ip, 'topology', 'GetZoneGroupState', {}, 2500);
  const stateXml = textOf(response, 'ZoneGroupState');
  const state = parseXml(stateXml);
  const groups: SonosGroup[] = [];
  for (const groupEl of byTag(state, 'ZoneGroup')) {
    const coordinatorId = groupEl.getAttribute('Coordinator') ?? '';
    const members: Speaker[] = [];
    let coordinator: Speaker | null = null;
    for (const memberEl of byTag(groupEl, 'ZoneGroupMember')) {
      const uuid = memberEl.getAttribute('UUID') ?? '';
      const location = memberEl.getAttribute('Location') ?? '';
      const memberIp = /^https?:\/\/([^:/]+)/.exec(location)?.[1] ?? '';
      const name = memberEl.getAttribute('ZoneName') ?? uuid;
      const invisible = memberEl.getAttribute('Invisible') === '1';
      if (!uuid || !memberIp || invisible) continue;
      const speaker = { uuid, name, ip: memberIp };
      members.push(speaker);
      if (uuid === coordinatorId) coordinator = speaker;
    }
    if (coordinator && members.length > 0) groups.push({ coordinator, members });
  }
  if (groups.length === 0) throw new Error('no zone groups in topology');
  await rememberIps(client, groups);
  return groups;
}

export type Discovery = {
  /** All zone groups across every answering household, deduped by coordinator. */
  groups: SonosGroup[];
  /** One coordinator per distinct household (favorites live per household). */
  households: Speaker[];
};

/**
 * Query every seed and merge the results. A network can host several Sonos
 * households (S1 and S2 systems can never see each other), and one speaker's
 * GetZoneGroupState only covers its own household — so the first answer is
 * not enough. Households never share speakers, so merging is a union deduped
 * by coordinator UUID.
 */
export async function discover(client: BridgethingClient, seedIps: string[]): Promise<Discovery> {
  const results = await Promise.allSettled(seedIps.map(ip => discoverFrom(client, ip)));
  const groups: SonosGroup[] = [];
  const households: Speaker[] = [];
  const seenGroups = new Set<string>();
  const seenHouseholds = new Set<string>();
  let firstErr: unknown = null;
  for (const result of results) {
    if (result.status === 'rejected') {
      firstErr ??= result.reason;
      continue;
    }
    const found = result.value;
    // one entry per distinct household, keyed by its coordinator set
    const signature = found.map(g => g.coordinator.uuid).sort().join(',');
    if (!seenHouseholds.has(signature)) {
      seenHouseholds.add(signature);
      households.push(found[0].coordinator);
    }
    for (const group of found) {
      if (seenGroups.has(group.coordinator.uuid)) continue;
      seenGroups.add(group.coordinator.uuid);
      groups.push(group);
    }
  }
  if (groups.length === 0) throw firstErr instanceof Error ? firstErr : new Error('no speaker answered');
  return { groups, households };
}

const PROBE_BATCH = 16;
const PROBE_TIMEOUT_MS = 800;
// ordered by how common each prefix is in home routers
const SCAN_PREFIXES = ['192.168.1', '192.168.0', '10.0.0', '192.168.2', '10.0.1'];

/** One HTTP probe: Sonos players answer 200 on :1400/status. */
async function probeSpeaker(client: BridgethingClient, ip: string): Promise<boolean> {
  const result = await client.net
    .fetch({
      request: {
        url: `http://${ip}:1400/status`,
        method: 'GET',
        headers: [],
        timeoutMs: PROBE_TIMEOUT_MS,
        redirect: 'error',
      },
    })
    .catch(() => null);
  return result?.ok === true && result.response.response.status === 200;
}

/**
 * Last-resort discovery for users who never entered an IP: probe common home
 * subnets through the phone tunnel. Stops at the first subnet that answers and
 * returns every speaker IP found in it — `discover` merges all households
 * those seeds belong to.
 */
export async function findSpeakersOnLan(
  client: BridgethingClient,
  onProgress?: (prefix: string) => void,
): Promise<string[]> {
  for (const prefix of SCAN_PREFIXES) {
    onProgress?.(prefix);
    const found: string[] = [];
    const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
    for (let i = 0; i < hosts.length; i += PROBE_BATCH) {
      const hits = await Promise.all(
        hosts.slice(i, i + PROBE_BATCH).map(async ip => ((await probeSpeaker(client, ip)) ? ip : null)),
      );
      found.push(...hits.filter((h): h is string => h !== null));
    }
    if (found.length > 0) return found;
  }
  return [];
}

const IP_STORE_KEY = 'sonos_ips';

/** Persist every known speaker IP so future startups survive DHCP changes. */
async function rememberIps(client: BridgethingClient, groups: SonosGroup[]): Promise<void> {
  const ips = groups.flatMap(g => g.members.map(m => m.ip));
  await client.store.put({ key: IP_STORE_KEY, value: JSON.stringify([...new Set(ips)]) }).catch(() => {});
}

/** Previously discovered speaker IPs, oldest knowledge first. */
export async function cachedIps(client: BridgethingClient): Promise<string[]> {
  const result = await client.store.get({ key: IP_STORE_KEY }).catch(() => null);
  if (!result?.ok || !result.response.value) return [];
  try {
    const parsed: unknown = JSON.parse(result.response.value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export async function getTransportState(client: BridgethingClient, ip: string): Promise<TransportState> {
  const response = await soap(client, ip, 'avTransport', 'GetTransportInfo', { InstanceID: '0' });
  return textOf(response, 'CurrentTransportState') || 'STOPPED';
}

/** Sonos reports times as "H:MM:SS"; streams and idle transports say NOT_IMPLEMENTED. */
function parseHms(value: string): number {
  const parts = value.split(':').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return 0;
  return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
}

export async function getNowPlaying(client: BridgethingClient, ip: string): Promise<NowPlaying> {
  const response = await soap(client, ip, 'avTransport', 'GetPositionInfo', { InstanceID: '0' });
  const positionMs = parseHms(textOf(response, 'RelTime'));
  const durationMs = parseHms(textOf(response, 'TrackDuration'));
  const metaXml = textOf(response, 'TrackMetaData');
  if (!metaXml || metaXml === 'NOT_IMPLEMENTED') return { ...EMPTY_NOW, positionMs, durationMs };
  try {
    const didl = parseXml(metaXml);
    return {
      title: textOf(didl, 'title'),
      artist: textOf(didl, 'creator'),
      album: textOf(didl, 'album'),
      artUri: textOf(didl, 'albumArtURI'),
      durationMs,
      positionMs,
    };
  } catch {
    return { ...EMPTY_NOW, positionMs, durationMs };
  }
}

/** Fetch artwork bytes (relative Sonos paths resolve against the speaker). */
export async function fetchArtwork(
  client: BridgethingClient,
  ip: string,
  artUri: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const url = artUri.startsWith('http') ? artUri : `http://${ip}:1400${artUri}`;
  const result = await client.net.fetch({
    request: { url, method: 'GET', headers: [], timeoutMs: 8000, redirect: 'follow' },
  });
  if (!result.ok) return null;
  const { status, headers, body } = result.response.response;
  if (status !== 200 || body.length === 0) return null;
  const mime =
    headers.find(h => h.name.toLowerCase() === 'content-type')?.value.split(';')[0] ?? 'image/jpeg';
  return { bytes: body, mime };
}

export function play(client: BridgethingClient, ip: string): Promise<Element> {
  return soap(client, ip, 'avTransport', 'Play', { InstanceID: '0', Speed: '1' });
}

export function pause(client: BridgethingClient, ip: string): Promise<Element> {
  return soap(client, ip, 'avTransport', 'Pause', { InstanceID: '0' });
}

export function stop(client: BridgethingClient, ip: string): Promise<Element> {
  return soap(client, ip, 'avTransport', 'Stop', { InstanceID: '0' });
}

/** Group volume via the coordinator, falling back to the speaker's own volume. */
export async function getVolume(client: BridgethingClient, ip: string): Promise<number> {
  try {
    const r = await soap(client, ip, 'groupRenderingControl', 'GetGroupVolume', { InstanceID: '0' });
    return Number(textOf(r, 'CurrentVolume')) || 0;
  } catch {
    const r = await soap(client, ip, 'renderingControl', 'GetVolume', { InstanceID: '0', Channel: 'Master' });
    return Number(textOf(r, 'CurrentVolume')) || 0;
  }
}

export async function setVolume(client: BridgethingClient, ip: string, volume: number): Promise<Element> {
  const desired = String(Math.round(Math.max(0, Math.min(100, volume))));
  try {
    return await soap(client, ip, 'groupRenderingControl', 'SetGroupVolume', { InstanceID: '0', DesiredVolume: desired });
  } catch {
    return soap(client, ip, 'renderingControl', 'SetVolume', {
      InstanceID: '0',
      Channel: 'Master',
      DesiredVolume: desired,
    });
  }
}

export async function getFavorites(client: BridgethingClient, ip: string): Promise<Favorite[]> {
  const response = await soap(client, ip, 'contentDirectory', 'Browse', {
    ObjectID: 'FV:2',
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: '0',
    RequestedCount: '100',
    SortCriteria: '',
  });
  const didl = parseXml(textOf(response, 'Result'));
  const favorites: Favorite[] = [];
  for (const item of byTag(didl, 'item')) {
    const title = textOf(item, 'title');
    const uri = textOf(item, 'res');
    const metadata = textOf(item, 'resMD');
    if (title && uri) favorites.push({ title, uri, metadata });
  }
  return favorites;
}

export async function playFavorite(
  client: BridgethingClient,
  coordinator: Speaker,
  favorite: Favorite,
): Promise<void> {
  const ip = coordinator.ip;
  if (favorite.uri.startsWith('x-rincon-cpcontainer:')) {
    // Container favorites (playlists, albums) are rejected as a transport URI
    // (UPnP error 714). Replace the queue with the container's tracks and
    // point the transport at the queue instead.
    await soap(client, ip, 'avTransport', 'RemoveAllTracksFromQueue', { InstanceID: '0', UpdateID: '0' });
    const added = await soap(client, ip, 'avTransport', 'AddURIToQueue', {
      InstanceID: '0',
      EnqueuedURI: favorite.uri,
      EnqueuedURIMetaData: favorite.metadata,
      DesiredFirstTrackNumberEnqueued: '0',
      EnqueueAsNext: '0',
    });
    const firstTrack = textOf(added, 'FirstTrackNumberEnqueued') || '1';
    await soap(client, ip, 'avTransport', 'SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: `x-rincon-queue:${coordinator.uuid}#0`,
      CurrentURIMetaData: '',
    });
    if (firstTrack !== '1') {
      await soap(client, ip, 'avTransport', 'Seek', { InstanceID: '0', Unit: 'TRACK_NR', Target: firstTrack });
    }
  } else {
    await soap(client, ip, 'avTransport', 'SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: favorite.uri,
      CurrentURIMetaData: favorite.metadata,
    });
  }
  await play(client, ip);
}
