import { Readable } from 'node:stream'
import { mkdtemp, readFile, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'

const root = await mkdtemp(join(tmpdir(), 'pm-test-'))
const routes = new Map()
const workspaces = new Map()
let nextId = 1

const registry = {
  list() {
    return [...workspaces.values()]
  },
  async create(path, title) {
    for (const item of workspaces.values()) if (item.path.toLowerCase() === path.toLowerCase()) return item
    const item = {
      id: `ws-${nextId++}`,
      path,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionIds: [],
      async setTitle(next) {
        this.title = next
      },
    }
    workspaces.set(item.id, item)
    return item
  },
  async delete(id) {
    workspaces.delete(id)
    return true
  },
}

const ctx = {
  get() {
    return undefined
  },
  inject(_deps, callback) {
    callback({ webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } } })
    return () => {}
  },
  workspaceRegistry: registry,
}

apply(ctx, { root, trashDir: '.dsh-trash' })

async function call(path, body) {
  const handler = routes.get(path)
  if (!handler) throw new Error(`missing route ${path}`)
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  request.url = path
  request.method = body === undefined ? 'GET' : 'POST'
  let status = 0
  let payload = ''
  const response = {
    set statusCode(value) { status = value },
    get statusCode() { return status },
    setHeader() {},
    end(chunk) { payload += chunk ? String(chunk) : '' },
  }
  await handler(request, response)
  const data = JSON.parse(payload || '{}')
  if (!data.ok) throw new Error(`${path}: ${data.error}`)
  return data
}

function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`)
  console.log(`ok - ${message}`)
}

try {
  let state = await call('/project-manager/state')
  check(state.ok && state.workspaces.length === 0, 'empty state')

  const created = await call('/project-manager/project/create', { name: 'demo' })
  const id = created.workspace.id
  check(created.workspace.title === 'demo' && created.workspace.isRoot === false, 'create project')

  await call('/project-manager/files/mkdir', { workspaceId: id, path: '', name: 'src' })
  await writeFile(join(root, 'demo', 'src', 'a.txt'), 'hello world')
  await writeFile(join(root, 'demo', 'root.md'), '# root')

  let listing = await call('/project-manager/files/list', { workspaceId: id, path: '' })
  check(listing.entries.some((item) => item.name === 'src' && item.kind === 'dir'), 'list has src dir')
  check(!listing.entries.some((item) => item.name === '.dsh-trash'), 'trash hidden')

  listing = await call('/project-manager/files/list', { workspaceId: id, path: 'src' })
  check(listing.entries[0].name === 'a.txt', 'nested list')

  const preview = await call('/project-manager/files/preview', { workspaceId: id, path: 'src/a.txt' })
  check(preview.text === 'hello world', 'preview text')

  await call('/project-manager/files/rename', { workspaceId: id, path: 'src/a.txt', name: 'b.txt' })
  check((await readFile(join(root, 'demo', 'src', 'b.txt'), 'utf8')) === 'hello world', 'rename file')

  await call('/project-manager/files/copy', { workspaceId: id, path: 'src/b.txt', destDir: '' })
  check((await readFile(join(root, 'demo', 'b.txt copy'), 'utf8')) === 'hello world', 'copy file')

  await call('/project-manager/files/move', { workspaceId: id, path: 'b.txt copy', destDir: 'src', name: 'c.txt' })
  check((await readFile(join(root, 'demo', 'src', 'c.txt'), 'utf8')) === 'hello world', 'move file')

  const recent = await call('/project-manager/files/recent', { workspaceId: id })
  check(recent.entries.length >= 2, 'recent files')

  const baseTime = Math.floor(Date.now() / 1000) + 1000
  for (let i = 0; i < 25; i += 1) {
    const target = join(root, 'demo', 'src', `z-${String(i).padStart(2, '0')}.txt`)
    await writeFile(target, String(i))
    await utimes(target, baseTime + i, baseTime + i)
  }
  const latest = await call('/project-manager/files/recent', { workspaceId: id })
  check(latest.entries[0].name === 'z-24.txt', 'recent keeps newest file')
  check(latest.entries.length === 18, 'recent is capped at 18')

  await call('/project-manager/files/trash', { workspaceId: id, paths: ['src/c.txt'] })
  let trash = await call('/project-manager/trash/list', { workspaceId: id })
  check(trash.entries.length === 1 && trash.entries[0].path === 'src/c.txt', 'trash file')

  await call('/project-manager/trash/restore', { workspaceId: id, id: trash.entries[0].id })
  check((await readFile(join(root, 'demo', 'src', 'c.txt'), 'utf8')) === 'hello world', 'restore file')

  await call('/project-manager/project/rename', { id, title: '演示' })
  state = await call('/project-manager/state')
  check(state.workspaces[0].title === '演示', 'rename project title')

  await call('/project-manager/project/remove', { id })
  state = await call('/project-manager/state')
  check(state.workspaces.length === 0, 'remove registration keeps folder')
  check((await readFile(join(root, 'demo', 'root.md'), 'utf8')) === '# root', 'files remain')

  const imported = await call('/project-manager/project/import', { names: ['demo'] })
  check(imported.imported.length === 1, 'import folder')

  const bad = await call('/project-manager/files/list', { workspaceId: imported.imported[0], path: '../..' }).catch((error) => error)
  check(bad instanceof Error, 'reject path traversal')

  console.log('ALL OK')
} finally {
  await rm(root, { recursive: true, force: true })
}
