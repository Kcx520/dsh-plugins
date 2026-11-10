#!/usr/bin/env node
/**
 * dsh-comfyui CLI — the same tools as the plugin, without the plugin loader.
 *
 * The agent can always shell out to this file, so image/video generation keeps
 * working even when DSH's bundle loader decides not to mount the plugin.
 *
 *   node cli.mjs status
 *   node cli.mjs image --prompt "a cat" [--width 1024 --height 1024 --steps 30 --seed 42]
 *   node cli.mjs video --prompt "slow push in" [--image <file>] [--seconds 2] [--width 576 --height 320]
 *   node cli.mjs recent
 *
 * Why the rewrite: `index.js` imports `@deepseek-ai/dsh-tools`, which only
 * exists inside the harness process. Here it is swapped for a local shim that
 * hands back the tool descriptor unchanged — enough, because this CLI calls the
 * tool's own `execute`, not the registry that would consume the schema.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const cacheDir = path.join(here, '.cache')
const shim = path.join(cacheDir, 'dsh-tools-shim.mjs')
const entry = path.join(cacheDir, 'index.cli.mjs')

await mkdir(cacheDir, { recursive: true })
await writeFile(shim, 'export const defineTool = (options) => options\n')

const source = await readFile(path.join(here, 'index.js'), 'utf8')
await writeFile(
  entry,
  source.replaceAll("'@deepseek-ai/dsh-tools'", `'${pathToFileURL(shim).href}'`),
)

const mod = await import(pathToFileURL(entry).href)
const tools = new Map()
const config = {
  outputDir: path.join(here, '..', 'comfyui-output'),
}
mod.apply({ tools: { register: (tool) => tools.set(tool.name, tool) } }, config)

const argv = process.argv.slice(2)
const command = argv.shift() ?? 'status'
const flags = {}
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue
  const key = argv[i].slice(2)
  const next = argv[i + 1]
  flags[key] = next === undefined || next.startsWith('--') ? true : (i += 1, next)
}

const number = (key) => (flags[key] === undefined ? undefined : Number(flags[key]))
const toolName = { status: 'comfyui_status', image: 'comfyui_image', video: 'comfyui_video', wait: 'comfyui_wait', cancel: 'comfyui_cancel', recent: 'comfyui_recent' }[command]
if (!toolName) {
  console.error(`unknown command ${JSON.stringify(command)}; use status | image | video | recent`)
  process.exit(2)
}

const args = command === 'image'
  ? { prompt: flags.prompt, width: number('width'), height: number('height'), steps: number('steps'), seed: number('seed'), negative_prompt: flags.negative, cfg: number('cfg') }
  : command === 'video'
    ? { prompt: flags.prompt ?? '', image_path: flags.image, seconds: number('seconds'), frames: number('frames'), width: number('width'), height: number('height'), seed: number('seed'), wait_seconds: number('wait') }
    : command === 'wait'
      ? { prompt_id: flags.prompt_id ?? flags.promptId, wait_seconds: number('wait') }
      : command === 'cancel'
        ? { prompt_id: flags.prompt_id ?? flags.promptId }
        : command === 'recent'
      ? { limit: number('limit') }
      : {}

const result = await tools.get(toolName).execute(args)
console.log(result.text)
if (result.files?.length) for (const file of result.files) console.log(`file: ${file.path}`)
