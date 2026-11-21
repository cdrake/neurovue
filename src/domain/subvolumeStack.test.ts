import { expect, test } from 'bun:test'
import { pushCut, stackLevels } from './subvolumeStack'

test('a cut pushes below the volume it came from', () => {
  expect(pushCut([], 'whole', 'a')).toEqual(['whole', 'a'])
  expect(pushCut(['whole', 'a'], 'a', 'b')).toEqual(['whole', 'a', 'b'])
  // Cutting again partway up drops the levels below.
  expect(pushCut(['whole', 'a', 'b'], 'whole', 'c')).toEqual(['whole', 'c'])
  // A cut from a volume off the stack starts a new one.
  expect(pushCut(['whole', 'a'], 'other', 'd')).toEqual(['other', 'd'])
})

test('levels show only while a stacked volume is shown', () => {
  const stack = ['whole', 'a', 'b']
  expect(stackLevels(stack, 'whole')?.map((l) => l.label)).toEqual([
    'Whole',
    'Block 1',
    'Block 2',
  ])
  expect(stackLevels(stack, 'other')).toBeNull()
  expect(stackLevels(['whole'], 'whole')).toBeNull()
})
