// DSH 保活守护 · 宿主半边（跑在 DSH 里面）
//
// 这一半很轻，只做三件事，任何一步出错都只记日志、绝不把 DSH 带崩：
//   1. 每分钟写一次 <dataDir>/host-pulse.json：DSH 的 pid、插件版本、知道的话还有网页端口。
//   2. 盯着会话事件：一轮对话开始（user/message）之后，如果很久（host.stuckTurnMinutes，
//      默认 45 分钟）没有任何新事件、也没等到 turn/end，就把它写进心跳文件的 stuck 列表。
//      外面的看门狗读到后发通知（配置成 restart 时才会重启）。
//      ——这是为了 2026-10-28 那种情况：一个工具调用卡死，整轮停住，网页照样能打开，
//      端口检查发现不了，后面所有定时唤醒都排在它后面，8 个小时没人知道。
//   3. 提供状态接口：GET /dsh-keepalive/status，POST /dsh-keepalive/maintenance {"on": true|false}，
//      以及一个很简单的状态页 /dsh-keepalive/。
//
// 真正的看门狗（重启、备份、清理）**不在这里**：插件跑在 DSH 里，DSH 一挂它也跟着挂，
// 所以那部分是外面的 Windows 计划任务（见 README 和 lib/tasks.mjs）。
//
// ⚠ 不声明 `export const Config`：装在 profile 的 node_modules 里时拿不到 schemastery，
//   import 失败会让整个插件加载不了。配置一律读 keepalive.config.json（和 CLI 共用）。
// ⚠ 只用 Node 自带模块，没有任何依赖（尤其不碰 sharp：插件自带的 sharp 会让 DSH 自己的
//   sharp 加载失败，之后每次发图都报 "DeepSeek Messages transport failed"）。

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfigPath, loadConfig, stateDir } from './config.mjs'
import { enterMaintenance, exitMaintenance, maintenanceStatus } from './maintenance.mjs'
import { readJson } from './util.mjs'

export const name = 'keepalive'
export const inject = ['webServer', 'timer']

const PREFIX = '/dsh-keepalive'
const HERE = dirname(fileURLToPath(import.meta.url))
const VERSION = (readJson(join(HERE, '..', 'package.json'), {}) || {}).version || '?'

const sessionKey = (v) => {
  const s = String(v == null ? '' : v).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

/**
 * Turn tracker, kept separate from DSH so it can be tested with a fake clock.
 * user/message opens a turn, turn/end closes it, any other event in that
 * session counts as activity.
 */
export function createTurnTracker(now = () => Date.now()) {
  const turns = new Map()
  return {
    turns,
    onEvent(session, event) {
      const id = sessionKey(session && session.id)
      if (!id || !event || !event.type) return
      const t = now()
      if (event.type === 'user/message') {
        const cur = turns.get(id)
        turns.set(id, { since: cur ? cur.since : t, last: t })
      } else if (event.type === 'turn/end') {
        turns.delete(id)
      } else {
        const cur = turns.get(id)
        if (cur) cur.last = t
      }
    },
    drop(id) {
      turns.delete(sessionKey(id))
    },
    stuck(limitMinutes) {
      const t = now()
      const limit = (Number(limitMinutes) || 45) * 60000
      const out = []
      for (const [id, x] of turns) {
        if (t - x.last > limit) out.push({ session: id, since: new Date(x.since).toISOString(), minutes: Math.round((t - x.last) / 60000) })
      }
      return out
    },
  }
}

const STATUS_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 保活守护</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--mute:#6e6e73;--line:#e5e5ea;--accent:#0a66c2}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#f2f2f7;--mute:#a1a1a6;--line:#38383a;--accent:#4ea1ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 16px}
dl{display:grid;grid-template-columns:8em 1fr;gap:6px 12px;margin:0 0 20px}
dt{color:var(--mute)}dd{margin:0;word-break:break-all}
button{font:inherit;padding:6px 14px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);cursor:pointer;margin-right:8px}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
p.note{color:var(--mute);font-size:13px}
</style></head><body><main>
<h1>DSH 保活守护</h1>
<dl id="info"><dt>状态</dt><dd>读取中…</dd></dl>
<button class="primary" id="on">进入维护模式</button><button id="off">退出维护模式</button>
<p class="note">维护模式里，看门狗不会重启 DSH，也不会改插件配置；到时间会自动失效。</p>
<script>
const $=(s)=>document.querySelector(s)
function row(k,v){return '<dt>'+k+'</dt><dd>'+String(v).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</dd>'}
async function load(){try{const s=await (await fetch('${PREFIX}/status')).json()
const m=s.maintenance||{}
$('#info').innerHTML=row('插件版本',s.version)+row('维护模式',m.on?('开着，还剩 '+m.leftMinutes+' 分钟'):'关着')
+row('外面的看门狗',s.installed?('已安装（'+(s.installed.tasks||[]).join('、')+'）'):'还没安装')
+row('上次心跳',s.heartbeat?(s.heartbeat.last+' '+(s.heartbeat.lastAliveAt||'')):'没有记录')
+row('进行中的对话',s.pulse?s.pulse.openTurns:0)+row('很久没动静的',s.pulse&&s.pulse.stuck.length?s.pulse.stuck.map(x=>x.session+'（'+x.minutes+' 分钟）').join('，'):'没有')
+row('配置文件',s.config)}catch(e){$('#info').innerHTML=row('状态','读取失败：'+e.message)}}
async function set(on){await fetch('${PREFIX}/maintenance',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({on})});load()}
$('#on').onclick=()=>set(true);$('#off').onclick=()=>set(false);load();setInterval(load,30000)
</script></main></body></html>`

export function apply(ctx) {
  const say = (m) => {
    try {
      ctx.logger.info('keepalive: ' + m)
    } catch {}
  }

  let cfg
  try {
    cfg = loadConfig(defaultConfigPath(), { allowMissing: true })
  } catch (error) {
    say('配置文件有问题，先用默认值：' + String((error && error.message) || error).split('\n')[0])
    cfg = loadConfig(join(HERE, '__no-config__.json'), { allowMissing: true })
  }

  const tracker = createTurnTracker()
  const startedAt = new Date().toISOString()
  let port = null
  let pulseError = ''

  const writePulse = () => {
    try {
      const data = {
        pid: process.pid,
        time: new Date().toISOString(),
        version: VERSION,
        startedAt,
        port,
        openTurns: tracker.turns.size,
        stuck: tracker.stuck(cfg.host.stuckTurnMinutes),
      }
      mkdirSync(cfg.dataDir, { recursive: true })
      const file = join(cfg.dataDir, 'host-pulse.json')
      writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), 'utf8')
      renameSync(file + '.tmp', file)
      pulseError = ''
    } catch (error) {
      const msg = String((error && error.message) || error)
      if (msg !== pulseError) say('写心跳文件失败：' + msg)
      pulseError = msg
    }
  }

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        tracker.onEvent(session, event)
      } catch {}
    })
    return () => {
      try {
        if (typeof off === 'function') off()
      } catch {}
    }
  }, 'keepalive: 盯住每一轮对话')

  ctx.effect(() => {
    const off = ctx.on('agent/error', (payload) => {
      try {
        if (payload && payload.agent) tracker.drop(payload.agent.id)
      } catch {}
    })
    return () => {
      try {
        if (typeof off === 'function') off()
      } catch {}
    }
  }, 'keepalive: 出错的那轮不算卡住')

  ctx.effect(() => {
    writePulse()
    const ms = Math.max(15, Number(cfg.host.pulseSeconds) || 60) * 1000
    if (typeof ctx.interval === 'function') return ctx.interval(writePulse, ms)
    const h = setInterval(writePulse, ms)
    return () => clearInterval(h)
  }, 'keepalive: 定时写心跳文件')

  const json = (res, obj, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  const readBody = async (req) => {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      return JSON.parse(body || '{}')
    } catch {
      return {}
    }
  }
  const status = () => ({
    ok: true,
    version: VERSION,
    config: cfg._exists ? cfg._file : '（还没有配置文件，正在用默认值）',
    maintenance: maintenanceStatus(cfg),
    installed: readJson(join(cfg.dataDir, 'installed.json'), null),
    heartbeat: readJson(join(stateDir(cfg), 'heartbeat.json'), null),
    pulse: readJson(join(cfg.dataDir, 'host-pulse.json'), null),
  })
  const route = (path, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            if (!port && req.socket && req.socket.localPort) port = req.socket.localPort
            await handler(req, res)
          } catch (error) {
            json(res, { ok: false, error: String((error && error.message) || error) }, 500)
          }
        },
      }),
    )

  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    route(PREFIX + '/status', async (req, res) => json(res, status()))
    route(PREFIX + '/maintenance', async (req, res) => {
      if (req.method !== 'POST') return json(res, status())
      const body = await readBody(req)
      if (body.on) enterMaintenance(cfg, String(body.note || 'from DSH'))
      else exitMaintenance(cfg)
      say(body.on ? '进入维护模式' : '退出维护模式')
      json(res, status())
    })
    const page = async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(STATUS_PAGE)
    }
    route(PREFIX, page)
    route(PREFIX + '/', page)
  }

  const installed = readJson(join(cfg.dataDir, 'installed.json'), null)
  say(
    `v${VERSION} 已加载；配置 ${cfg._exists ? cfg._file : '（还没有，正在用默认值）'}；` +
      `外面的看门狗${installed ? '已安装' : '还没安装（运行 dsh-keepalive install）'}`,
  )
}
