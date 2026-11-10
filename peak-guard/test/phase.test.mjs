import assert from 'node:assert/strict'
import { test } from 'node:test'

import { computeState, parseWindow, resolveConfig } from '../index.js'

const CONFIG = resolveConfig({
  leadMinutes: 3,
  peakWindows: ['09:00-12:00', '14:00-18:00'],
  workdays: [1, 2, 3, 4, 5],
  utcOffsetMinutes: 480,
  holidays: ['2026-10-01', '2026-10-02'],
})

/** Beijing wall clock -> epoch ms (UTC+8, no DST). */
function bj(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour - 8, minute)
}

function phaseAt(year, month, day, hour, minute, config = CONFIG) {
  return computeState(bj(year, month, day, hour, minute), config)
}

test('parseWindow rejects malformed or inverted ranges', () => {
  assert.deepEqual(parseWindow('09:00-12:00'), { start: 540, end: 720 })
  assert.equal(parseWindow('12:00-09:00'), null)
  assert.equal(parseWindow('9-12'), null)
  assert.equal(parseWindow('24:00-25:00'), null)
})

test('nothing fires in the middle of the morning peak', () => {
  const state = phaseAt(2026, 10, 20, 10, 30)
  assert.equal(state.phase, 'peak')
  assert.equal(state.end, bj(2026, 10, 20, 12, 0))
})

test('wrap-up starts exactly leadMinutes before the peak', () => {
  assert.equal(phaseAt(2026, 10, 20, 13, 56).phase, 'normal')
  const state = phaseAt(2026, 10, 20, 13, 57)
  assert.equal(state.phase, 'wrapup')
  assert.equal(state.start, bj(2026, 10, 20, 14, 0))
})

test('the peak boundary flips wrap-up to peak', () => {
  assert.equal(phaseAt(2026, 10, 20, 13, 59).phase, 'wrapup')
  assert.equal(phaseAt(2026, 10, 20, 14, 0).phase, 'peak')
})

test('the end of a window returns to normal and names the next start', () => {
  const state = phaseAt(2026, 10, 20, 18, 0)
  assert.equal(state.phase, 'normal')
  assert.equal(state.nextStart, bj(2026, 10, 21, 9, 0))
})

test('the lunch break is normal with the afternoon peak next', () => {
  const state = phaseAt(2026, 10, 20, 12, 30)
  assert.equal(state.phase, 'normal')
  assert.equal(state.nextStart, bj(2026, 10, 20, 14, 0))
})

test('weekends are free all day', () => {
  const state = phaseAt(2026, 10, 24, 10, 0)
  assert.equal(state.phase, 'normal')
  assert.equal(state.nextStart, bj(2026, 10, 26, 9, 0))
})

test('configured holidays are free all day', () => {
  assert.equal(phaseAt(2026, 10, 1, 10, 0).phase, 'normal')
  assert.equal(phaseAt(2026, 10, 1, 13, 58).phase, 'normal')
})

test('a larger lead widens the wrap-up window', () => {
  const cautious = resolveConfig({ leadMinutes: 30, utcOffsetMinutes: 480 })
  const state = computeState(bj(2026, 10, 20, 13, 40), cautious)
  assert.equal(state.phase, 'wrapup')
})

test('defaults survive an empty or broken config', () => {
  const config = resolveConfig({ peakWindows: ['nope'], leadMinutes: -4 })
  assert.equal(config.leadMinutes, 3)
  assert.equal(config.windows.length, 2)
  assert.equal(computeState(bj(2026, 10, 20, 10, 0), config).phase, 'peak')
})
