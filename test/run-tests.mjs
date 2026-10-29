// Sandboxed tests: everything happens inside a fresh temp folder. No real DSH
// process is killed or started, no scheduled task is created, no message
// leaves this machine (notifications go to a local fake OneBot server).
// The only real things it touches: it reads the profile's `yaml` module (if
// present) for YAML checks, and runs node.exe / cmd.exe children in the sandbox.
//
//   node test/run-tests.mjs

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { runBackup, makeExcluder } from '../lib/backup.mjs'
import { loadConfig, PACKAGE_ROOT } from '../lib/config.mjs'
import { clearAuthCookies, countAuthCookies } from '../lib/cookies.mjs'
import { linkIntoDsh, unlinkFromDsh } from '../lib/dsh-link.mjs'
import { heartbeat } from '../lib/heartbeat.mjs'
import { enterMaintenance, inMaintenance, maintenanceStatus } from '../lib/maintenance.mjs'
import { fmt } from '../lib/messages.mjs'
import { notify } from '../lib/notify.mjs'
import { countEntries, patchGuard } from '../lib/patch-guard.mjs'
import { rescue, restart } from '../lib/restart.mjs'
import { MARK } from '../lib/shortcuts.mjs'
import { findAncestor } from '../lib/system.mjs'
import { restartRequestFile } from '../lib/heartbeat.mjs'
import { buildTaskXml, install, uninstall, writeTaskXml } from '../lib/tasks.mjs'
import { runTrim } from '../lib/trim.mjs'

// ---------------------------------------------------------------- harness --
const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push(true)
    console.log('✓ ' + name)
  } catch (error) {
    results.push(false)
    console.log('✗ ' + name)
    console.log('    ' + String((error && error.stack) || error).split('\n').slice(0, 6).join('\n    '))
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-keepalive-test-'))
const HOME = join(ROOT, 'dsh-home')
mkdirSync(join(HOME, 'attachments'), { recursive: true })
mkdirSync(join(HOME, 'profiles', 'desktop'), { recursive: true })
const FAKE_EXE = join(ROOT, 'app', 'DeepSeek Harness.exe')
mkdirSync(join(ROOT, 'app'), { recursive: true })
writeFileSync(FAKE_EXE, '')
const LIVE_PROFILE_PKG = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop', 'package.json')

// fake OneBot / webhook server
const received = []
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  let json = {}
  try {
    json = JSON.parse(body || '{}')
  } catch {}
  received.push({ url: req.url, headers: req.headers, body: json })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ status: 'ok', retcode: 0 }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const BRIDGE = join(ROOT, 'bridge.json')
writeFileSync(BRIDGE, JSON.stringify({ NapCat: `http://127.0.0.1:${PORT}`, 令牌: 'test-token-xyz', 私聊QQ: '10001' }), 'utf8')

let n = 0
function freshCfg(over = {}) {
  n++
  const base = {
    dshHome: HOME,
    dataDir: join(ROOT, `data-${n}`),
    nodePath: process.execPath,
    dsh: { exe: FAKE_EXE, processNames: ['DeepSeek Harness.exe'], cookieStore: join(ROOT, `Cookies-${n}`), profileDir: join(HOME, 'profiles', 'desktop') },
    restart: { settleSeconds: 0, killWaitSeconds: 0, startTimeoutSeconds: 10 },
    notify: {
      channels: [{ type: 'onebot', enabled: true, fromFile: { path: BRIDGE, urlField: 'NapCat', tokenField: '令牌', userIdField: '私聊QQ' } }],
    },
  }
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge({ ...a[k] }, v) : v
    return a
  }
  const file = join(ROOT, `cfg-${n}.json`)
  writeFileSync(file, JSON.stringify(merge(base, over), null, 2), 'utf8')
  return loadConfig(file)
}

function fakeSys() {
  const s = {
    calls: [],
    procs: [],
    listen: [],
    answering: new Set(),
    open: new Set(),
    alivePids: new Set(),
    tasks: new Map(),
    psOk: true,
    admin: false,
    inside: false, // true = pretend this command was started from inside DSH
    sleep: async () => {},
    insideProcess() {
      s.calls.push('where')
      return s.inside ? { inside: true, ancestor: { pid: 777, name: 'DeepSeek Harness.exe' } } : { inside: s.inside }
    },
    async listProcesses() {
      s.calls.push('list')
      return s.psOk ? { ok: true, procs: s.procs, listen: s.listen } : { ok: false, procs: [], listen: [], error: 'boom' }
    },
    pidAlive: (pid) => s.alivePids.has(Number(pid)),
    async httpAnswers(port) {
      s.calls.push('http:' + port)
      return s.answering.has(Number(port))
    },
    async portOpen(port) {
      return s.open.has(Number(port))
    },
    killByName(names) {
      s.calls.push('kill')
      s.procs = []
      return names.map((name) => ({ name, code: 0 }))
    },
    killNodeMatching() {
      s.calls.push('killnode')
      return 0
    },
    startDsh(exe) {
      s.calls.push('start')
      s.procs = [{ pid: 4242, name: 'DeepSeek Harness' }]
    },
    startService(svc) {
      s.calls.push('svc:' + svc.name)
      s.open.add(Number(svc.port))
    },
    isAdmin: () => s.admin,
    taskExists: (name) => s.tasks.has(name),
    taskInfo: (name) => (s.tasks.has(name) ? { exists: true, enabled: s.tasks.get(name).enabled } : { exists: false, enabled: false }),
    runTask(name) {
      s.calls.push('run:' + name)
      return { ok: s.tasks.has(name), out: '' }
    },
    createTaskFromXml(name, file) {
      s.calls.push('create:' + name)
      s.tasks.set(name, { enabled: true, xml: readFileSync(file) })
      return { ok: true, out: '' }
    },
    deleteTask(name) {
      s.calls.push('delete:' + name)
      s.tasks.delete(name)
      return { ok: true, out: '' }
    },
    setTaskEnabled(name, enabled) {
      s.calls.push((enabled ? 'enable:' : 'disable:') + name)
      if (s.tasks.has(name)) s.tasks.get(name).enabled = enabled
      return { ok: true, out: '' }
    },
    currentUser: () => 'TESTPC\\tester',
    processPath: () => '',
  }
  return s
}

function makeEnv(sys, extra = {}) {
  const lines = []
  const log = (m) => lines.push(String(m))
  return { log, sys, dryRun: false, lines, confirm: async () => true, ...extra }
}

const take = () => received.splice(0, received.length)

async function makeCookies(file) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT)')
  const ins = db.prepare('INSERT INTO cookies VALUES (?, ?, ?)')
  ins.run('127.0.0.1', 'dsh-auth-1', 'x')
  ins.run('localhost', 'dsh-auth-2', 'x')
  ins.run('127.0.0.1', 'dsh-auth-3', 'x')
  ins.run('127.0.0.1', 'other', 'x')
  ins.run('example.com', 'dsh-auth-9', 'x')
  db.close()
}

const daysAgo = (d) => new Date(Date.now() - d * 86400000)

// ------------------------------------------------------------------ tests --
console.log('沙盒：' + ROOT + '\n')

await test('配置：占位符展开、// 说明键被忽略、内置保护路径、缺文件给出提示', async () => {
  const cfg = freshCfg({ '//': 'comment', backup: { jobs: { a: { dest: '${DATA_DIR}/bk', items: [] } } } })
  assert.equal(cfg.dshHome, HOME)
  assert.ok(cfg.dataDir.startsWith(ROOT))
  assert.equal(cfg.maintenance.flagFile, join(cfg.dataDir, 'maintenance.flag'))
  assert.equal(cfg.backup.jobs.a.dest, join(cfg.dataDir, 'bk'))
  assert.equal(cfg.nodePath, process.execPath)
  assert.ok(!('//' in cfg))
  assert.ok(cfg.trim.protect.some((p) => p.endsWith('/attachments') || p.endsWith('\\attachments')))
  assert.equal(cfg.tasks.length, 2)
  assert.throws(() => loadConfig(join(ROOT, 'nope.json')), /init/)
  assert.equal(loadConfig(join(ROOT, 'nope.json'), { allowMissing: true })._exists, false)
  assert.equal(fmt('a {x} b {y}', { x: 1 }), 'a 1 b ')
})

await test('维护模式：进入、生效、超过时限自动失效并删除标记', async () => {
  const cfg = freshCfg({ maintenance: { maxMinutes: 120 } })
  const env = makeEnv(fakeSys())
  assert.equal(maintenanceStatus(cfg).on, false)
  enterMaintenance(cfg, 'test')
  assert.equal(inMaintenance(cfg, env.log), true)
  const old = new Date(Date.now() - 121 * 60000)
  utimesSync(cfg.maintenance.flagFile, old, old)
  assert.equal(inMaintenance(cfg, env.log), false)
  assert.equal(existsSync(cfg.maintenance.flagFile), false)
})

await test('心跳：正常时不发通知、不重启', async () => {
  const cfg = freshCfg()
  const sys = fakeSys()
  sys.procs = [{ pid: 100, name: 'DeepSeek Harness' }]
  sys.listen = [{ port: 5000, pid: 100 }, { port: 80, pid: 100 }]
  sys.answering.add(5000)
  take()
  const r = await heartbeat(cfg, makeEnv(sys))
  assert.equal(r.result, 'alive')
  assert.equal(r.port, 5000)
  assert.ok(!sys.calls.includes('http:80'), '低于 minPort 的端口不探测')
  assert.equal(take().length, 0)
})

await test('心跳：进程没了 → 通知一次 + 触发重启任务；连续掉线不重复通知；恢复后发「回来了」', async () => {
  const cfg = freshCfg()
  const sys = fakeSys()
  sys.tasks.set('DSHKeepalive-Restart', { enabled: true })
  take()
  let r = await heartbeat(cfg, makeEnv(sys))
  assert.equal(r.result, 'down')
  assert.ok(sys.calls.includes('run:DSHKeepalive-Restart'))
  let msgs = take()
  assert.equal(msgs.length, 1)
  assert.match(msgs[0].url, /^\/send_private_msg\?access_token=test-token-xyz$/)
  assert.equal(msgs[0].body.user_id, 10001)
  assert.match(msgs[0].body.message[0].data.text, /掉了/)
  const req = JSON.parse(readFileSync(join(cfg.dataDir, 'state', 'restart-request.json'), 'utf8'))
  assert.equal(req.reason, 'down')

  r = await heartbeat(cfg, makeEnv(sys))
  assert.equal(r.result, 'down')
  assert.equal(take().length, 0, '第二次掉线不重复通知')

  sys.procs = [{ pid: 1, name: 'DeepSeek Harness' }]
  sys.listen = [{ port: 5001, pid: 1 }]
  sys.answering.add(5001)
  r = await heartbeat(cfg, makeEnv(sys))
  assert.equal(r.result, 'alive')
  msgs = take()
  assert.equal(msgs.length, 1)
  assert.match(msgs[0].body.message[0].data.text, /回来了/)
})

await test('心跳：进程在但端口不应答，连续 3 次才重启', async () => {
  const cfg = freshCfg()
  const sys = fakeSys()
  sys.tasks.set('DSHKeepalive-Restart', { enabled: true })
  sys.procs = [{ pid: 7, name: 'DeepSeek Harness' }]
  sys.listen = [{ port: 5002, pid: 7 }]
  take()
  assert.equal((await heartbeat(cfg, makeEnv(sys))).result, 'not-answering')
  assert.equal((await heartbeat(cfg, makeEnv(sys))).result, 'not-answering')
  assert.ok(!sys.calls.some((c) => c.startsWith('run:')))
  assert.equal((await heartbeat(cfg, makeEnv(sys))).result, 'hung')
  assert.ok(sys.calls.includes('run:DSHKeepalive-Restart'))
  const msgs = take()
  assert.equal(msgs.length, 1)
  assert.match(msgs[0].body.message[0].data.text, /卡住/)
})

await test('心跳：进程在但还没有端口（启动中）→ 宽限 6 次', async () => {
  const cfg = freshCfg()
  const sys = fakeSys()
  sys.procs = [{ pid: 8, name: 'DeepSeek Harness' }]
  for (let i = 1; i < 6; i++) assert.equal((await heartbeat(cfg, makeEnv(sys))).result, 'no-port')
  assert.equal((await heartbeat(cfg, makeEnv(sys))).result, 'hung')
  take()
})

await test('心跳：读不到进程列表时什么都不做；维护模式时直接跳过', async () => {
  const cfg = freshCfg()
  const sys = fakeSys()
  sys.psOk = false
  sys.tasks.set('DSHKeepalive-Restart', { enabled: true })
  assert.equal((await heartbeat(cfg, makeEnv(sys))).result, 'unknown')
  assert.ok(!sys.calls.some((c) => c.startsWith('run:')))
  enterMaintenance(cfg)
  sys.calls.length = 0
  assert.equal((await heartbeat(cfg, makeEnv(sys))).result, 'maintenance')
  assert.equal(sys.calls.length, 0)
  assert.equal(take().length, 0)
})

await test('心跳：DSH 里的插件报告「一轮卡住」→ 只通知一次；配置成 restart 时触发重启', async () => {
  const cfg = freshCfg()
  const sys = fakeSys()
  sys.procs = [{ pid: 9, name: 'DeepSeek Harness' }]
  sys.listen = [{ port: 5003, pid: 9 }]
  sys.answering.add(5003)
  sys.alivePids.add(9)
  mkdirSync(cfg.dataDir, { recursive: true })
  writeFileSync(
    join(cfg.dataDir, 'host-pulse.json'),
    JSON.stringify({ pid: 9, time: new Date().toISOString(), stuck: [{ session: 'abc', since: '2026-10-28T01:00:00Z', minutes: 50 }] }),
  )
  take()
  assert.equal((await heartbeat(cfg, makeEnv(sys))).result, 'stuck')
  let msgs = take()
  assert.equal(msgs.length, 1)
  assert.match(msgs[0].body.message[0].data.text, /abc.*50 分钟/)
  assert.equal((await heartbeat(cfg, makeEnv(sys))).result, 'alive')
  assert.equal(take().length, 0, '同一次卡住不重复通知')

  const cfg2 = freshCfg({ heartbeat: { stuckTurnAction: 'restart' } })
  sys.tasks.set('DSHKeepalive-Restart', { enabled: true })
  mkdirSync(cfg2.dataDir, { recursive: true })
  writeFileSync(join(cfg2.dataDir, 'host-pulse.json'), readFileSync(join(cfg.dataDir, 'host-pulse.json')))
  assert.equal((await heartbeat(cfg2, makeEnv(sys))).result, 'stuck-restart')
  assert.ok(sys.calls.includes('run:DSHKeepalive-Restart'))
  take()
})

await test('心跳：插件心跳文件里的端口会被一起探测', async () => {
  const cfg = freshCfg()
  const sys = fakeSys()
  sys.procs = [{ pid: 10, name: 'DeepSeek Harness' }]
  sys.alivePids.add(10)
  sys.answering.add(6000)
  mkdirSync(cfg.dataDir, { recursive: true })
  writeFileSync(join(cfg.dataDir, 'host-pulse.json'), JSON.stringify({ pid: 10, port: 6000, time: new Date().toISOString(), stuck: [] }))
  assert.equal((await heartbeat(cfg, makeEnv(sys))).result, 'alive')
})

await test('重启：完整流程（结束→清 cookie→启动→拉起 QQ 后端→自检→汇报文件→通知）', async () => {
  const scFile = join(ROOT, 'selfcheck.md')
  const cfg = freshCfg({
    services: [{ name: 'QQ 后端', port: 39999, command: process.execPath, args: [], when: ['restart'], startWaitSeconds: 3 }],
    restart: {
      selfcheck: {
        enabled: true,
        command: process.execPath,
        args: ['-e', "require('fs').writeFileSync(process.argv[process.argv.length-1], 'x\\n小结：全部正常\\n')", scFile],
        readFile: scFile,
        summaryPattern: '小结',
      },
    },
  })
  await makeCookies(cfg.dsh.cookieStore)
  const sys = fakeSys()
  sys.procs = [{ pid: 1, name: 'DeepSeek Harness' }]
  take()
  const r = await restart(cfg, makeEnv(sys), { reason: 'hung' })
  assert.equal(r.result, 'restarted')
  assert.deepEqual(sys.calls.filter((c) => ['kill', 'start', 'svc:QQ 后端'].includes(c)), ['kill', 'start', 'svc:QQ 后端'])
  const report = readFileSync(cfg.restart.reportFile, 'utf8')
  assert.match(report, /重启汇报/)
  assert.match(report, /页面不应答/)
  assert.match(report, /QQ 后端在/)
  assert.match(report, /小结：全部正常/)
  const msgs = take()
  assert.equal(msgs.length, 1)
  assert.match(msgs[0].body.message[0].data.text, /重启汇报/)
  const c = await countAuthCookies(cfg.dsh.cookieStore)
  assert.equal(c.count, 0, 'dsh-auth cookie 清掉了')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(cfg.dsh.cookieStore)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cookies').get().n, 2, '别的 cookie 没动')
  db.close()
  assert.ok(existsSync(join(cfg.cookies.backupDir, 'Cookies')), '清之前留了备份')
})

await test('重启：冷却时间内跳过；一小时超过次数就停手并只通知一次', async () => {
  const cfg = freshCfg()
  const sys = fakeSys()
  take()
  assert.equal((await restart(cfg, makeEnv(sys))).result, 'restarted')
  take()
  assert.equal((await restart(cfg, makeEnv(sys))).result, 'cooldown')

  const cfg2 = freshCfg()
  mkdirSync(join(cfg2.dataDir, 'state'), { recursive: true })
  const t = Date.now()
  writeFileSync(join(cfg2.dataDir, 'state', 'restart-history.json'), JSON.stringify({ times: [t - 50 * 60000, t - 40 * 60000, t - 30 * 60000, t - 20 * 60000] }))
  assert.equal((await restart(cfg2, makeEnv(sys))).result, 'gave-up')
  let msgs = take()
  assert.equal(msgs.length, 1)
  assert.match(msgs[0].body.message[0].data.text, /停手/)
  assert.equal((await restart(cfg2, makeEnv(sys))).result, 'gave-up')
  assert.equal(take().length, 0)
  assert.equal((await restart(cfg2, makeEnv(sys), { force: true })).result, 'restarted', '--force 不受限制')
  take()
})

await test('重启：维护模式时跳过；没配置 dsh.exe 时报失败并通知', async () => {
  const cfg = freshCfg()
  enterMaintenance(cfg)
  assert.equal((await restart(cfg, makeEnv(fakeSys()))).result, 'maintenance')
  const cfg2 = freshCfg({ dsh: { exe: join(ROOT, 'missing.exe') } })
  take()
  const r = await restart(cfg2, makeEnv(fakeSys()))
  assert.equal(r.result, 'failed')
  assert.match(take()[0].body.message[0].data.text, /没起来/)
})

await test('急救：退出维护模式、结束 DSH、交给重启任务', async () => {
  const cfg = freshCfg()
  enterMaintenance(cfg)
  const sys = fakeSys()
  sys.tasks.set('DSHKeepalive-Restart', { enabled: true })
  const r = await rescue(cfg, makeEnv(sys))
  assert.equal(r.result, 'task')
  assert.equal(existsSync(cfg.maintenance.flagFile), false)
  assert.ok(sys.calls.includes('kill'))
  assert.ok(sys.calls.includes('run:DSHKeepalive-Restart'))
  const note = JSON.parse(readFileSync(restartRequestFile(cfg), 'utf8'))
  assert.equal(note.force, true, '急救交给任务时要求跳过冷却和每小时上限')
  assert.equal(note.rescue, true)
})

await test('急救：交给任务的那次重启不受冷却 / 每小时上限限制（不会关了 DSH 又不重启）', async () => {
  const cfg = freshCfg({ dsh: { rescueKillNodePattern: 'deepseek' } })
  const sys = fakeSys()
  sys.tasks.set('DSHKeepalive-Restart', { enabled: true })
  mkdirSync(join(cfg.dataDir, 'state'), { recursive: true })
  const t = Date.now()
  writeFileSync(join(cfg.dataDir, 'state', 'restart-history.json'), JSON.stringify({ times: [t - 50 * 60000, t - 40 * 60000, t - 30 * 60000, t - 60000] }))
  take()
  assert.equal((await rescue(cfg, makeEnv(sys))).result, 'task')
  // the scheduled task now runs `restart` with no arguments, outside DSH
  const r = await restart(cfg, makeEnv(sys))
  assert.equal(r.result, 'restarted', '带着急救的「强制」标记，冷却中、已到上限也照样重启')
  assert.ok(sys.calls.filter((c) => c === 'killnode').length >= 1, '交给任务的急救也会顺手清残留 node 进程')
  take()
})

await test('在 DSH 里面运行 restart：交给计划任务，自己绝不结束 DSH', async () => {
  const cfg = freshCfg()
  const sys = fakeSys()
  sys.inside = true
  sys.tasks.set('DSHKeepalive-Restart', { enabled: true })
  const r = await restart(cfg, makeEnv(sys), { reason: 'manual' })
  assert.equal(r.result, 'handed-off')
  assert.ok(!sys.calls.includes('kill'), '不能自己结束 DSH')
  assert.ok(!sys.calls.includes('start'))
  assert.ok(sys.calls.includes('run:DSHKeepalive-Restart'))
  const note = JSON.parse(readFileSync(restartRequestFile(cfg), 'utf8'))
  assert.equal(note.reason, 'manual')
  assert.equal(note.force, false, '没加 --force 就照常受冷却和上限约束')
  assert.ok(!existsSync(join(cfg.dataDir, 'state', 'restart-history.json')), '交出去的这次不计入重启次数')
})

await test('在 DSH 里面运行 restart，但重启任务没装：什么都不做，返回拒绝', async () => {
  const cfg = freshCfg()
  const sys = fakeSys()
  sys.inside = true
  const r = await restart(cfg, makeEnv(sys))
  assert.equal(r.result, 'refused-inside-dsh')
  assert.ok(!sys.calls.includes('kill'))
  assert.ok(!sys.calls.includes('start'))
})

await test('在 DSH 里面运行 rescue：不自己动手，整个交给计划任务；任务带强制标记', async () => {
  const cfg = freshCfg()
  enterMaintenance(cfg)
  const sys = fakeSys()
  sys.inside = true
  sys.tasks.set('DSHKeepalive-Restart', { enabled: true })
  const r = await rescue(cfg, makeEnv(sys))
  assert.equal(r.result, 'task')
  assert.ok(!sys.calls.includes('kill'))
  assert.ok(!sys.calls.includes('killnode'))
  assert.equal(existsSync(cfg.maintenance.flagFile), false, '维护模式照样先退出')
  const note = JSON.parse(readFileSync(restartRequestFile(cfg), 'utf8'))
  assert.deepEqual([note.reason, note.force, note.rescue], ['rescue', true, true])
  const sys2 = fakeSys()
  sys2.inside = true
  assert.equal((await rescue(freshCfg(), makeEnv(sys2))).result, 'refused-inside-dsh', '没有任务可交就不动手')
  assert.ok(!sys2.calls.includes('kill'))
})

await test('读不到进程关系时按「在外面」处理（计划任务自己的重启不会被卡住）', async () => {
  const cfg = freshCfg()
  const sys = fakeSys()
  sys.inside = null
  assert.equal((await restart(cfg, makeEnv(sys))).result, 'restarted')
  take()
})

await test('进程树：认出上级里的 DSH；PID 被复用的「假父进程」不算；有环也不会死循环', async () => {
  const want = new Set(['deepseek harness'])
  const list = [
    { i: 10, p: 1, n: 'DeepSeek Harness.exe', c: 100 },
    { i: 20, p: 10, n: 'node.exe', c: 200 },
    { i: 30, p: 20, n: 'bash.exe', c: 300 },
    { i: 40, p: 30, n: 'node.exe', c: 400 },
  ]
  assert.deepEqual(findAncestor(list, 40, want), { inside: true, ancestor: { pid: 10, name: 'DeepSeek Harness.exe' } })
  const task = [
    { i: 5, p: 4, n: 'svchost.exe', c: 50 },
    { i: 6, p: 5, n: 'wscript.exe', c: 60 },
    { i: 7, p: 6, n: 'node.exe', c: 70 },
  ]
  assert.deepEqual(findAncestor(task, 7, want), { inside: false }, '计划任务启动的不算')
  const reused = [
    { i: 10, p: 1, n: 'DeepSeek Harness.exe', c: 900 }, // started AFTER the child: PID 10 was reused
    { i: 20, p: 10, n: 'node.exe', c: 200 },
  ]
  assert.deepEqual(findAncestor(reused, 20, want), { inside: false })
  const loop = [
    { i: 1, p: 2, n: 'a.exe', c: 0 },
    { i: 2, p: 1, n: 'b.exe', c: 0 },
  ]
  assert.deepEqual(findAncestor(loop, 1, want), { inside: false })
})

await test('插件配置守护：用最新的「健康」备份恢复，跳过语法坏的，坏文件先存一份', async () => {
  const dir = join(ROOT, 'patch')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'cordis.patch.yml')
  const good3 = '- insert:\n    - id: a\n      name: a\n    - id: b\n      name: b\n    - id: c\n      name: c\n'
  const good5 = good3 + '    - id: d\n      name: d\n    - id: e\n      name: e\n'
  writeFileSync(file, '# stub\n')
  writeFileSync(file + '.bak-old', good5)
  writeFileSync(file + '.bak-mid', good3)
  writeFileSync(file + '.bak-new', 'name: a\nname: b\nname: c\n  - bad: [\n')
  utimesSync(file + '.bak-old', daysAgo(3), daysAgo(3))
  utimesSync(file + '.bak-mid', daysAgo(2), daysAgo(2))
  utimesSync(file + '.bak-new', daysAgo(1), daysAgo(1))
  const cfg = freshCfg({ patchGuard: { enabled: true, file, minEntries: 3, yamlFrom: LIVE_PROFILE_PKG } })
  const env = makeEnv(fakeSys())
  const r = await patchGuard(cfg, env)
  const yamlAvailable = !env.lines.some((l) => l.includes('找不到 yaml'))
  assert.equal(r.result, 'restored')
  if (yamlAvailable) assert.equal(r.backup, 'cordis.patch.yml.bak-mid')
  assert.equal(countEntries(readFileSync(file, 'utf8')), yamlAvailable ? 3 : 3)
  assert.equal(readdirSync(join(cfg.dataDir, 'patch-guard')).length, 1)
  assert.equal((await patchGuard(cfg, env)).result, 'ok')
  writeFileSync(file, '# stub again\n')
  enterMaintenance(cfg)
  assert.equal((await patchGuard(cfg, env)).result, 'maintenance')
  assert.match(readFileSync(file, 'utf8'), /stub again/, '维护模式时不动文件')
  if (!yamlAvailable) console.log('    （没找到 yaml 模块，YAML 语法检查这一项没测）')
})

await test('插件配置守护：本机真实的 cordis.patch.yml 条目数（只读）', async () => {
  const live = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop', 'cordis.patch.yml')
  if (!existsSync(live)) return console.log('    （本机没有，跳过）')
  const nLive = countEntries(readFileSync(live, 'utf8'))
  console.log(`    本机现在 ${nLive} 项`)
  assert.ok(nLive >= 20, '本机配置的 minEntries=20 应该不会误报')
})

await test('备份：排除规则、跳过链接、通配符、改名、只删 8 位日期的旧文件夹、缺必需项算失败', async () => {
  const src = join(ROOT, 'bsrc')
  for (const d of ['node_modules', 'sub/node_modules', 'tmp', 'tmp-1', 'keep/tmp', '_隔离-1', 'scripts', 'mem']) mkdirSync(join(src, d), { recursive: true })
  for (const f of ['a.txt', 'node_modules/x.js', 'sub/node_modules/y.js', 'sub/s.txt', 'tmp/z.txt', 'tmp-1/q.txt', 'keep/tmp/k.txt', '_隔离-1/w.txt', 'scripts/a.sh', 'scripts/b.sh', 'scripts/c.txt', 'mem/m.md'])
    writeFileSync(join(src, f), f)
  mkdirSync(join(ROOT, 'elsewhere'), { recursive: true })
  writeFileSync(join(ROOT, 'elsewhere', 'big.bin'), 'x')
  symlinkSync(join(ROOT, 'elsewhere'), join(src, 'link'), 'junction')
  const dest = join(ROOT, 'bdest')
  mkdirSync(join(dest, '20200101'), { recursive: true })
  mkdirSync(join(dest, 'notadate'), { recursive: true })
  const cfg = freshCfg({
    backup: {
      jobs: {
        t: {
          dest,
          keepDays: 7,
          items: [
            { src, as: 'work', exclude: ['node_modules', '/_隔离-*', '/tmp', '/tmp-*'], required: true },
            { src: join(src, 'scripts', '*.sh'), into: 'scripts' },
            { src: join(src, 'mem'), as: 'auto-memory' },
            { src: join(ROOT, 'nope.txt') },
          ],
        },
        bad: { dest, items: [{ src: join(ROOT, 'nope-required'), required: true }] },
      },
    },
  })
  const env = makeEnv(fakeSys())
  const dry = await runBackup(cfg, { ...env, dryRun: true }, 't')
  assert.equal(existsSync(dry.out), false, '试运行不写文件')
  const r = await runBackup(cfg, env, 't')
  assert.equal(r.result, 'ok')
  const w = join(r.out, 'work')
  assert.ok(existsSync(join(w, 'a.txt')))
  assert.ok(existsSync(join(w, 'sub', 's.txt')))
  assert.ok(existsSync(join(w, 'keep', 'tmp', 'k.txt')), '/tmp 只排除最上层')
  for (const gone of ['node_modules', 'sub/node_modules', 'tmp', 'tmp-1', '_隔离-1', 'link']) assert.ok(!existsSync(join(w, gone)), gone + ' 应该被排除')
  assert.deepEqual(readdirSync(join(r.out, 'scripts')).sort(), ['a.sh', 'b.sh'])
  assert.ok(existsSync(join(r.out, 'auto-memory', 'm.md')))
  assert.equal(r.links, 1)
  assert.equal(r.missing, 1)
  assert.ok(!existsSync(join(dest, '20200101')), '旧备份删掉了')
  assert.ok(existsSync(join(dest, 'notadate')), '不是日期命名的不动')
  assert.equal((await runBackup(cfg, env, 'bad')).result, 'errors')
  assert.equal((await runBackup(cfg, env, 'nope')).result, 'missing')
  const ex = makeExcluder(['node_modules', '/tmp-*'])
  assert.ok(ex('a/node_modules', 'node_modules') && ex('tmp-x', 'tmp-x') && !ex('a/tmp-x', 'tmp-x'))
})

await test('清理：只删旧文件；附件库、包含受保护目录的文件夹、指向附件库的链接、磁盘根目录一律拒绝', async () => {
  const t = join(ROOT, 'trimme')
  mkdirSync(t, { recursive: true })
  writeFileSync(join(t, 'old.jpg'), 'x')
  writeFileSync(join(t, 'new.jpg'), 'x')
  utimesSync(join(t, 'old.jpg'), daysAgo(30), daysAgo(30))
  writeFileSync(join(HOME, 'attachments', 'pic.png'), 'x')
  utimesSync(join(HOME, 'attachments', 'pic.png'), daysAgo(99), daysAgo(99))
  symlinkSync(join(HOME, 'attachments'), join(ROOT, 'att-link'), 'junction')
  const cfg = freshCfg({
    trim: {
      jobs: [
        { name: '旧图', path: t, olderThanDays: 7 },
        { name: '附件', path: join(HOME, 'attachments'), olderThanDays: 1 },
        { name: '整个 DSH', path: HOME, olderThanDays: 1, recurse: true },
        { name: '链接', path: join(ROOT, 'att-link'), olderThanDays: 1 },
        { name: '根目录', path: 'C:\\', olderThanDays: 1 },
      ],
    },
  })
  const env = makeEnv(fakeSys())
  await runTrim(cfg, { ...env, dryRun: true })
  assert.ok(existsSync(join(t, 'old.jpg')), '试运行不删')
  const r = await runTrim(cfg, env)
  assert.ok(!existsSync(join(t, 'old.jpg')))
  assert.ok(existsSync(join(t, 'new.jpg')))
  assert.ok(existsSync(join(HOME, 'attachments', 'pic.png')), '附件一个都没删')
  for (const name of ['附件', '整个 DSH', '链接', '根目录']) assert.ok(env.lines.some((l) => l.includes(`清理「${name}」被拒绝`)), name + ' 应该被拒绝')
  assert.match(r.summary, /旧图 清了 1 个文件/)
})

await test('cookie：试运行只数不删', async () => {
  const cfg = freshCfg()
  await makeCookies(cfg.dsh.cookieStore)
  const r = await clearAuthCookies(cfg, { ...makeEnv(fakeSys()), dryRun: true })
  assert.match(r.message, /3 个/)
  assert.equal((await countAuthCookies(cfg.dsh.cookieStore)).count, 3)
})

await test('通知：webhook、command、缺收信人时只报错不抛异常', async () => {
  const out = join(ROOT, 'cmd-notify.txt')
  const cfg = freshCfg({
    notify: {
      channels: [
        { type: 'webhook', url: `http://127.0.0.1:${PORT}/hook`, bodyTemplate: { msg: '{{text}}', n: 1 } },
        { type: 'command', command: process.execPath, args: ['-e', "require('fs').copyFileSync(process.argv[1], process.argv[2])", '{{file}}', out] },
        { type: 'onebot', url: `http://127.0.0.1:${PORT}` },
      ],
    },
  })
  take()
  const env = makeEnv(fakeSys())
  const rs = await notify(cfg, '你好 test', env.log)
  assert.deepEqual(rs.map((r) => r.ok), [true, true, false])
  const msgs = take()
  assert.equal(msgs.length, 1)
  assert.deepEqual(msgs[0].body, { msg: '你好 test', n: 1 })
  assert.equal(readFileSync(out, 'utf8'), '你好 test')
  assert.ok(!env.lines.join('\n').includes('test-token-xyz'), '日志里没有令牌')
})

await test('计划任务：XML 内容（触发器、权限、命令行）和 UTF-16 编码', async () => {
  const cfg = freshCfg({
    tasks: [
      { id: 'tick', name: 'K-Tick', run: ['tick'], everyMinutes: 5, atLogon: true, logonDelaySeconds: 60 },
      { id: 'restart', name: 'K-Restart', run: ['restart'], onDemand: true, elevated: true },
      { id: 'bk', name: 'K-Backup', run: ['backup', 'f-drive'], dailyAt: '04:30' },
    ],
  })
  const user = 'XNQM的玩具\\admin'
  const [tick, rs, bk] = cfg.tasks.map((t) => buildTaskXml(cfg, t, { user }))
  assert.match(tick, /<LogonTrigger>\s*<Delay>PT60S<\/Delay>\s*<UserId>XNQM的玩具\\admin<\/UserId>/)
  assert.match(tick, /<Interval>PT5M<\/Interval>/)
  assert.ok(!/<Duration>/.test(tick), '重复不设截止（旧的 DSHBootCheck 30 天后就停了）')
  assert.match(tick, /<RunLevel>LeastPrivilege<\/RunLevel>/)
  assert.match(tick, /wscript\.exe<\/Command>/)
  assert.match(tick, /\/\/B \/\/Nologo &quot;.*run-hidden\.vbs&quot;/)
  assert.ok(tick.includes('&quot;--config&quot;') && tick.includes('&quot;tick&quot;'))
  assert.match(rs, /<Triggers \/>/)
  assert.match(rs, /HighestAvailable/)
  assert.match(bk, /<CalendarTrigger>\s*<StartBoundary>\d{4}-\d\d-\d\dT04:30:00<\/StartBoundary>/)
  assert.ok(bk.includes('&quot;backup&quot; &quot;f-drive&quot;'))
  for (const xml of [tick, rs, bk]) {
    const stack = []
    for (const m of xml.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
      if (m[3]) continue
      if (m[1]) assert.equal(stack.pop(), m[2], '标签配对')
      else stack.push(m[2])
    }
    assert.equal(stack.length, 0)
  }
  assert.throws(() => buildTaskXml(cfg, { id: 'x', dailyAt: '4点半' }, { user }), /04:30/)
  const f = join(ROOT, 'x.xml')
  writeTaskXml(f, tick)
  const b = readFileSync(f)
  assert.ok(b[0] === 0xff && b[1] === 0xfe, 'UTF-16 LE BOM')
  assert.ok(b.toString('utf16le').includes('XNQM的玩具'))
})

await test('安装/卸载：复制运行文件、建任务（非管理员跳过高权限任务）、生成小工具、不覆盖别人的文件、旧任务停用后能恢复', async () => {
  const sc = join(ROOT, '小工具')
  mkdirSync(sc, { recursive: true })
  writeFileSync(join(sc, 'DSH急救.cmd'), '@echo off\r\necho mine\r\n')
  const cfgDir = join(ROOT, '配置目录')
  mkdirSync(cfgDir, { recursive: true })
  const base = freshCfg({ shortcuts: { dir: sc }, legacy: { tasks: ['OldGuard'] } })
  const cfgFile = join(cfgDir, 'keepalive.config.json')
  writeFileSync(cfgFile, readFileSync(base._file))
  const cfg = loadConfig(cfgFile)
  const sys = fakeSys()
  sys.tasks.set('OldGuard', { enabled: true })

  const dry = await install(cfg, { ...makeEnv(sys), dryRun: true })
  assert.equal(dry.result, 'dry-run')
  assert.ok(!sys.calls.some((c) => c.startsWith('create:')), '试运行不建任务')

  const env = makeEnv(sys)
  const r = await install(cfg, env, { disableLegacy: true })
  assert.equal(r.result, 'partial')
  assert.deepEqual(r.done, ['DSHKeepalive-Tick'])
  assert.equal(r.failed[0].why, '需要管理员')
  assert.ok(existsSync(join(cfg.dataDir, 'runtime', 'bin', 'dsh-keepalive.mjs')))
  assert.ok(existsSync(join(cfg.dataDir, 'runtime', 'scripts', 'run-hidden.vbs')))
  assert.equal(sys.tasks.get('OldGuard').enabled, false)
  assert.equal(readFileSync(join(sc, 'DSH急救.cmd'), 'utf8'), '@echo off\r\necho mine\r\n', '别人的文件没被覆盖')
  const on = join(sc, '进入维护模式.cmd')
  assert.ok(readFileSync(on, 'latin1').includes(MARK))

  // the generated helper really works: run it with cmd.exe (config path has Chinese → file is GBK)
  const run = spawnSync('cmd.exe', ['/c', on], { input: Buffer.from('\r\n'), timeout: 60000, windowsHide: true })
  assert.equal(run.status, 0, 'cmd 退出码')
  assert.ok(existsSync(cfg.maintenance.flagFile), '双击「进入维护模式」后标记文件出现了')

  sys.admin = true
  const r2 = await install(cfg, makeEnv(sys), { yes: true })
  assert.equal(r2.result, 'ok')
  assert.ok(sys.tasks.has('DSHKeepalive-Restart'))

  const u = await uninstall(cfg, makeEnv(sys), { yes: true, purge: true })
  assert.equal(u.result, 'ok')
  assert.ok(!sys.tasks.has('DSHKeepalive-Tick') && !sys.tasks.has('DSHKeepalive-Restart'))
  assert.equal(sys.tasks.get('OldGuard').enabled, true, '旧任务恢复了')
  assert.ok(!existsSync(on))
  assert.ok(existsSync(join(sc, 'DSH急救.cmd')), '别人的文件卸载时也不删')
  assert.ok(!existsSync(join(cfg.dataDir, 'runtime')))
})

await test('安装：缺 DSH 主程序或配置文件时拒绝安装', async () => {
  const cfg = freshCfg({ dsh: { exe: join(ROOT, 'none.exe') } })
  const sys = fakeSys()
  assert.equal((await install(cfg, makeEnv(sys), { yes: true })).result, 'blocked')
  assert.equal(sys.calls.length, 0)
  const cfg2 = loadConfig(join(ROOT, 'no-config.json'), { allowMissing: true })
  assert.equal((await install(cfg2, makeEnv(sys), { yes: true })).result, 'blocked')
})

await test('装进 DSH（不跑 pnpm）：复制、建链接、改 package.json（保留换行风格）、可重复执行、能撤销', async () => {
  const profile = join(ROOT, 'profile')
  mkdirSync(profile, { recursive: true })
  const pj = join(profile, 'package.json')
  writeFileSync(pj, JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['x'] } }, dependencies: { x: '1.0.0' } }, null, 2).replace(/\n/g, '\r\n') + '\r\n')
  const cfg = freshCfg({ dsh: { profileDir: profile, pluginsDir: join(ROOT, 'plugins') }, backupDir: join(ROOT, 'link-backups') })
  const env = makeEnv(fakeSys())
  assert.equal((await linkIntoDsh(cfg, { ...env, dryRun: true })).result, 'dry-run')
  assert.ok(!existsSync(join(ROOT, 'plugins')))
  assert.equal((await linkIntoDsh(cfg, env, { yes: true })).result, 'ok')
  const after = JSON.parse(readFileSync(pj, 'utf8'))
  assert.equal(after.dependencies['dsh-keepalive'], 'link:' + join(ROOT, 'plugins', 'dsh-keepalive').replace(/\\/g, '/'))
  assert.deepEqual(after.dsh.profile.bundles, ['x', 'dsh-keepalive'])
  assert.ok(readFileSync(pj, 'utf8').includes('\r\n'))
  const link = join(profile, 'node_modules', 'dsh-keepalive')
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.ok(existsSync(join(link, 'lib', 'host.js')))
  assert.ok(existsSync(join(link, 'cordis.patch.yml')))
  assert.equal(readdirSync(join(ROOT, 'link-backups')).length, 1)
  assert.equal((await linkIntoDsh(cfg, env, { yes: true })).result, 'ok')
  assert.deepEqual(JSON.parse(readFileSync(pj, 'utf8')).dsh.profile.bundles, ['x', 'dsh-keepalive'], '重复执行不会加两遍')
  assert.equal((await unlinkFromDsh(cfg, env, { yes: true })).result, 'ok')
  const back = JSON.parse(readFileSync(pj, 'utf8'))
  assert.ok(!back.dependencies['dsh-keepalive'])
  assert.deepEqual(back.dsh.profile.bundles, ['x'])
  assert.ok(!existsSync(link))
  assert.ok(existsSync(join(ROOT, 'plugins', 'dsh-keepalive', 'lib', 'host.js')), '不加 --purge 时插件文件保留')
})

await test('DSH 里的宿主半边：加载、写心跳文件、状态接口、维护模式接口、卡住检测', async () => {
  const cfg = freshCfg({ host: { stuckTurnMinutes: 45 } })
  process.env.DSH_KEEPALIVE_CONFIG = cfg._file
  const host = await import('../lib/host.js')
  assert.equal(host.name, 'keepalive')
  assert.deepEqual(host.inject, ['webServer', 'timer'])
  const routes = new Map()
  const handlers = {}
  const intervals = []
  const logs = []
  const disposers = []
  const ctx = {
    logger: { info: (m) => logs.push(m) },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
    on(name, fn) {
      handlers[name] = fn
      return () => delete handlers[name]
    },
    interval(fn, ms) {
      intervals.push([fn, ms])
      return () => {}
    },
    webServer: {
      register(r) {
        routes.set(r.path, r.handler)
        return () => routes.delete(r.path)
      },
    },
  }
  host.apply(ctx)
  assert.ok(logs.some((l) => l.includes('已加载')))
  const pulse = JSON.parse(readFileSync(join(cfg.dataDir, 'host-pulse.json'), 'utf8'))
  assert.equal(pulse.pid, process.pid)
  assert.equal(intervals[0][1], 60000)
  for (const p of ['/dsh-keepalive/status', '/dsh-keepalive/maintenance', '/dsh-keepalive', '/dsh-keepalive/']) assert.ok(routes.has(p), p)

  const call = async (path, method = 'GET', body = '') => {
    const req = (async function* () {
      if (body) yield body
    })()
    req.method = method
    req.socket = { localPort: 12345 }
    let out = { code: 0, body: '' }
    const res = { writeHead: (c) => (out.code = c), end: (b) => (out.body = b) }
    await routes.get(path)(req, res)
    return out
  }
  const st = JSON.parse((await call('/dsh-keepalive/status')).body)
  assert.equal(st.ok, true)
  assert.equal(st.maintenance.on, false)
  await call('/dsh-keepalive/maintenance', 'POST', JSON.stringify({ on: true }))
  assert.ok(existsSync(cfg.maintenance.flagFile))
  await call('/dsh-keepalive/maintenance', 'POST', JSON.stringify({ on: false }))
  assert.ok(!existsSync(cfg.maintenance.flagFile))
  assert.match((await call('/dsh-keepalive/')).body, /DSH 保活守护/)
  intervals[0][0]()
  assert.equal(JSON.parse(readFileSync(join(cfg.dataDir, 'host-pulse.json'), 'utf8')).port, 12345, '记下了网页端口')
  handlers['session/event']({ id: 'session-s1' }, { type: 'user/message' })
  assert.equal(JSON.parse((await call('/dsh-keepalive/status')).body).ok, true)

  let now = 0
  const tr = host.createTurnTracker(() => now)
  tr.onEvent({ id: 'session-s1' }, { type: 'user/message' })
  now = 10 * 60000
  tr.onEvent({ id: 's1' }, { type: 'assistant/message' })
  now = 50 * 60000
  assert.equal(tr.stuck(45).length, 0, '最后一次动静在 40 分钟前，不算卡住')
  now = 56 * 60000
  assert.deepEqual(tr.stuck(45).map((s) => [s.session, s.minutes]), [['s1', 46]])
  tr.onEvent({ id: 's1' }, { type: 'turn/end' })
  assert.equal(tr.stuck(45).length, 0)
  tr.onEvent({ id: 's2' }, { type: 'tool/call' })
  assert.equal(tr.turns.size, 0, '没开始的轮次不跟踪')
  for (const d of disposers) d()
  delete process.env.DSH_KEEPALIVE_CONFIG
})

await test('打包内容：.cmd / .vbs 是纯 ASCII；包里没有令牌、QQ 号之类的东西', async () => {
  for (const f of ['安装守护.cmd', '卸载守护.cmd', 'scripts/run-hidden.vbs']) {
    const b = readFileSync(join(PACKAGE_ROOT, f))
    assert.ok(b.every((x) => x < 0x80), f + ' 应该是纯 ASCII')
  }
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const walk = (p) => (lstatSync(p).isDirectory() ? readdirSync(p).flatMap((x) => walk(join(p, x))) : [p])
  const files = pkg.files.flatMap((f) => (existsSync(join(PACKAGE_ROOT, f)) ? walk(join(PACKAGE_ROOT, f)) : []))
  // QQ-number-like digits, tokens in URLs, Bilibili cookie names
  const forbidden = [/\b\d{9,11}\b(?![-\d])/, /access_token=[A-Za-z0-9_-]{20,}/, /SESS[D]ATA/i, /bili_[j]ct/i]
  // and this machine's real QQ-bridge token, if there is one (read here, never stored)
  const bridge = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge-config.json')
  let realToken = ''
  try {
    realToken = String(JSON.parse(readFileSync(bridge, 'utf8').replace(/^﻿/, ''))['令牌'] || '')
  } catch {}
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    if (realToken.length >= 8) assert.ok(!text.includes(realToken), `${f} 里有本机的 QQ 令牌`)
    if (f.includes(join('test', 'run-tests.mjs'))) continue
    for (const re of forbidden) assert.ok(!re.test(text), `${f} 里有可疑内容 ${re}`)
  }
})

// ------------------------------------------------------------------ done ---
server.close()
const ok = results.filter(Boolean).length
console.log(`\n${ok}/${results.length} 项通过`)
if (ok === results.length) rmSync(ROOT, { recursive: true, force: true })
else console.log('失败时保留沙盒，方便查看：' + ROOT)
process.exitCode = ok === results.length ? 0 : 1
