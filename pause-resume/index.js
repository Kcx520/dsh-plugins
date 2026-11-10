/**
 * dsh-pause-resume — 一个按钮：暂停、善后、下次从断点继续。
 *
 * 设计：
 * - 点「暂停」：给正在跑的 agent 注入一条 steering（下一步就生效），要它把进度写进
 *   工作区的 .dsh-progress.md，然后停手；同时把暂停标记写进 .dsh-pause.json。
 * - 暂停期间：systemPrompt 里一直挂着一条「别开工」的提示，agent 不会自己接着干。
 * - 点「继续」/ 直接发一句「继续」：清掉标记，把 .dsh-progress.md 的内容作为上下文
 *   送回去，从断点继续，而不是从头再来。
 * - 关掉 DSH 再开：.dsh-pause.json 里记着 sessionId，同一个会话重新打开时仍然是暂停
 *   状态，按钮显示「继续上次任务」。
 *
 * @module @local/dsh-pause-resume
 */

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** 启动诊断：把加载过程写进 ~/.dsh/pause-resume-boot.log（排查插件没生效用）。 */
function bootLog(line) {
  try {
    appendFileSync(join(homedir(), '.dsh', 'pause-resume-boot.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // 诊断失败不能影响插件本体
  }
}

bootLog('module imported')

export const name = 'dsh-pause-resume'
export const inject = ['agents', 'commands', 'systemPrompt']

const RESUME_PATTERN = /^(继续|接着|接着干|继续干|继续吧|继续工作|继续做|恢复|往下|go on|continue|resume)/i
const MAX_PROGRESS_CHARS = 6000

function resolveConfig(raw) {
  return {
    enabled: raw.enabled !== false,
    progressFile: typeof raw.progressFile === 'string' && raw.progressFile ? raw.progressFile : '.dsh-progress.md',
    stateFile: typeof raw.stateFile === 'string' && raw.stateFile ? raw.stateFile : '.dsh-pause.json',
  }
}

/** Concatenate the text blocks of one model-facing message. */
function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** A short "继续" that should lift the pause. */
function looksLikeResume(text) {
  const normalised = String(text ?? '').trim().replace(/[\s。！!，,.、~～…]+$/u, '')
  if (normalised.length === 0 || normalised.length > 12) return false
  if (/^(不|别急|先不|不用)/u.test(normalised)) return false
  return RESUME_PATTERN.test(normalised)
}

/** Build a plain user message (same shape the loop's createUserMessage produces). */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function clip(text, limit = MAX_PROGRESS_CHARS) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}\n\n…（断点文件较长，已截断）` : value
}

export function apply(ctx, rawConfig = {}) {
  bootLog('apply called')
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return () => {}

  /** agentId -> { at: number, restored: boolean } */
  const paused = new Map()
  /** agentId -> disposer of the agent-scoped prompt context. */
  const installed = new Map()

  function workspaceDir(agent) {
    try {
      const dir = ctx.get('workingDirectory')?.get(agent?.session)
      if (typeof dir === 'string' && dir.length > 0) return dir
    } catch {
      // Agent without a live session: fall through to the process directory.
    }
    return process.cwd()
  }

  const statePath = (agent) => join(workspaceDir(agent), config.stateFile)
  const progressPath = (agent) => join(workspaceDir(agent), config.progressFile)

  function persistState(agent) {
    const record = {
      pausedAt: Date.now(),
      sessionId: String(agent?.session?.id ?? ''),
      progressFile: config.progressFile,
    }
    try {
      writeFileSync(statePath(agent), JSON.stringify(record, null, 2), 'utf8')
    } catch {
      // Read-only workspace: the pause still works in-memory for this run.
    }
  }

  function clearState(agent) {
    try {
      rmSync(statePath(agent), { force: true })
    } catch {
      // ignore
    }
  }

  function readProgress(agent) {
    try {
      return readFileSync(progressPath(agent), 'utf8')
    } catch {
      return ''
    }
  }

  function hasProgress(agent) {
    return readProgress(agent).trim().length > 0
  }

  /** Restore a pause left behind by an earlier DSH run of the same session. */
  function restore(agent) {
    try {
      const parsed = JSON.parse(readFileSync(statePath(agent), 'utf8'))
      const sameSession = !parsed.sessionId || String(agent?.session?.id ?? '') === parsed.sessionId
      if (parsed && Number(parsed.pausedAt) > 0 && sameSession) {
        paused.set(agent.id, { at: Number(parsed.pausedAt), restored: true })
      }
    } catch {
      // No state file (or unreadable): nothing to restore.
    }
  }

  function pauseText(agent) {
    if (!paused.has(agent.id)) return ''
    return [
      '⏸ 用户点了「暂停」按钮，现在处于暂停状态（dsh-pause-resume 插件）。',
      `- 立刻停止一切新工作：不要开始新的实现、调研、生成或命令。`,
      `- 只做一件事：把当前进度写进工作区的 ${config.progressFile}（Markdown：任务目标 / 已完成 / 进行中 / 下一步第一个动作 / 关键文件与路径 / 正在跑的后台任务）。`,
      `- 写完用一句话告诉用户「进度已保存到 ${config.progressFile}，等你回复继续」，然后结束这一回合。`,
      '- 在用户说「继续」（或再点继续按钮）之前，不要调用任何其它工具。',
    ].join('\n')
  }

  function install(agent) {
    if (!agent?.id || installed.has(agent.id)) return
    restore(agent)
    const dispose = agent.ctx.effect(() => agent.ctx.systemPrompt.context({
      name: 'pause-resume',
      order: 1490,
      text: () => pauseText(agent),
    }))
    installed.set(agent.id, dispose)
  }

  function uninstall(agent) {
    const dispose = installed.get(agent.id)
    installed.delete(agent.id)
    paused.delete(agent.id)
    dispose?.()
  }

  function pause(agent) {
    if (!agent?.id) return
    paused.set(agent.id, { at: Date.now(), restored: false })
    persistState(agent)
    if (agent.status === 'running') {
      try {
        agent.steer(userMessage(
          `【暂停】用户点了暂停按钮。请立刻停止新工作：只把当前进度写进 ${config.progressFile}`
          + `（目标 / 已完成 / 进行中 / 下一步第一个动作 / 关键文件），然后用一句话告诉用户进度已保存、等你回复继续。`
          + '不要做其它任何事。',
        ))
      } catch {
        // Agent cannot take input right now; the pause flag still stands.
      }
    }
  }

  function resume(agent, { announce = true } = {}) {
    if (!agent?.id) return false
    const was = paused.get(agent.id)
    paused.delete(agent.id)
    clearState(agent)
    if (!was) return false
    const progress = readProgress(agent)
    if (!announce) {
      // The user typed 继续 themselves: their message already drives the turn,
      // so only hand back the breakpoint as extra context.
      if (progress.trim()) {
        try {
          agent.inject(userMessage(`【断点】上次暂停时保存的进度如下，请接着做，不要从头开始：\n\n${clip(progress)}`))
        } catch {
          // ignore
        }
      }
      return true
    }
    const text = progress.trim()
      ? `【继续】用户点了继续按钮。这是上次暂停时保存的断点文件（${config.progressFile}）：\n\n${clip(progress)}\n\n请从中断处接着做，不要从头开始，也不要重复已经完成的工作。`
      : '【继续】用户点了继续按钮，但工作区里没有找到断点文件。请先用一句话向用户确认上次做到哪一步，然后继续。'
    try {
      agent.followup(userMessage(text))
    } catch {
      return false
    }
    return true
  }

  function hardStop(agent) {
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch {
      // ignore
    }
  }

  const targets = () => ctx.agents.list().filter((agent) => agent && agent.id)

  function snapshot() {
    const agents = targets().map((agent) => ({
      id: agent.id,
      status: agent.status,
      paused: paused.has(agent.id),
      since: paused.get(agent.id)?.at ?? null,
    }))
    const pausedAgents = targets().filter((agent) => paused.has(agent.id))
    const lead = targets()[0]
    const progress = lead ? readProgress(lead) : ''
    return {
      paused: pausedAgents.length > 0,
      agents,
      progressFile: config.progressFile,
      stateFile: config.stateFile,
      hasProgress: progress.trim().length > 0,
      progress: clip(progress, 2000),
      at: pausedAgents.length > 0 ? Math.max(...pausedAgents.map((agent) => paused.get(agent.id).at)) : null,
    }
  }

  function jsonEnd(response, payload) {
    response.statusCode = 200
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end(JSON.stringify(payload))
  }

  // The control endpoint. GET keeps the client trivial and avoids a JSON body.
  const offRoute = ctx.inject(['webServer'], (webCtx) => {
    bootLog('webServer inject fired')
    try {
      const off = webCtx.webServer.register({
    kind: 'exact',
    path: '/pause-resume/status',
    handler: (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const action = (url.searchParams.get('do') ?? '').trim()
      if (action === 'pause') {
        for (const agent of targets()) pause(agent)
      } else if (action === 'resume') {
        for (const agent of targets()) resume(agent, { announce: true })
      } else if (action === 'hard') {
        for (const agent of targets()) {
          if (paused.has(agent.id)) hardStop(agent)
        }
      }
      jsonEnd(response, snapshot())
    },
      })
      bootLog('route registered')
      return off
    } catch (error) {
      bootLog(`route registration threw: ${error?.stack ?? error}`)
      return undefined
    }
  })

  const offCommand = ctx.commands.register({
    name: 'pause',
    description: '暂停 / 继续：把进度存进断点文件，下次从断点接着做',
    input: { hint: '[pause | resume | status]' },
    handler: (invocation) => {
      const agent = invocation.agent
      const action = String(invocation.rawInput ?? '').trim().toLowerCase() || 'status'
      if (action === 'pause' || action === '暂停' || action === '停') {
        pause(agent)
        return { kind: 'success', text: `⏸ 已暂停。进度会写进 ${config.progressFile}；说「继续」或点继续按钮接着做。` }
      }
      if (action === 'resume' || action === 'continue' || action === '继续') {
        const ok = resume(agent, { announce: true })
        return {
          kind: 'success',
          text: ok ? '▶ 已恢复，正在从断点继续。' : '现在不在暂停状态，照常工作即可。',
        }
      }
      const state = snapshot()
      const once = agent && paused.get(agent.id)
      return {
        kind: 'success',
        text: [
          'dsh-pause-resume 状态',
          `- 当前：${once ? `已暂停（${new Date(once.at).toLocaleString()}）` : '运行中 / 空闲'}`,
          `- 断点文件：${progressPath(agent)}（${hasProgress(agent) ? '有内容' : '空或不存在'}）`,
          `- 暂停标记：${statePath(agent)}`,
          '用法：/pause pause · /pause resume · /pause status',
        ].join('\n'),
      }
    },
  })

  // A typed "继续" lifts the pause exactly like the button.
  const offInserted = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!agent?.id || !paused.has(agent.id)) return
    if (!looksLikeResume(textOf(message))) return
    resume(agent, { announce: false })
  })

  const offCreated = ctx.on('agent/created', ({ agent }) => install(agent))
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => uninstall(agent))

  for (const agent of ctx.agents.list()) {
    try {
      install(agent)
    } catch (error) {
      bootLog(`install(${agent?.id}) threw: ${error?.stack ?? error}`)
    }
  }

  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
    paused.clear()
    offCommand?.()
    offInserted?.()
    offCreated?.()
    offDisposed?.()
    offRoute?.()
  })
}
