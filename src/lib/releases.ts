import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '../data/projects';

export type Platform = 'linux' | 'windows' | 'macos';

export type Download = {
  platform: Platform;
  platformLabel: string;
  filename: string;
  url: string;
  bytes: number;
};

export type ReleaseInfo = {
  tag: string;
  /** Display version: the release name when set, otherwise the tag. */
  version: string;
  isBeta: boolean;
  publishedAt: string;
  url: string;
  downloads: Download[];
};

type GhAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type GhRelease = {
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
};

type CacheShape = {
  repos: Record<string, ReleaseInfo | null>;
};

const API = 'https://api.github.com';

/**
 * Resolved from the project root rather than `import.meta.url`: during a build
 * this module is bundled into `dist/.prerender/`, so a URL-relative path would
 * point at the throwaway build output instead of the committed source file.
 * npm scripts always run with the package directory as cwd.
 */
const CACHE_PATH = path.resolve(process.env.RELEASE_CACHE_PATH ?? 'src/data/release-cache.json');

const PLATFORM_LABELS: Record<Platform, string> = {
  linux: 'Linux',
  windows: 'Windows',
  macos: 'macOS',
};

const PLATFORM_ORDER: readonly Platform[] = ['linux', 'windows', 'macos'];

/**
 * Ordered most-specific first. A source archive is `.tar.gz`/`.zip` and matches
 * nothing here, so source code is intentionally not offered as a download.
 */
const EXTENSIONS: ReadonlyArray<readonly [Platform, RegExp]> = [
  ['linux', /\.(appimage|deb|rpm|snap|flatpak)$/i],
  ['windows', /\.(exe|msi|msix)$/i],
  ['macos', /\.(dmg|pkg)$/i],
];

/**
 * A version label can advertise a pre-release even when GitHub's own
 * `prerelease` flag is false. RimChronicle ships releases named
 * "1.2.3-beta" from a non-prerelease tag, so the name is the signal we trust
 * for presentation.
 */
const BETA_SUFFIX = /-(alpha|beta|rc|pre|preview|dev|nightly)(\.\d+)?\d*$/i;

export function isBetaLabel(version: string): boolean {
  return BETA_SUFFIX.test(version.trim());
}

function authToken(): string | undefined {
  return process.env.GITHUB_RELEASES_TOKEN || process.env.GITHUB_TOKEN || undefined;
}

function classify(asset: GhAsset): Download | null {
  for (const [platform, pattern] of EXTENSIONS) {
    if (pattern.test(asset.name)) {
      return {
        platform,
        platformLabel: PLATFORM_LABELS[platform],
        filename: asset.name,
        url: asset.browser_download_url,
        bytes: asset.size,
      };
    }
  }
  return null;
}

function summarise(release: GhRelease | undefined): ReleaseInfo | null {
  if (!release) return null;

  const version = release.name?.trim() || release.tag_name;
  const downloads = release.assets
    .map(classify)
    .filter((item): item is Download => item !== null)
    .sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform));

  return {
    tag: release.tag_name,
    version,
    isBeta: release.prerelease || isBetaLabel(version),
    publishedAt: release.published_at,
    url: release.html_url,
    downloads,
  };
}

function selectRelease(list: GhRelease[], includePrerelease: boolean): GhRelease | undefined {
  return list
    .filter((release) => !release.draft)
    .filter((release) => includePrerelease || !release.prerelease)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
}

async function readCache(repo: string): Promise<ReleaseInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(CACHE_PATH, 'utf8')) as CacheShape;
    return parsed.repos?.[repo] ?? null;
  } catch {
    return null;
  }
}

async function writeCache(repo: string, info: ReleaseInfo): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(CACHE_PATH, 'utf8')) as CacheShape;
    parsed.repos ??= {};
    // Only rewrite when something actually changed, otherwise every build
    // leaves a dirty working tree.
    if (JSON.stringify(parsed.repos[repo]) === JSON.stringify(info)) return;
    parsed.repos[repo] = info;
    await mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    console.log(`[releases] updated cached release for ${repo} -> ${info.version}`);
  } catch (err) {
    console.warn(`[releases] could not update cache for ${repo}:`, err);
  }
}

async function fetchRelease(project: Project): Promise<ReleaseInfo | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'averyfaulk.github.io',
  };
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API}/repos/${project.repo}/releases?per_page=20`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API responded ${response.status} ${response.statusText}`);
  }
  const list = (await response.json()) as GhRelease[];
  return summarise(selectRelease(list, project.includePrerelease));
}

async function load(project: Project): Promise<ReleaseInfo | null> {
  // Keep `astro dev` from spending API quota on every reload.
  if (import.meta.env.DEV) return null;

  const cached = await readCache(project.repo);
  try {
    const info = await fetchRelease(project);
    if (info) await writeCache(project.repo, info);
    return info;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[releases] live fetch failed for ${project.repo}: ${reason}`);
    if (cached) {
      console.warn(`[releases] using cached release ${cached.version} for ${project.repo}`);
      return cached;
    }
    console.warn(`[releases] no cached release for ${project.repo}; downloads omitted`);
    return null;
  }
}

const inflight = new Map<string, Promise<ReleaseInfo | null>>();

/** Memoised per repo, so N pages referencing a project cost one request. */
export function getRelease(project: Project): Promise<ReleaseInfo | null> {
  let pending = inflight.get(project.repo);
  if (!pending) {
    pending = load(project);
    inflight.set(project.repo, pending);
  }
  return pending;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  // One decimal below 100 reads better; above that it is just noise, so a
  // 136.47 MB installer should not claim to be "136.5 MB".
  return `${value.toFixed(value < 100 ? 1 : 0)} ${units[index]}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
