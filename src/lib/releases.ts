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
  /**
   * Post-download step, or null when the file runs as-is. `command` is a shell
   * line shown verbatim under a `label`; `note` is prose.
   */
  installHint: { kind: 'command'; label: string; text: string } | { kind: 'note'; text: string } | null;
};

export type ReleaseInfo = {
  tag: string;
  /** Display version: the release name when set, otherwise the tag. */
  version: string;
  isBeta: boolean;
  publishedAt: string;
  url: string;
  downloads: Download[];
  /**
   * Release notes rendered to HTML. Safe to inject with `set:html`: the source
   * is escaped before any markup is added, so only tags from `renderNotes`
   * can ever reach the page.
   */
  notesHtml: string;
};

export type ReleasePanel = {
  release: ReleaseInfo | null;
  /**
   * `pushed_at` of the repository. Fetched live and never cached - it changes
   * on every commit, so caching it would rewrite the cache file on nearly
   * every build and leave the working tree permanently dirty.
   */
  updatedAt: string | null;
};

type GhAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type GhRelease = {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
};

type GhRepo = {
  pushed_at: string | null;
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

function headers(): Record<string, string> {
  const base: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'averyfaulk.github.io',
  };
  const token = authToken();
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Bare URLs only - an unescaped `javascript:` or `data:` href never gets through. */
function linkify(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"']+/g, (match) => {
    const trailing = /[.,;:!?)\]]+$/.exec(match)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    if (!url) return match;
    return `<a href="${url}" rel="noopener noreferrer nofollow">${url}</a>${trailing}`;
  });
}

function inline(text: string): string {
  return linkify(
    text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>'),
  );
}

/**
 * A deliberately small Markdown subset for GitHub release bodies: headings,
 * bullet lists, `**bold**`, `` `code` `` and bare URLs. Input is escaped first,
 * so a release description cannot inject markup - a real concern when the
 * source is an API response rendered into a public page.
 */
export function renderNotes(body: string | null | undefined): string {
  if (!body) return '';

  // GitHub release bodies frequently arrive with CRLF endings.
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flush = () => {
    if (paragraph.length) {
      blocks.push(`<p>${inline(escapeHtml(paragraph.join(' ')))}</p>`);
      paragraph = [];
    }
    if (bullets.length) {
      const items = bullets.map((item) => `<li>${inline(escapeHtml(item))}</li>`).join('');
      blocks.push(`<ul>${items}</ul>`);
      bullets = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }

    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      if (paragraph.length) flush();
      bullets.push(bullet[1] ?? '');
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(`<h4>${inline(escapeHtml(heading[1] ?? ''))}</</h4>`);
      continue;
    }

    if (bullets.length) flush();
    paragraph.push(line);
  }
  flush();

  return blocks.join('');
}

function installHintFor(filename: string): Download['installHint'] {
  if (/\.appimage$/i.test(filename)) {
    return {
      kind: 'command',
      label: 'Install and run',
      text: `chmod +x ${filename} && ./${filename}`,
    };
  }
  if (/\.deb$/i.test(filename)) {
    return { kind: 'command', label: 'Install with', text: `sudo apt install ./${filename}` };
  }
  if (/\.dmg$/i.test(filename)) {
    return { kind: 'note', text: 'Open the disk image and drag the app into Applications.' };
  }
  if (/\.msi$/i.test(filename)) {
    return { kind: 'note', text: 'Run the installer and follow the prompts.' };
  }
  // .exe installers and flatpaks need nothing beyond double-clicking.
  return null;
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
        installHint: installHintFor(asset.name),
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
    notesHtml: renderNotes(release.body),
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
  const response = await fetch(`${API}/repos/${project.repo}/releases?per_page=20`, {
    headers: headers(),
  });
  if (!response.ok) {
    throw new Error(`GitHub API responded ${response.status} ${response.statusText}`);
  }
  const list = (await response.json()) as GhRelease[];
  return summarise(selectRelease(list, project.includePrerelease));
}

/** Best effort: a missing last-updated date must never fail the build. */
async function fetchUpdatedAt(repo: string): Promise<string | null> {
  try {
    const response = await fetch(`${API}/repos/${repo}`, { headers: headers() });
    if (!response.ok) return null;
    const data = (await response.json()) as GhRepo;
    return data.pushed_at ?? null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[releases] could not read pushed_at for ${repo}: ${reason}`);
    return null;
  }
}

async function load(project: Project): Promise<ReleasePanel> {
  // Keep `astro dev` from spending API quota on every reload.
  if (import.meta.env.DEV || !project.repo) return { release: null, updatedAt: null };

  const updatedAt = fetchUpdatedAt(project.repo);

  let release: ReleaseInfo | null = null;
  if (project.showReleases) {
    const cached = await readCache(project.repo);
    try {
      release = await fetchRelease(project);
      if (release) await writeCache(project.repo, release);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[releases] live fetch failed for ${project.repo}: ${reason}`);
      if (cached) {
        console.warn(`[releases] using cached release ${cached.version} for ${project.repo}`);
        release = cached;
      } else {
        console.warn(`[releases] no cached release for ${project.repo}; downloads omitted`);
      }
    }
  }

  return { release, updatedAt: await updatedAt };
}

const inflight = new Map<string, Promise<ReleasePanel>>();

/** Memoised per repo, so N pages referencing a project cost one request. */
export function getProjectRelease(project: Project): Promise<ReleasePanel> {
  const key = project.repo ?? `wip:${project.slug}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = load(project);
    inflight.set(key, pending);
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

/** True when both timestamps fall on the same UTC day, so one can be hidden. */
export function isSameDay(a: string, b: string): boolean {
  return formatDate(a) === formatDate(b);
}
