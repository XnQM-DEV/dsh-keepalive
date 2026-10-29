// init (write a starter config), doctor (check everything, read only) and
// status (short summary, read only).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseVars, dshHomeDefault, expand, PACKAGE_ROOT, runtimeDir, stateDir } from './config.mjs'
import { countAuthCookies } from './cookies.mjs'
import { linkPlan } from './dsh-link.mjs'
import { pulseFile } from './heartbeat.mjs'
import { maintenanceStatus } from './maintenance.mjs'
import { resolveOnebot } from './notify.mjs'
import { checkPatchFile, countEntries } from './patch-guard.mjs'
import { readInstalled, taskStatus } from './tasks.mjs'
import { protectedRoots, whyRefused } from './trim.mjs'
import { readJson, writeJson } from './util.mjs'

export async function init(cfgPath, env, { force = false, ifMissing = false } = {}) {
  const { log, sys } = env
  if (existsSync(cfgPath) && !force) {
    log(`配置文件已经有了：${cfgPath}${ifMissing ? '' : '（要重新生成请加 --force，旧文件会被覆盖）'}`)
    return { result: 'exists', file: cfgPath }
  }
  const tpl = readJson(join(PACKAGE_ROOT, 'keepalive.config.example.json'), null)
  if (!tpl) throw new Error('模板 keepalive.config.example.json 读不了')
  const vars = { ...baseVars(), DSH_HOME: dshHomeDefault() }
  const found = []

  // DSH executable: the running one first, then common install places.
  let exe = ''
  try {
    exe = sys.processPath('DeepSeek Harness')
  } catch {}
  if (!exe) {
    for (const c of [
      join(vars.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
      'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    ]) {
      if (existsSync(c)) {
        exe = c
        break
      }
    }
  }
  if (exe) {
    tpl.dsh.exe = exe
    found.push('DSH 主程序：' + exe)
  } else found.push('没找到 DSH 主程序，请手动填写 dsh.exe')

  // QQ bridge config: use it as the notification source (values are read at send time, not copied).
  const bridge = join(vars.DSH_HOME, 'qq-bridge-config.json')
  const b = readJson(bridge, null)
  const ch = (tpl.notify.channels || []).find((c) => c.type === 'onebot')
  if (b && ch && b.NapCat && b['私聊QQ']) {
    ch.enabled = true
    found.push('找到 QQ 桥配置，通知会从里面读地址、令牌和 QQ 号（不会复制到这里）')
  }

  // Patch guard: suggest a minimum based on the current file.
  const patch = expand(tpl.patchGuard.file || '${DSH_HOME}/profiles/desktop/cordis.patch.yml', vars)
  if (existsSync(patch)) {
    const n = countEntries(readFileSync(patch, 'utf8'))
    if (n >= 5) {
      tpl.patchGuard.minEntries = Math.max(1, Math.floor(n * 0.6))
      found.push(`插件配置现在有 ${n} 项；建议的最少项数设为 ${tpl.patchGuard.minEntries}（patchGuard 默认关闭，确认后再打开）`)
    }
  }

  writeJson(cfgPath, tpl)
  log('已生成配置文件：' + cfgPath)
  for (const f of found) log('  · ' + f)
  log('用记事本打开它看一遍，再运行 doctor 检查。')
  return { result: 'ok', file: cfgPath, found }
}

const yes = (b) => (b ? '✓' : '✗')

export async function doctor(cfg, env) {
  const { log, sys } = env
  const warn = []
  const line = (ok, text) => {
    log(`${ok === null ? '·' : yes(ok)} ${text}`)
    if (ok === false) warn.push(text)
  }

  line(cfg._exists, `配置文件：${cfg._file}${cfg._exists ? '' : '（不存在，正在用默认值）'}`)
  line(existsSync(cfg.nodePath), `node.exe：${cfg.nodePath}`)
  line(!!cfg.dsh.exe && existsSync(cfg.dsh.exe), `DSH 主程序：${cfg.dsh.exe || '（没填 dsh.exe）'}`)
  line(null, `数据文件夹：${cfg.dataDir}`)

  const snap = await sys.listProcesses(cfg.dsh.processNames)
  if (!snap.ok) line(false, '读不到进程列表：' + snap.error)
  else {
    const ports = [...new Set(snap.listen.map((l) => l.port))].filter((p) => p >= cfg.dsh.minPort)
    let answered = null
    for (const p of ports) {
      if (await sys.httpAnswers(p, 3000)) {
        answered = p
        break
      }
    }
    line(snap.procs.length > 0, `DSH 进程：${snap.procs.length} 个${ports.length ? `，监听端口 ${ports.join(', ')}` : ''}${answered ? `，端口 ${answered} 有应答` : snap.procs.length ? '，没有端口应答' : ''}`)
  }

  const m = maintenanceStatus(cfg)
  line(null, m.on ? `维护模式：开着（还剩 ${m.leftMinutes} 分钟）` : `维护模式：关着（标记文件 ${m.file}）`)

  const pulse = readJson(pulseFile(cfg), null)
  if (pulse) {
    const age = Math.round((Date.now() - Date.parse(pulse.time)) / 1000)
    line(age < 300, `DSH 里的插件心跳：${age} 秒前（插件 v${pulse.version || '?'}，pid ${pulse.pid}${sys.pidAlive(pulse.pid) ? '' : '，这个进程已经不在了'}）${pulse.stuck && pulse.stuck.length ? `，有 ${pulse.stuck.length} 轮对话很久没动静` : ''}`)
  } else line(null, 'DSH 里的插件心跳：没有（插件还没装进 DSH，或 DSH 没开）——不影响外面的看门狗')

  const lp = linkPlan(cfg)
  const pj = readJson(lp.pkgJson, null)
  if (pj) {
    const inDeps = !!(pj.dependencies && pj.dependencies['dsh-keepalive'])
    line(null, `插件装进 DSH 了吗：${inDeps && existsSync(lp.linkPath) ? '是' : '没有（可以用 link-into-dsh）'}`)
  }

  const channels = (cfg.notify.channels || []).filter((c) => c && c.enabled !== false)
  if (!channels.length) line(null, '通知通道：没有开启的（消息只写日志）')
  for (const c of channels) {
    if (c.type === 'onebot') {
      const o = resolveOnebot(c)
      line(!!o.url && !!(o.userId || o.groupId), `QQ 通知（onebot）：地址 ${o.url ? '✓' : '✗'}，令牌 ${o.token ? '✓' : '（无）'}，收信人 ${o.userId || o.groupId ? '✓' : '✗'}${c.fromFile && c.fromFile.path ? `（从 ${c.fromFile.path} 读取）` : ''}`)
    } else line(!!(c.url || c.command), `${c.type} 通知：${c.url ? '已填地址' : c.command ? '已填命令' : '没填'}`)
  }

  const r = cfg.restart.selfcheck || {}
  if (r.enabled) line(existsSync(r.command), `重启后自检：${r.command}`)
  for (const s of cfg.services || []) {
    const up = await sys.portOpen(s.port)
    line(null, `服务「${s.name}」端口 ${s.port}：${up ? '在' : '没在监听'}${s.command ? (existsSync(s.command) ? '' : '（启动命令找不到！）') : '（没配置启动命令，只报告）'}`)
  }

  if (cfg.patchGuard.enabled) {
    const c = checkPatchFile(cfg.patchGuard.file, cfg, log)
    line(c.ok, `插件配置守护：${cfg.patchGuard.file}，${c.entries} 项${c.ok ? '，正常' : '，' + c.why}`)
  } else line(null, '插件配置守护：关闭')

  for (const [name, job] of Object.entries(cfg.backup.jobs || {})) {
    const missing = (job.items || []).filter((i) => i.required && !i.src.includes('*') && !existsSync(i.src)).map((i) => i.src)
    const st = readJson(join(stateDir(cfg), `backup-${name}.json`), null)
    line(missing.length === 0, `备份「${name}」→ ${job.dest}，${(job.items || []).length} 项${missing.length ? `，缺少必需项：${missing.join('、')}` : ''}${st ? `；上次 ${st.at}：${st.result}，失败 ${st.errors} 处` : '；还没跑过'}`)
  }

  const roots = protectedRoots(cfg)
  for (const j of cfg.trim.jobs || []) {
    if (!j || !j.path) continue
    const why = existsSync(j.path) ? whyRefused(j.path, roots) : ''
    line(!why, `清理「${j.name || j.path}」：${why ? '会被拒绝，' + why : `${j.olderThanDays || 14} 天以前的文件`}`)
  }

  const inst = readInstalled(cfg)
  for (const t of taskStatus(cfg, sys)) {
    if (!t.wanted && !t.exists) continue
    line(t.wanted ? t.exists && t.enabled : null, `计划任务 ${t.name}：${t.exists ? (t.enabled ? '已安装' : '已安装但被停用') : '没安装'}`)
  }
  if (inst) {
    const rtv = readJson(join(runtimeDir(cfg), 'package.json'), {}).version
    const v = readJson(join(PACKAGE_ROOT, 'package.json'), {}).version
    line(rtv === v, `运行文件版本：${rtv || '?'}（当前包 ${v}）${rtv === v ? '' : '——重新运行 install 更新'}`)
  }
  const legacy = (cfg.legacy.tasks || []).map((n) => ({ n, ...sys.taskInfo(n) })).filter((x) => x.exists && x.enabled)
  if (legacy.length) line(null, `旧的守护任务还开着：${legacy.map((x) => x.n).join('、')}（和新任务会重复守护）`)

  const c = await countAuthCookies(cfg.dsh.cookieStore)
  if (c.ok) line(c.count < 50, `DSH 登录 cookie：${c.count} 个${c.count >= 50 ? '（快到 70 个的上限了，下次重启会自动清）' : ''}`)
  else line(null, 'DSH 登录 cookie：现在读不了（DSH 开着时文件是锁住的，正常）')

  log(warn.length ? `发现 ${warn.length} 个问题（上面打 ✗ 的）。` : '没发现问题。')
  return { problems: warn }
}

export function status(cfg, env) {
  const { log, sys } = env
  const m = maintenanceStatus(cfg)
  const hb = readJson(join(stateDir(cfg), 'heartbeat.json'), null)
  const hist = readJson(join(stateDir(cfg), 'restart-history.json'), null)
  const pulse = readJson(pulseFile(cfg), null)
  log(m.on ? `维护模式：开着，还剩 ${m.leftMinutes} 分钟` : '维护模式：关着')
  log(hb ? `上次心跳：${hb.last === 'alive' ? '正常' : hb.last}${hb.lastAliveAt ? `（最后一次正常 ${new Date(hb.lastAliveAt).toLocaleString('zh-CN')}）` : ''}` : '上次心跳：还没跑过')
  if (hist && hist.times && hist.times.length) {
    const last = hist.times[hist.times.length - 1]
    const inHour = hist.times.filter((t) => Date.now() - t < 3600000).length
    log(`上次重启：${new Date(last).toLocaleString('zh-CN')}；最近一小时 ${inHour} 次`)
  } else log('上次重启：没有记录')
  if (pulse) log(`DSH 里的插件心跳：${Math.round((Date.now() - Date.parse(pulse.time)) / 1000)} 秒前`)
  for (const [name] of Object.entries(cfg.backup.jobs || {})) {
    const st = readJson(join(stateDir(cfg), `backup-${name}.json`), null)
    log(`备份「${name}」：${st ? `${st.at} ${st.result === 'ok' ? '成功' : `有 ${st.errors} 处失败`}` : '还没跑过'}`)
  }
  for (const t of taskStatus(cfg, sys)) {
    if (!t.wanted && !t.exists) continue
    log(`计划任务 ${t.name}：${t.exists ? (t.enabled ? '在' : '被停用') : '没安装'}`)
  }
  const report = cfg.restart.reportFile
  if (report && existsSync(report)) {
    log('最近一次重启汇报：')
    for (const l of readFileSync(report, 'utf8').replace(/^\ufeff/, '').trim().split(/\r?\n/)) log('  ' + l)
  }
  return { maintenance: m, heartbeat: hb, pulse }
}
