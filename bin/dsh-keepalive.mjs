#!/usr/bin/env node
// dsh-keepalive command line. Scheduled tasks call this with DSH's own node.exe;
// people can run it by hand too (all messages are Chinese, all args ASCII).

import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctor, init, status } from '../lib/admin.mjs'
import { runBackup } from '../lib/backup.mjs'
import { defaultConfigPath, loadConfig, logFile, PACKAGE_ROOT, stateDir } from '../lib/config.mjs'
import { clearAuthCookies } from '../lib/cookies.mjs'
import { linkIntoDsh, unlinkFromDsh } from '../lib/dsh-link.mjs'
import { heartbeat } from '../lib/heartbeat.mjs'
import { enterMaintenance, exitMaintenance, maintenanceStatus } from '../lib/maintenance.mjs'
import { message } from '../lib/messages.mjs'
import { notify } from '../lib/notify.mjs'
import { patchGuard } from '../lib/patch-guard.mjs'
import { rescue, restart } from '../lib/restart.mjs'
import { runServices } from '../lib/services.mjs'
import { realSystem } from '../lib/system.mjs'
import { install, uninstall } from '../lib/tasks.mjs'
import { runTrim } from '../lib/trim.mjs'
import { makeLogger, powershell, psQuote, readJson, spawnDetached, stamp, writeJson } from '../lib/util.mjs'

const CLI = fileURLToPath(import.meta.url)
const VERSION = (readJson(join(PACKAGE_ROOT, 'package.json'), {}) || {}).version || '?'

const HELP = `dsh-keepalive ${VERSION} —— DSH 保活守护

用法：dsh-keepalive [--config 配置文件] <命令> [选项]
默认配置文件：${defaultConfigPath()}

第一次用：
  init                 生成配置文件（会自动找 DSH 主程序和 QQ 桥配置）
  doctor               检查配置和环境，只读，不改任何东西
  install              安装外面的看门狗（计划任务 + 双击小工具），会先列出要做的事再问你
  link-into-dsh        把插件的宿主半边装进 DSH（不运行 pnpm），会先问你

日常：
  status               看守护状态
  maintenance on|off|status   进入 / 退出 / 查看维护模式（--note 写个备注）
  rescue               急救：退出维护模式、结束卡住的 DSH、清登录 cookie、重启
  notify-test [文字]   发一条测试通知

计划任务调用的（也可以手动跑）：
  tick                 插件配置守护 + 心跳检查 + 服务检查（每 5 分钟）
  heartbeat            只做心跳检查
  restart              重启 DSH（--force 忽略维护模式和次数限制，--reason 写原因）
  patch-guard          插件配置被重置时从备份恢复
  backup <名字>|--all   跑备份任务
  trim                 清理磁盘
  services [watch|restart]   检查依赖的服务
  clear-cookies        清 DSH 的旧登录 cookie（DSH 关着时才行）

卸载：
  uninstall            删除计划任务和小工具（--purge 连运行文件一起删；配置、日志、备份都保留）
  unlink-from-dsh      把宿主半边从 DSH 里拿掉

通用选项：
  --dry-run            试运行：只说会做什么，什么都不改、不发通知、不写日志文件
  --yes                不再询问，直接执行（install / uninstall / link 用）
  --verbose            把日志也打印到屏幕上
`

function parseArgs(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') opts.config = argv[++i]
    else if (a === '--reason') opts.reason = argv[++i]
    else if (a === '--note') opts.note = argv[++i]
    else if (a === '--only') opts.only = String(argv[++i] || '').split(',').filter(Boolean)
    else if (a.startsWith('--')) opts[a.slice(2).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = true
    else opts._.push(a)
  }
  return opts
}

function confirm(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((done) =>
    rl.question(question, (answer) => {
      rl.close()
      done(/^(y|yes|是|好|确认)$/i.test(String(answer).trim()))
    }),
  )
}

async function pauseAtEnd() {
  if (!process.stdin.isTTY) return
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  await new Promise((done) => rl.question('按回车键关闭窗口……', () => done()))
  rl.close()
}

function describeResult(r) {
  const words = {
    alive: 'DSH 正常',
    down: 'DSH 进程没了',
    hung: 'DSH 卡住了',
    'not-answering': 'DSH 没应答',
    'no-port': 'DSH 还没有端口',
    unknown: '读不到进程列表',
    maintenance: '维护模式中，跳过',
    disabled: '没打开',
    stuck: '有一轮对话卡住了',
    'stuck-restart': '有一轮对话卡住了，已触发重启',
    ok: '正常',
    restored: '已从备份恢复',
    degraded: '不正常且没有可用备份',
    'dry-run': '试运行',
  }
  const extra = r.port ? `（端口 ${r.port} 有应答）` : r.entries ? `（${r.entries} 项）` : r.fails ? `（第 ${r.fails} 次）` : ''
  return (words[r.result] || r.result) + extra
}

const NEEDS_CONFIG = new Set(['tick', 'heartbeat', 'restart', 'rescue', 'patch-guard', 'backup', 'trim', 'services', 'clear-cookies'])

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cmd = opts._[0] || 'help'
  if (cmd === 'help' || opts.help) {
    console.log(HELP)
    return 0
  }
  if (cmd === 'version') {
    console.log(VERSION)
    return 0
  }

  const cfgPath = resolve(opts.config || defaultConfigPath())
  const sys = realSystem()
  const dryRun = !!opts.dryRun
  const interactive = !!process.stdout.isTTY || !!opts.verbose || dryRun

  if (cmd === 'init') {
    const log = makeLogger(null, 'init', { echo: true })
    await init(cfgPath, { log, sys }, { force: !!opts.force, ifMissing: !!opts.ifMissing })
    return 0
  }

  const cfg = loadConfig(cfgPath, { allowMissing: !NEEDS_CONFIG.has(cmd) })
  const log = makeLogger(dryRun ? null : logFile(cfg), cmd, { echo: interactive || dryRun })
  const env = {
    log,
    sys,
    dryRun,
    confirm,
    spawnRestart: (reason) =>
      spawnDetached(process.execPath, ['--no-warnings', CLI, '--config', cfg._file, 'restart', '--reason', reason], { hidden: true }),
    relaunchElevated: () => {
      const args = [CLI, '--config', cfg._file, 'install', '--pause']
      if (opts.disableLegacy) args.push('--disable-legacy')
      if (opts.only) args.push('--only', opts.only.join(','))
      const argStr = args.map((a) => '"' + String(a).replace(/"/g, '\\"') + '"').join(' ')
      powershell(`Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(argStr)} -Verb RunAs -Wait`, { timeoutMs: 30 * 60000 })
    },
  }

  switch (cmd) {
    case 'tick': {
      const pg = await patchGuard(cfg, env)
      const hb = await heartbeat(cfg, env)
      if (hb.result !== 'maintenance' && hb.result !== 'down' && hb.result !== 'hung') await runServices(cfg, env, 'watch')
      if (interactive) log(`插件配置：${describeResult(pg)}；心跳：${describeResult(hb)}`)
      return 0
    }
    case 'heartbeat': {
      const hb = await heartbeat(cfg, env)
      if (interactive) log('心跳：' + describeResult(hb))
      return 0
    }
    case 'restart': {
      const r = await restart(cfg, env, { force: !!opts.force, reason: opts.reason || '' })
      return r.result === 'failed' ? 1 : 0
    }
    case 'rescue':
      await rescue(cfg, env)
      return 0
    case 'patch-guard': {
      const r = await patchGuard(cfg, env)
      if (interactive && r.result === 'ok') log(`插件配置正常（${r.entries} 项）`)
      if (interactive && r.result === 'disabled') log('插件配置守护没打开（patchGuard.enabled = false）')
      return r.result === 'degraded' ? 1 : 0
    }
    case 'backup': {
      const names = opts.all ? Object.keys(cfg.backup.jobs || {}) : opts._.slice(1)
      if (!names.length) {
        log('要跑哪个备份？写名字，或者用 --all。现有的：' + (Object.keys(cfg.backup.jobs || {}).join('、') || '无'))
        return 1
      }
      let bad = 0
      for (const n of names) {
        const r = await runBackup(cfg, env, n)
        if (r.errors) bad++
        if (!dryRun) writeJson(join(stateDir(cfg), `backup-${n}.json`), { at: stamp(), result: r.result, errors: r.errors || 0, files: r.files || 0, out: r.out || '' })
      }
      return bad ? 1 : 0
    }
    case 'trim':
      await runTrim(cfg, env)
      return 0
    case 'services': {
      const when = opts._[1] || 'watch'
      const rs = await runServices(cfg, env, when)
      if (interactive) for (const r of rs) log(`${r.name}：${r.up ? '在' : '没起来'}${r.started ? '（刚启动）' : ''}`)
      if (interactive && !rs.length) log(`没有 when 包含 "${when}" 的服务`)
      return 0
    }
    case 'clear-cookies': {
      const r = await clearAuthCookies(cfg, env)
      log(r.message)
      return r.ok ? 0 : 1
    }
    case 'maintenance': {
      const sub = opts._[1] || 'status'
      const show = (m) => (m.on ? `维护模式：开着，还剩 ${m.leftMinutes} 分钟（到时间自动失效）` : '维护模式：关着')
      if (sub === 'on') {
        if (dryRun) log('[试运行] 会进入维护模式')
        else {
          const m = enterMaintenance(cfg, opts.note || '')
          log(`已进入维护模式：接下来 ${m.maxMinutes} 分钟内，看门狗不会重启 DSH，也不会改插件配置。`)
          log('现在可以手动关掉 DSH。弄完记得退出维护模式；忘了也没关系，到时间会自动失效。')
        }
      } else if (sub === 'off') {
        if (dryRun) log('[试运行] 会退出维护模式')
        else {
          const was = exitMaintenance(cfg)
          log(was ? '已退出维护模式，守护恢复正常。如果 DSH 还关着，几分钟内会被自动打开。' : '当前不在维护模式。')
        }
      } else log(show(maintenanceStatus(cfg)))
      return 0
    }
    case 'notify-test': {
      const text = opts._.slice(1).join(' ') || message(cfg, 'test')
      const rs = await notify(cfg, text, log, { dryRun })
      return rs.some((r) => !r.ok) ? 1 : 0
    }
    case 'install': {
      const r = await install(cfg, env, { yes: !!opts.yes, elevate: !!opts.elevate, disableLegacy: !!opts.disableLegacy, only: opts.only })
      return ['ok', 'dry-run', 'relaunched', 'cancelled'].includes(r.result) ? 0 : 1
    }
    case 'uninstall': {
      const r = await uninstall(cfg, env, { yes: !!opts.yes, purge: !!opts.purge, all: !!opts.all })
      return ['ok', 'dry-run', 'cancelled'].includes(r.result) ? 0 : 1
    }
    case 'link-into-dsh': {
      const r = await linkIntoDsh(cfg, env, { yes: !!opts.yes })
      return ['ok', 'dry-run', 'cancelled'].includes(r.result) ? 0 : 1
    }
    case 'unlink-from-dsh': {
      const r = await unlinkFromDsh(cfg, env, { yes: !!opts.yes, purge: !!opts.purge })
      return ['ok', 'dry-run', 'cancelled'].includes(r.result) ? 0 : 1
    }
    case 'doctor': {
      const r = await doctor(cfg, env)
      return r.problems.length ? 1 : 0
    }
    case 'status':
      status(cfg, env)
      return 0
    default:
      console.log(`不认识的命令：${cmd}\n`)
      console.log(HELP)
      return 1
  }
}

const opts0 = parseArgs(process.argv.slice(2))
main()
  .then(async (code) => {
    if (opts0.pause) await pauseAtEnd()
    process.exitCode = code || 0
  })
  .catch(async (error) => {
    console.error('出错了：' + String((error && error.message) || error))
    try {
      const cfg = loadConfig(resolve(opts0.config || defaultConfigPath()), { allowMissing: true })
      makeLogger(logFile(cfg), 'error')(String((error && error.stack) || error))
    } catch {}
    if (opts0.pause) await pauseAtEnd()
    process.exitCode = 1
  })
