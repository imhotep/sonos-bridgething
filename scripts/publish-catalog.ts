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

// hosted settings page bytes still ship in site/ (see the NOTE below), but
// are not referenced from the catalog while old companions reject the field
if (manifest.settings) {
  const settingsPath = join(distDir, basename(manifest.settings));
  if (!existsSync(settingsPath)) throw new Error(`manifest declares settings but ${settingsPath} is missing`);
  copyFileSync(settingsPath, join(siteDir, manifest.id, `${manifest.version}.settings.html`));
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
  $schema: 'https://apps.bridgething.com/schemas/catalog/v1.json',
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
          permissions: manifest.permissions ?? [],
          min_libbridgething_version: '0.10.0',
          changelog: 'Initial release.',
        },
      ],
    },
  ],
  recommended_sources: [],
};
// NOTE: no `screenshots` or `settings` keys on purpose — companions shipped
// before 2026-08-30 bundle a strict catalog schema (additionalProperties:
// false) that predates both fields and rejects the whole source over them.
// The files still ship in site/ so they can be re-enabled once the old
// validator is gone.

writeFileSync(join(siteDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(`wrote site/ — catalog for ${manifest.name} ${manifest.version}`);
console.log(`catalog url: ${BASE_URL}/catalog.json`);
