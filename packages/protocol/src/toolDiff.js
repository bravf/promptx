// 对修改片段做有界逐行比较；大块替换降级为前后缀比较，避免二次方计算。
export function createToolPatch(before, after) {
  const left = before === '' ? [] : String(before).replace(/\r\n/g, '\n').split('\n')
  const right = after === '' ? [] : String(after).replace(/\r\n/g, '\n').split('\n')
  let start = 0, leftEnd = left.length, rightEnd = right.length
  while (start < leftEnd && start < rightEnd && left[start] === right[start]) start++
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd--; rightEnd-- }
  if (start === left.length && start === right.length) return left.map(line => ` ${line}`).join('\n')
  const rows = left.slice(0, start).map(line => ` ${line}`)
  const n = leftEnd - start, m = rightEnd - start
  if (n * m <= 250000 && n + m < 10000) {
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      table[i][j] = left[start + i] === right[start + j] ? 1 + table[i + 1][j + 1] : Math.max(table[i + 1][j], table[i][j + 1])
    }
    let i = 0, j = 0
    while (i < n || j < m) {
      if (i < n && j < m && left[start + i] === right[start + j]) { rows.push(` ${left[start + i++]}`); j++ }
      else if (i < n && (j === m || table[i + 1][j] >= table[i][j + 1])) rows.push(`-${left[start + i++]}`)
      else rows.push(`+${right[start + j++]}`)
    }
  } else {
    for (let i = start; i < leftEnd; i++) rows.push(`-${left[i]}`)
    for (let i = start; i < rightEnd; i++) rows.push(`+${right[i]}`)
  }
  for (let i = leftEnd; i < left.length; i++) rows.push(` ${left[i]}`)
  return `@@ 修改片段 @@\n${rows.join('\n')}`
}
