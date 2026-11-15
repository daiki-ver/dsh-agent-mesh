import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'node',
  // The Host supplies these at runtime; bundling them would duplicate Cordis.
  deps: {
    neverBundle: [/^@deepseek-ai\//],
  },
})
