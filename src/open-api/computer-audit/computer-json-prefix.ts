// Keep only observed JSON values. An open object/array is useful for locating its
// complete children; callers must check closed paths before using an item as evidence.
export function readComputerJsonPrefix(text: string) {
  const source = text.trimStart().replace(/^\x60\x60\x60(?:json)?\s*/i, "")
  const closed = new Set<string>()
  const corrections: string[] = []
  let pos = 0
  function skipSpace() {
    while (pos < source.length && /\s/.test(source[pos])) pos++
  }
  function readString(): string | undefined {
    const start = pos++
    while (pos < source.length) {
      const ch = source[pos++]
      if (ch === "\\") pos++
      else if (ch === '"') return JSON.parse(source.slice(start, pos))
    }
    return undefined
  }
  function read(path: string, depth: number): unknown {
    if (depth > 80) throw new Error("模型 JSON 嵌套异常")
    skipSpace()
    const ch = source[pos]
    if (!ch) return undefined
    if (ch === '"') {
      const value = readString()
      if (value !== undefined) closed.add(path)
      return value
    }
    if (ch !== "[" && ch !== "{") {
      const match =
        /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\s,\]}]|$)/.exec(
          source.slice(pos)
        )
      if (!match) {
        if (/^(?:t|tr|tru|f|fa|fal|fals|n|nu|nul|-|\d+[.eE][+-]?)$/.test(source.slice(pos))) {
          pos = source.length
          return undefined
        }
        throw new Error("模型 JSON 值无效")
      }
      pos += match[0].length
      closed.add(path)
      return JSON.parse(match[0])
    }
    pos++
    const array = ch === "[" ? ([] as unknown[]) : undefined
    const object: Record<string, unknown> = Object.create(null)
    const stop = array ? "]" : "}"
    skipSpace()
    while (pos < source.length && source[pos] !== stop) {
      let key: string
      if (array) key = String(array.length)
      else {
        if (source[pos] !== '"') throw new Error("模型 JSON 字段名无效")
        const name = readString()
        if (name === undefined) break
        if (!name || name.includes(".") || Object.hasOwn(object, name))
          throw new Error("模型 JSON 字段名重复")
        key = name
        skipSpace()
        if (pos >= source.length) break
        if (source[pos++] !== ":") throw new Error("模型 JSON 字段缺少冒号")
      }
      const value = read(path ? path + "." + key : key, depth + 1)
      if (value !== undefined) {
        if (array) array.push(value)
        else object[key] = value
      }
      skipSpace()
      if (pos >= source.length || source[pos] === stop) break
      if (source[pos] === ",") pos++
      else if (
        array &&
        source[pos] === "{" &&
        value &&
        typeof value === "object" &&
        /\.deductions$/.test(path)
      )
        corrections.push(path + " 补对象分隔符")
      else throw new Error("模型 JSON 分隔符无效")
      skipSpace()
    }
    if (source[pos] === stop) {
      pos++
      closed.add(path)
    }
    return array ?? object
  }
  if (!source.startsWith("{")) throw new Error("模型响应缺少 JSON 对象")
  const root = read("", 0) as Record<string, unknown>
  return { root, closed, corrections }
}
