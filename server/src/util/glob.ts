export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped.replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*')
  return new RegExp(`^${pattern}$`)
}

export function matchesGlob(value: string, glob: string): boolean {
  return globToRegExp(glob).test(value)
}
