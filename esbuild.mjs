// Bundles the extension into dist/extension.js (CommonJS, Node 20 — VS Code's extension host).
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // vscode is provided by the extension host; @cfworker/json-schema is an optional peer of the MCP
  // SDK that we do not use (its default validator is ajv).
  external: ['vscode', '@cfworker/json-schema'],
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
