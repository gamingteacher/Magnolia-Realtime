import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/release.mjs', import.meta.url))

describe('release platforms', () => {
  it.each([[], ['--no-upload']])('rejects macOS releases %j', (...flags) => {
    const result = spawnSync(process.execPath, [script, 'release', 'mac', ...flags], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unsupported release platform "mac"')
  })
})
