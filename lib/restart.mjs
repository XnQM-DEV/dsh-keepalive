// Restart DSH: stop it, clear stale login cookies, start it, bring helper
// services back, run an optional self-check, then write and send a report.
// Guarded by maintenance mode, a cooldown and a per-hour limit, so a DSH that
// cannot start is not restarted in an endless loop.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findTask, stateDir } from './config.mjs'
import { clearAuthCookies } from './cookies.mjs'
import { restartRequestFile } from './heartbeat.mjs'
import { exitMaintenance, inMaintenance } from './maintenance.mjs'
import { message, REASONS } from './messages.mjs'
import { notify } from './notify.mjs'
import { describeServices, runServices } from './services.mjs'
import { readJson, removeFile, runNoPipe, shortStamp, writeJson, writeTextBom } from './util.mjs'

const historyFile = (cfg) => join(stateDir(cfg), 'restart-history.json')

function takeRestartRequest(cfg, dryRun) {
  const f = restartRequestFile(cfg)
  const r = readJson(f, null)
  if (!dryRun) removeFile(f)
  if (r && r.reason && Date.now() - Number(r.at) < 15 * 60000) return r.reason
  return ''
}

async function waitForProcess(cfg, sys, seconds) {
  for (let t = 0; t < seconds; t += 5) {
    await sys.sleep(5000)
    const s = await sys.listProcesses(cfg.dsh.processNames)
    if (s.ok && s.procs.length) return true
  }
  return false
}

export async function runSelfcheck(cfg, env) {
  const sc = cfg.restart.selfcheck || {}
  if (!sc.enabled || !sc.command) return ''
  if (env.dryRun) {
    env.log(`[试运行] 会运行自检：${sc.command} ${(sc.args || []).join(' ')}`)
    return ''
  }
  const r = await runNoPipe(sc.command, sc.args || [], {
    cwd: sc.cwd || undefined,
    timeoutMs: (Number(sc.timeoutSeconds) || 180) * 1000,
  })
  let summary = ''
  if (sc.readFile && existsSync(sc.readFile)) {
    try {
      const text = readFileSync(sc.readFile, 'utf8')
      const pattern = sc.summaryPattern ? new RegExp(sc.summaryPattern) : null
      const lines = text.split(/\r?\n/).filter((l) => (pattern ? pattern.test(l) : l.trim()))
      if (lines.length) summary = lines[lines.length - 1].trim()
    } catch {}
  }
  if (!summary) summary = r.timedOut ? '自检超时了' : r.code === 0 ? '自检跑完了' : `自检退出码 ${r.code}${r.error ? '（' + r.error + '）' : ''}`
  return summary
}

export async function restart(cfg, env, { force = false, reason = '' } = {}) {
  const { log, sys, dryRun } = env
  const rc = cfg.restart
  if (!rc.enabled && !force) {
    log('重启功能已关闭（restart.enabled = false）')
    return { result: 'disabled' }
  }
  if (!force && inMaintenance(cfg, log, { dryRun })) return { result: 'maintenance' }
  const reasonKey = reason || takeRestartRequest(cfg, dryRun) || 'manual'
  const reasonText = REASONS[reasonKey] || reasonKey

  // ---- rate limits ----------------------------------------------------------
  const now = Date.now()
  const hist = readJson(historyFile(cfg), {}) || {}
  hist.times = (hist.times || []).filter((t) => now - t < 3600000)
  if (!force) {
    const last = hist.times[hist.times.length - 1]
    const cooldown = (Number(rc.cooldownMinutes) || 0) * 60000
    if (last && now - last < cooldown) {
      log(`${Math.round((now - last) / 1000)} 秒前刚重启过，冷却中 → 这次跳过`)
      return { result: 'cooldown' }
    }
    const maxPerHour = Number(rc.maxPerHour) || 0
    if (maxPerHour && hist.times.length >= maxPerHour) {
      log(`最近一小时已经重启 ${hist.times.length} 次 → 不再自动重启`)
      if (!hist.gaveUpAt || now - hist.gaveUpAt > 3600000) {
        hist.gaveUpAt = now
        if (!dryRun) writeJson(historyFile(cfg), hist)
        await notify(cfg, message(cfg, 'gaveUp', { count: hist.times.length }), log, { dryRun })
      }
      return { result: 'gave-up' }
    }
  }
  hist.times.push(now)
  if (!dryRun) writeJson(historyFile(cfg), hist)

  if (dryRun) {
    log(`[试运行] 会重启 DSH（原因：${reasonText}）：结束 ${cfg.dsh.processNames.join('、')} → ${rc.clearAuthCookies ? '清登录 cookie → ' : ''}启动 ${cfg.dsh.exe || '（没配置 dsh.exe！）'}`)
    await runServices(cfg, env, 'restart')
    await runSelfcheck(cfg, env)
    return { result: 'dry-run' }
  }

  log(`=== 开始重启（原因：${reasonText}）===`)
  await sys.sleep(2000)
  for (const k of sys.killByName(cfg.dsh.processNames)) log(`结束 ${k.name}：退出码 ${k.code}${k.code === 128 ? '（本来就没在运行）' : ''}`)
  await sys.sleep((Number(rc.killWaitSeconds) || 4) * 1000)

  if (rc.clearAuthCookies) {
    const c = await clearAuthCookies(cfg, env)
    log(c.message)
  }

  if (!cfg.dsh.exe || !existsSync(cfg.dsh.exe)) {
    log(`没配置 dsh.exe，或者文件不存在（${cfg.dsh.exe || '空'}），没法启动`)
    await notify(cfg, message(cfg, 'restartFailed'), log)
    return { result: 'failed', why: 'no-exe' }
  }
  try {
    sys.startDsh(cfg.dsh.exe)
    log('已启动 ' + cfg.dsh.exe)
  } catch (error) {
    log('启动失败：' + String((error && error.message) || error))
  }
  let up = await waitForProcess(cfg, sys, Number(rc.startTimeoutSeconds) || 60)
  if (!up && rc.retryOnce) {
    log('第一次没起来，再试一次')
    try {
      sys.startDsh(cfg.dsh.exe)
    } catch {}
    up = await waitForProcess(cfg, sys, 30)
  }
  log(up ? 'DSH 进程已经起来' : 'DSH 进程一直没出现')

  await sys.sleep((Number(rc.settleSeconds) || 0) * 1000)
  const services = await runServices(cfg, env, 'restart')
  const selfcheck = up ? await runSelfcheck(cfg, env) : ''

  const report = message(cfg, 'restartReport', {
    time: shortStamp(),
    reason: reasonText,
    services: describeServices(services),
    selfcheck,
  })
  if (rc.reportFile) {
    try {
      writeTextBom(rc.reportFile, report + `\r\n（写入时间 ${shortStamp()}）\r\n`)
    } catch {}
  }
  if (rc.notify !== false) await notify(cfg, report, log)
  if (!up) await notify(cfg, message(cfg, 'restartFailed'), log)
  log('=== 重启流程结束 ===')
  return { result: up ? 'restarted' : 'failed', services, selfcheck }
}

/**
 * Emergency button: leave maintenance mode, kill DSH (and stray node workers
 * when configured), clear login cookies, then restart.
 */
export async function rescue(cfg, env) {
  const { log, sys, dryRun } = env
  if (dryRun) {
    log('[试运行] 急救会：退出维护模式 → 结束 DSH → 清登录 cookie → 重启')
    return { result: 'dry-run' }
  }
  if (exitMaintenance(cfg)) log('已自动退出维护模式')
  log('正在结束卡住的 DSH……')
  sys.killByName(cfg.dsh.processNames)
  if (cfg.dsh.rescueKillNodePattern) {
    const n = sys.killNodeMatching(cfg.dsh.rescueKillNodePattern)
    log(`顺手结束了 ${n} 个残留的 node 进程`)
  }
  await sys.sleep(2000)
  const c = await clearAuthCookies(cfg, env)
  log(c.message)
  const task = findTask(cfg, 'restart')
  writeJson(restartRequestFile(cfg), { reason: 'rescue', at: Date.now() })
  if (task && task.enabled !== false && sys.taskExists(task.name)) {
    const r = sys.runTask(task.name)
    if (r.ok) {
      log(`已发出重启指令（计划任务 ${task.name}），大约半分钟后 DSH 会重新打开。`)
      return { result: 'task' }
    }
    log(`计划任务 ${task.name} 没能运行：${r.out}；改为直接重启`)
  }
  return restart(cfg, env, { force: true, reason: 'rescue' })
}
