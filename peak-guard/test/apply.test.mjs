import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../index.js'

/** Minimal stand-in for the Cordis context the plugin talks to. */
function harness() {
  const contexts = new Map()
  const listeners = new Map()
  const commands = []
  const agent = {
    id: 'session-test',
    session: {},
    ctx: {
      effect(fn) {
        return fn()
      },
      systemPrompt: {
        context(definition) {
          contexts.set(definition.name, definition)
          return () => contexts.delete(definition.name)
        },
      },
    },
  }
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn(),
    commands: { register: (definition) => { commands.push(definition); return () => {} } },
    agents: { list: () => [agent] },
    on: (event, listener) => { listeners.set(event, listener); return () => {} },
  }
  return { ctx, agent, contexts, listeners, commands }
}

function bj(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour - 8, minute)
}

async function withClock(ms, run) {
  const real = Date.now
  Date.now = () => ms
  try {
    return await run()
  } finally {
    Date.now = real
  }
}

const text = (contexts) => contexts.get('peak-guard').text()

test('the guard stays silent outside the protection window', async () => {
  const { ctx, contexts } = harness()
  apply(ctx, { leadMinutes: 3 })
  assert.equal(contexts.size, 1)
  await withClock(bj(2026, 10, 20, 13, 30), () => {
    assert.equal(text(contexts), '')
  })
})

test('three minutes before the peak it asks for a handoff then a stop', async () => {
  const { ctx, contexts } = harness()
  apply(ctx, { leadMinutes: 3 })
  await withClock(bj(2026, 10, 20, 13, 58), () => {
    const value = text(contexts)
    assert.match(value, /高峰/)
    assert.match(value, /PEAK_HANDOFF\.md/)
    assert.match(value, /停止工作|停止当前工作|暂停/)
    assert.match(value, /\/peak continue/)
  })
})

test('inside the peak it pauses new work', async () => {
  const { ctx, contexts } = harness()
  apply(ctx, { leadMinutes: 3 })
  await withClock(bj(2026, 10, 20, 15, 0), () => {
    assert.match(text(contexts), /高峰时段/)
  })
})

test('saying 继续 in the inbox lifts the pause for the rest of the window', async () => {
  const { ctx, agent, contexts, listeners } = harness()
  apply(ctx, { leadMinutes: 3 })
  await withClock(bj(2026, 10, 20, 15, 0), () => {
    assert.match(text(contexts), /高峰时段/)
    listeners.get('agent/inbox/inserted')({ agent, message: { content: [{ type: 'text', text: '继续' }] } })
    assert.equal(text(contexts), '')
  })
})

test('an unrelated long message does not lift the pause', async () => {
  const { ctx, agent, contexts, listeners } = harness()
  apply(ctx, { leadMinutes: 3 })
  await withClock(bj(2026, 10, 20, 15, 0), () => {
    listeners.get('agent/inbox/inserted')({
      agent,
      message: { content: [{ type: 'text', text: '继续把这个项目的测试补完，然后跑一遍构建' }] },
    })
    assert.match(text(contexts), /高峰时段/)
  })
})

test('/peak off silences the guard and /peak on restores it', async () => {
  const { ctx, agent, contexts, commands } = harness()
  apply(ctx, { leadMinutes: 3 })
  const run = (input) => commands[0].handler({ agent, rawInput: input })
  await withClock(bj(2026, 10, 20, 15, 0), () => {
    assert.equal(run('off').kind, 'success')
    assert.equal(text(contexts), '')
    run('on')
    assert.match(text(contexts), /高峰时段/)
    const status = run('status')
    assert.match(status.text, /peak-guard 状态/)
    assert.match(status.text, /PEAK_HANDOFF\.md/)
  })
})
