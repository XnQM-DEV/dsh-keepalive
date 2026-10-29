// Backups. Each job copies a list of items into <dest>/<YYYYMMDD>/ and keeps
// the last keepDays dated folders. Only children named with exactly 8 digits
// are ever deleted, so the backup root itself can never be removed.
//
// Job:  { dest, keepDays, dated: true, notifyOnError: false, items: [...] }
// Item: { src, into?, as?, exclude?: [...], required?: false }
//   src      a file, a folder, or a folder/*.ext pattern
//   into     sub-folder (inside the dated folder) to put it in
//   as       new name for a folder or file
//   exclude  "node_modules" matches that name anywhere; "/tmp" or "/tmp-*"
//            only at the top of this item; "*" is the only wildcard
// Symbolic links and junctions inside folders are skipped (never followed).

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { message } from './messages.mjs'
import { notify } from './notify.mjs'
import { dayStamp, formatMB } from './util.mjs'
import { logFile } from './config.mjs'

function globToRegex(glob) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + esc + '$', 'i')
}

export function makeExcluder(patterns = []) {
  const anywhere = []
  const anchored = []
  for (const raw of patterns) {
    const p = String(raw).replace(/\\/g, '/').replace(/^\.\//, '/')
    if (p.startsWith('/')) anchored.push(globToRegex(p.slice(1)))
    else anywhere.push(globToRegex(p))
  }
  return (relPath, name) => anywhere.some((r) => r.test(name)) || anchored.some((r) => r.test(relPath))
}

function copyTree(src, dst, excluded, stats, log, dryRun, rel = '') {
  let entries
  try {
    entries = readdirSync(src, { withFileTypes: true })
  } catch (error) {
    stats.errors++
    log(`读不了文件夹 ${src}：${error.message}`)
    return
  }
  if (!dryRun) mkdirSync(dst, { recursive: true })
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    const from = join(src, e.name)
    if (e.isSymbolicLink()) {
      stats.links++
      continue
    }
    if (excluded(r, e.name)) {
      stats.skipped++
      continue
    }
    if (e.isDirectory()) {
      copyTree(from, join(dst, e.name), excluded, stats, log, dryRun, r)
    } else if (e.isFile()) {
      try {
        const size = statSync(from).size
        if (!dryRun) copyFileSync(from, join(dst, e.name))
        stats.files++
        stats.bytes += size
      } catch (error) {
        stats.errors++
        log(`复制失败 ${from}：${error.message}`)
      }
    }
  }
}

function expandItem(src) {
  const name = basename(src)
  if (!name.includes('*')) return [src]
  const dir = dirname(src)
  const re = globToRegex(name)
  try {
    return readdirSync(dir)
      .filter((n) => re.test(n))
      .map((n) => join(dir, n))
      .filter((p) => {
        try {
          return lstatSync(p).isFile()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

export function cleanupOld(dest, keepDays, log, dryRun, today = new Date()) {
  if (!keepDays || keepDays <= 0 || !existsSync(dest)) return []
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - keepDays)
  const removed = []
  for (const n of readdirSync(dest)) {
    if (!/^\d{8}$/.test(n)) continue
    const d = new Date(Number(n.slice(0, 4)), Number(n.slice(4, 6)) - 1, Number(n.slice(6, 8)))
    if (isNaN(d.getTime()) || d >= cutoff) continue
    const full = join(dest, n)
    try {
      if (!lstatSync(full).isDirectory()) continue
      if (!dryRun) rmSync(full, { recursive: true, force: true })
      removed.push(n)
    } catch (error) {
      log(`删旧备份 ${n} 失败：${error.message}`)
    }
  }
  if (removed.length) log(`${dryRun ? '[试运行] 会' : '已'}删掉 ${keepDays} 天前的旧备份：${removed.join(', ')}`)
  return removed
}

export async function runBackup(cfg, env, jobName) {
  const { log, dryRun } = env
  const job = cfg.backup && cfg.backup.jobs ? cfg.backup.jobs[jobName] : null
  if (!job) {
    log(`没有叫「${jobName}」的备份任务（backup.jobs 里有：${Object.keys((cfg.backup && cfg.backup.jobs) || {}).join('、') || '无'}）`)
    return { result: 'missing', errors: 1 }
  }
  if (!job.dest) {
    log(`备份「${jobName}」没写 dest`)
    return { result: 'bad-config', errors: 1 }
  }
  const out = job.dated === false ? job.dest : join(job.dest, dayStamp())
  const stats = { files: 0, bytes: 0, links: 0, skipped: 0, errors: 0, missing: 0 }
  log(`${dryRun ? '[试运行] ' : ''}开始备份「${jobName}」→ ${out}`)

  for (const item of job.items || []) {
    const sources = expandItem(item.src)
    if (!sources.length || (sources.length === 1 && !existsSync(sources[0]))) {
      if (item.required) {
        stats.errors++
        log(`找不到（必需）：${item.src}`)
      } else {
        stats.missing++
      }
      continue
    }
    const targetDir = item.into ? join(out, item.into) : out
    for (const src of sources) {
      let real = src
      try {
        real = realpathSync(src)
      } catch {}
      let st
      try {
        st = statSync(real)
      } catch (error) {
        stats.errors++
        log(`读不了 ${src}：${error.message}`)
        continue
      }
      const name = item.as && sources.length === 1 ? item.as : basename(src)
      if (st.isDirectory()) {
        copyTree(real, join(targetDir, name), makeExcluder(item.exclude || []), stats, log, dryRun)
      } else {
        try {
          if (!dryRun) {
            mkdirSync(targetDir, { recursive: true })
            copyFileSync(real, join(targetDir, name))
          }
          stats.files++
          stats.bytes += st.size
        } catch (error) {
          stats.errors++
          log(`复制失败 ${src}：${error.message}`)
        }
      }
    }
  }

  if (job.dated !== false) cleanupOld(job.dest, Number(job.keepDays) || 0, log, dryRun)
  log(
    `${dryRun ? '[试运行] ' : ''}备份「${jobName}」完成：${stats.files} 个文件，${formatMB(stats.bytes)}，` +
      `跳过链接 ${stats.links} 个、排除 ${stats.skipped} 项、缺失 ${stats.missing} 项，失败 ${stats.errors} 处`,
  )
  if (stats.errors && job.notifyOnError) {
    await notify(cfg, message(cfg, 'backupFailed', { job: jobName, errors: stats.errors, log: logFile(cfg) }), log, { dryRun })
  }
  return { result: stats.errors ? 'errors' : 'ok', out, ...stats }
}
