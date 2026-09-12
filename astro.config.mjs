import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.desertgreymusicfestival.com',
  compressHTML: true,
  devToolbar: { enabled: false },
});
