export function toolExpansionKey(epoch, turnId, callId) {
  return JSON.stringify([epoch, turnId || '', callId])
}

export function isToolExpanded({ enabled, remote, manual }) {
  // 手动操作优先；默认展开与记录来源、加载方式无关。
  return typeof manual === 'boolean' ? manual : Boolean(enabled && !remote)
}
