/**
 * Minimal glob dialect for scope rules and plugin detection: `*` matches any
 * run of characters (including `:` and `/`), `?` matches exactly one, and a
 * backslash makes the next character literal. Matching is anchored at both
 * ends.
 */
export interface CompiledGlob {
  readonly pattern: string
  /** Number of wildcards, i.e. of captures a match returns. */
  readonly wildcards: number
  /** One capture per wildcard, in pattern order, when `text` matches; otherwise `undefined`. */
  match(text: string): readonly string[] | undefined
}

export interface GlobOptions {
  readonly caseInsensitive?: boolean
}

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\/]/g

function escapeLiteral(text: string): string {
  return text.replace(REGEXP_SPECIAL, '\\$&')
}

export function compileGlob(pattern: string, options: GlobOptions = {}): CompiledGlob {
  let source = ''
  let wildcards = 0
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!
    if (char === '\\' && index + 1 < pattern.length) {
      source += escapeLiteral(pattern[++index]!)
    } else if (char === '*') {
      source += '(.*?)'
      wildcards++
    } else if (char === '?') {
      source += '(.)'
      wildcards++
    } else {
      source += escapeLiteral(char)
    }
  }
  const regexp = new RegExp(`^${source}$`, options.caseInsensitive ? 'isu' : 'su')
  return {
    pattern,
    wildcards,
    match(text) {
      const result = regexp.exec(text)
      return result ? result.slice(1).map(capture => capture ?? '') : undefined
    },
  }
}

export function matchGlob(pattern: string, text: string, options: GlobOptions = {}): boolean {
  return compileGlob(pattern, options).match(text) !== undefined
}
