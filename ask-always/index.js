/**
 * dsh-ask-always — 让「有任何问题问我，越详细越好」成为每条消息的默认后缀。
 *
 * 实现方式：给每个 agent 挂一条常驻的 systemPrompt 上下文（不是改用户的原始消息，
 * 这样不会污染聊天记录、也不会影响分支/重放），内容就是这条叮嘱的详细版解释。
 *
 * @module @local/dsh-ask-always
 */

export const name = 'dsh-ask-always'
export const inject = ['agents', 'commands', 'systemPrompt']

const NOTE = [
  '📌 用户已开启「自动追问」（dsh-ask-always 插件）：他发出的每一条消息，末尾都默认附带着一句',
  '「有任何问题问我，越详细越好」。请把它当成这条消息的一部分来解释：',
  '- 遇到任何不确定的地方（目标、范围、优先级、验收标准、风格取舍、要不要动某个文件、要不要花时间/算力），',
  '  先用 ask_user_question 问清楚，不要自己假设完闷头做。',
  '- 开工前把关键选择摆给他（给具体选项 + 每个选项的代价/收益，推荐项放第一位）；',
  '  运行中遇到真正的分叉就停下来问；收尾前把可能影响结果的选择一并说清。',
  '- 提问必须具体：不要问「这样可以吗」，要问「A 还是 B，A 快但粗糙、B 慢但更准」。',
  '- 只有在确实没有影响结果的疑问时才直接往下做；不要为了问而问，也不要拿没营养的问题打断他。',
].join('\n')

export function apply(ctx, rawConfig = {}) {
  const enabled = rawConfig.enabled !== false
  /** agentId -> disposer of the prompt context. */
  const installed = new Map()
  /** agentId -> guard switched off by `/ask-always off`. */
  const muted = new Set()

  function textFor(agent) {
    if (!enabled) return ''
    if (muted.has(agent.id)) return ''
    return NOTE
  }

  function install(agent) {
    if (!agent?.id || installed.has(agent.id)) return
    const dispose = agent.ctx.effect(() => agent.ctx.systemPrompt.context({
      name: 'ask-always',
      order: 1480,
      text: () => textFor(agent),
    }))
    installed.set(agent.id, dispose)
  }

  function uninstall(agent) {
    const dispose = installed.get(agent.id)
    installed.delete(agent.id)
    muted.delete(agent.id)
    dispose?.()
  }

  const offCommand = ctx.commands.register({
    name: 'ask-always',
    description: '自动追问：每条消息末尾默认附带「有任何问题问我」',
    input: { hint: '[status | on | off]' },
    handler: (invocation) => {
      const agent = invocation.agent
      const action = String(invocation.rawInput ?? '').trim().toLowerCase() || 'status'
      if (action === 'off' || action === '关') {
        muted.add(agent.id)
        return { kind: 'success', text: '已关闭自动追问（本会话）。/ask-always on 可恢复。' }
      }
      if (action === 'on' || action === '开') {
        muted.delete(agent.id)
        return { kind: 'success', text: '已恢复自动追问：以后每条消息我都会默认先问清楚再动手。' }
      }
      return {
        kind: 'success',
        text: [
          'dsh-ask-always 自动追问',
          `- 全局：${enabled ? '开启' : '关闭（配置里 enabled: false）'}`,
          `- 本会话：${muted.has(agent.id) ? '已关闭' : '开启'}`,
          '效果：遇到不确定的地方先用 ask_user_question 问你，而不是自己猜。',
          '用法：/ask-always on · /ask-always off',
        ].join('\n'),
      }
    },
  })

  const offCreated = ctx.on('agent/created', ({ agent }) => install(agent))
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => uninstall(agent))

  for (const agent of ctx.agents.list()) install(agent)

  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
    muted.clear()
    offCommand?.()
    offCreated?.()
    offDisposed?.()
  })
}
