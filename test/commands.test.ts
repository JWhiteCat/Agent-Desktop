import { describe, expect, it } from 'vitest'
import { argumentHint, filterCommands, mergeCommands, parseAvailableCommands, slashQuery, type SlashCommand } from '../src/shared/commands'

const web: SlashCommand = { name: 'web', description: 'Search the web', hint: 'query to search for' }
const test: SlashCommand = { name: 'test', description: 'Run tests' }
const fork: SlashCommand = { name: 'fork', description: 'Fork locally', local: true }

describe('parseAvailableCommands', () => {
  it('reads names, descriptions, and text hints', () => {
    expect(
      parseAvailableCommands([
        { name: 'web', description: 'Search the web', input: { hint: 'query to search for' } },
        { name: 'plan', description: 'Write a plan', input: { type: 'text', hint: 'what to plan' } },
        { name: 'test', description: 'Run tests' }
      ])
    ).toEqual([
      { name: 'web', description: 'Search the web', hint: 'query to search for' },
      { name: 'plan', description: 'Write a plan', hint: 'what to plan' },
      { name: 'test', description: 'Run tests' }
    ])
  })

  it('drops hints for unknown input types and skips broken entries', () => {
    expect(
      parseAvailableCommands([
        { name: 'files', description: 'Pick files', input: { type: 'paths', hint: 'ignored' } },
        { name: '', description: 'missing name' },
        { name: 'web', description: '' },
        null,
        'web',
        { name: 'web', description: 'first' },
        { name: 'web', description: 'duplicate' }
      ])
    ).toEqual([
      { name: 'files', description: 'Pick files' },
      { name: 'web', description: 'first' }
    ])
  })

  it('returns nothing for a missing list', () => {
    expect(parseAvailableCommands(undefined)).toEqual([])
    expect(parseAvailableCommands({ name: 'web' })).toEqual([])
  })
})

describe('slashQuery', () => {
  it('returns the name being typed', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('  /web')).toBe('web')
  })

  it('closes once arguments, another line, or ordinary text start', () => {
    expect(slashQuery('/web ')).toBeUndefined()
    expect(slashQuery('/web query')).toBeUndefined()
    expect(slashQuery('/web\nmore')).toBeUndefined()
    expect(slashQuery('please /web')).toBeUndefined()
  })
})

describe('filterCommands', () => {
  const commands = [web, test]

  it('matches the name or the description', () => {
    expect(filterCommands(commands, '')).toEqual(commands)
    expect(filterCommands(commands, 'WEB')).toEqual([web])
    expect(filterCommands(commands, 'run')).toEqual([test])
  })
})

describe('mergeCommands', () => {
  it('keeps the local command when the CLI uses the same name', () => {
    expect(mergeCommands([fork], [{ name: 'fork', description: 'CLI fork' }, web])).toEqual([fork, web])
  })
})

describe('argumentHint', () => {
  it('shows the hint only while the argument is still empty', () => {
    expect(argumentHint('/web ', [web, test])).toBe('query to search for')
    expect(argumentHint('/web query', [web])).toBeUndefined()
    expect(argumentHint('/test ', [test])).toBeUndefined()
    expect(argumentHint('/missing ', [web])).toBeUndefined()
  })
})
