import { expect, test } from 'bun:test'
import { gzip, writeFileBody } from './saveFile'

test('prefixes the path to the bytes', () => {
  const body = writeFileBody('/tmp/é.nii.gz', new Uint8Array([7, 8]))
  const pathLength = new DataView(body.buffer).getUint32(0, true)
  expect(pathLength).toBe(14)
  expect(new TextDecoder().decode(body.subarray(4, 4 + pathLength))).toBe(
    '/tmp/é.nii.gz',
  )
  expect([...body.subarray(4 + pathLength)]).toEqual([7, 8])
})

test('gzips', async () => {
  const data = new Uint8Array(1000).fill(3)
  const packed = await gzip(data)
  expect([packed[0], packed[1]]).toEqual([0x1f, 0x8b])
  expect(Bun.gunzipSync(packed)).toEqual(data)
})
