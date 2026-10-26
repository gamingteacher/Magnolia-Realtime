import { describe, expect, it } from 'vitest'
import { isValidUsername, usernameEmail } from '../../src/renderer/sync/auth'

describe('sync account usernames', () => {
  it('maps usernames to normalized Magnolia auth emails', () => {
    expect(usernameEmail(' Research.Team ')).toBe('research.team@magnolia.sync')
  })

  it('accepts only 3–32 lowercase-safe username characters', () => {
    expect(isValidUsername('abc')).toBe(true)
    expect(isValidUsername('study_group-2.')).toBe(true)
    expect(isValidUsername('ab')).toBe(false)
    expect(isValidUsername('UPPER')).toBe(false)
    expect(isValidUsername('has space')).toBe(false)
    expect(isValidUsername('x'.repeat(33))).toBe(false)
  })
})
