import { expect, test } from 'bun:test'
import { absolutizeServerUrls } from './desktop'

// Behind Neurodesk's proxy the page base is /user/<name>/neurovue/.
const base = 'https://hub.example/user/ada/neurovue/'

test('resolves ./ server URLs against the page base, at any depth', () => {
  const manifest = {
    id: './iiif/desktop/neuro/manifest',
    items: [
      {
        metadata: './volumes/t1/abc/metadata',
        levels: [{ level: 1, raw: './volumes/t1/abc/levels/1/raw.nii' }],
      },
    ],
  }
  expect(absolutizeServerUrls(manifest, base)).toEqual({
    id: `${base}iiif/desktop/neuro/manifest`,
    items: [
      {
        metadata: `${base}volumes/t1/abc/metadata`,
        levels: [{ level: 1, raw: `${base}volumes/t1/abc/levels/1/raw.nii` }],
      },
    ],
  })
})

test('keeps URL template placeholders unencoded', () => {
  expect(
    absolutizeServerUrls('./volumes/t1/abc/raw.nii.gz?level={level}', base),
  ).toBe(`${base}volumes/t1/abc/raw.nii.gz?level={level}`)
})

test('leaves absolute URLs, paths, and non-strings alone', () => {
  const value = {
    url: 'http://127.0.0.1:8090/volumes/t1/abc/raw.nii.gz',
    sourcePath: '/data/sub-01_T1w.nii.gz',
    label: 'sub-01_T1w.nii.gz',
    shape: [160, 192, 192],
    ready: true,
    derivation: null,
  }
  expect(absolutizeServerUrls(value, base)).toEqual(value)
})
