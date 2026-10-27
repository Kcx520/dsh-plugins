# 项目管理（dsh-project-manager）

DeepSeek Harness 里的项目 / 文件管理器。目标很简单：**一个项目 = 一个文件夹 = 一个 DSH 工作区**，打开面板就能看清每个项目在做什么，并直接做日常的文件整理。

## 入口

- **设置 → 项目**：嵌入式面板，适合管理。
- **侧边栏底部「项目」按钮**：打开全屏浮层，随时可用。
- **进入项目**：直接切到该工作区的空白会话，以后这个会话的产物就落在项目文件夹里。

## 能看到什么

- 左侧项目栏：项目名、会话数、最近修改时间；运行中的项目有绿点，文件夹丢失会标「缺失」，根目录标「根」。
- 顶部概览：会话数、运行中的会话、最近改动、文件夹状态。
- **文件**：面包屑导航、当前文件夹筛选；双击文件夹进入、双击文件预览；每行可改名 / 移动 / 复制 / 删除。
- **最近改动**：项目内最近修改的 18 个文件（跳过 `node_modules`、`.git`、回收站），双击预览。
- **回收站**：删除先移到 `<项目>/.dsh-trash/`，可以恢复或彻底清空。

## 安全边界

- 所有文件操作只允许发生在**当前项目文件夹内**；绝对路径、`..`、符号链接、Windows 保留名都会被拒绝。
- 删除是「移到回收站」，不是直接抹掉；恢复时如果原位置已被占用会拒绝覆盖。
- 「移除项目」只删 DSH 工作区注册，**不删文件夹、文件或会话历史**，之后可以用「导入」加回来。
- 写操作串行执行，避免同一目录下并发改名/移动打架。
- 文本预览上限 512 KB，图片/媒体走原始文件路由上限 8 MB。

## 安装（本机已经接好时跳过）

1. 确认 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 包含 `@local/dsh-project-manager`。
2. 依赖里加：

   ```json
   "@local/dsh-project-manager": "link:C:/Users/kcx2008/Documents/deepseek-harness/default-workspace/dsh-project-manager"
   ```

3. 安装链接：

   ```bash
   pnpm install --dir ~/.dsh/profiles/desktop
   ```

4. 体检并重启 DSH：

   ```bash
   node tools/dsh-doctor.mjs
   ```

5. 重启后打开 **设置 → 项目**，能看到项目列表即成功；侧边栏底部也会多一个「项目」按钮。

> 改 DSH 的 JSON 配置不要用 PowerShell 的 `Set-Content -Encoding UTF8`，会写 BOM 导致启动崩溃。用 `node tools/jsoncfg.mjs`。

## 配置

`cordis.patch.yml` 里可以改：

```yaml
config:
  enabled: true
  root: 'C:/Users/kcx2008/Documents/deepseek-harness/default-workspace'
  trashDir: .dsh-trash
```

- `root`：新建项目 / 扫描「可导入文件夹」的根目录。
- `trashDir`：每个项目内的回收站目录名，默认 `.dsh-trash`，在文件列表里自动隐藏。

## HTTP 路由（给后续扩展用）

所有 POST 都是 JSON，返回 `{ ok: true, ... }` 或 `{ ok: false, error }`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/project-manager/state?preferred=ID` | 项目概览、可导入文件夹、当前选中项 |
| POST | `/project-manager/project/create` | 新建文件夹并注册工作区 |
| POST | `/project-manager/project/import` | 导入根目录里已有的文件夹 |
| POST | `/project-manager/project/rename` | 只改显示名称 |
| POST | `/project-manager/project/remove` | 只移除注册，不删文件 |
| POST | `/project-manager/files/list` | 列目录 |
| POST | `/project-manager/files/mkdir` | 新建文件夹 |
| POST | `/project-manager/files/rename` | 改名 |
| POST | `/project-manager/files/move` | 移动到项目内某目录 |
| POST | `/project-manager/files/copy` | 复制到项目内某目录 |
| POST | `/project-manager/files/trash` | 移到回收站 |
| POST | `/project-manager/files/preview` | 文本预览 |
| POST | `/project-manager/files/recent` | 最近改动 |
| POST | `/project-manager/trash/list` | 回收站列表 |
| POST | `/project-manager/trash/restore` | 恢复 |
| POST | `/project-manager/trash/empty` | 清空回收站 |
| GET | `/project-manager/files/raw` | 原始字节（图片 / 媒体） |

## 自测

```bash
node dsh-project-manager/test-host.mjs
node dsh-project-manager/test-client.mjs
```

覆盖创建 / 列表 / 预览 / 改名 / 复制 / 移动 / 回收站 / 恢复 / 项目改名 / 移除 / 导入 / 路径穿越拦截 / 最近改动排序；客户端冒烟测试会校验三个 UI 插槽和组件能否挂载。

## 后续可以加的功能

这些是这次没有做、但和现有结构很搭的方向：

1. **全局文件搜索**：跨项目按文件名/内容搜索，结果直接预览。
2. **拖拽移动与上传**：把文件拖进文件夹即移动，从系统拖入即上传。
3. **Markdown / 代码高亮预览**：现在只有纯文本，下一步可以渲染 Markdown、给代码加高亮。
4. **项目模板**：新建项目时选「空 / 前端 / Python / 短剧素材」等模板，自动生成目录骨架和说明文件。
5. **项目活动时间线**：把会话、最近文件、运行状态合成一条「这个项目最近发生了什么」。
6. **会话入口**：在项目卡片上直接列出最近会话，一键继续，而不是只开空白会话。
7. **批量操作**：多选文件后批量移动/删除/复制。
8. **回收站保留策略**：按天数或总大小自动清理，避免 `.dsh-trash` 无限增长。
9. **打开所在文件夹 / 用默认程序打开**：桌面端补一个「在资源管理器中显示」。
10. **快捷键**：`Ctrl/Cmd+K` 搜索，`F2` 改名，`Delete` 删除，`Esc` 关闭浮层。
