/**
 * dsh-project-manager — browser face.
 *
 * A settings section, a sidebar shortcut and a full-screen overlay all render
 * the same manager: projects on the left, the selected project's files on the
 * right. Everything talks to the host routes in ./index.js.
 *
 * @module @local/dsh-project-manager/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-project-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico'])
    const MEDIA_EXT = new Set(['.mp4', '.webm', '.mp3', '.wav', '.pdf'])

    let overlayOpen = false
    const overlayListeners = new Set()

    function setOverlayOpen(next) {
      overlayOpen = Boolean(next)
      for (const listener of overlayListeners) listener(overlayOpen)
    }

    function useOverlayOpen() {
      const [open, setOpen] = useState(overlayOpen)
      useEffect(() => {
        overlayListeners.add(setOpen)
        setOpen(overlayOpen)
        return () => overlayListeners.delete(setOpen)
      }, [])
      return open
    }

    async function api(path, body) {
      const init = body === undefined
        ? { cache: 'no-store' }
        : {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
      const response = await fetch(path, init)
      const raw = await response.text()
      let data = {}
      try {
        data = raw ? JSON.parse(raw) : {}
      } catch {
        data = { ok: false, error: raw.slice(0, 400) || `请求失败（${response.status}）` }
      }
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `请求失败（${response.status}）`)
      }
      return data
    }

    function rawUrl(workspaceId, path) {
      return `/project-manager/files/raw?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`
    }

    function formatSize(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
      return `${(value / 1024 / 1024).toFixed(1)} MB`
    }

    function formatTime(ms) {
      if (!ms) return '—'
      const date = new Date(ms)
      const now = Date.now()
      const diff = now - ms
      if (diff >= 0 && diff < 60_000) return '刚刚'
      if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
      if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
      return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }

    function bytes(value) {
      return Number(value) || 0
    }

    function iconFor(entry) {
      if (entry.kind === 'dir') return '▸'
      if (entry.kind === 'link') return '↗'
      if (IMAGE_EXT.has(entry.ext)) return '▧'
      if (entry.ext === '.md') return 'M'
      if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.yml', '.yaml', '.py', '.ps1', '.sh', '.css', '.html'].includes(entry.ext)) return '<>'
      return '·'
    }

    function joinPath(dir, name) {
      return dir ? `${dir}/${name}` : name
    }

    function parentOf(path) {
      const index = path.lastIndexOf('/')
      return index < 0 ? '' : path.slice(0, index)
    }

    function btn(label, onClick, options = {}) {
      return h('button', {
        type: 'button',
        className: `pm-btn${options.kind ? ` pm-btn-${options.kind}` : ''}${options.small ? ' pm-btn-sm' : ''}`,
        onClick,
        disabled: options.disabled,
        title: options.title,
      }, label)
    }

    function Spinner() {
      return h('span', { className: 'pm-spinner', 'aria-hidden': 'true' })
    }

    function Field({ label, value, onChange, placeholder, onEnter, inputRef }) {
      return h('label', { className: 'pm-field' },
        h('span', { className: 'pm-field-label' }, label),
        h('input', {
          ref: inputRef,
          className: 'pm-input',
          value,
          placeholder,
          onChange: (event) => onChange(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onEnter?.()
            }
          },
        }),
      )
    }

    function PromptDialog({ dialog, onDone }) {
      const [value, setValue] = useState(dialog.value ?? '')
      const inputRef = useRef(null)
      useEffect(() => {
        const timer = setTimeout(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        }, 30)
        return () => clearTimeout(timer)
      }, [])
      const submit = () => {
        const next = value.trim()
        if (!next) return
        onDone(next)
      }
      return h('div', {
        className: 'pm-dialog-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onDone(null)
        },
      },
      h('div', { className: 'pm-dialog' },
        h('div', { className: 'pm-dialog-title' }, dialog.title),
        dialog.message ? h('div', { className: 'pm-dialog-msg' }, dialog.message) : null,
        h(Field, {
          label: dialog.label ?? '名称',
          value,
          onChange: setValue,
          placeholder: dialog.placeholder ?? '',
          onEnter: submit,
          inputRef,
        }),
        h('div', { className: 'pm-dialog-actions' },
          btn('取消', () => onDone(null)),
          btn(dialog.confirmText ?? '确定', submit, { kind: 'primary' }),
        ),
      ))
    }

    function ConfirmDialog({ dialog, onDone }) {
      return h('div', {
        className: 'pm-dialog-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onDone(false)
        },
      },
      h('div', { className: 'pm-dialog' },
        h('div', { className: 'pm-dialog-title' }, dialog.title),
        h('div', { className: 'pm-dialog-msg' }, dialog.message),
        h('div', { className: 'pm-dialog-actions' },
          btn('取消', () => onDone(false)),
          btn(dialog.confirmText ?? '确定', () => onDone(true), { kind: dialog.danger ? 'danger' : 'primary' }),
        ),
      ))
    }

    function ImportDialog({ discovered, onDone }) {
      const [selected, setSelected] = useState({})
      const toggle = (name) => setSelected((prev) => ({ ...prev, [name]: !prev[name] }))
      const names = discovered.map((item) => item.name).filter((name) => selected[name])
      return h('div', {
        className: 'pm-dialog-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onDone(null)
        },
      },
      h('div', { className: 'pm-dialog pm-dialog-wide' },
        h('div', { className: 'pm-dialog-title' }, '导入已有文件夹'),
        h('div', { className: 'pm-dialog-msg' }, '把根目录里尚未注册的文件夹加入项目列表。不会移动或修改这些文件夹。'),
        discovered.length === 0
          ? h('div', { className: 'pm-empty-line' }, '根目录里的文件夹都已经在项目列表里了。')
          : h('div', { className: 'pm-import-list' },
              h('div', { className: 'pm-import-tools' },
                btn('全选', () => setSelected(Object.fromEntries(discovered.map((item) => [item.name, true]))), { small: true }),
                btn('清空', () => setSelected({}), { small: true }),
              ),
              discovered.map((item) => h('label', { key: item.name, className: 'pm-import-row' },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(selected[item.name]),
                  onChange: () => toggle(item.name),
                }),
                h('span', { className: 'pm-import-name' }, item.name),
                h('span', { className: 'pm-import-time' }, formatTime(item.lastModified)),
              )),
            ),
        h('div', { className: 'pm-dialog-actions' },
          btn('取消', () => onDone(null)),
          btn(names.length ? `导入 ${names.length} 个` : '导入', () => onDone(names), { kind: 'primary', disabled: names.length === 0 }),
        ),
      ))
    }

    function PreviewModal({ preview, onClose, onReveal }) {
      if (!preview) return null
      const { entry, loading, text, image, media, error } = preview
      return h('div', {
        className: 'pm-dialog-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
      h('div', { className: 'pm-dialog pm-preview' },
        h('div', { className: 'pm-preview-head' },
          h('div', { className: 'pm-preview-title' }, entry.name),
          h('div', { className: 'pm-preview-path' }, entry.path),
          h('div', { className: 'pm-preview-actions' },
            btn('定位', onReveal, { small: true }),
            btn('关闭', onClose, { small: true }),
          ),
        ),
        h('div', { className: 'pm-preview-body' },
          loading ? h('div', { className: 'pm-empty' }, h(Spinner), ' 正在读取…') : null,
          !loading && image ? h('img', { className: 'pm-preview-image', src: image, alt: entry.name }) : null,
          !loading && text !== undefined ? h('pre', { className: 'pm-preview-text' }, text) : null,
          !loading && media ? h('div', { className: 'pm-empty' },
            h('div', null, '这个文件太大或不是文本，浏览器不能直接预览。'),
            h('div', { className: 'pm-preview-path' }, `${formatSize(entry.size)} · ${entry.ext || '无扩展名'}`),
            h('a', { className: 'pm-link', href: media, target: '_blank', rel: 'noreferrer' }, '在新标签页打开'),
          ) : null,
          !loading && error ? h('div', { className: 'pm-empty pm-error-text' }, error) : null,
        ),
      ))
    }

    function ProjectManager({ embedded, close, ctx }) {
      const [overview, setOverview] = useState(null)
      const [selectedId, setSelectedId] = useState(null)
      const [tab, setTab] = useState('files')
      const [dir, setDir] = useState('')
      const [listing, setListing] = useState(null)
      const [recent, setRecent] = useState([])
      const [trash, setTrash] = useState([])
      const [filter, setFilter] = useState('')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [toast, setToast] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [importOpen, setImportOpen] = useState(false)
      const [preview, setPreview] = useState(null)

      const selectedIdRef = useRef(selectedId)
      selectedIdRef.current = selectedId
      const dirProjectRef = useRef(null)
      const dialogResolve = useRef(null)
      const toastTimer = useRef(null)

      const selected = overview?.workspaces.find((item) => item.id === selectedId) ?? null

      function showToast(message, kind = 'ok') {
        setToast({ message, kind })
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 3200)
      }

      useEffect(() => () => {
        if (toastTimer.current) clearTimeout(toastTimer.current)
      }, [])

      async function refresh(preferred) {
        try {
          const query = preferred ? `?preferred=${encodeURIComponent(preferred)}` : ''
          const data = await api(`/project-manager/state${query}`)
          setOverview(data)
          setSelectedId((previous) => {
            const wanted = preferred ?? previous
            if (wanted && data.workspaces.some((item) => item.id === wanted)) return wanted
            return data.selectedWorkspaceId
          })
          setError('')
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }

      useEffect(() => {
        refresh()
      }, [])

      useEffect(() => {
        if (!selectedId) return
        if (dirProjectRef.current !== selectedId) {
          dirProjectRef.current = selectedId
          if (dir !== '') {
            setDir('')
            setListing(null)
            return
          }
        }
        if (tab === 'files') loadFiles(selectedId, dir)
        else if (tab === 'recent') loadRecent(selectedId)
        else loadTrash(selectedId)
      }, [selectedId, tab, dir])

      async function loadFiles(projectId, target) {
        setBusy('files')
        try {
          const data = await api('/project-manager/files/list', { workspaceId: projectId, path: target })
          if (projectId !== selectedIdRef.current) return
          setListing(data)
          setError('')
        } catch (cause) {
          if (projectId === selectedIdRef.current) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (projectId === selectedIdRef.current) setBusy('')
        }
      }

      async function loadRecent(projectId) {
        setBusy('recent')
        try {
          const data = await api('/project-manager/files/recent', { workspaceId: projectId })
          if (projectId !== selectedIdRef.current) return
          setRecent(data.entries)
        } catch (cause) {
          if (projectId === selectedIdRef.current) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (projectId === selectedIdRef.current) setBusy('')
        }
      }

      async function loadTrash(projectId) {
        setBusy('trash')
        try {
          const data = await api('/project-manager/trash/list', { workspaceId: projectId })
          if (projectId !== selectedIdRef.current) return
          setTrash(data.entries)
        } catch (cause) {
          if (projectId === selectedIdRef.current) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (projectId === selectedIdRef.current) setBusy('')
        }
      }

      function selectProject(id) {
        if (id === selectedId) return
        setSelectedId(id)
        setDir('')
        setFilter('')
        setTab('files')
        setListing(null)
        setRecent([])
        setTrash([])
        setError('')
      }

      function finishDialog(value) {
        const resolve = dialogResolve.current
        dialogResolve.current = null
        setDialog(null)
        resolve?.(value)
      }

      function askText(options) {
        dialogResolve.current?.(null)
        return new Promise((resolve) => {
          dialogResolve.current = resolve
          setDialog({ kind: 'prompt', ...options })
        })
      }

      function askConfirm(options) {
        dialogResolve.current?.(false)
        return new Promise((resolve) => {
          dialogResolve.current = resolve
          setDialog({ kind: 'confirm', ...options })
        })
      }

      async function createProject() {
        const name = await askText({
          title: '新建项目',
          message: '会在根目录创建同名文件夹，并把它注册成 DSH 工作区。之后这个项目的会话都会归到这里。',
          label: '项目文件夹名',
          placeholder: '例如：my-new-project',
          confirmText: '创建',
        })
        if (name === null) return
        setBusy('project')
        try {
          const data = await api('/project-manager/project/create', { name })
          setOverview(data.state)
          setSelectedId(data.workspace.id)
          setDir('')
          setFilter('')
          setTab('files')
          showToast(`已创建 ${data.workspace.title}`)
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : String(cause), 'error')
        } finally {
          setBusy('')
        }
      }

      async function importProjects(names) {
        if (!names || names.length === 0) return
        setBusy('project')
        try {
          const data = await api('/project-manager/project/import', { names })
          setOverview(data.state)
          if (data.imported.length > 0) {
            setSelectedId(data.imported[0])
            setDir('')
            setFilter('')
            setTab('files')
          }
          showToast(`已导入 ${data.imported.length} 个项目`)
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : String(cause), 'error')
        } finally {
          setBusy('')
        }
      }

      async function renameProject() {
        if (!selected) return
        const title = await askText({
          title: '重命名项目',
          message: '只改项目在列表里的显示名称，不会改文件夹名。',
          label: '显示名称',
          value: selected.title,
          confirmText: '保存',
        })
        if (title === null) return
        setBusy('project')
        try {
          const data = await api('/project-manager/project/rename', { id: selected.id, title })
          setOverview(data.state)
          showToast('已重命名')
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : String(cause), 'error')
        } finally {
          setBusy('')
        }
      }

      async function removeProject() {
        if (!selected) return
        if (selected.isRoot) {
          showToast('根目录不能从项目列表移除', 'error')
          return
        }
        const ok = await askConfirm({
          title: '从列表移除项目',
          message: `只会把「${selected.title}」从项目列表里移除，文件夹和文件都不会删除，历史会话也保留。之后可以用「导入」重新加回来。`,
          confirmText: '移除',
          danger: true,
        })
        if (!ok) return
        setBusy('project')
        try {
          const data = await api('/project-manager/project/remove', { id: selected.id })
          setOverview(data.state)
          setSelectedId(data.state.selectedWorkspaceId)
          setDir('')
          setFilter('')
          setTab('files')
          showToast('已从列表移除')
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : String(cause), 'error')
        } finally {
          setBusy('')
        }
      }

      async function enterProject() {
        if (!selected) return
        setBusy('project')
        try {
          await ctx.uiWorkspace.openWorkspace(selected.id)
          close?.()
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : String(cause), 'error')
        } finally {
          setBusy('')
        }
      }

      async function copyPath() {
        if (!selected) return
        try {
          await navigator.clipboard.writeText(selected.path)
          showToast('项目路径已复制')
        } catch {
          showToast(selected.path, 'ok')
        }
      }

      async function createFolder() {
        if (!selected) return
        const name = await askText({
          title: '新建文件夹',
          message: `位置：${dir || '项目根目录'}`,
          label: '文件夹名',
          confirmText: '创建',
        })
        if (name === null) return
        setBusy('files')
        try {
          await api('/project-manager/files/mkdir', { workspaceId: selected.id, path: dir, name })
          await loadFiles(selected.id, dir)
          showToast('文件夹已创建')
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : String(cause), 'error')
        } finally {
          setBusy('')
        }
      }

      async function renameEntry(entry) {
        if (!selected) return
        const name = await askText({
          title: entry.kind === 'dir' ? '重命名文件夹' : '重命名文件',
          message: entry.path,
          label: '新名称',
          value: entry.name,
          confirmText: '重命名',
        })
        if (name === null) return
        setBusy('files')
        try {
          const data = await api('/project-manager/files/rename', { workspaceId: selected.id, path: entry.path, name })
          await loadFiles(selected.id, dir)
          showToast(`已重命名为 ${data.path.split('/').pop()}`)
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : String(cause), 'error')
        } finally {
          setBusy('')
        }
      }

      async function moveOrCopy(entry, mode) {
        if (!selected) return
        const destDir = await askText({
          title: mode === 'move' ? '移动到文件夹' : '复制到文件夹',
          message: `${entry.path}\n目标写相对项目根目录的路径，留空表示项目根目录。`,
          label: '目标文件夹',
          value: dir,
          placeholder: '例如：src/components 或留空',
          confirmText: mode === 'move' ? '移动' : '复制',
        })
        if (destDir === null) return
        setBusy('files')
        try {
          await api(`/project-manager/files/${mode}`, {
            workspaceId: selected.id,
            path: entry.path,
            destDir: destDir.trim(),
          })
          await loadFiles(selected.id, dir)
          showToast(mode === 'move' ? '已移动' : '已复制')
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : String(cause), 'error')
        } finally {
          setBusy('')
        }
      }

      async function trashEntry(entry) {
        if (!selected) return
        const ok = await askConfirm({
          title: '移到回收站',
          message: `「${entry.name}」会移到项目的 .dsh-trash 里，可以在这里恢复。`,
          confirmText: '移到回收站',
          danger: true,
        })
        if (!ok) return
        setBusy('files')
        try {
          await api('/project-manager/files/trash', { workspaceId: selected.id, paths: [entry.path] })
          await loadFiles(selected.id, dir)
          showToast('已移到回收站')
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : String(cause), 'error')
        } finally {
          setBusy('')
        }
      }

      async function openPreview(entry) {
        if (!selected) return
        const image = IMAGE_EXT.has(entry.ext) ? rawUrl(selected.id, entry.path) : null
        const media = MEDIA_EXT.has(entry.ext) ? rawUrl(selected.id, entry.path) : null
        setPreview({ entry, loading: !image && !media, image, media })
        if (image || media) return
        try {
          const data = await api('/project-manager/files/preview', { workspaceId: selected.id, path: entry.path })
          setPreview({ entry, text: data.text })
        } catch (cause) {
          setPreview({ entry, error: cause instanceof Error ? cause.message : String(cause) })
        }
      }

      function revealEntry(entry) {
        setPreview(null)
        setTab('files')
        setDir(parentOf(entry.path))
        setFilter('')
      }

      async function restoreItem(item) {
        if (!selected) return
        setBusy('trash')
        try {
          const data = await api('/project-manager/trash/restore', { workspaceId: selected.id, id: item.id })
          await loadTrash(selected.id)
          showToast(`已恢复到 ${data.restored}`)
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : String(cause), 'error')
        } finally {
          setBusy('')
        }
      }

      async function emptyTrash() {
        if (!selected) return
        const ok = await askConfirm({
          title: '清空回收站',
          message: '回收站里的内容会被永久删除，无法恢复。',
          confirmText: '永久删除',
          danger: true,
        })
        if (!ok) return
        setBusy('trash')
        try {
          await api('/project-manager/trash/empty', { workspaceId: selected.id })
          await loadTrash(selected.id)
          showToast('回收站已清空')
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : String(cause), 'error')
        } finally {
          setBusy('')
        }
      }

      const projectTotal = overview?.workspaces.length ?? 0
      const sessionTotal = overview?.workspaces.reduce((sum, item) => sum + item.sessionCount, 0) ?? 0
      const runningTotal = overview?.workspaces.reduce((sum, item) => sum + item.running, 0) ?? 0
      const segments = dir ? dir.split('/') : []
      const entries = (listing?.entries ?? []).filter((entry) => {
        const needle = filter.trim().toLowerCase()
        return !needle || entry.name.toLowerCase().includes(needle)
      })

      const rail = h('aside', { className: 'pm-rail' },
        h('div', { className: 'pm-rail-head' },
          h('div', { className: 'pm-rail-title' }, '项目'),
          h('div', { className: 'pm-rail-stats' }, `${projectTotal} 个项目 · ${sessionTotal} 个会话`),
        ),
        h('div', { className: 'pm-list' },
          (overview?.workspaces ?? []).map((item) => h('button', {
            key: item.id,
            type: 'button',
            className: `pm-project${item.id === selectedId ? ' is-active' : ''}`,
            onClick: () => selectProject(item.id),
            title: item.path,
          },
          h('span', { className: 'pm-project-line' },
            h('span', { className: 'pm-project-name' }, item.title),
            item.isRoot ? h('span', { className: 'pm-badge' }, '根') : null,
            item.running > 0 ? h('span', { className: 'pm-dot', title: `${item.running} 个会话运行中` }) : null,
            item.exists === false ? h('span', { className: 'pm-badge pm-badge-warn' }, '缺失') : null,
          ),
          h('span', { className: 'pm-project-meta' },
            `${item.sessionCount} 会话 · ${formatTime(item.lastModified)}`,
          )),
          ),
          (overview?.workspaces ?? []).length === 0 && !busy
            ? h('div', { className: 'pm-empty pm-empty-small' }, '还没有项目，先新建一个。')
            : null,
        ),
        h('div', { className: 'pm-rail-actions' },
          btn('新建', createProject, { kind: 'primary', small: true, disabled: Boolean(busy) }),
          btn('导入', () => setImportOpen(true), { small: true, disabled: Boolean(busy) }),
        ),
      )

      const detail = selected
        ? h('section', { className: 'pm-detail' },
            h('div', { className: 'pm-detail-head' },
              h('div', { className: 'pm-detail-title-row' },
                h('h2', { className: 'pm-detail-title' }, selected.title),
                selected.running > 0 ? h('span', { className: 'pm-live' }, '运行中') : null,
              ),
              h('div', { className: 'pm-detail-path', title: selected.path }, selected.path),
              h('div', { className: 'pm-detail-actions' },
                btn('进入项目', enterProject, { kind: 'primary', disabled: Boolean(busy) }),
                btn('改名', renameProject, { disabled: Boolean(busy) }),
                btn('复制路径', copyPath),
                btn('移除', removeProject, { kind: 'danger', disabled: Boolean(busy) || selected.isRoot, title: selected.isRoot ? '根目录不能移除' : '只移除列表项，不删文件' }),
              ),
            ),
            h('div', { className: 'pm-summary' },
              h('span', null, h('b', null, selected.sessionCount), ' 会话'),
              h('span', null, h('b', null, selected.running), ' 运行中'),
              h('span', null, '最近改动 ', h('b', null, formatTime(selected.lastModified))),
              h('span', { className: 'pm-summary-path' }, selected.exists === false ? '文件夹不存在' : '文件夹正常'),
            ),
            h('div', { className: 'pm-tabs' },
              h('button', { type: 'button', className: `pm-tab${tab === 'files' ? ' is-active' : ''}`, onClick: () => setTab('files') }, '文件'),
              h('button', { type: 'button', className: `pm-tab${tab === 'recent' ? ' is-active' : ''}`, onClick: () => setTab('recent') }, '最近改动'),
              h('button', { type: 'button', className: `pm-tab${tab === 'trash' ? ' is-active' : ''}`, onClick: () => setTab('trash') }, '回收站'),
            ),
            tab === 'files' ? h('div', { className: 'pm-panel' },
              h('div', { className: 'pm-toolbar' },
                h('div', { className: 'pm-crumbs' },
                  h('button', { type: 'button', className: 'pm-crumb', onClick: () => setDir('') }, '根目录'),
                  segments.map((segment, index) => h('span', { key: `${segment}-${index}`, className: 'pm-crumb-group' },
                    h('span', { className: 'pm-crumb-sep' }, '/'),
                    h('button', {
                      type: 'button',
                      className: 'pm-crumb',
                      onClick: () => setDir(segments.slice(0, index + 1).join('/')),
                    }, segment),
                  )),
                ),
                h('div', { className: 'pm-toolbar-right' },
                  h('input', {
                    className: 'pm-input pm-filter',
                    value: filter,
                    placeholder: '筛选当前文件夹',
                    onChange: (event) => setFilter(event.target.value),
                  }),
                  btn('新建文件夹', createFolder, { small: true, disabled: Boolean(busy) }),
                  btn('刷新', () => loadFiles(selected.id, dir), { small: true, disabled: Boolean(busy) }),
                ),
              ),
              busy === 'files' && !listing
                ? h('div', { className: 'pm-empty' }, h(Spinner), ' 正在读取…')
                : entries.length === 0
                  ? h('div', { className: 'pm-empty' }, filter ? '没有匹配的文件' : '这个文件夹是空的')
                  : h('div', { className: 'pm-files' },
                      h('div', { className: 'pm-file-head' },
                        h('span', null, '名称'),
                        h('span', { className: 'pm-size' }, '大小'),
                        h('span', { className: 'pm-time' }, '修改时间'),
                        h('span', { className: 'pm-actions-col' }, '操作'),
                      ),
                      entries.map((entry) => h('div', {
                        key: entry.path,
                        className: 'pm-file-row',
                        onDoubleClick: () => {
                          if (entry.kind === 'dir') setDir(entry.path)
                          else openPreview(entry)
                        },
                      },
                      h('div', { className: 'pm-file-name' },
                        h('span', { className: `pm-icon pm-icon-${entry.kind}` }, iconFor(entry)),
                        h('button', {
                          type: 'button',
                          className: 'pm-name-btn',
                          onClick: () => {
                            if (entry.kind === 'dir') setDir(entry.path)
                            else openPreview(entry)
                          },
                          title: entry.path,
                        }, entry.name),
                      ),
                      h('span', { className: 'pm-size' }, entry.kind === 'dir' ? '—' : formatSize(entry.size)),
                      h('span', { className: 'pm-time' }, formatTime(entry.mtime)),
                      h('div', { className: 'pm-row-actions' },
                        btn('改名', () => renameEntry(entry), { small: true, disabled: Boolean(busy) }),
                        btn('移动', () => moveOrCopy(entry, 'move'), { small: true, disabled: Boolean(busy) }),
                        btn('复制', () => moveOrCopy(entry, 'copy'), { small: true, disabled: Boolean(busy) }),
                        btn('删除', () => trashEntry(entry), { small: true, kind: 'danger', disabled: Boolean(busy) }),
                      )),
                      ),
                    ),
            ) : null,
            tab === 'recent' ? h('div', { className: 'pm-panel' },
              h('div', { className: 'pm-panel-note' }, '最近修改的文件（不含 node_modules、.git 和回收站）。双击预览。'),
              busy === 'recent' && recent.length === 0
                ? h('div', { className: 'pm-empty' }, h(Spinner), ' 正在读取…')
                : recent.length === 0
                  ? h('div', { className: 'pm-empty' }, '还没有最近改动')
                  : h('div', { className: 'pm-list' },
                      recent.map((entry) => h('button', {
                        key: entry.path,
                        type: 'button',
                        className: 'pm-recent-row',
                        onClick: () => openPreview(entry),
                        title: entry.path,
                      },
                      h('span', { className: 'pm-recent-name' }, entry.name),
                      h('span', { className: 'pm-recent-path' }, entry.path),
                      h('span', { className: 'pm-recent-time' }, formatTime(entry.mtime)),
                      )),
                    ),
            ) : null,
            tab === 'trash' ? h('div', { className: 'pm-panel' },
              h('div', { className: 'pm-panel-note' }, '删除的项目文件先放在这里，可以恢复。清空后无法找回。'),
              h('div', { className: 'pm-toolbar pm-toolbar-tight' },
                h('span', { className: 'pm-muted' }, `${trash.length} 项`),
                h('div', { className: 'pm-toolbar-right' },
                  btn('刷新', () => loadTrash(selected.id), { small: true, disabled: Boolean(busy) }),
                  btn('清空回收站', emptyTrash, { small: true, kind: 'danger', disabled: Boolean(busy) || trash.length === 0 }),
                ),
              ),
              busy === 'trash' && trash.length === 0
                ? h('div', { className: 'pm-empty' }, h(Spinner), ' 正在读取…')
                : trash.length === 0
                  ? h('div', { className: 'pm-empty' }, '回收站是空的')
                  : h('div', { className: 'pm-list' },
                      trash.map((item) => h('div', { key: item.id, className: 'pm-trash-row' },
                        h('div', { className: 'pm-trash-main' },
                          h('span', { className: 'pm-trash-name' }, item.name),
                          h('span', { className: 'pm-trash-path' }, `原位置：${item.path}`),
                        ),
                        h('span', { className: 'pm-time' }, formatTime(item.deletedAt)),
                        btn('恢复', () => restoreItem(item), { small: true, disabled: Boolean(busy) }),
                      )),
                    ),
            ) : null,
          )
        : h('section', { className: 'pm-detail pm-detail-empty' },
            h('div', { className: 'pm-empty' }, '左边还没有可用的项目。'),
            h('div', { className: 'pm-empty-actions' },
              btn('新建项目', createProject, { kind: 'primary' }),
              btn('导入已有文件夹', () => setImportOpen(true)),
            ),
          )

      return h('div', { className: `pm-root${embedded ? ' pm-embedded' : ''}` },
        error
          ? h('div', { className: 'pm-error-bar' },
              h('span', null, error),
              h('button', { type: 'button', className: 'pm-x', onClick: () => setError('') }, '×'),
            )
          : null,
        h('div', { className: 'pm-body' }, rail, detail),
        toast ? h('div', { className: `pm-toast${toast.kind === 'error' ? ' pm-toast-error' : ''}` }, toast.message) : null,
        dialog?.kind === 'prompt'
          ? h(PromptDialog, { dialog, onDone: finishDialog })
          : dialog?.kind === 'confirm'
            ? h(ConfirmDialog, { dialog, onDone: finishDialog })
            : null,
        importOpen
          ? h(ImportDialog, {
              discovered: overview?.discovered ?? [],
              onDone: (names) => {
                setImportOpen(false)
                if (names) importProjects(names)
              },
            })
          : null,
        h(PreviewModal, {
          preview,
          onClose: () => setPreview(null),
          onReveal: () => preview && revealEntry(preview.entry),
        }),
      )
    }

    function OverlayHost({ ctx }) {
      const open = useOverlayOpen()
      useEffect(() => {
        if (!open) return
        const onKey = (event) => {
          if (event.key === 'Escape') setOverlayOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])
      if (!open) return null
      return h('div', {
        className: 'pm-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) setOverlayOpen(false)
        },
      },
      h('div', { className: 'pm-card' },
        h('button', {
          type: 'button',
          className: 'pm-card-close',
          onClick: () => setOverlayOpen(false),
          title: '关闭 (Esc)',
        }, '×'),
        h(ProjectManager, { embedded: false, close: () => setOverlayOpen(false), ctx }),
      ))
    }

    function SidebarButton({ wide }) {
      const open = useOverlayOpen()
      return h('button', {
        type: 'button',
        className: `pm-side-btn${open ? ' is-active' : ''}`,
        onClick: () => setOverlayOpen(!overlayOpen),
        title: '项目管理',
      },
      h('span', { className: 'pm-side-icon' }, '▦'),
      wide ? h('span', { className: 'pm-side-label' }, '项目') : null,
      )
    }

    function SettingsSection({ close, ctx }) {
      return h('div', { className: 'pm-settings-wrap' }, h(ProjectManager, { embedded: true, close, ctx }))
    }

    let styled = false
    function ensureStyle() {
      if (styled || typeof document === 'undefined') return
      styled = true
      const style = document.createElement('style')
      style.id = 'dsh-project-manager-style'
      style.textContent = `
.pm-root{--pm-bg:var(--dsw-alias-bg-base,#fff);--pm-layer:var(--dsw-alias-bg-layer-1,#f7f7f8);--pm-layer2:var(--dsw-alias-bg-layer-2,#f0f0f2);--pm-text:var(--dsw-alias-label-primary,#1b1b1f);--pm-text2:var(--dsw-alias-label-secondary,#5d5d68);--pm-text3:var(--dsw-alias-label-tertiary,#8b8b96);--pm-border:var(--dsw-alias-border-l1,#e5e5ea);--pm-border2:var(--dsw-alias-border-l2,#d4d4dc);--pm-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.045));--pm-primary:var(--dsw-alias-button-primary-fill,#2b2b31);--pm-primary-text:var(--dsw-alias-label-primary-inverted,#fff);--pm-danger:var(--dsw-alias-state-error-primary,#d83b3b);--pm-ok:var(--dsw-alias-state-success-primary,#1f9d63);display:flex;flex-direction:column;min-height:0;height:100%;color:var(--pm-text);font-size:13px;line-height:1.45;box-sizing:border-box}
.pm-root *,.pm-root *:before,.pm-root *:after{box-sizing:border-box}
.pm-settings-wrap{height:100%;min-height:0}
.pm-body{display:flex;min-height:0;flex:1;border:1px solid var(--pm-border);border-radius:10px;overflow:hidden;background:var(--pm-bg)}
.pm-embedded .pm-body{min-height:520px}
.pm-rail{width:186px;flex:0 0 186px;border-right:1px solid var(--pm-border);background:var(--pm-layer);display:flex;flex-direction:column;min-height:0}
.pm-rail-head{padding:12px 12px 8px}
.pm-rail-title{font-size:13px;font-weight:650;letter-spacing:.02em}
.pm-rail-stats{font-size:11px;color:var(--pm-text3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-list{overflow:auto;flex:1;padding:2px 6px 8px;min-height:0}
.pm-project{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;border:0;background:transparent;color:inherit;padding:7px 8px;border-radius:7px;cursor:pointer;font:inherit;margin-bottom:2px}
.pm-project:hover{background:var(--pm-hover)}
.pm-project.is-active{background:var(--pm-layer2);box-shadow:inset 2px 0 0 var(--pm-primary)}
.pm-project-line{display:flex;align-items:center;gap:5px;min-width:0}
.pm-project-name{font-weight:560;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.pm-project-meta{font-size:10.5px;color:var(--pm-text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:2px}
.pm-badge{font-size:9.5px;line-height:1;padding:2px 4px;border-radius:4px;border:1px solid var(--pm-border2);color:var(--pm-text2);flex:0 0 auto}
.pm-badge-warn{color:var(--pm-danger);border-color:color-mix(in srgb,var(--pm-danger) 40%,transparent)}
.pm-dot{width:6px;height:6px;border-radius:50%;background:var(--pm-ok);flex:0 0 auto;box-shadow:0 0 0 3px color-mix(in srgb,var(--pm-ok) 18%,transparent)}
.pm-rail-actions{display:flex;gap:6px;padding:8px;border-top:1px solid var(--pm-border)}
.pm-rail-actions .pm-btn{flex:1}
.pm-detail{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.pm-detail-head{padding:12px 14px 8px}
.pm-detail-title-row{display:flex;align-items:center;gap:8px;min-width:0}
.pm-detail-title{font-size:16px;font-weight:650;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-live{font-size:10px;color:var(--pm-ok);border:1px solid color-mix(in srgb,var(--pm-ok) 45%,transparent);border-radius:10px;padding:1px 6px;flex:0 0 auto}
.pm-detail-path{font-size:11px;color:var(--pm-text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.pm-detail-actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}
.pm-summary{display:flex;gap:14px;flex-wrap:wrap;padding:0 14px 9px;font-size:11px;color:var(--pm-text2);border-bottom:1px solid var(--pm-border)}
.pm-summary b{font-weight:620;color:var(--pm-text)}
.pm-summary-path{margin-left:auto;color:var(--pm-text3)}
.pm-tabs{display:flex;gap:2px;padding:6px 10px 0;border-bottom:1px solid var(--pm-border)}
.pm-tab{border:0;background:transparent;color:var(--pm-text2);font:inherit;font-size:12px;padding:5px 9px 7px;cursor:pointer;border-bottom:2px solid transparent;border-radius:5px 5px 0 0}
.pm-tab:hover{background:var(--pm-hover);color:var(--pm-text)}
.pm-tab.is-active{color:var(--pm-text);border-bottom-color:var(--pm-primary);font-weight:580}
.pm-panel{flex:1;min-height:0;display:flex;flex-direction:column;padding:8px 10px 10px}
.pm-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0 7px}
.pm-toolbar-tight{padding:0 0 6px}
.pm-toolbar-right{display:flex;align-items:center;gap:5px;margin-left:auto;flex-wrap:wrap}
.pm-crumbs{display:flex;align-items:center;gap:1px;flex-wrap:wrap;min-width:0;max-width:100%}
.pm-crumb-group{display:flex;align-items:center}
.pm-crumb{border:0;background:transparent;color:var(--pm-text2);font:inherit;font-size:11.5px;padding:2px 4px;border-radius:4px;cursor:pointer;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-crumb:hover{background:var(--pm-hover);color:var(--pm-text)}
.pm-crumb-sep{color:var(--pm-text3);font-size:10px}
.pm-filter{width:145px;height:27px;font-size:11.5px}
.pm-panel-note{font-size:11px;color:var(--pm-text3);padding:1px 1px 8px;line-height:1.5}
.pm-files{flex:1;min-height:0;overflow:auto;border-top:1px solid var(--pm-border)}
.pm-file-head{display:grid;grid-template-columns:minmax(0,1fr) 62px 88px 154px;gap:6px;padding:5px 4px;font-size:10.5px;color:var(--pm-text3);position:sticky;top:0;background:var(--pm-bg);z-index:1;border-bottom:1px solid var(--pm-border)}
.pm-file-row{display:grid;grid-template-columns:minmax(0,1fr) 62px 88px 154px;gap:6px;align-items:center;padding:3px 4px;border-radius:6px;min-height:31px}
.pm-file-row:hover{background:var(--pm-hover)}
.pm-file-name{display:flex;align-items:center;gap:7px;min-width:0}
.pm-name-btn{border:0;background:transparent;color:inherit;font:inherit;font-size:12px;padding:2px 0;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pm-name-btn:hover{text-decoration:underline}
.pm-icon{width:18px;height:18px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;flex:0 0 auto;background:var(--pm-layer2);color:var(--pm-text2);font-family:ui-monospace,monospace}
.pm-icon-dir{background:color-mix(in srgb,var(--pm-primary) 12%,transparent);color:var(--pm-text)}
.pm-size,.pm-time{font-size:10.5px;color:var(--pm-text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-row-actions{display:flex;gap:2px;justify-content:flex-end;opacity:0;transition:opacity .12s}
.pm-file-row:hover .pm-row-actions,.pm-file-row:focus-within .pm-row-actions{opacity:1}
.pm-actions-col{text-align:right}
.pm-btn{border:1px solid var(--pm-border2);background:var(--pm-bg);color:var(--pm-text);font:inherit;font-size:11.5px;line-height:1;padding:6px 9px;border-radius:6px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:27px}
.pm-btn:hover{background:var(--pm-hover)}
.pm-btn:disabled{opacity:.45;cursor:not-allowed}
.pm-btn-sm{padding:4px 6px;min-height:23px;font-size:10.5px;border-color:transparent;background:transparent;color:var(--pm-text2)}
.pm-btn-sm:hover{background:var(--pm-hover);color:var(--pm-text)}
.pm-btn-primary{background:var(--pm-primary);border-color:var(--pm-primary);color:var(--pm-primary-text)}
.pm-btn-primary:hover{filter:brightness(1.08);background:var(--pm-primary)}
.pm-btn-danger{color:var(--pm-danger)}
.pm-btn-sm.pm-btn-danger:hover{background:color-mix(in srgb,var(--pm-danger) 9%,transparent);color:var(--pm-danger)}
.pm-empty{display:flex;align-items:center;justify-content:center;gap:8px;min-height:120px;color:var(--pm-text3);font-size:11.5px;text-align:center;padding:18px;flex-direction:column;flex:1}
.pm-empty-small{min-height:60px;padding:12px 8px;flex:none}
.pm-empty-line{font-size:11.5px;color:var(--pm-text3);padding:6px 0}
.pm-empty-actions{display:flex;gap:6px;justify-content:center;padding-bottom:20px}
.pm-muted{font-size:11px;color:var(--pm-text3)}
.pm-recent-row{display:grid;grid-template-columns:minmax(110px,1fr) minmax(0,1.4fr) 78px;gap:8px;align-items:center;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:6px 7px;border-radius:6px;cursor:pointer;width:100%}
.pm-recent-row:hover{background:var(--pm-hover)}
.pm-recent-name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-recent-path{font-size:10.5px;color:var(--pm-text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.pm-recent-time{font-size:10px;color:var(--pm-text3);text-align:right;white-space:nowrap}
.pm-trash-row{display:flex;align-items:center;gap:10px;padding:6px 7px;border-radius:6px}
.pm-trash-row:hover{background:var(--pm-hover)}
.pm-trash-main{display:flex;flex-direction:column;min-width:0;flex:1}
.pm-trash-name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-trash-path{font-size:10.5px;color:var(--pm-text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.pm-error-bar{display:flex;align-items:flex-start;gap:8px;background:color-mix(in srgb,var(--pm-danger) 8%,transparent);border:1px solid color-mix(in srgb,var(--pm-danger) 28%,transparent);color:var(--pm-danger);border-radius:7px;padding:6px 8px;margin-bottom:7px;font-size:11.5px;line-height:1.45}
.pm-error-bar span{flex:1;word-break:break-word}
.pm-x{border:0;background:transparent;color:inherit;cursor:pointer;font-size:15px;line-height:1;padding:0 2px}
.pm-detail-empty{padding:22px;align-items:center;justify-content:center}
.pm-spinner{width:13px;height:13px;border:1.5px solid var(--pm-border2);border-top-color:var(--pm-text2);border-radius:50%;display:inline-block;animation:pm-spin .8s linear infinite;flex:0 0 auto}
@keyframes pm-spin{to{transform:rotate(360deg)}}
.pm-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--pm-primary);color:var(--pm-primary-text);padding:7px 13px;border-radius:7px;font-size:12px;z-index:1400;box-shadow:0 6px 24px rgba(0,0,0,.22);max-width:80vw}
.pm-toast-error{background:var(--pm-danger)}
.pm-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.34);backdrop-filter:blur(2px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}
.pm-card{position:relative;width:min(1080px,94vw);height:min(820px,88vh);background:var(--pm-bg,#fff);border:1px solid var(--pm-border,#e5e5ea);border-radius:13px;box-shadow:0 24px 80px rgba(0,0,0,.3);padding:12px;display:flex;flex-direction:column;min-height:0}
.pm-card-close{position:absolute;right:9px;top:7px;width:27px;height:27px;border:0;background:transparent;color:var(--pm-text2,#5d5d68);font-size:19px;line-height:1;border-radius:6px;cursor:pointer;z-index:5}
.pm-card-close:hover{background:var(--pm-hover,rgba(0,0,0,.06))}
.pm-dialog-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.38);z-index:1300;display:flex;align-items:center;justify-content:center;padding:20px}
.pm-dialog{background:var(--pm-bg,#fff);color:var(--pm-text,#1b1b1f);border:1px solid var(--pm-border,#e5e5ea);border-radius:11px;padding:16px;width:min(390px,92vw);box-shadow:0 18px 60px rgba(0,0,0,.3);font-size:12px}
.pm-dialog-wide{width:min(470px,92vw)}
.pm-dialog-title{font-size:14px;font-weight:650;margin-bottom:6px}
.pm-dialog-msg{font-size:11.5px;color:var(--pm-text2,#5d5d68);white-space:pre-line;line-height:1.55;margin-bottom:11px;word-break:break-word}
.pm-dialog-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:13px}
.pm-field{display:flex;flex-direction:column;gap:5px}
.pm-field-label{font-size:10.5px;color:var(--pm-text3,#8b8b96)}
.pm-input{border:1px solid var(--pm-border2,#d4d4dc);background:var(--pm-bg,#fff);color:var(--pm-text,#1b1b1f);border-radius:6px;padding:6px 8px;font:inherit;font-size:12px;outline:none;min-width:0}
.pm-input:focus{border-color:var(--pm-text2,#5d5d68)}
.pm-import-list{max-height:300px;overflow:auto;border:1px solid var(--pm-border,#e5e5ea);border-radius:7px;padding:4px}
.pm-import-tools{display:flex;gap:4px;padding:2px 2px 5px}
.pm-import-row{display:flex;align-items:center;gap:8px;padding:5px 5px;border-radius:5px;cursor:pointer}
.pm-import-row:hover{background:var(--pm-hover,rgba(0,0,0,.05))}
.pm-import-name{flex:1;min-width:0;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-import-time{font-size:10px;color:var(--pm-text3,#8b8b96)}
.pm-preview{width:min(820px,94vw);height:min(660px,86vh);display:flex;flex-direction:column;padding:12px}
.pm-preview-head{display:flex;flex-direction:column;gap:1px;padding-right:34px;margin-bottom:8px}
.pm-preview-title{font-size:13.5px;font-weight:640;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-preview-path{font-size:10.5px;color:var(--pm-text3,#8b8b96);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-preview-actions{display:flex;gap:4px;margin-top:5px}
.pm-preview-body{flex:1;min-height:0;overflow:auto;border:1px solid var(--pm-border,#e5e5ea);border-radius:7px;background:var(--pm-layer,#f7f7f8)}
.pm-preview-image{max-width:100%;max-height:100%;display:block;margin:auto;object-fit:contain}
.pm-preview-text{margin:0;padding:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--pm-text,#1b1b1f)}
.pm-error-text{color:var(--pm-danger,#d83b3b)}
.pm-link{color:var(--pm-text,#1b1b1f);text-decoration:underline;font-size:11.5px}
.pm-side-btn{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5d5d68);font:inherit;font-size:12px;padding:6px 8px;border-radius:6px;cursor:pointer;min-width:0}
.pm-side-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1b1b1f)}
.pm-side-btn.is-active{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1b1b1f)}
.pm-side-icon{width:18px;text-align:center;font-size:13px;flex:0 0 auto}
.pm-side-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-embedded .pm-rail{width:164px;flex-basis:164px}
.pm-embedded .pm-detail-head{padding:10px 11px 6px}
.pm-embedded .pm-detail-actions{gap:4px}
.pm-embedded .pm-summary{padding:0 11px 8px;gap:10px}
.pm-embedded .pm-panel{padding:7px 8px 8px}
.pm-embedded .pm-file-head{grid-template-columns:minmax(0,1fr) 84px 150px}
.pm-embedded .pm-file-row{grid-template-columns:minmax(0,1fr) 84px 150px}
.pm-embedded .pm-file-head .pm-size,.pm-embedded .pm-file-row>.pm-size{display:none}
.pm-embedded .pm-file-head .pm-time,.pm-embedded .pm-file-row>.pm-time{font-size:9.5px}
.pm-embedded .pm-detail-title{font-size:15px}
.pm-embedded .pm-btn{font-size:11px;padding:5px 7px}
@media (max-width:640px){.pm-rail{width:150px;flex-basis:150px}.pm-file-head,.pm-file-row{grid-template-columns:minmax(0,1fr) 134px}.pm-size,.pm-time{display:none}.pm-summary-path{display:none}}
@media (max-width:520px){.pm-rail{width:132px;flex-basis:132px}.pm-file-head,.pm-file-row{grid-template-columns:minmax(0,1fr) 118px}.pm-time{display:none}.pm-file-head .pm-actions-col{display:none}}
`
      document.head.appendChild(style)
    }

    return {
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        ensureStyle()
        const disposers = []
        disposers.push(ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'project-manager',
          order: 3,
          label: () => '项目',
        }, (props) => h(SettingsSection, { ...props, ctx }))))
        disposers.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'project-manager-shortcut',
          order: 20,
        }, SidebarButton)))
        disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'project-manager-overlay',
          order: 50,
        }, () => h(OverlayHost, { ctx }))))
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // ignore
            }
          }
        }
      },
    }
  },
})
