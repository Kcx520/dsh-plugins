/**
 * dsh-peak-guard — DeepSeek API peak-hour guard for DeepSeek Harness.
 *
 * DeepSeek charges double during peak hours (Beijing time, workdays
 * 09:00–12:00 and 14:00–18:00). This plugin watches the clock, and a few
 * minutes before a peak window it injects a model-facing runtime-context
 * note: "stop starting new work, write the handoff file, then pause and tell
 * the user". When the peak actually starts, newly asked work is answered with
 * a short pause notice instead of being executed.
 *
 * The pause is deliberately soft: the user stays in control. Saying "继续"
 * (or /peak continue) lifts it for the rest of that window, and /peak off
 * removes the guard for one session entirely.
 *
 * @module @local/dsh-peak-guard
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MINUTE = 60_000
const DAY = 86_400_000
/** File name of the per-workspace "drill" marker written by `/peak test`. */
const DRILL_FILE = '.peak-guard-drill.json'
/** How long one drill run lasts. */
const DRILL_MS = 180_000

const DEFAULTS = {
  enabled: true,
  leadMinutes: 3,
  peakWindows: ['09:00-12:00', '14:00-18:00'],
  workdays: [1, 2, 3, 4, 5],
  utcOffsetMinutes: 480,
  handoffFile: 'PEAK_HANDOFF.md',
  holidays: [],
}

export const name = 'dsh-peak-guard'
export const inject = ['agents', 'commands', 'systemPrompt']

// ---------------------------------------------------------------------------
// clock math (pure, exported for tests)
// ---------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Parse `"HH:MM"` into minutes after local midnight, or `null`. */
export function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** Parse `"09:00-12:00"` into `{ start, end }` minutes, or `null`. */
export function parseWindow(value) {
  const [from, to] = String(value ?? '').split('-')
  const start = parseClock(from)
  const end = parseClock(to)
  if (start == null || end == null || end <= start) return null
  return { start, end }
}

/** Local wall-clock parts for an instant shifted by the configured offset. */
function localParts(ms, offsetMinutes) {
  const date = new Date(ms + offsetMinutes * MINUTE)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  }
}

function dateKey(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

/** UTC instant of local midnight for the given parts. */
function dayStart(parts, offsetMinutes) {
  return Date.UTC(parts.year, parts.month - 1, parts.day) - offsetMinutes * MINUTE
}

/**
 * Resolve the configured peak segments for one local date.
 * Weekends and configured holidays contribute no segments.
 */
function segmentsFor(parts, config) {
  if (!config.workdays.includes(parts.weekday)) return []
  if (config.holidaySet.has(dateKey(parts))) return []
  const base = dayStart(parts, config.utcOffsetMinutes)
  return config.windows.map(({ start, end }) => ({
    start: base + start * MINUTE,
    end: base + end * MINUTE,
  }))
}

/**
 * Decide what the guard should do right now.
 *
 * - `wrapup`: inside `leadMinutes` before a peak window — save and stop.
 * - `peak`: inside a peak window — do not start new work by default.
 * - `normal`: anything else (`start`/`end` are `null`).
 *
 * `nextStart` always names the next peak window start, so status output can
 * say how long is left.
 */
export function computeState(now, config) {
  const lead = config.leadMinutes * MINUTE
  const today = localParts(now, config.utcOffsetMinutes)
  let nextStart = null

  for (const segment of segmentsFor(today, config)) {
    if (now >= segment.start - lead && now < segment.start) {
      return { phase: 'wrapup', start: segment.start, end: segment.end, nextStart: segment.start }
    }
    if (now >= segment.start && now < segment.end) {
      return { phase: 'peak', start: segment.start, end: segment.end, nextStart: segment.start }
    }
    if (segment.start > now && (nextStart == null || segment.start < nextStart)) {
      nextStart = segment.start
    }
  }

  if (nextStart == null) {
    for (let ahead = 1; ahead <= 9 && nextStart == null; ahead += 1) {
      const parts = localParts(dayStart(today, config.utcOffsetMinutes) + ahead * DAY, config.utcOffsetMinutes)
      const segments = segmentsFor(parts, config)
      if (segments.length > 0) nextStart = segments[0].start
    }
  }

  return { phase: 'normal', start: null, end: null, nextStart }
}

/** Validate and normalise the plugin config; invalid entries fall back to defaults. */
export function resolveConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const windows = (Array.isArray(input.peakWindows) ? input.peakWindows : DEFAULTS.peakWindows)
    .map(parseWindow)
    .filter(Boolean)
  const workdays = (Array.isArray(input.workdays) ? input.workdays : DEFAULTS.workdays)
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  const holidays = Array.isArray(input.holidays) ? input.holidays : DEFAULTS.holidays
  const lead = Number(input.leadMinutes)
  const offset = Number(input.utcOffsetMinutes)

  return {
    enabled: input.enabled !== false,
    leadMinutes: Number.isFinite(lead) && lead >= 0 && lead <= 120 ? Math.round(lead) : DEFAULTS.leadMinutes,
    windows: windows.length > 0 ? windows : DEFAULTS.peakWindows.map(parseWindow),
    workdays: workdays.length > 0 ? workdays : DEFAULTS.workdays,
    holidaySet: new Set(holidays.map((value) => String(value).trim()).filter(Boolean)),
    utcOffsetMinutes: Number.isFinite(offset) ? Math.round(offset) : DEFAULTS.utcOffsetMinutes,
    handoffFile: typeof input.handoffFile === 'string' && input.handoffFile.trim()
      ? input.handoffFile.trim()
      : DEFAULTS.handoffFile,
  }
}

function formatClock(ms, config) {
  const date = new Date(ms + config.utcOffsetMinutes * MINUTE)
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`
}

function formatRemaining(ms) {
  const totalMinutes = Math.max(1, Math.round(ms / MINUTE))
  if (totalMinutes < 60) return `${totalMinutes} 分钟`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`
}

/** Words that mean "the user wants to keep working through the peak". */
const OVERRIDE_PATTERN = /^(继续|接着|接着干|继续干|继续吧|继续工作|继续做|别停|不要停|不用停|继续搞|go on|continue|resume)/i

function looksLikeOverride(text) {
  const normalised = String(text ?? '').trim().replace(/[\s。！!，,.、~～…]+$/u, '')
  if (normalised.length === 0 || normalised.length > 12) return false
  if (/^(不|别急|先不|不用)/u.test(normalised)) return false
  return OVERRIDE_PATTERN.test(normalised)
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

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return () => {}

  /** agentId -> override deadline (end of the peak window it applies to). */
  const overrides = new Map()
  /** agentId -> guard switched off by `/peak off`. */
  const disabled = new Set()
  /** agentId -> disposer of the agent-scoped prompt context. */
  const installed = new Map()
  /** workspace dir -> last drill-marker read. */
  const drillCache = new Map()

  function handoffDir(agent) {
    const workingDirectory = ctx.get('workingDirectory')
    try {
      const dir = workingDirectory?.get(agent?.session)
      if (typeof dir === 'string' && dir.length > 0) return dir
    } catch {
      // Agent without a live session: fall through to the process directory.
    }
    return process.cwd()
  }

  function handoffPath(agent) {
    return join(handoffDir(agent), config.handoffFile)
  }

  function readDrill(agent) {
    const dir = handoffDir(agent)
    const cached = drillCache.get(dir)
    const now = Date.now()
    if (cached && now - cached.at < 1000) return cached.value
    let value = null
    try {
      const parsed = JSON.parse(readFileSync(join(dir, DRILL_FILE), 'utf8'))
      if (parsed && Number(parsed.until) > now && (parsed.phase === 'wrapup' || parsed.phase === 'peak')) {
        value = { phase: parsed.phase, until: Number(parsed.until) }
      }
    } catch {
      value = null
    }
    drillCache.set(dir, { at: now, value })
    return value
  }

  /** The guard state for one agent right now, or `null` when it stays quiet. */
  function stateFor(agent, now = Date.now()) {
    if (disabled.has(agent.id)) return null
    const deadline = overrides.get(agent.id)
    if (deadline != null) {
      if (now >= deadline) overrides.delete(agent.id)
      else return null
    }
    const drill = readDrill(agent)
    if (drill) return { phase: drill.phase, start: null, end: null, nextStart: null, drill: true }
    const state = computeState(now, config)
    return state.phase === 'normal' ? null : state
  }

  function renderWrapup(agent, state) {
    const path = handoffPath(agent)
    const when = state.drill ? '现在' : formatClock(state.start, config)
    const lead = state.drill ? '数分钟' : `${config.leadMinutes} 分钟`
    const header = state.drill
      ? '⏰ 【演练】API 高峰保护（peak-guard）已触发——这是 /peak test 的演练，不需要真的停止当前工作，但请向用户确认你收到了这条保护提示。'
      : `⏰ API 高峰保护（peak-guard）：DeepSeek API 高峰时段将在北京时间 ${when} 开始（约 ${formatRemaining(state.start - Date.now())}后，单价翻倍）。`
    return [
      header,
      '',
      '现在进入收尾，请立即按顺序做三件事：',
      `1. 把当前进度写进交接文件：${path}`,
      '   （Markdown：任务目标 / 已完成 / 进行中 / 下一步 / 关键文件与命令）',
      `2. 写完后停止工作，只回用户一句话：已到高峰前 ${lead}，进度已保存到 ${config.handoffFile}，我先停下；要接着干请回复「继续」或输入 /peak continue。`,
      '3. 除写这个交接文件外，不要再调用任何工具，也不要开始新的实现或调研。',
      '',
      '（本提示由 peak-guard 插件注入。用户在高峰期说「继续」或使用 /peak continue 时会自动解除暂停。）',
    ].join('\n')
  }

  function renderPeak(agent, state) {
    const path = handoffPath(agent)
    const header = state.drill
      ? '⏰ 【演练】API 高峰保护（peak-guard）：演练的高峰状态已生效——不需要真的停止当前工作，请向用户确认你收到了这条保护提示。'
      : `⏰ API 高峰保护（peak-guard）：现在处于 DeepSeek API 高峰时段（北京时间工作日 ${config.windows.map(({ start, end }) => `${pad2(Math.floor(start / 60))}:${pad2(start % 60)}–${pad2(Math.floor(end / 60))}:${pad2(end % 60)}`).join('、')}，单价翻倍）。`
    return [
      header,
      '',
      '默认策略：暂停工作。',
      '- 如果用户这条消息明确要求继续（例如「继续」「接着干」），插件会自动解除暂停，正常干活即可。',
      '- 否则不要开始新任务：用一两句话告诉用户现在是高峰时段、工作已暂停，并提示回复「继续」或输入 /peak continue 可以继续。',
      `- 如果还有未保存的进度，先写进 ${path} 再停。`,
      '',
      '（本提示由 peak-guard 插件注入。）',
    ].join('\n')
  }

  function promptTextFor(agent) {
    const state = stateFor(agent)
    if (state == null) return ''
    return state.phase === 'wrapup' ? renderWrapup(agent, state) : renderPeak(agent, state)
  }

  function install(agent) {
    if (installed.has(agent.id)) return
    const dispose = agent.ctx.effect(() => agent.ctx.systemPrompt.context({
      name: 'peak-guard',
      order: 1500,
      text: () => promptTextFor(agent),
    }))
    installed.set(agent.id, dispose)
  }

  function uninstall(agent) {
    const dispose = installed.get(agent.id)
    installed.delete(agent.id)
    overrides.delete(agent.id)
    disabled.delete(agent.id)
    dispose?.()
  }

  // Status / control command.
  const offCommand = ctx.commands.register({
    name: 'peak',
    description: 'API 高峰保护：查看状态、继续工作、临时关闭或演练',
    input: { hint: '[status | continue | off | on | test]' },
    handler: (invocation) => {
      const agent = invocation.agent
      const action = String(invocation.rawInput ?? '').trim().toLowerCase() || 'status'
      const now = Date.now()
      const state = computeState(now, config)
      const deadline = overrides.get(agent.id)

      if (action === 'continue' || action === 'resume' || action === '继续') {
        const target = state.phase === 'normal' ? state.nextStart : state.end
        if (target == null) {
          return { kind: 'success', text: '现在本来就不在保护窗口内，照常工作即可。' }
        }
        overrides.set(agent.id, target)
        disabled.delete(agent.id)
        return {
          kind: 'success',
          text: `已解除本轮高峰暂停，可以继续工作到北京时间 ${formatClock(target, config)}。下个高峰窗口会重新保护。`,
        }
      }

      if (action === 'off') {
        disabled.add(agent.id)
        overrides.delete(agent.id)
        return { kind: 'success', text: '已为本会话关闭高峰保护（/peak on 可恢复）。' }
      }

      if (action === 'on') {
        disabled.delete(agent.id)
        return { kind: 'success', text: '已为本会话恢复高峰保护。' }
      }

      if (action === 'test' || action === '演练') {
        const dir = handoffDir(agent)
        writeFileSync(join(dir, DRILL_FILE), JSON.stringify({ until: now + DRILL_MS, phase: 'wrapup' }), 'utf8')
        return {
          kind: 'success',
          text: `演练已开始（${Math.round(DRILL_MS / 1000)} 秒）。下一步我会收到「高峰前收尾」提示，并演示保存与暂停的流程。`,
        }
      }

      const lines = ['peak-guard 状态', `- 当前：${describeState(state, now, config)}`]
      if (deadline != null && deadline > now) {
        lines.push(`- 本轮高峰：已解除，可工作到 ${formatClock(deadline, config)}`)
      } else if (state.phase === 'peak') {
        lines.push('- 本轮高峰：保护中（说「继续」或 /peak continue 可继续）')
      }
      lines.push(`- 收尾提前量：${config.leadMinutes} 分钟`)
      lines.push(`- 高峰时段：${describeWindows(config)}（UTC+${config.utcOffsetMinutes / 60}）`)
      lines.push(`- 交接文件：${handoffPath(agent)}`)
      lines.push(`- 本会话保护：${disabled.has(agent.id) ? '已关闭（/peak on 恢复）' : '开启'}`)
      lines.push('用法：/peak continue · /peak off · /peak on · /peak test')
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  function describeWindows(cfg) {
    return cfg.windows
      .map(({ start, end }) => `${pad2(Math.floor(start / 60))}:${pad2(start % 60)}–${pad2(Math.floor(end / 60))}:${pad2(end % 60)}`)
      .join('、')
  }

  function describeState(state, now, cfg) {
    if (state.phase === 'wrapup') {
      return `高峰前收尾窗口（${formatClock(state.start, cfg)} 开始高峰，约 ${formatRemaining(state.start - now)}后）`
    }
    if (state.phase === 'peak') {
      return `高峰时段中（${formatClock(state.start, cfg)}–${formatClock(state.end, cfg)}）`
    }
    return state.nextStart == null
      ? '空闲时段'
      : `空闲时段（下次高峰 ${formatClock(state.nextStart, cfg)} 开始，还有 ${formatRemaining(state.nextStart - now)}）`
  }

  // A short "继续" in the inbox lifts the pause for the rest of this window.
  const offInserted = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (disabled.has(agent.id)) return
    if (!looksLikeOverride(textOf(message))) return
    const now = Date.now()
    const state = computeState(now, config)
    if (state.phase === 'normal') return
    overrides.set(agent.id, state.end)
  })

  const offCreated = ctx.on('agent/created', ({ agent }) => {
    install(agent)
  })

  // Tiny JSON endpoint the Web UI status badge polls. Registered through
  // `inject` so it also lands when webServer mounts after this plugin.
  const offRoute = ctx.inject(['webServer'], (webCtx) => webCtx.webServer.register({
    kind: 'exact',
    path: '/peak-guard/status',
    handler: (_request, response) => {
      const now = Date.now()
      const state = computeState(now, config)
      response.statusCode = 200
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(JSON.stringify({
        now,
        phase: state.phase,
        start: state.start,
        end: state.end,
        nextStart: state.nextStart,
        leadMinutes: config.leadMinutes,
        utcOffsetMinutes: config.utcOffsetMinutes,
        handoff: config.handoffFile,
      }))
    },
  }))

  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    uninstall(agent)
  })

  for (const agent of ctx.agents.list()) install(agent)

  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
    overrides.clear()
    disabled.clear()
    offCommand?.()
    offInserted?.()
    offCreated?.()
    offDisposed?.()
    offRoute?.()
  })
}
