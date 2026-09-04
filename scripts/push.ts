#!/usr/bin/env bun
// Generated from @bridgething/webapp-shared. It is yours now; tweak it freely.
import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { discoverSonosIps, writeSeedsFile } from './discover';

function parseUuid(s: string): Uint8Array {
  const hex = s.replace(/-/g, '').toLowerCase();
  if (hex.length !== 32 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`invalid uuid: ${s}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function freshMsgId(): Uint8Array {
  return parseUuid(randomUUID());
}

function uuidToString(bytes: Uint8Array): string {
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function bundleDirName(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`manifest id is not a uuid: ${id}`);
  return hex;
}

const FRAME_HEADER_LENGTH = 16;
const FRAME_MAGIC = 0xdead;
const FRAME_VERSION = 2;
const COMPRESSION_NONE = 0x00;
const ENCODING_MSGPACK = 0x00;
const PRIORITY_NORMAL = 0x00;

function writeFrameHeader(payloadLength: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(FRAME_HEADER_LENGTH);
  const view = new DataView(buf.buffer);
  view.setUint16(0, FRAME_MAGIC, false);
  view.setUint8(2, FRAME_VERSION);
  view.setUint8(3, COMPRESSION_NONE);
  view.setUint8(4, ENCODING_MSGPACK);
  view.setUint8(5, PRIORITY_NORMAL);
  view.setBigUint64(8, BigInt(payloadLength), false);
  return buf;
}

function frame(message: unknown): Uint8Array<ArrayBuffer> {
  const body = msgpackEncode(message);
  const header = writeFrameHeader(body.length);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

type GatewayMsg = { id: Uint8Array; meta: unknown; data: unknown };

class FrameAccumulator {
  private buffer = new Uint8Array(0);

  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  next(): GatewayMsg | null {
    if (this.buffer.length < FRAME_HEADER_LENGTH) return null;
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    const magic = view.getUint16(0, false);
    if (magic !== FRAME_MAGIC) throw new Error(`bad framing magic 0x${magic.toString(16)}`);
    const version = view.getUint8(2);
    if (version !== FRAME_VERSION) throw new Error(`unsupported frame version ${version}`);
    const compression = view.getUint8(3);
    if (compression !== COMPRESSION_NONE) {
      throw new Error(`unsupported inbound compression ${compression} (this script only handles uncompressed)`);
    }
    const encoding = view.getUint8(4);
    if (encoding !== ENCODING_MSGPACK) throw new Error(`unsupported inbound encoding ${encoding}`);
    const len = Number(view.getBigUint64(8, false));
    const total = FRAME_HEADER_LENGTH + len;
    if (this.buffer.length < total) return null;
    const body = this.buffer.subarray(FRAME_HEADER_LENGTH, total);
    const decoded = msgpackDecode(body) as GatewayMsg;
    this.buffer = this.buffer.slice(total);
    return decoded;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const ANNOUNCE_DATA = {
  type: 'capabilities',
  data: {
    event: 'announce',
    data: {
      gateway: {
        address: '',
        name: 'bridgething-webapp-push',
        osName: 'host',
        appName: 'bridgething-webapp-push',
        appVersion: '0.1.0',
        adapterVersion: 'host',
        libVersion: 'v0',
        libbridgethingVersion: 'v0',
      },
      uriSchemes: [],
      network: { kind: 'unknown', metered: false },
      available: { geo: false, notifications: false, netFetch: false, netWs: false, audioTts: false },
      audio: { earcons: [], voices: [] },
    },
  },
};

function sendRequest(host: string, port: number, data: unknown): Promise<unknown | null> {
  const url = `ws://${host}:${port}/`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const acc = new FrameAccumulator();
  const requestId = freshMsgId();
  let sent = false;

  return new Promise<unknown | null>((res, rej) => {
    const overall = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      rej(new Error(`gateway request timed out (15s) against ${url}`));
    }, 15_000);

    const finish = (fn: () => void) => {
      clearTimeout(overall);
      try {
        ws.close();
      } catch {}
      fn();
    };

    ws.addEventListener('open', () => {
      ws.send(frame({ id: freshMsgId(), meta: { kind: 'event' }, data: ANNOUNCE_DATA }));
      ws.send(frame({ id: requestId, meta: { kind: 'request' }, data }));
      sent = true;
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      const raw = event.data;
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw instanceof Uint8Array ? raw : null;
      if (!bytes) return;
      try {
        acc.append(bytes);
        for (let msg = acc.next(); msg !== null; msg = acc.next()) {
          const meta = msg.meta as { kind?: string; data?: { requestId?: Uint8Array } };
          const respId = meta?.kind === 'response' ? meta.data?.requestId : undefined;
          if (respId && bytesEqual(respId, requestId)) {
            finish(() => res(msg.data));
            return;
          }
        }
      } catch (err) {
        finish(() => rej(err instanceof Error ? err : new Error(String(err))));
      }
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      clearTimeout(overall);
      if (sent && (event.code === 1000 || event.code === 1005)) {
        res(null);
        return;
      }
      rej(new Error(`gateway ws closed before response (code ${event.code})`));
    });
  });
}

type Outcome<T> = { ok: true; value: T | null } | { ok: false; reason: string };

function interpret<T>(data: unknown | null, expected: string): Outcome<T> {
  if (data === null) return { ok: true, value: null };
  const outer = data as { type?: string; data?: unknown };
  if (outer?.type !== 'webapp') {
    return { ok: false, reason: `unexpected response type ${JSON.stringify(outer?.type)}` };
  }
  const inner = outer.data as { event?: string; data?: unknown };
  if (inner?.event === expected) return { ok: true, value: inner.data as T };
  if (inner?.event === 'webappError') {
    const err = inner.data as { type?: string; data?: Record<string, unknown> } | undefined;
    return { ok: false, reason: `daemon refused: ${err?.type} ${JSON.stringify(err?.data ?? {})}` };
  }
  return { ok: false, reason: `unexpected webapp response variant ${JSON.stringify(inner?.event)}` };
}

type ActiveWebapp = { id?: Uint8Array | null; name?: string | null };
type Slots = { launcher?: Uint8Array | null; overlay?: Uint8Array | null };
type Slot = 'launcher' | 'overlay';

async function switchTo(host: string, port: number, id: string): Promise<Outcome<ActiveWebapp>> {
  const data = { type: 'webapp', data: { event: 'switchTo', data: { id: parseUuid(id) } } };
  return interpret<ActiveWebapp>(await sendRequest(host, port, data), 'switched');
}

async function setSlot(host: string, port: number, slot: Slot, id: string | null): Promise<Outcome<Slots>> {
  const data = {
    type: 'webapp',
    data: { event: 'setSlot', data: { slot, id: id === null ? null : parseUuid(id) } },
  };
  return interpret<Slots>(await sendRequest(host, port, data), 'slots');
}

const WEBAPP_ROOT = '/var/bridgething/webapps';
const SSH_OPTS = ['-o', 'UserKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=no', '-o', 'LogLevel=ERROR'];

function run(cmd: string, args: string[], label: string, cwd?: string, stdinFile?: string): Promise<void> {
  return new Promise<void>((res, rej) => {
    const fd = stdinFile ? openSync(stdinFile, 'r') : undefined;
    const child = spawn(cmd, args, { stdio: fd !== undefined ? [fd, 'inherit', 'inherit'] : 'inherit', cwd });
    child.on('exit', code => (code === 0 ? res() : rej(new Error(`${label} exited ${code}`))));
    child.on('error', rej);
  });
}

async function pushBundle(localDir: string, host: string, dirName: string): Promise<void> {
  const staged = `.push.${dirName}`;
  const tarball = join(tmpdir(), `${dirName}.tgz`);
  console.log(`tar+ssh ${localDir} -> root@${host}:${WEBAPP_ROOT}/${dirName}/`);
  // the device has no rsync; stream a tarball over ssh instead (same atomic swap)
  await run('tar', ['-czf', tarball, '-C', localDir, '.'], 'tar');
  try {
    const extract = `rm -rf ${WEBAPP_ROOT}/${staged} && mkdir -p ${WEBAPP_ROOT}/${staged} && tar -xzf - -C ${WEBAPP_ROOT}/${staged}`;
    await run('ssh', [...SSH_OPTS, `root@${host}`, extract], 'ssh', undefined, tarball);
    const swap = [
      'set -e',
      `cd ${WEBAPP_ROOT}`,
      `rm -rf .old.${dirName}`,
      `if [ -d ${dirName} ]; then mv ${dirName} .old.${dirName}; fi`,
      `mv ${staged} ${dirName}`,
      `rm -rf .old.${dirName}`,
    ].join('; ');
    await run('ssh', [...SSH_OPTS, `root@${host}`, swap], 'ssh');
  } finally {
    await rm(tarball, { force: true });
  }
}

function buildBundle(repoDir: string): Promise<void> {
  console.log('bun run build');
  return run('bun', ['run', 'build'], 'bun run build', repoDir);
}

/** Bake SSDP-discovered speaker IPs into the bundle so the app needs no manual IP. */
async function bakeSonosSeeds(repoDir: string): Promise<void> {
  try {
    const ips = await discoverSonosIps();
    if (ips.length === 0) {
      console.log('ssdp: no Sonos speakers found on this network; keeping any existing seeds');
      return;
    }
    writeSeedsFile(repoDir, ips);
    console.log(`ssdp: baked ${ips.length} speaker IPs into the bundle`);
  } catch (err) {
    console.log(`ssdp: discovery failed (${err instanceof Error ? err.message : String(err)}); continuing`);
  }
}

type Manifest = { id?: string; name?: string; role?: string; overlay?: string };

function declaredSlots(manifest: Manifest): Slot[] {
  const slots: Slot[] = [];
  if (manifest.role === 'launcher') slots.push('launcher');
  if (manifest.overlay) slots.push('overlay');
  return slots;
}

type Args = {
  host: string;
  port: number;
  skipBuild: boolean;
  claimSlots: boolean;
  release: boolean;
  switchAfter: boolean | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    host: process.env.SUPERBIRD_HOST ?? 'bridgething.local',
    port: Number(process.env.BRIDGETHING_GATEWAY_PORT ?? 8892),
    skipBuild: process.env.SKIP_BUILD === '1',
    claimSlots: true,
    release: false,
    switchAfter: null,
  };
  for (const arg of argv) {
    if (arg === '--skip-build') args.skipBuild = true;
    else if (arg === '--no-switch') args.switchAfter = false;
    else if (arg === '--switch') args.switchAfter = true;
    else if (arg === '--no-slot') args.claimSlots = false;
    else if (arg === '--release') args.release = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    else args.host = arg;
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: bun run push [host] [options]

Build, push dist/ onto a connected Car Thing, and make it visible.

A plain webapp becomes the active app. A launcher also takes the home-screen
slot; an overlay takes the overlay slot and the daemon reloads the kiosk so it
is injected into whatever app is showing. Overlay-only bundles are not switched
to by default, since switching away is the opposite of what you want to test.

Options:
  --release      hand this bundle's slots back to the built-in ones and stop.
                 the recovery path when a build wedges the screen.
  --no-slot      push without claiming any slot.
  --switch       switch to this bundle even if it is overlay-only.
  --no-switch    push without switching.
  --skip-build   push whatever is already in dist/.

Env: SUPERBIRD_HOST, BRIDGETHING_GATEWAY_PORT, SKIP_BUILD=1
`);
}

export type BridgethingPushOptions = {
  scriptUrl: string;
};

export async function bridgethingPush({ scriptUrl }: BridgethingPushOptions): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const repoDir = resolve(dirname(new URL(scriptUrl).pathname), '..');
  const distDir = resolve(repoDir, 'dist');
  const manifestPath = resolve(distDir, 'manifest.json');

  const readManifest = (): Manifest => {
    if (!existsSync(manifestPath)) {
      throw new Error(`no manifest.json at ${manifestPath}; run 'bun run build' first or drop --skip-build`);
    }
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    if (!parsed.id) throw new Error(`${manifestPath} has no 'id' field`);
    return parsed;
  };

  if (args.release) {
    const manifest = readManifest();
    for (const slot of declaredSlots(manifest)) {
      const result = await setSlot(args.host, args.port, slot, null);
      if (!result.ok) throw new Error(result.reason);
      console.log(`${slot} slot: reverted to the built-in one`);
    }
    if (declaredSlots(manifest).length === 0) console.log('this bundle declares no slots; nothing to release');
    return;
  }

  if (!args.skipBuild) {
    await bakeSonosSeeds(repoDir);
    await buildBundle(repoDir);
  }
  const manifest = readManifest();
  const id = manifest.id as string;
  const slots = declaredSlots(manifest);

  await pushBundle(distDir, args.host, bundleDirName(id));

  if (args.claimSlots) {
    for (const slot of slots) {
      const result = await setSlot(args.host, args.port, slot, id);
      if (!result.ok) throw new Error(result.reason);
      console.log(`${slot} slot: ${manifest.name ?? id}`);
    }
  }

  const overlayOnly = slots.length > 0 && slots.every(s => s === 'overlay');
  const shouldSwitch = args.switchAfter ?? !overlayOnly;
  if (!shouldSwitch) {
    console.log(overlayOnly ? 'overlay pushed; the kiosk reloaded with it injected' : 'skipping switch');
    return;
  }

  const switched = await switchTo(args.host, args.port, id);
  if (!switched.ok) throw new Error(switched.reason);
  const active = switched.value;
  if (!active) {
    console.log('switched (the daemon dropped the push connection reloading the kiosk)');
    return;
  }
  const activeStr = active.id ? uuidToString(active.id) : '(none)';
  console.log(`active webapp: ${active.name ?? '(unnamed)'} ${activeStr}`);
}

bridgethingPush({ scriptUrl: import.meta.url }).catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
