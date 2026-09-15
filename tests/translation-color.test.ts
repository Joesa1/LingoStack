// @vitest-environment node
import { expect, it } from 'vitest'
import { parseSettings } from '../src/shared/settings-store'
it('defaults old settings to adaptive color and accepts only six-digit hex colors', () => {
  expect(parseSettings({}).translationColorMode).toBe('auto')
  expect(parseSettings({ translationColorMode: 'custom', translationColor: '#AAbbCC' }).translationColor).toBe('#AAbbCC')
  expect(parseSettings({ translationColorMode: 'unknown', translationColor: 'red; background:url(x)' })).toMatchObject({ translationColorMode: 'auto', translationColor: '#007aff' })
})
