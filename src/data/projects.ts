export type Project = {
  /** URL segment: /projects/<slug>/ */
  slug: string;
  name: string;
  tagline: string;
  /** owner/repo on GitHub, used for both the repo link and the release feed. */
  repo: string;
  /** One-paragraph summary, used for the card and meta description. */
  summary: string;
  /** Longer prose shown only on the project page. */
  detail: string;
  features: { title: string; body: string }[];
  tech: string[];
  /** What the visitor can actually download today. */
  platforms: string[];
  /**
   * Whether a release GitHub has flagged `prerelease` may be treated as the
   * latest. Independent of the beta badge, which is presentation only.
   */
  includePrerelease: boolean;
  showReleases: boolean;
  featured: boolean;
  order: number;
};

export const projects: Project[] = [
  {
    slug: 'rimchronicle',
    name: 'RimChronicle',
    tagline: 'Storyteller Wiki & Novel Studio',
    repo: 'averyfaulk/RimChronicle',
    summary:
      'Turns a RimWorld playthrough into an automated Markdown wiki, relationship graph, timeline chronicle and novelization studio.',
    detail:
      'A local-first Electron desktop app for turning a playthrough — or any sci-fi, fantasy or TTRPG campaign — into a living record of the world. Everything you write is stored on your device, and every feature works fully offline against a rule-based storytelling engine. Where you want more, the same features are supercharged by AI through the OpenCode gateway.',
    features: [
      {
        title: 'World Wiki',
        body: 'Nested, Obsidian-style Markdown articles with [[WikiLinks]], hover previews, backlinks, drag-and-drop folders and full-text search.',
      },
      {
        title: 'Social Web',
        body: 'A draggable character relationship graph covering romance, feuds, kinship, mentorship and more, with per-bond opinion ratings.',
      },
      {
        title: 'World Map',
        body: 'An interactive map with location nodes, danger rings, terrain-difficulty-weighted travel routes and multi-mode travel-time math.',
      },
      {
        title: 'Chronicle Timeline',
        body: 'A living in-game calendar with a master clock, event stencils, downtime vignettes and branching Crossroads scenarios.',
      },
      {
        title: 'Ideology',
        body: 'Per-faction Precept Matrices that track doctrinal stances and surface cultural-friction drama automatically.',
      },
      {
        title: 'Plot Doctor',
        body: 'A narrative consistency audit that finds plot holes, contradictions, dead zones and unresolved arcs, then bridges them.',
      },
      {
        title: 'Novel Studio',
        body: 'A full Act to Chapter to Scene manuscript editor with AI chapter generation and on-device canon enforcement.',
      },
      {
        title: 'Archivist AI',
        body: 'An in-universe Chronicler chatbot with complete knowledge of your world, wiki, timeline and factions.',
      },
    ],
    tech: ['React 19', 'TypeScript', 'Electron', 'Vite 6', 'Tailwind CSS 4', 'OpenCode'],
    platforms: ['Windows', 'Linux'],
    includePrerelease: true,
    showReleases: true,
    featured: true,
    order: 1,
  },
];

export function bySlug(slug: string): Project | undefined {
  return projects.find((project) => project.slug === slug);
}
