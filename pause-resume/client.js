window.__ModuleLoader__.load({
  id: '@local/dsh-pause-resume',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATUS = '/pause-resume/status'
    const POLL_MS = 3000

    function formatClock(ms) {
      if (!ms) return ''
      const date = new Date(ms)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    function PauseBar() {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let cancelled = false
        const load = () => {
          fetch(STATUS, { headers: { accept: 'application/json' }, cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
            .then((data) => {
              if (!cancelled) setState(data)
            })
            .catch(() => {
              if (!cancelled) setState((prev) => prev ?? null)
            })
        }
        load()
        const timer = setInterval(load, POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [])

      if (!state) return null

      const act = (what) => {
        if (busy) return
        setBusy(true)
        fetch(`${STATUS}?do=${what}`, { headers: { accept: 'application/json' }, cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
          .then((data) => setState(data))
          .catch(() => {})
          .then(() => setBusy(false))
      }

      const paused = Boolean(state.paused)
      const color = paused ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)'
      const label = paused ? '▶ 继续上次任务' : '⏸ 暂停并保存进度'
      const hint = paused
        ? `已暂停${state.at ? `于 ${formatClock(state.at)}` : ''} · ${state.hasProgress ? `断点已存 ${state.progressFile}` : '断点文件还未写入'}`
        : '把进度存进断点文件后停下，随时继续'

      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          margin: '2px 0 8px',
          fontSize: 11,
          lineHeight: '16px',
          userSelect: 'none',
        },
      }, [
        h('button', {
          key: 'btn',
          type: 'button',
          title: hint,
          disabled: busy,
          onClick: () => act(paused ? 'resume' : 'pause'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 10px',
            borderRadius: 999,
            border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
            background: `color-mix(in srgb, ${color} 12%, transparent)`,
            color,
            fontSize: 11,
            lineHeight: '16px',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
            font: 'inherit',
          },
        }, label),
        h('span', {
          key: 'hint',
          style: { color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))' },
        }, paused && state.hasProgress ? `进度已保存到 ${state.progressFile}` : hint),
        paused
          ? h('button', {
            key: 'hard',
            type: 'button',
            title: '立刻中断当前回合，不再等它收尾（进度文件可能不完整）',
            disabled: busy,
            onClick: () => act('hard'),
            style: {
              padding: '2px 8px',
              borderRadius: 999,
              border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)',
              background: 'transparent',
              color: 'var(--dsw-alias-state-error-primary)',
              fontSize: 11,
              lineHeight: '16px',
              cursor: busy ? 'default' : 'pointer',
              font: 'inherit',
            },
          }, '硬停')
          : null,
      ].filter(Boolean))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'pause-resume-bar',
          order: 6,
        }, PauseBar))
      },
    }
  },
})
