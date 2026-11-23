import { defineConfig } from 'tsdown'
import manifest from './package.json' with { type: 'json' }

const clientId = JSON.stringify(manifest.name)

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node24',
    dts: false,
    clean: false,
    sourcemap: true,
    outExtensions: () => ({ js: '.js' }),
  },
  {
    entry: { engine: 'src/engine/entry.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node24',
    dts: false,
    clean: false,
    sourcemap: true,
    outExtensions: () => ({ js: '.js' }),
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: true,
    deps: { neverBundle: [/^react(\/.*)?$/, /^@deepseek-ai\//] },
    outExtensions: () => ({ js: '.js' }),
    inputOptions: { platform: 'browser' },
    outputOptions: {
      banner: `window.__ModuleLoader__.load({id:${clientId},factory:require=>{var module={exports:{}};var exports=module.exports;`,
      footer: 'return module.exports}});',
    },
  },
])
