# averyfaulk.github.io

Personal site: a project list plus a detail page per project, with download
buttons wired to each project's latest GitHub release.

Static output, no client-side JavaScript, no tracking.

## Commands

| Command | Action |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Start the dev server (`astro dev --background`) |
| `npm run check` | Type check with `astro check` |
| `npm run build` | Build to `dist/` |
| `npm run preview` | Serve the built `dist/` locally |

## Adding a project

Add one entry to `src/data/projects.ts`. That is the only edit required.

- `repo` must be `owner/name` on GitHub. It drives both the repository link and
  the release feed, and the download buttons update themselves when you publish
  a new release.
- `includePrerelease` decides whether a release GitHub has flagged `prerelease`
  may be treated as the latest. This is separate from the beta badge, which is
  inferred from the release *name* and is presentation only.
- `showReleases: false` hides the download panel for projects with no binaries.

Set `featured: false` to keep a project out of the index while retaining its
page.

## How release data works

`src/lib/releases.ts` fetches `/repos/{repo}/releases` once per build, during
`astro build` only, and is memoised so a project referenced by several pages
still costs a single request.

Assets are classified by extension — `.AppImage`/`.deb`/`.rpm`/`.snap`/`.flatpak`
to Linux, `.exe`/`.msi`/`.msix` to Windows, `.dmg`/`.pkg` to macOS. Source
archives are not offered as downloads.

Failures never break the build. The most recent successful result is committed
to `src/data/release-cache.json` and used when the API is unreachable; if there
is no cache entry either, the page renders without a download panel.

The cache file is committed on purpose so a fresh clone builds with no network
access, and so a failed deploy does not silently drop every download button.

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every
push to `main`. In the repository settings, set **Pages → Source** to
**GitHub Actions** — otherwise the workflow goes green and the site stays 404.

`.github/workflows/secret-scan.yml` runs gitleaks over new commits on every
push and blocks anything newly introduced. There is deliberately no
`.gitleaks.toml`: this site has no credentials, so an allowlist would only be a
place for a secret to hide.
