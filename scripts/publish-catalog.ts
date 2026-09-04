#!/usr/bin/env bun
/**
 * Build the publishable static site into `site/`: the bundle zip, the hosted
 * settings page, icon, screenshots, and the `catalog.v1` document the
 * bridgething store reads. GitHub Pages deploys `site/` as-is; its URLs send
 * the CORS headers the store requires.
 *
 * Run with `bun run publish:catalog` after `bun run build`.
 */
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const repoDir = resolve(import.meta.dir, '..');
const distDir = resolve(repoDir, 'dist');
const siteDir = resolve(repoDir, 'site');

const BASE_URL = 'https://imhotep.github.io/sonos-bridgething';
const SOURCE_URL = 'https://github.com/imhotep/sonos-bridgething';
const AUTHOR = 'imhotep';

type Manifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  permissions?: string[];
  settings?: string;
};

const manifestPath = join(distDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`no manifest.json at ${manifestPath}; run 'bun run build' first`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
if (!manifest.id || !manifest.version) throw new Error('manifest.json needs id and version');

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Zip dist/ the same way scripts/share.ts does (seeds file never ships). */
function bundleZip(): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else {
        const rel = relative(distDir, abs);
        if (rel === 'sonos-seeds.json') continue;
        files[rel] = new Uint8Array(readFileSync(abs));
      }
    }
  };
  walk(distDir);
  return zipSync(files, { level: 9 });
}

rmSync(siteDir, { recursive: true, force: true });
mkdirSync(join(siteDir, manifest.id), { recursive: true });

// bundle zip
const zip = bundleZip();
const zipName = `${manifest.version}.zip`;
writeFileSync(join(siteDir, manifest.id, zipName), zip);

// hosted settings page (must digest-match the copy inside the bundle)
let settings: { url: string; size: number; sha256: string } | undefined;
if (manifest.settings) {
  const settingsPath = join(distDir, basename(manifest.settings));
  if (!existsSync(settingsPath)) throw new Error(`manifest declares settings but ${settingsPath} is missing`);
  const bytes = new Uint8Array(readFileSync(settingsPath));
  const settingsName = `${manifest.version}.settings.html`;
  writeFileSync(join(siteDir, manifest.id, settingsName), bytes);
  settings = { url: `${BASE_URL}/${manifest.id}/${settingsName}`, size: bytes.length, sha256: sha256(bytes) };
}

// icon + screenshots
copyFileSync(resolve(repoDir, 'icon.svg'), join(siteDir, 'icon.svg'));
const shotsDir = resolve(repoDir, 'screenshots');
const screenshots = existsSync(shotsDir)
  ? readdirSync(shotsDir)
      .filter(f => f.endsWith('.png'))
      .sort()
      .slice(0, 6)
  : [];
mkdirSync(join(siteDir, 'screenshots'), { recursive: true });
for (const shot of screenshots) copyFileSync(join(shotsDir, shot), join(siteDir, 'screenshots', shot));

const catalog = {
  schema: 'catalog.v1',
  updated_at: new Date().toISOString(),
  repo: {
    name: "imhotep's apps",
    description: 'webapps I publish for bridgething.',
    homepage: SOURCE_URL,
    icon: `${BASE_URL}/icon.svg`,
  },
  apps: [
    {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description ?? '',
      author: AUTHOR,
      icon: `${BASE_URL}/icon.svg`,
      screenshots: screenshots.map(s => `${BASE_URL}/screenshots/${s}`),
      homepage: SOURCE_URL,
      source: SOURCE_URL,
      versions: [
        {
          version: manifest.version,
          released_at: new Date().toISOString(),
          download: {
            url: `${BASE_URL}/${manifest.id}/${zipName}`,
            size: zip.length,
            sha256: sha256(zip),
          },
          ...(settings ? { settings } : {}),
          permissions: manifest.permissions ?? [],
          changelog: 'Initial release.',
        },
      ],
    },
  ],
  recommended_sources: [],
};

writeFileSync(join(siteDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(`wrote site/ — catalog for ${manifest.name} ${manifest.version}`);
console.log(`catalog url: ${BASE_URL}/catalog.json`);
