// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// The repository name already matches the apex domain, so no `base` is needed:
// pages resolve as /projects/rimchronicle/ rather than /averyfaulk.github.io/...
export default defineConfig({
  site: 'https://averyfaulk.github.io',
  vite: {
    plugins: [tailwindcss()],
  },
});
