import { expect, test } from 'bun:test'
import { dayLight, dayTint } from './dayTint'

test('hits each key exactly', () => {
  expect(dayTint(2)).toBe('92 108 224')
  expect(dayTint(12)).toBe('215 166 66')
  expect(dayTint(20.5)).toBe('172 104 214')
})

test('interpolates between keys', () => {
  expect(dayTint(4)).toBe('157 116 186')
})

test('wraps across midnight between dusk and night', () => {
  // 20.5 -> 2 spans 5.5 h; midnight is 3.5 h in.
  const t = 3.5 / 5.5
  const want = [172, 104, 214].map((v, k) =>
    Math.round(v + ([92, 108, 224][k] - v) * t),
  )
  expect(dayTint(0)).toBe(want.join(' '))
  expect(dayTint(23.99)).not.toBe(dayTint(2))
})

test('daylight is dark at night and full near midday', () => {
  expect(dayLight(2)).toBe(0)
  expect(dayLight(22)).toBe(0)
  expect(dayLight(12.5)).toBe(1)
  expect(dayLight(7)).toBeGreaterThan(0)
})
