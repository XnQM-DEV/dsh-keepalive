// Heartbeat: is DSH alive? If not, ask the restart task to bring it back.
//
//   no DSH process at all              -> restart now ("down")
//   process there, no port answers     -> count; after hungThreshold ticks in a row, restart ("hung")
//   process there, no listening port   -> probably still starting; only after noPortThreshold ticks
//   process list could not be read     -> do nothing this tick (never restart on missing information)
//
// The in-DSH half of this plugin writes <dataDir>/host-pulse.json every minute
// with its pid, its web port (when known) and any turn that has had no
// activity for a long time ("stuck"). The heartbeat uses it as a port hint and
// reports stuck turns (and restarts for them only if stuckTurnAction="restart").

import { join } from 'node:path'
import { findTask, stateDir } from './config.mjs'
import { inMaintenance } from './maintenance.mjs'
import { message, REASONS } from './messages.mjs'
import { notify } from './notify.mjs'
import { readJson, writeJson } from './util.mjs'

export const pulseFile = (cfg) => join(cfg.dataDir, 'host-pulse.json')
const stateFile = (cfg) => join(stateDir(cfg), 'heartbeat.json')
export const restartRequestFile = (cfg) => join(stateDir(cfg), 'restart-request.json')

/** Ask for a restart: through the restart scheduled task when installed, else in a detached child. */
export async function triggerRestart(cfg, env, reasonKey) {
  const { log, sys, dryRun } = env
  if (dryRun) {
    log(`[试运行] 这里会触发重启（原因：${REASONS[reasonKey] || reasonKey}）`)
    return { how: 'dry-run' }
  }
  writeJson(restartRequestFile(cfg), { reason: reasonKey, at: Date.now() })
  const task = findTask(cfg, 'restart')
  if (task && task.enabled !== false && sys.taskExists(task.name)) {
    const r = sys.runTask(task.name)
    if (r.ok) {
      log(`已触发计划任务 ${task.name}`)
      return { how: 'task' }
    }
    log(`触发计划任务 ${task.name} 失败：${r.out}；改为直接重启`)
  }
  if (env.spawnRestart) {
    env.spawnRestart(reasonKey)
    log('已在后台直接启动重启流程（没有可用的重启计划任务）')
    return { how: 'spawn' }
  }
  log('没有重启计划任务，也没法直接启动重启流程')
  return { how: 'none' }
}

export async function heartbeat(cfg, env) {
  const { log, sys, dryRun } = env
  const hb = cfg.heartbeat
  if (!hb.enabled) {
    log('心跳检查已关闭（heartbeat.enabled = false）')
    return { result: 'disabled' }
  }
  if (inMaintenance(cfg, log, { dryRun })) return { result: 'maintenance' }

  const st = readJson(stateFile(cfg), {}) || {}
  st.fails = Number(st.fails) || 0
  st.noPort = Number(st.noPort) || 0
  const save = () => {
    if (!dryRun) writeJson(stateFile(cfg), st)
  }
  const say = async (key, vars) => {
    if (hb.notify === false) return
    await notify(cfg, message(cfg, key, vars), log, { dryRun })
  }

  const snap = await sys.listProcesses(cfg.dsh.processNames)
  if (!snap.ok) {
    log(`读不到进程列表（${snap.error || '原因不明'}），这一轮什么都不做`)
    return { result: 'unknown' }
  }

  const pulse = readJson(pulseFile(cfg), null)
  const pulseLive = !!(pulse && pulse.pid && sys.pidAlive(pulse.pid))
  const pulseAgeSec = pulse && pulse.time ? (Date.now() - Date.parse(pulse.time)) / 1000 : Infinity
  const pulseFresh = pulseLive && pulseAgeSec < Math.max(180, 3 * (Number(cfg.host.pulseSeconds) || 60))

  const ports = new Set()
  for (const l of snap.listen) if (Number(l.port) >= Number(cfg.dsh.minPort || 1025)) ports.add(Number(l.port))
  for (const p of cfg.dsh.extraPorts || []) if (Number(p)) ports.add(Number(p))
  if (pulseLive && Number(pulse.port)) ports.add(Number(pulse.port))

  let answeredPort = null
  const timeoutMs = (Number(cfg.dsh.probeTimeoutSeconds) || 3) * 1000
  for (const port of ports) {
    if (await sys.httpAnswers(port, timeoutMs)) {
      answeredPort = port
      break
    }
  }

  // ---- alive ----------------------------------------------------------------
  if (answeredPort !== null) {
    if (st.last === 'down' || st.last === 'hung') {
      log('DSH 回来了')
      await say('back')
    }
    st.fails = 0
    st.noPort = 0
    st.last = 'alive'
    st.lastAliveAt = new Date().toISOString()
    st.port = answeredPort

    // a turn with no activity for a long time (reported by the in-DSH half)
    const stuck = pulseFresh && Array.isArray(pulse.stuck) ? pulse.stuck : []
    const action = hb.stuckTurnAction || 'notify'
    if (stuck.length && action !== 'off') {
      const s = stuck[0]
      const key = `${s.session}@${s.since}`
      if (st.stuckKey !== key) {
        st.stuckKey = key
        log(`会话 ${s.session} 的一轮 ${s.minutes} 分钟没动静`)
        await say('stuck', {
          session: s.session,
          minutes: s.minutes,
          action: message(cfg, action === 'restart' ? 'stuckActionRestart' : 'stuckActionNotify'),
        })
        save()
        if (action === 'restart') {
          await triggerRestart(cfg, env, 'stuck')
          return { result: 'stuck-restart', port: answeredPort }
        }
        return { result: 'stuck', port: answeredPort }
      }
    } else if (!stuck.length) {
      st.stuckKey = ''
    }
    save()
    return { result: 'alive', port: answeredPort }
  }

  // ---- no process at all ----------------------------------------------------
  if (snap.procs.length === 0) {
    log('没有 DSH 进程 → 重启')
    if (st.last !== 'down') await say('down')
    st.last = 'down'
    st.fails = 0
    st.noPort = 0
    save()
    await triggerRestart(cfg, env, 'down')
    return { result: 'down' }
  }

  // ---- process there, but nothing listening: probably still starting ---------
  if (ports.size === 0) {
    st.noPort += 1
    const limit = Number(cfg.dsh.noPortThreshold) || 6
    log(`DSH 进程在，但没找到它监听的端口（第 ${st.noPort}/${limit} 次，可能还在启动）`)
    if (st.noPort >= limit) {
      log('一直没有端口 → 当作卡住，重启')
      await say('hung', { count: st.noPort })
      st.last = 'hung'
      st.noPort = 0
      save()
      await triggerRestart(cfg, env, 'hung')
      return { result: 'hung' }
    }
    save()
    return { result: 'no-port', count: st.noPort }
  }

  // ---- process there, ports there, nobody answers ---------------------------
  st.fails += 1
  st.noPort = 0
  const limit = Number(hb.hungThreshold) || 3
  log(`DSH 进程在，但 ${ports.size} 个端口都没应答（第 ${st.fails}/${limit} 次）`)
  if (st.fails >= limit) {
    log(`连续 ${limit} 次不应答 → 重启`)
    await say('hung', { count: st.fails })
    st.last = 'hung'
    st.fails = 0
    save()
    await triggerRestart(cfg, env, 'hung')
    return { result: 'hung' }
  }
  save()
  return { result: 'not-answering', fails: st.fails }
}
