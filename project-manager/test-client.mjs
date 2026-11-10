/**
 * Static-ish smoke test for the browser face: runs the module factory with a
 * tiny React stub, applies the plugin, and invokes each registered component.
 * This is not a render test — it catches missing imports, bad hook usage at
 * module scope, and slot registration mistakes.
 */

let definition
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
  addEventListener() {},
  removeEventListener() {},
}

const style = { id: '', textContent: '' }
globalThis.document = {
  createElement() {
    return style
  },
  head: { appendChild() {} },
}

function useState(initial) {
  return [typeof initial === 'function' ? initial() : initial, () => {}]
}

function useRef(value) {
  return { current: value }
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState,
  useEffect() {},
  useRef,
}

await import('./client.js')
if (!definition || typeof definition.factory !== 'function') throw new Error('module did not register')

const mod = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

const registrations = []
const ctx = {
  slots: {
    inject(name, callback) {
      callback()
    },
    register(slot, component) {
      registrations.push({ slot, component })
      return () => {}
    },
  },
  uiWorkspace: { openWorkspace() {} },
}

const dispose = mod.apply(ctx)
const expected = ['settings.section', 'sidebar.footer.action', 'shell.overlay']
const seen = registrations.map((item) => item.slot.name).sort()
if (JSON.stringify(seen) !== JSON.stringify([...expected].sort())) {
  throw new Error(`unexpected slots: ${seen.join(', ')}`)
}
for (const item of registrations) {
  const tree = item.component({ wide: true, close() {} })
  if (!tree) throw new Error(`component for ${item.slot.name} returned nothing`)
  console.log(`ok - ${item.slot.name} / ${item.slot.id}`)
}
dispose()
console.log('CLIENT SMOKE OK')
