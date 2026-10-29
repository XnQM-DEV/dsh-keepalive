// Notification channels.
//   onebot  – QQ through a OneBot v11 HTTP API (NapCat, SnowLuma, LLOneBot ...)
//   webhook – POST a JSON body to any URL (Bark, ServerChan, a home server ...)
//   command – run a program; {{text}} / {{file}} in its args are replaced
//
// Secrets: the onebot channel can read url / token / QQ number from another
// JSON file at send time ("fromFile"), so they never have to be copied into
// this plugin's config, and they are never written to the log.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, readJson, removeFile, runSync } from './util.mjs'

export function resolveOnebot(ch) {
  const ff = ch.fromFile || {}
  const src = ff.path ? readJson(ff.path, {}) || {} : {}
  const get = (key, fieldKey) => {
    const v = ch[key]
    if (v !== undefined && v !== null && String(v) !== '') return String(v)
    const field = ff[fieldKey]
    return field && src[field] !== undefined && src[field] !== null ? String(src[field]) : ''
  }
  return {
    url: get('url', 'urlField').replace(/\/+$/, ''),
    token: get('token', 'tokenField'),
    userId: get('userId', 'userIdField'),
    groupId: get('groupId', 'groupIdField'),
  }
}

const asId = (v) => (/^\d+$/.test(v) ? Number(v) : v)

async function postJson(url, body, headers = {}, timeoutMs = 10000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, ok: res.ok, json }
}

async function sendOnebot(ch, text) {
  const o = resolveOnebot(ch)
  if (!o.url) throw new Error('没有 OneBot 地址（url）')
  const targets = []
  if (o.userId) targets.push(['send_private_msg', 'user_id', o.userId, '私聊'])
  if (o.groupId) targets.push(['send_group_msg', 'group_id', o.groupId, '群'])
  if (!targets.length) throw new Error('没有收信人（userId / groupId 都是空的）')
  const out = []
  for (const [action, idKey, id, label] of targets) {
    let url = `${o.url}/${action}`
    const headers = {}
    if (o.token) {
      if (ch.tokenIn === 'header') headers.authorization = 'Bearer ' + o.token
      else url += '?access_token=' + encodeURIComponent(o.token)
    }
    const r = await postJson(url, { [idKey]: asId(id), message: [{ type: 'text', data: { text } }] }, headers)
    const j = r.json || {}
    const good = r.ok && (j.status === undefined || j.status === 'ok' || j.retcode === 0)
    if (!good) throw new Error(`${label}发送失败（HTTP ${r.status}${j.message ? '，' + j.message : ''}）`)
    out.push(label)
  }
  return 'onebot→' + out.join('+')
}

function fillTemplate(value, text) {
  if (typeof value === 'string') return value.split('{{text}}').join(text)
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, text))
  if (value && typeof value === 'object') {
    const o = {}
    for (const [k, v] of Object.entries(value)) o[k] = fillTemplate(v, text)
    return o
  }
  return value
}

async function sendWebhook(ch, text) {
  if (!ch.url) throw new Error('没有 webhook 地址（url）')
  const body = fillTemplate(ch.bodyTemplate || { text: '{{text}}' }, text)
  const r = await postJson(ch.url, body, ch.headers || {})
  if (!r.ok) throw new Error(`webhook 返回 HTTP ${r.status}`)
  return 'webhook'
}

function sendCommand(ch, text, tmpDir) {
  if (!ch.command) throw new Error('没有 command')
  ensureDir(tmpDir)
  const file = join(tmpDir, `notify-${process.pid}-${Date.now()}.txt`)
  writeFileSync(file, text, 'utf8')
  try {
    const args = (ch.args || []).map((a) => String(a).split('{{file}}').join(file).split('{{text}}').join(text))
    const r = runSync(ch.command, args, { timeoutMs: (Number(ch.timeoutSeconds) || 30) * 1000 })
    if (r.code !== 0) throw new Error(`命令退出码 ${r.code}${r.error ? '（' + r.error + '）' : ''}`)
    return 'command'
  } finally {
    removeFile(file)
  }
}

/**
 * Send `text` on every enabled channel. Never throws; returns per-channel
 * results. With dryRun, only logs what would be sent.
 */
export async function notify(cfg, text, log, { dryRun = false } = {}) {
  const channels = (cfg.notify && cfg.notify.channels) || []
  const enabled = channels.filter((c) => c && c.enabled !== false)
  if (!enabled.length) {
    log('没有配置通知通道，消息只写进日志：' + text.replace(/\s+/g, ' '))
    return []
  }
  const results = []
  for (const ch of enabled) {
    if (dryRun) {
      log(`[试运行] 会通过 ${ch.type} 发送：${text.replace(/\s+/g, ' ')}`)
      results.push({ type: ch.type, ok: true, dryRun: true })
      continue
    }
    try {
      let how
      if (ch.type === 'onebot') how = await sendOnebot(ch, text)
      else if (ch.type === 'webhook') how = await sendWebhook(ch, text)
      else if (ch.type === 'command') how = sendCommand(ch, text, join(cfg.dataDir, 'tmp'))
      else throw new Error('不认识的通道类型：' + ch.type)
      log(`通知已发送（${how}）`)
      results.push({ type: ch.type, ok: true })
    } catch (error) {
      log(`通知发送失败（${ch.type}）：${String((error && error.message) || error)}`)
      results.push({ type: ch.type, ok: false, error: String((error && error.message) || error) })
    }
  }
  return results
}
