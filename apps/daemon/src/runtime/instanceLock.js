import fs from 'node:fs'
import path from 'node:path'

// 以原子创建锁文件保护同一数据库；端口不同也不能同时恢复运行状态。
export function acquireInstanceLock(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const lockPath = `${fs.realpathSync(path.dirname(databasePath))}/${path.basename(databasePath)}.lock`
  const identity = JSON.stringify({ pid: process.pid })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(fd, identity)
      fs.closeSync(fd)
      return () => {
        try { if (fs.readFileSync(lockPath, 'utf8') === identity) fs.unlinkSync(lockPath) } catch {}
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let pid
      try { pid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid } catch {}
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0) } catch (probe) {
          if (probe.code === 'ESRCH') { fs.unlinkSync(lockPath); continue }
        }
      }
      throw new Error(`该数据目录已有 Daemon 实例或未完成的启动锁：${lockPath}`)
    }
  }
  throw new Error('无法取得 Daemon 启动锁。')
}
