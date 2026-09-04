#!/usr/bin/env bun
import { zipSync } from 'fflate';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoDir = resolve(import.meta.dir, '..');
const distDir = resolve(repoDir, 'dist');
const manifestPath = join(distDir, 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error(`no manifest.json at ${manifestPath}; run 'bun run build' first`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; version?: string };
const name = (manifest.name || 'webapp').replace(/[^a-z0-9._-]+/gi, '-');
const version = manifest.version || '0.0.0';

const files: Record<string, Uint8Array> = {};
function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs);
    else {
      const rel = relative(distDir, abs);
      // sonos-seeds.json holds the pushing machine's LAN IPs — never ship those
      if (rel === 'sonos-seeds.json') continue;
      files[rel] = new Uint8Array(readFileSync(abs));
    }
  }
}
walk(distDir);

const outPath = resolve(repoDir, `${name}-${version}.zip`);
writeFileSync(outPath, zipSync(files, { level: 9 }));
console.log(`wrote ${relative(process.cwd(), outPath)} (${Object.keys(files).length} files)`);
console.log('share it: anyone with a bridgething Car Thing installs it from the companion app');
