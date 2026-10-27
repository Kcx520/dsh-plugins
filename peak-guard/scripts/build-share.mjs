/**
 * Build the publishable package for sharing / npm.
 *
 * The working copy is linked into a DSH profile as `@local/dsh-peak-guard`, so
 * its manifest keeps that private name. This script copies the runtime files
 * into `dist/dsh-peak-guard/` under a public, unscoped name and rewrites the
 * bundle patch to match. Run `npm pack` inside `dist/dsh-peak-guard` (or
 * `node scripts/build-share.mjs --pack`) to produce the tarball.
 *
 * @module dsh-peak-guard/scripts/build-share
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const PUBLIC_NAME = 'dsh-peak-guard'
const root = new URL('../', import.meta.url)
const dist = new URL(`../dist/${PUBLIC_NAME}/`, import.meta.url)

const rootPkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

const publishPkg = {
  name: PUBLIC_NAME,
  version: rootPkg.version,
  description: rootPkg.description,
  type: 'module',
  license: 'MIT',
  author: rootPkg.author ?? 'dsh-peak-guard contributors',
  keywords: [
    'dsh',
    'dsh-plugin',
    'dsh-bundle',
    'deepseek',
    'deepseek-harness',
    'peak-hours',
    'off-peak',
    'cost-control',
    'agent',
    'plugin',
  ],
  engines: { node: '>=22' },
  exports: rootPkg.exports,
  files: rootPkg.files,
  dsh: rootPkg.dsh,
  publishConfig: { access: 'public' },
  scripts: { test: 'node --test test/*.test.mjs' },
}

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

for (const file of ['index.js', 'client.js', 'README.md', 'LICENSE', 'icon.svg']) {
  await cp(new URL(file, root), new URL(file, dist))
}
await mkdir(new URL('locale/', dist), { recursive: true })
for (const file of ['locale/en.json', 'locale/zh.json']) {
  await cp(new URL(file, root), new URL(file, dist))
}

await writeFile(new URL('package.json', dist), `${JSON.stringify(publishPkg, null, 2)}\n`)
await writeFile(
  new URL('cordis.patch.yml', dist),
  (await readFile(new URL('cordis.patch.yml', root), 'utf8')).replaceAll('@local/dsh-peak-guard', PUBLIC_NAME),
)

// Keep the tests in the repository but out of the published tarball.

console.log(`built ${PUBLIC_NAME}@${publishPkg.version} in dist/${PUBLIC_NAME}`)
console.log(`next: cd dist/${PUBLIC_NAME} && npm pack --pack-destination ../../share`)
