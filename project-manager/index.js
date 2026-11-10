/**
 * dsh-project-manager — host face.
 *
 * The browser face talks to these exact routes. Everything is deliberately
 * small and local: projects are DSH workspaces (one directory each), files are
 * only touched inside the selected workspace, and deletion goes to a workspace
 * trash folder with an index so it can be restored.
 *
 * @module @local/dsh-project-manager
 */

import { randomUUID } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'dsh-project-manager'
export const inject = ['webServer', 'workspaceRegistry']

const MAX_BODY = 1_000_000
const MAX_LIST = 600
const MAX_PREVIEW = 512 * 1024
const MAX_RAW = 8 * 1024 * 1024
const MAX_RECENT = 3600
const MAX_RECENT_FILES = 18
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const BAD_NAME = /[<>:"/\\|?*\u0000-\u001f]/

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8',
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function resolveConfig(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const candidate = typeof value.trashDir === 'string' ? value.trashDir.trim() : ''
  const trashDir = candidate && candidate !== '.' && candidate !== '..' && !/[/\\:]/.test(candidate)
    ? candidate
    : '.dsh-trash'
  return {
    enabled: value.enabled !== false,
    root: resolve(typeof value.root === 'string' && value.root.trim() ? value.root : process.cwd()),
    trashDir,
  }
}

function norm(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function posix(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

function inside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function cleanRel(input) {
  let value = String(input ?? '').trim().replace(/\\/g, '/')
  if (!value || value === '.') return ''
  if (isAbsolute(value) || /^[a-zA-Z]:/.test(value)) throw new HttpError(400, '只能使用项目内的相对路径')
  const parts = value.split('/').filter((part) => part !== '')
  if (parts.some((part) => part === '..' || part === '.')) throw new HttpError(400, '路径里不能有 . 或 ..')
  if (parts.some((part) => /[:*?"<>|]/.test(part) || /[. ]$/.test(part))) throw new HttpError(400, '路径里有不允许的字符')
  return parts.join('/')
}

function validateName(input, { project = false } = {}) {
  const value = String(input ?? '').trim()
  if (!value) throw new HttpError(400, '名称不能为空')
  if (value.length > 64) throw new HttpError(400, '名称最多 64 个字符')
  if (value === '.' || value === '..' || BAD_NAME.test(value)) throw new HttpError(400, '名称里有不允许的字符')
  if (/[. ]$/.test(value)) throw new HttpError(400, '名称不能以点或空格结尾')
  if (RESERVED_NAMES.test(value)) throw new HttpError(400, '这是 Windows 保留名称')
  if (project && value.startsWith('.')) throw new HttpError(400, '项目名不能以点开头')
  return value
}

async function assertInside(root, target) {
  const rootReal = await realpath(root)
  let probe = target
  for (;;) {
    try {
      await lstat(probe)
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  const real = await realpath(probe)
  if (!inside(rootReal, real)) throw new HttpError(403, '路径越出了项目文件夹')
}

async function resolveInside(root, input, { mustExist = false } = {}) {
  const rel = cleanRel(input)
  const abs = rel ? resolve(root, ...rel.split('/')) : root
  if (!inside(root, abs)) throw new HttpError(403, '路径越出了项目文件夹')
  await assertInside(root, abs)
  if (mustExist) {
    try {
      await lstat(abs)
    } catch {
      throw new HttpError(404, '文件或文件夹不存在')
    }
  }
  return { rel, abs }
}

function jsonEnd(response, status, payload) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(payload))
}

async function readJson(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, '请求太大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求不是合法 JSON')
  }
}

function fileEntry(rootDir, dirRel, name, st) {
  const rel = posix(join(dirRel, name))
  const kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other'
  return {
    name,
    path: rel,
    kind,
    size: st.size,
    mtime: st.mtimeMs,
    ext: extname(name).toLowerCase(),
    hidden: name.startsWith('.'),
  }
}

async function listDir(rootDir, dirRel, trashName) {
  const { abs } = await resolveInside(rootDir, dirRel, { mustExist: true })
  const st = await stat(abs)
  if (!st.isDirectory()) throw new HttpError(400, '这不是文件夹')
  const dirents = await readdir(abs, { withFileTypes: true })
  const entries = []
  for (const dirent of dirents) {
    if (dirRel === '' && dirent.name === trashName) continue
    const target = join(abs, dirent.name)
    try {
      const info = await lstat(target)
      entries.push(fileEntry(rootDir, dirRel, dirent.name, info))
    } catch {
      // A file disappearing mid-list should not fail the whole directory.
    }
    if (entries.length >= MAX_LIST) break
  }
  entries.sort((a, b) => {
    if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  })
  return {
    path: posix(dirRel),
    parent: dirRel === '' ? null : posix(dirname(dirRel)),
    entries,
    truncated: dirents.length > entries.length,
  }
}

async function quickLatest(rootDir) {
  let latest = 0
  try {
    const st = await stat(rootDir)
    latest = st.mtimeMs
    const dirents = await readdir(rootDir, { withFileTypes: true })
    await Promise.all(dirents.slice(0, 80).map(async (dirent) => {
      try {
        const info = await lstat(join(rootDir, dirent.name))
        if (info.mtimeMs > latest) latest = info.mtimeMs
      } catch {
        // ignore
      }
    }))
  } catch {
    // missing project directory: report 0
  }
  return latest
}

async function scanRecent(rootDir) {
  const found = []
  let visited = 0
  async function walk(dir, rel, depth) {
    if (depth > 3 || visited >= MAX_RECENT) return
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      if (visited >= MAX_RECENT) return
      visited += 1
      if (dirent.name === 'node_modules' || dirent.name === '.git' || dirent.name === '.dsh-trash') continue
      const target = join(dir, dirent.name)
      const childRel = posix(join(rel, dirent.name))
      if (dirent.isDirectory()) {
        await walk(target, childRel, depth + 1)
        continue
      }
      if (!dirent.isFile()) continue
      try {
        const info = await lstat(target)
        found.push({
          name: dirent.name,
          path: childRel,
          size: info.size,
          mtime: info.mtimeMs,
          ext: extname(dirent.name).toLowerCase(),
        })
      } catch {
        // ignore
      }
    }
  }
  await walk(rootDir, '', 0)
  found.sort((a, b) => b.mtime - a.mtime)
  return found.slice(0, MAX_RECENT_FILES)
}

async function ensureTrash(rootDir, trashName) {
  const dir = join(rootDir, trashName)
  try {
    const info = await lstat(dir)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new HttpError(500, '回收站路径不是文件夹')
  } catch (error) {
    if (error instanceof HttpError) throw error
    if (error?.code !== 'ENOENT') throw error
    await mkdir(dir, { recursive: true })
  }
  const rootReal = await realpath(rootDir)
  const dirReal = await realpath(dir)
  if (!inside(rootReal, dirReal)) throw new HttpError(403, '回收站越出了项目文件夹')
  return dir
}

async function readTrashIndex(rootDir, trashName) {
  const dir = join(rootDir, trashName)
  try {
    const raw = await readFile(join(dir, 'index.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string' && typeof item.path === 'string') : []
  } catch {
    return []
  }
}

async function writeTrashIndex(rootDir, trashName, entries) {
  const dir = join(rootDir, trashName)
  const tmp = join(dir, `index.${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8')
  await rename(tmp, join(dir, 'index.json'))
}

function moveAcrossDevices(error) {
  return error?.code === 'EXDEV' || error?.code === 'EPERM' || error?.code === 'EACCES'
}

function readRawBody(query) {
  const workspaceId = String(query.get('workspaceId') ?? '')
  const path = String(query.get('path') ?? '')
  return { workspaceId, path }
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return () => {}

  let opTail = Promise.resolve()
  const serial = (fn) => {
    const next = opTail.then(fn, fn)
    opTail = next.catch(() => {})
    return next
  }

  function workspaces() {
    return ctx.workspaceRegistry.list()
  }

  function workspaceOf(id) {
    const found = workspaces().find((item) => String(item.id) === String(id))
    if (found === undefined) throw new HttpError(404, '项目不存在')
    return found
  }

  function rootOf(id) {
    return workspaceOf(id).path
  }

  function runningByPath() {
    const counts = new Map()
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.list !== 'function') return counts
    for (const agent of agents.list()) {
      const status = String(agent?.status ?? '')
      if (!status || status === 'idle' || status === 'stopped' || status === 'cancelled') continue
      let dir
      try {
        dir = ctx.get('workingDirectory')?.get(agent?.session)
      } catch {
        // fall through to header cwd
      }
      if (typeof dir !== 'string' || !dir) dir = agent?.session?.header?.cwd
      if (typeof dir !== 'string' || !dir) continue
      const key = norm(resolve(dir))
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }

  async function projectView(item, running) {
    const latest = await quickLatest(item.path)
    return {
      id: String(item.id),
      title: item.title,
      path: item.path,
      createdAt: item.createdAt ?? null,
      updatedAt: item.updatedAt ?? null,
      sessionCount: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
      lastModified: latest,
      running: running.get(norm(item.path)) ?? 0,
      exists: existsSync(item.path),
      isRoot: norm(item.path) === norm(config.root),
    }
  }

  async function discoveredDirs() {
    let dirents
    try {
      dirents = await readdir(config.root, { withFileTypes: true })
    } catch {
      return []
    }
    const known = new Set(workspaces().map((item) => norm(item.path)))
    const result = []
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name === config.trashDir) continue
      const abs = join(config.root, dirent.name)
      if (known.has(norm(abs))) continue
      result.push({ name: dirent.name, path: abs, lastModified: await quickLatest(abs) })
    }
    result.sort((a, b) => b.lastModified - a.lastModified)
    return result.slice(0, 60)
  }

  async function statePayload(preferredId) {
    const running = runningByPath()
    const items = await Promise.all(workspaces().map((item) => projectView(item, running)))
    items.sort((a, b) => {
      if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1
      return (b.lastModified ?? 0) - (a.lastModified ?? 0)
    })
    const discovered = await discoveredDirs()
    const preferred = preferredId !== undefined ? items.find((item) => item.id === String(preferredId)) : undefined
    return {
      root: config.root,
      trashDir: config.trashDir,
      workspaces: items,
      discovered,
      selectedWorkspaceId: preferred?.id ?? items.find((item) => item.isRoot)?.id ?? items[0]?.id ?? null,
    }
  }

  async function createProject(body) {
    const projectName = validateName(body.name, { project: true })
    await mkdir(config.root, { recursive: true })
    const abs = join(config.root, projectName)
    let existed = false
    try {
      const info = await lstat(abs)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(409, '同名文件已存在，不能作为项目文件夹')
      existed = true
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (error?.code !== 'ENOENT') throw error
      await mkdir(abs)
    }
    const workspace = await ctx.workspaceRegistry.create(abs, projectName)
    return { workspace: await projectView(workspace, runningByPath()), existed, state: await statePayload(workspace.id) }
  }

  async function importProjects(body) {
    const names = Array.isArray(body.names) ? body.names.slice(0, 40) : []
    const imported = []
    const skipped = []
    for (const raw of names) {
      let projectName
      try {
        projectName = validateName(raw, { project: true })
      } catch {
        skipped.push(String(raw))
        continue
      }
      const abs = join(config.root, projectName)
      try {
        const info = await lstat(abs)
        if (!info.isDirectory() || info.isSymbolicLink()) {
          skipped.push(projectName)
          continue
        }
        const workspace = await ctx.workspaceRegistry.create(abs, projectName)
        imported.push(String(workspace.id))
      } catch {
        skipped.push(projectName)
      }
    }
    return { imported, skipped, state: await statePayload(imported[0]) }
  }

  async function trashList(id) {
    const root = rootOf(id)
    const entries = await readTrashIndex(root, config.trashDir)
    const result = []
    for (const entry of entries) {
      const stored = join(root, config.trashDir, entry.id, entry.name)
      if (!existsSync(stored)) continue
      result.push({
        id: entry.id,
        name: entry.name,
        path: entry.path,
        deletedAt: entry.deletedAt,
        kind: entry.kind,
        size: entry.size ?? 0,
      })
    }
    result.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
    return { entries: result }
  }

  async function addToTrash(id, body) {
    const root = rootOf(id)
    const requested = Array.isArray(body.paths) ? body.paths.slice(0, 60) : []
    if (requested.length === 0) throw new HttpError(400, '没有选择要删除的内容')
    const trash = await ensureTrash(root, config.trashDir)
    const index = await readTrashIndex(root, config.trashDir)
    const moved = []
    for (const item of requested) {
      const { rel, abs } = await resolveInside(root, item, { mustExist: true })
      if (rel === '') throw new HttpError(400, '不能删除项目根目录')
      if (rel === config.trashDir || rel.startsWith(`${config.trashDir}/`)) throw new HttpError(400, '不能删除回收站')
      const info = await lstat(abs)
      if (info.isSymbolicLink()) throw new HttpError(400, `暂不支持移动符号链接：${rel}`)
      const trashId = randomUUID()
      const bucket = join(trash, trashId)
      await mkdir(bucket, { recursive: true })
      const destination = join(bucket, basename(abs))
      try {
        await rename(abs, destination)
      } catch (error) {
        if (!moveAcrossDevices(error)) throw error
        await cp(abs, destination, { recursive: true, force: true, errorOnExist: false })
        await rm(abs, { recursive: true, force: true })
      }
      index.push({
        id: trashId,
        name: basename(abs),
        path: rel,
        kind: info.isDirectory() ? 'dir' : 'file',
        size: info.size,
        deletedAt: Date.now(),
      })
      // Persist after every item: a later failure must not orphan earlier moves.
      await writeTrashIndex(root, config.trashDir, index)
      moved.push(rel)
    }
    return { moved }
  }

  async function restoreTrash(id, body) {
    const root = rootOf(id)
    const trashId = String(body.id ?? '')
    const index = await readTrashIndex(root, config.trashDir)
    const entry = index.find((item) => item.id === trashId)
    if (entry === undefined) throw new HttpError(404, '回收站里找不到这一项')
    const stored = join(root, config.trashDir, entry.id, entry.name)
    if (!existsSync(stored)) throw new HttpError(404, '回收站文件已不存在')
    const { abs } = await resolveInside(root, entry.path)
    if (existsSync(abs)) throw new HttpError(409, `原位置已有同名内容：${entry.path}`)
    await mkdir(dirname(abs), { recursive: true })
    try {
      await rename(stored, abs)
    } catch (error) {
      if (!moveAcrossDevices(error)) throw error
      await cp(stored, abs, { recursive: true, force: true, errorOnExist: false })
      await rm(stored, { recursive: true, force: true })
    }
    await rm(join(root, config.trashDir, entry.id), { recursive: true, force: true })
    await writeTrashIndex(root, config.trashDir, index.filter((item) => item.id !== trashId))
    return { restored: entry.path }
  }

  async function emptyTrash(id) {
    const root = rootOf(id)
    const trash = join(root, config.trashDir)
    await rm(trash, { recursive: true, force: true })
    await mkdir(trash, { recursive: true })
    await writeTrashIndex(root, config.trashDir, [])
    return { emptied: true }
  }

  async function recentFiles(id) {
    const root = rootOf(id)
    return { entries: await scanRecent(root) }
  }

  function route(handler) {
    return async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const body = request.method === 'POST' ? await readJson(request) : {}
        const payload = await handler({ url, body })
        jsonEnd(response, 200, { ok: true, ...payload })
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        jsonEnd(response, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const disposers = []
  const off = ctx.inject(['webServer'], (webCtx) => {
    const add = (path, handler) => {
      disposers.push(webCtx.webServer.register({ kind: 'exact', path, handler }))
    }

    add('/project-manager/state', route(async ({ url }) => statePayload(url.searchParams.get('preferred') ?? undefined)))

    add('/project-manager/project/create', route(async ({ body }) => serial(() => createProject(body))))

    add('/project-manager/project/import', route(async ({ body }) => serial(() => importProjects(body))))

    add('/project-manager/project/rename', route(async ({ body }) => serial(async () => {
      const title = String(body.title ?? '').trim()
      if (!title || title.length > 80) throw new HttpError(400, '项目名需要 1–80 个字符')
      const workspace = workspaceOf(body.id)
      await workspace.setTitle(title)
      return { state: await statePayload(workspace.id) }
    })))

    add('/project-manager/project/remove', route(async ({ body }) => serial(async () => {
      const workspace = workspaceOf(body.id)
      if (norm(workspace.path) === norm(config.root)) throw new HttpError(400, '根目录不能移除')
      await ctx.workspaceRegistry.delete(String(workspace.id))
      return { state: await statePayload() }
    })))

    add('/project-manager/files/list', route(async ({ body }) => {
      const root = rootOf(body.workspaceId)
      return listDir(root, cleanRel(body.path), config.trashDir)
    }))

    add('/project-manager/files/mkdir', route(async ({ body }) => serial(async () => {
      const root = rootOf(body.workspaceId)
      const dirName = validateName(body.name)
      const { rel, abs } = await resolveInside(root, body.path, { mustExist: true })
      const target = join(abs, dirName)
      if (existsSync(target)) throw new HttpError(409, '同名内容已存在')
      await mkdir(target)
      return { path: posix(join(rel, dirName)) }
    })))

    add('/project-manager/files/rename', route(async ({ body }) => serial(async () => {
      const root = rootOf(body.workspaceId)
      const { rel, abs } = await resolveInside(root, body.path, { mustExist: true })
      if (rel === '') throw new HttpError(400, '不能重命名项目根目录')
      const nextName = validateName(body.name)
      const target = join(dirname(abs), nextName)
      if (norm(target) !== norm(abs) && existsSync(target)) throw new HttpError(409, '同名内容已存在')
      await rename(abs, target)
      return { path: posix(join(dirname(rel) === '.' ? '' : dirname(rel), nextName)) }
    })))

    add('/project-manager/files/move', route(async ({ body }) => serial(async () => {
      const root = rootOf(body.workspaceId)
      const { rel, abs } = await resolveInside(root, body.path, { mustExist: true })
      if (rel === '') throw new HttpError(400, '不能移动项目根目录')
      if (rel === config.trashDir || rel.startsWith(`${config.trashDir}/`)) throw new HttpError(400, '不能移动回收站内容')
      const { rel: destRel, abs: destDir } = await resolveInside(root, body.destDir, { mustExist: true })
      const destInfo = await stat(destDir)
      if (!destInfo.isDirectory()) throw new HttpError(400, '目标不是文件夹')
      if (destRel === rel || destRel.startsWith(`${rel}/`)) throw new HttpError(400, '不能移动到自身或子文件夹')
      const nextName = body.name === undefined || body.name === '' ? basename(abs) : validateName(body.name)
      const target = join(destDir, nextName)
      if (existsSync(target)) throw new HttpError(409, '目标位置已有同名内容')
      await rename(abs, target)
      return { path: posix(join(destRel, nextName)) }
    })))

    add('/project-manager/files/copy', route(async ({ body }) => serial(async () => {
      const root = rootOf(body.workspaceId)
      const { rel, abs } = await resolveInside(root, body.path, { mustExist: true })
      if (rel === '') throw new HttpError(400, '不能复制项目根目录')
      const info = await lstat(abs)
      if (info.isSymbolicLink()) throw new HttpError(400, '暂不支持复制符号链接')
      const { rel: destRel, abs: destDir } = await resolveInside(root, body.destDir, { mustExist: true })
      const destInfo = await stat(destDir)
      if (!destInfo.isDirectory()) throw new HttpError(400, '目标不是文件夹')
      const nextName = body.name === undefined || body.name === '' ? `${basename(abs)} copy` : validateName(body.name)
      const target = join(destDir, nextName)
      if (existsSync(target)) throw new HttpError(409, '目标位置已有同名内容')
      await cp(abs, target, { recursive: true, force: false, errorOnExist: true })
      return { path: posix(join(destRel, nextName)) }
    })))

    add('/project-manager/files/trash', route(async ({ body }) => serial(() => addToTrash(body.workspaceId, body))))

    add('/project-manager/files/preview', route(async ({ body }) => {
      const root = rootOf(body.workspaceId)
      const { rel, abs } = await resolveInside(root, body.path, { mustExist: true })
      const info = await lstat(abs)
      if (!info.isFile()) throw new HttpError(400, '只能预览文件')
      if (info.size > MAX_PREVIEW) throw new HttpError(413, '文件超过 512 KB，先在文件栏里打开')
      const data = await readFile(abs)
      if (data.subarray(0, 8192).includes(0)) throw new HttpError(415, '二进制文件不能当文本预览')
      return { path: rel, name: basename(abs), size: info.size, mtime: info.mtimeMs, text: data.toString('utf8') }
    }))

    add('/project-manager/files/recent', route(async ({ body }) => recentFiles(body.workspaceId)))

    add('/project-manager/trash/list', route(async ({ body }) => trashList(body.workspaceId)))

    add('/project-manager/trash/restore', route(async ({ body }) => serial(() => restoreTrash(body.workspaceId, body))))

    add('/project-manager/trash/empty', route(async ({ body }) => serial(() => emptyTrash(body.workspaceId))))

    add('/project-manager/files/raw', async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const { workspaceId, path } = readRawBody(url.searchParams)
        const root = rootOf(workspaceId)
        const { abs } = await resolveInside(root, path, { mustExist: true })
        const info = await lstat(abs)
        if (!info.isFile() || info.size > MAX_RAW) {
          jsonEnd(response, 413, { ok: false, error: '文件不存在或超过 8 MB' })
          return
        }
        const data = await readFile(abs)
        response.statusCode = 200
        response.setHeader('content-type', MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream')
        response.setHeader('cache-control', 'no-store')
        response.setHeader('x-content-type-options', 'nosniff')
        // A project file is untrusted input: never let an SVG/HTML payload run
        // scripts with the DSH origin's privileges when opened in a new tab.
        response.setHeader('content-security-policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
        response.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(basename(abs))}`)
        response.end(data)
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        jsonEnd(response, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // ignore
        }
      }
    }
  })

  return () => {
    try {
      off?.()
    } catch {
      // ignore
    }
  }
}
