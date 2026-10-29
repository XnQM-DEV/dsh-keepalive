// Local helper services DSH depends on (a QQ backend, an image server ...).
// Each one: { name, port, command, args, cwd, env, startWaitSeconds, when }
//   when: ["restart"] – checked right after DSH is restarted
//         ["watch"]   – checked on every tick (and so after a reboot)
// A service is only started when its port is not listening. A service with no
// command is only reported (for example one that needs a QR-code login).

export async function ensureService(svc, env) {
  const { sys, log, dryRun } = env
  const name = svc.name || `端口 ${svc.port}`
  if (!svc.port) return { name, up: false, started: false, note: '没写端口' }
  if (await sys.portOpen(svc.port)) return { name, up: true, started: false }
  if (!svc.command) {
    log(`${name}：端口 ${svc.port} 没在监听，也没配置启动命令，只能报告`)
    return { name, up: false, started: false }
  }
  if (dryRun) {
    log(`[试运行] ${name} 没起来，会执行：${svc.command} ${(svc.args || []).join(' ')}`)
    return { name, up: false, started: false, dryRun: true }
  }
  try {
    sys.startService(svc)
  } catch (error) {
    log(`${name}：启动失败 ${String((error && error.message) || error)}`)
    return { name, up: false, started: false }
  }
  const waitMs = (Number(svc.startWaitSeconds) || 15) * 1000
  const step = 1000
  for (let t = 0; t < waitMs; t += step) {
    await sys.sleep(step)
    if (await sys.portOpen(svc.port)) {
      log(`${name}：已启动（端口 ${svc.port}）`)
      return { name, up: true, started: true }
    }
  }
  log(`${name}：启动了，但 ${waitMs / 1000} 秒内端口 ${svc.port} 还没起来`)
  return { name, up: false, started: true }
}

export async function runServices(cfg, env, when) {
  const list = (cfg.services || []).filter((s) => s && s.enabled !== false && (s.when || ['restart']).includes(when))
  const results = []
  for (const svc of list) results.push(await ensureService(svc, env))
  return results
}

export function describeServices(results) {
  if (!results.length) return ''
  return results.map((r) => `${r.name}${r.up ? '在' : '没起来'}`).join('；') + '；'
}
