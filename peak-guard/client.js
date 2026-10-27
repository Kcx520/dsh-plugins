window.__ModuleLoader__.load({
  id: '@local/dsh-peak-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/peak-guard/status'
    const DOT = 7

    // Mirrors the Host defaults. Used only when the status endpoint is
    // unreachable, so the badge still shows a clock instead of going blank.
    // Holidays live on the Host; an offline estimate ignores them.
    const FALLBACK = {
      leadMinutes: 3,
      utcOffsetMinutes: 480,
      workdays: [1, 2, 3, 4, 5],
      windows: [{ start: 540, end: 720 }, { start: 840, end: 1080 }],
      handoff: 'PEAK_HANDOFF.md',
    }

    const MINUTE = 60000
    const DAY = 86400000

    function localParts(now, offsetMinutes) {
      const date = new Date(now + offsetMinutes * MINUTE)
      return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        weekday: date.getUTCDay(),
      }
    }

    function computeLocal(now) {
      const config = FALLBACK
      const lead = config.leadMinutes * MINUTE
      const today = localParts(now, config.utcOffsetMinutes)
      const base = Date.UTC(today.year, today.month - 1, today.day) - config.utcOffsetMinutes * MINUTE
      let nextStart = null
      const common = {
        leadMinutes: config.leadMinutes,
        utcOffsetMinutes: config.utcOffsetMinutes,
        handoff: config.handoff,
        local: true,
      }

      if (config.workdays.includes(today.weekday)) {
        for (const window of config.windows) {
          const start = base + window.start * MINUTE
          const end = base + window.end * MINUTE
          if (now >= start - lead && now < start) {
            return { ...common, phase: 'wrapup', start, end, nextStart: start }
          }
          if (now >= start && now < end) {
            return { ...common, phase: 'peak', start, end, nextStart: start }
          }
          if (start > now && (nextStart == null || start < nextStart)) nextStart = start
        }
      }

      for (let ahead = 1; ahead <= 9 && nextStart == null; ahead += 1) {
        const probe = localParts(base + ahead * DAY, config.utcOffsetMinutes)
        if (!config.workdays.includes(probe.weekday)) continue
        const probeBase = Date.UTC(probe.year, probe.month - 1, probe.day) - config.utcOffsetMinutes * MINUTE
        nextStart = probeBase + config.windows[0].start * MINUTE
      }

      return { ...common, phase: 'normal', start: null, end: null, nextStart }
    }

    function formatDuration(ms) {
      const totalMinutes = Math.max(1, Math.round(ms / 60000))
      if (totalMinutes < 60) return `${totalMinutes} 分钟`
      const totalHours = Math.floor(totalMinutes / 60)
      if (totalHours < 24) {
        const minutes = totalMinutes % 60
        return minutes === 0 ? `${totalHours} 小时` : `${totalHours} 小时 ${minutes} 分`
      }
      const days = Math.floor(totalHours / 24)
      const hours = totalHours % 24
      return hours === 0 ? `${days} 天` : `${days} 天 ${hours} 小时`
    }

    function clockOf(ms, offsetMinutes) {
      const date = new Date(ms + offsetMinutes * MINUTE)
      return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
    }

    function PeakBadge() {
      const [state, setState] = React.useState(null)
      const [, tick] = React.useState(0)
      const skew = React.useRef(0)

      React.useEffect(() => {
        let cancelled = false
        let fails = 0
        const apply = (data) => {
          if (cancelled || !data) return
          setState(data)
        }
        const load = () => {
          fetch(ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
            .then((data) => {
              fails = 0
              skew.current = data.now - Date.now()
              apply(data)
            })
            .catch(() => {
              fails += 1
              // Endpoint missing or unreachable: keep showing a usable clock.
              if (fails >= 1) {
                skew.current = 0
                apply(computeLocal(Date.now()))
              }
            })
        }
        load()
        const poll = setInterval(load, 15000)
        const beat = setInterval(() => tick((value) => value + 1), 1000)
        return () => {
          cancelled = true
          clearInterval(poll)
          clearInterval(beat)
        }
      }, [])

      if (!state) return null

      const now = Date.now() + skew.current
      let label
      let color
      if (state.phase === 'peak') {
        color = 'var(--dsw-alias-state-error-primary)'
        label = `高峰中 · 剩余 ${formatDuration(state.end - now)}`
      } else if (state.phase === 'wrapup') {
        color = 'var(--dsw-alias-state-warn-primary)'
        label = `收尾中 · 距高峰 ${formatDuration(state.start - now)}`
      } else {
        color = 'var(--dsw-alias-state-success-primary)'
        label = state.nextStart == null
          ? '空闲时段'
          : `空闲 · 距高峰 ${formatDuration(state.nextStart - now)}`
      }

      const clock = (ms) => clockOf(ms, state.utcOffsetMinutes)
      const title = state.phase === 'peak'
        ? `DeepSeek API 高峰中（${clock(state.start)}–${clock(state.end)}）。提前量 ${state.leadMinutes} 分钟；交接文件：${state.handoff}`
        : state.phase === 'wrapup'
          ? `高峰期 ${clock(state.start)} 开始，现在处于收尾窗口（提前 ${state.leadMinutes} 分钟）。交接文件：${state.handoff}`
          : `下次高峰 ${state.nextStart == null ? '未知' : `${clock(state.nextStart)} 开始`}。提前量 ${state.leadMinutes} 分钟。`

      return h('div', {
        title: state.local ? `${title}（离线估算，未计法定节假日）` : title,
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          margin: '2px 0 8px',
          fontSize: 11,
          lineHeight: '16px',
          color: 'var(--dsw-alias-label-secondary)',
          userSelect: 'none',
        },
      }, [
        h('span', {
          key: 'dot',
          'aria-hidden': true,
          style: {
            width: DOT,
            height: DOT,
            borderRadius: '50%',
            background: color,
            boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)`,
            flex: '0 0 auto',
          },
        }),
        h('span', { key: 'text', style: { fontVariantNumeric: 'tabular-nums' } }, label),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'peak-guard-badge',
          order: 5,
        }, PeakBadge))
      },
    }
  },
})
