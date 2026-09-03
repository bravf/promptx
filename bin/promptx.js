#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonPath = path.join(rootDir, 'package.json')
const serviceScriptPath = path.join(rootDir, 'scripts', 'service.mjs')
const doctorScriptPath = path.join(rootDir, 'scripts', 'doctor.mjs')
const relayScriptPath = path.join(rootDir, 'scripts', 'relay.mjs')
const relayServiceScriptPath = path.join(rootDir, 'scripts', 'relay-service.mjs')

function readCliVersion() {
  try {
    const payload = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    return String(payload.version || '').trim() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function printVersion() {
  console.log(readCliVersion())
}

function printHelp() {
  const version = readCliVersion()
  console.log(`
PromptX CLI

版本：
  ${version}

用法：
  promptx start
  promptx stop
  promptx restart
  promptx status
  promptx doctor
  promptx version
  promptx relay start
  promptx relay stop
  promptx relay restart
  promptx relay status

说明：
  - start: 后台启动 PromptX V2，本机默认地址 http://127.0.0.1:3001
  - stop: 停止后台服务
  - restart: 重启后台服务
  - status: 查看当前运行状态
  - doctor: 检查 Node、Agent Provider、数据目录、端口和打包产物
  - version: 输出当前版本
  - relay start/stop/restart/status: 后台管理 PromptX Relay 中转服务
    Relay 是无账号的 E2EE 密文转发服务，不需要配置租户或 Token
`.trim())
}

function runNodeScript(scriptPath, args = []) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}

const command = String(process.argv[2] || 'help').trim()
const subCommand = String(process.argv[3] || '').trim()

if (
  !command
  || command === 'help'
  || command === '--help'
  || command === '-h'
) {
  printHelp()
} else if (
  command === 'version'
  || command === '--version'
  || command === '-v'
  || command === '-version'
  || command === '--versioin'
  || command === '-versioin'
) {
  printVersion()
} else if (['start', 'stop', 'restart', 'status'].includes(command)) {
  runNodeScript(serviceScriptPath, [command])
} else if (command === 'doctor') {
  runNodeScript(doctorScriptPath)
} else if (command === 'relay' && ['start', 'stop', 'restart', 'status'].includes(subCommand)) {
  runNodeScript(relayServiceScriptPath, [subCommand])
} else if (command === 'relay' && subCommand === 'run') {
  runNodeScript(relayScriptPath)
} else {
  console.error(`[promptx] 不支持的命令：${command}`)
  console.error('[promptx] 可用命令：start / stop / restart / status / doctor / version / relay start / relay stop / relay restart / relay status / relay run')
  process.exitCode = 1
}
