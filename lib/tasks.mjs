// Windows scheduled tasks: build the task XML from the config, install the
// runtime copy + tasks + helper shortcuts, and remove them again.
//
// Tasks run a STABLE copy of this package (<dataDir>/runtime), not the copy in
// DSH's node_modules: updating or removing the plugin inside DSH must never
// break the watchdog, and the watchdog must keep running when DSH is dead.
// Every task is started through scripts/run-hidden.vbs so no console window
// flashes up (and steals focus from a full-screen game).

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PACKAGE_ROOT, runtimeDir } from './config.mjs'
import { removeShortcuts, shortcutPlan, writeShortcuts } from './shortcuts.mjs'
import { arr, isInside, readJson, stamp, writeJson } from './util.mjs'

export const installedFile = (cfg) => join(cfg.dataDir, 'installed.json')

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const pad = (n) => String(n).padStart(2, '0')
const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const quoteArg = (a) => '"' + String(a).replace(/"/g, '\\"') + '"'

export function wscriptPath() {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
}

/** What a task runs: wscript //B run-hidden.vbs node.exe cli --config <file> <command...> */
export function taskAction(cfg, task) {
  const rt = runtimeDir(cfg)
  const args = [
    join(rt, 'scripts', 'run-hidden.vbs'),
    cfg.nodePath,
    '--no-warnings',
    join(rt, 'bin', 'dsh-keepalive.mjs'),
    '--config',
    cfg._file,
    ...arr(task.run).map(String),
  ]
  return { command: wscriptPath(), arguments: '//B //Nologo ' + args.map(quoteArg).join(' '), workingDirectory: rt }
}

export function describeTask(task) {
  const parts = []
  if (task.atLogon) parts.push(`登录后 ${Number(task.logonDelaySeconds) || 0} 秒`)
  if (task.everyMinutes) parts.push(`每 ${task.everyMinutes} 分钟`)
  if (task.dailyAt) parts.push(`每天 ${task.dailyAt}`)
  if (task.onDemand || !parts.length) parts.push('只在需要时被触发')
  return parts.join(' + ') + (task.elevated ? '，以最高权限运行（需要管理员）' : '')
}

export function buildTaskXml(cfg, task, { user, now = new Date() } = {}) {
  const t = []
  if (task.atLogon) {
    const delay = Number(task.logonDelaySeconds) || 0
    t.push(
      '    <LogonTrigger>\n' +
        (delay ? `      <Delay>PT${delay}S</Delay>\n` : '') +
        `      <UserId>${xmlEsc(user)}</UserId>\n` +
        '    </LogonTrigger>',
    )
  }
  if (task.everyMinutes) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1, 0)
    t.push(
      '    <TimeTrigger>\n' +
        `      <StartBoundary>${isoLocal(start)}</StartBoundary>\n` +
        '      <Repetition>\n' +
        `        <Interval>PT${Number(task.everyMinutes)}M</Interval>\n` +
        '        <StopAtDurationEnd>false</StopAtDurationEnd>\n' +
        '      </Repetition>\n' +
        '    </TimeTrigger>',
    )
  }
  if (task.dailyAt) {
    const m = String(task.dailyAt).match(/^(\d{1,2}):(\d{2})$/)
    if (!m) throw new Error(`任务 ${task.id} 的 dailyAt 应该写成 "04:30" 这样：${task.dailyAt}`)
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), 0)
    t.push(
      '    <CalendarTrigger>\n' +
        `      <StartBoundary>${isoLocal(start)}</StartBoundary>\n` +
        '      <ScheduleByDay>\n' +
        '        <DaysInterval>1</DaysInterval>\n' +
        '      </ScheduleByDay>\n' +
        '    </CalendarTrigger>',
    )
  }
  const a = taskAction(cfg, task)
  const limit = Number(task.timeLimitMinutes) || 60
  return (
    '<?xml version="1.0" encoding="UTF-16"?>\n' +
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n' +
    '  <RegistrationInfo>\n' +
    '    <Author>dsh-keepalive</Author>\n' +
    `    <Description>${xmlEsc(`dsh-keepalive: ${task.id} (${describeTask(task)}). Created by dsh-keepalive install; remove with dsh-keepalive uninstall.`)}</Description>\n` +
    '  </RegistrationInfo>\n' +
    (t.length ? '  <Triggers>\n' + t.join('\n') + '\n  </Triggers>\n' : '  <Triggers />\n') +
    '  <Principals>\n' +
    '    <Principal id="Author">\n' +
    `      <UserId>${xmlEsc(user)}</UserId>\n` +
    '      <LogonType>InteractiveToken</LogonType>\n' +
    `      <RunLevel>${task.elevated ? 'HighestAvailable' : 'LeastPrivilege'}</RunLevel>\n` +
    '    </Principal>\n' +
    '  </Principals>\n' +
    '  <Settings>\n' +
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n' +
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n' +
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n' +
    '    <AllowHardTerminate>true</AllowHardTerminate>\n' +
    '    <StartWhenAvailable>true</StartWhenAvailable>\n' +
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n' +
    '    <IdleSettings>\n' +
    '      <StopOnIdleEnd>false</StopOnIdleEnd>\n' +
    '      <RestartOnIdle>false</RestartOnIdle>\n' +
    '    </IdleSettings>\n' +
    '    <AllowStartOnDemand>true</AllowStartOnDemand>\n' +
    '    <Enabled>true</Enabled>\n' +
    '    <Hidden>false</Hidden>\n' +
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>\n' +
    '    <WakeToRun>false</WakeToRun>\n' +
    `    <ExecutionTimeLimit>PT${limit}M</ExecutionTimeLimit>\n` +
    '    <Priority>7</Priority>\n' +
    '  </Settings>\n' +
    '  <Actions Context="Author">\n' +
    '    <Exec>\n' +
    `      <Command>${xmlEsc(a.command)}</Command>\n` +
    `      <Arguments>${xmlEsc(a.arguments)}</Arguments>\n` +
    `      <WorkingDirectory>${xmlEsc(a.workingDirectory)}</WorkingDirectory>\n` +
    '    </Exec>\n' +
    '  </Actions>\n' +
    '</Task>\n'
  )
}

/** schtasks wants UTF-16 LE with a BOM. */
export function writeTaskXml(file, xml) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '\ufeff' + xml, 'utf16le')
}

/** Copy lib/, bin/, scripts/ and package.json to <dataDir>/runtime. */
export function copyRuntime(cfg) {
  const rt = runtimeDir(cfg)
  if (isInside(PACKAGE_ROOT, rt)) return { copied: false, dir: rt }
  rmSync(rt, { recursive: true, force: true })
  mkdirSync(rt, { recursive: true })
  for (const part of ['lib', 'bin', 'scripts']) cpSync(join(PACKAGE_ROOT, part), join(rt, part), { recursive: true })
  cpSync(join(PACKAGE_ROOT, 'package.json'), join(rt, 'package.json'))
  return { copied: true, dir: rt }
}

function selectedTasks(cfg, only) {
  return (cfg.tasks || []).filter((t) => t && t.name && t.enabled !== false && (!only || only.includes(t.id)))
}

/** Things that would make the installed watchdog useless; install refuses while any is present. */
export function blockingProblems(cfg) {
  const p = []
  if (!cfg._exists) p.push(`还没有配置文件：${cfg._file}（先运行 init）`)
  if (!existsSync(cfg.nodePath)) p.push(`找不到 node.exe：${cfg.nodePath}（改配置里的 nodePath）`)
  const restartTask = (cfg.tasks || []).find((t) => t && t.id === 'restart' && t.enabled !== false)
  if (restartTask && (!cfg.dsh.exe || !existsSync(cfg.dsh.exe))) p.push(`找不到 DSH 主程序：${cfg.dsh.exe || '（dsh.exe 没填）'}`)
  for (const t of cfg.tasks || []) {
    if (t && t.dailyAt && !/^\d{1,2}:\d{2}$/.test(String(t.dailyAt))) p.push(`任务 ${t.id} 的 dailyAt 格式不对：${t.dailyAt}`)
  }
  return p
}

export async function install(cfg, env, opts = {}) {
  const { log, sys, dryRun } = env
  const problems = blockingProblems(cfg)
  if (problems.length) {
    for (const p of problems) log('✗ ' + p)
    log('先把上面的问题改好再安装。')
    return { result: 'blocked', problems }
  }
  const tasks = selectedTasks(cfg, opts.only)
  const admin = sys.isAdmin()
  const user = sys.currentUser()
  const legacy = (cfg.legacy.tasks || []).map((name) => ({ name, ...sys.taskInfo(name) })).filter((x) => x.exists)
  const shortcuts = cfg.shortcuts.enabled === false ? [] : shortcutPlan(cfg)

  log('将要做的事：')
  log(`  1. 把运行文件复制到 ${runtimeDir(cfg)}（计划任务从这里运行）`)
  log('  2. 创建计划任务：')
  for (const t of tasks) log(`       ${t.name}：${describeTask(t)} → 运行「${arr(t.run).join(' ')}」`)
  if (shortcuts.length) {
    log('  3. 生成双击用的小工具：')
    for (const s of shortcuts) log(`       ${s.file}`)
  }
  if (legacy.length) {
    const on = legacy.filter((x) => x.enabled)
    log(`  ⚠ 发现旧的守护任务：${legacy.map((x) => x.name + (x.enabled ? '' : '（已停用）')).join('、')}`)
    if (opts.disableLegacy && on.length) log(`  4. 停用（不删除）旧任务：${on.map((x) => x.name).join('、')}；卸载时会重新启用`)
    else if (on.length) log('     它们和新任务会同时守护、可能重复重启。确认没问题后可以加 --disable-legacy 停用它们（卸载时自动恢复）。')
  }
  const needAdmin = tasks.filter((t) => t.elevated)
  if (needAdmin.length && !admin) log(`  ⚠ ${needAdmin.map((t) => t.name).join('、')} 需要管理员权限；现在不是管理员${opts.elevate ? '，会弹出 UAC 确认' : '，这几个会被跳过（可加 --elevate）'}`)

  if (dryRun) {
    for (const t of tasks) {
      log(`----- ${t.name} 的任务定义（试运行，没有创建）-----`)
      for (const line of buildTaskXml(cfg, t, { user }).split('\n')) if (line.trim()) log(line)
    }
    log('[试运行] 什么都没改。')
    return { result: 'dry-run', tasks: tasks.map((t) => t.name), legacy: legacy.map((x) => x.name) }
  }

  if (needAdmin.length && !admin && opts.elevate && env.relaunchElevated) {
    log('正在请求管理员权限（会弹出 UAC 窗口）……')
    env.relaunchElevated()
    return { result: 'relaunched' }
  }
  if (!opts.yes) {
    const ok = env.confirm ? await env.confirm('确认安装吗？输入 y 回车确认，其他任意键取消：') : false
    if (!ok) {
      log('已取消，什么都没改。')
      return { result: 'cancelled' }
    }
  }

  const prev = readJson(installedFile(cfg), {}) || {}
  const rt = copyRuntime(cfg)
  log(rt.copied ? `运行文件已复制到 ${rt.dir}` : `正在从 ${rt.dir} 运行，不用复制`)

  const done = []
  const failed = []
  for (const t of tasks) {
    if (t.elevated && !admin) {
      failed.push({ name: t.name, why: '需要管理员' })
      log(`跳过 ${t.name}（需要管理员权限）`)
      continue
    }
    const xmlFile = join(cfg.dataDir, 'tasks', `${t.id}.xml`)
    writeTaskXml(xmlFile, buildTaskXml(cfg, t, { user }))
    const r = sys.createTaskFromXml(t.name, xmlFile)
    if (r.ok) {
      done.push(t.name)
      log(`✓ 已创建计划任务 ${t.name}`)
    } else {
      failed.push({ name: t.name, why: r.out })
      log(`✗ 创建 ${t.name} 失败：${r.out}`)
    }
  }

  const written = shortcuts.length ? writeShortcuts(cfg, env) : []

  const disabledLegacy = new Set(prev.disabledLegacy || [])
  if (opts.disableLegacy) {
    for (const x of legacy.filter((y) => y.enabled)) {
      const r = sys.setTaskEnabled(x.name, false)
      if (r.ok) {
        disabledLegacy.add(x.name)
        log(`已停用旧任务 ${x.name}（卸载时会重新启用）`)
      } else log(`停用旧任务 ${x.name} 失败：${r.out}`)
    }
  }

  writeJson(installedFile(cfg), {
    version: readJson(join(PACKAGE_ROOT, 'package.json'), {}).version || '?',
    installedAt: stamp(),
    config: cfg._file,
    runtime: runtimeDir(cfg),
    tasks: [...new Set([...(prev.tasks || []), ...done])],
    shortcuts: [...new Set([...(prev.shortcuts || []), ...written])],
    disabledLegacy: [...disabledLegacy],
  })
  log(failed.length ? `安装完成，但有 ${failed.length} 个任务没建成（见上面）。` : '安装完成。')
  if (failed.some((f) => f.why === '需要管理员')) log('需要管理员的任务：右键「安装守护.cmd」→ 以管理员身份运行，或运行 install --elevate。')
  return { result: failed.length ? 'partial' : 'ok', done, failed, shortcuts: written }
}

export async function uninstall(cfg, env, opts = {}) {
  const { log, sys, dryRun } = env
  const rec = readJson(installedFile(cfg), null)
  const names = new Set(rec ? rec.tasks || [] : [])
  if (opts.all || !rec) for (const t of cfg.tasks || []) if (t && t.name) names.add(t.name)
  const present = [...names].filter((n) => sys.taskExists(n))
  const shortcuts = rec ? rec.shortcuts || [] : shortcutPlan(cfg).map((s) => s.file)
  const legacy = rec ? rec.disabledLegacy || [] : []

  log('将要做的事：')
  log(present.length ? `  删除计划任务：${present.join('、')}` : '  没有找到要删的计划任务')
  if (shortcuts.length) log(`  删除小工具（只删本插件生成的）：${shortcuts.length} 个`)
  if (legacy.length) log(`  重新启用安装时停用的旧任务：${legacy.join('、')}`)
  if (opts.purge) log(`  删除运行文件 ${runtimeDir(cfg)}（日志、状态和备份都保留）`)
  log('  配置文件、日志、备份都不会删。')
  if (dryRun) {
    log('[试运行] 什么都没改。')
    return { result: 'dry-run', tasks: present }
  }
  if (!opts.yes) {
    const ok = env.confirm ? await env.confirm('确认卸载吗？输入 y 回车确认，其他任意键取消：') : false
    if (!ok) {
      log('已取消，什么都没改。')
      return { result: 'cancelled' }
    }
  }
  const failed = []
  for (const n of present) {
    const r = sys.deleteTask(n)
    if (r.ok) log(`✓ 已删除 ${n}`)
    else {
      failed.push(n)
      log(`✗ 删除 ${n} 失败：${r.out}（以最高权限建的任务要用管理员身份删除）`)
    }
  }
  removeShortcuts(shortcuts, env)
  for (const n of legacy) {
    const r = sys.setTaskEnabled(n, true)
    log(r.ok ? `已重新启用旧任务 ${n}` : `重新启用 ${n} 失败：${r.out}`)
  }
  if (opts.purge) {
    const rt = runtimeDir(cfg)
    if (isInside(PACKAGE_ROOT, rt)) log('正在从运行文件夹里运行，没法删除它自己；请从别处运行 uninstall --purge')
    else rmSync(rt, { recursive: true, force: true })
  }
  if (!failed.length) rmSync(installedFile(cfg), { force: true })
  else writeJson(installedFile(cfg), { ...(rec || {}), tasks: failed, shortcuts: [], disabledLegacy: [] })
  log(failed.length ? `卸载没完全成功：${failed.join('、')} 还在。` : '卸载完成。')
  return { result: failed.length ? 'partial' : 'ok', failed }
}

/** Read-only: which of our tasks exist and are enabled. */
export function taskStatus(cfg, sys) {
  return (cfg.tasks || [])
    .filter((t) => t && t.name)
    .map((t) => ({ id: t.id, name: t.name, wanted: t.enabled !== false, ...sys.taskInfo(t.name) }))
}

export function readInstalled(cfg) {
  return readJson(installedFile(cfg), null)
}
