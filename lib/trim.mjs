// Disk clean-up: delete old files from folders that only hold things that can
// be re-created (video frames, temp files ...). Identity and configuration are
// never touched:
//   * a job whose folder is, contains, or sits inside a protected path is refused
//   * every file is checked again (after resolving links) before it is deleted
//   * only files directly in the folder by default (recurse: true to go deeper)
//   * symbolic links / junctions are never followed or deleted
// Built-in protected paths include <DSH_HOME>\attachments: DSH re-reads every
// image in a conversation's history on each turn, and a missing one makes
// every later turn fail with "DeepSeek Messages transport failed".
//
// Job: { path, olderThanDays, pattern: "*", recurse: false }

import { existsSync, lstatSync, readdirSync, realpathSync, statfsSync, unlinkSync } from 'node:fs'
import { join, parse } from 'node:path'
import { message } from './messages.mjs'
import { notify } from './notify.mjs'
import { formatMB, isInside } from './util.mjs'

function realOr(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function globToRegex(glob) {
  const esc = String(glob || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + esc + '$', 'i')
}

/** Both the configured path and its real target (for junctions) are protected. */
export function protectedRoots(cfg) {
  const out = []
  for (const p of cfg.trim.protect || []) {
    if (!p) continue
    out.push(p)
    const r = realOr(p)
    if (r.toLowerCase() !== String(p).toLowerCase()) out.push(r)
  }
  return out
}

export function whyRefused(folder, roots) {
  const real = realOr(folder)
  const { root } = parse(real)
  if (real.replace(/[\\/]+$/, '').toLowerCase() === root.replace(/[\\/]+$/, '').toLowerCase()) return '是整个磁盘的根目录'
  for (const r of roots) {
    if (isInside(real, r) || isInside(folder, r)) return `在受保护的 ${r} 里面`
    if (isInside(r, real) || isInside(r, folder)) return `包含受保护的 ${r}`
  }
  return ''
}

function collect(dir, re, cutoff, recurse, roots, list, stats) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      if (recurse) collect(full, re, cutoff, recurse, roots, list, stats)
      continue
    }
    if (!e.isFile() || !re.test(e.name)) continue
    try {
      const st = lstatSync(full)
      if (st.mtimeMs >= cutoff) continue
      const real = realOr(full)
      if (roots.some((r) => isInside(real, r))) {
        stats.protectedHits++
        continue
      }
      list.push({ full, size: st.size })
    } catch {}
  }
}

export async function runTrim(cfg, env) {
  const { log, dryRun } = env
  const roots = protectedRoots(cfg)
  const parts = []
  let total = 0
  for (const job of cfg.trim.jobs || []) {
    if (!job || job.enabled === false || !job.path) continue
    const label = job.name || job.path
    if (!existsSync(job.path)) {
      log(`清理「${label}」：文件夹不存在，跳过`)
      continue
    }
    const why = whyRefused(job.path, roots)
    if (why) {
      log(`清理「${label}」被拒绝：${why}`)
      parts.push(`${label} 拒绝清理`)
      continue
    }
    const days = Number(job.olderThanDays) || 14
    const cutoff = Date.now() - days * 86400000
    const list = []
    const stats = { protectedHits: 0 }
    collect(job.path, globToRegex(job.pattern), cutoff, !!job.recurse, roots, list, stats)
    let freed = 0
    let failed = 0
    for (const f of list) {
      if (dryRun) {
        freed += f.size
        continue
      }
      try {
        unlinkSync(f.full)
        freed += f.size
      } catch {
        failed++
      }
    }
    total += freed
    const msg = `${label}${dryRun ? ' 会清' : ' 清了'} ${list.length - failed} 个文件 ${formatMB(freed)}${failed ? `（${failed} 个删不掉，可能正被占用）` : ''}`
    log(msg)
    parts.push(msg)
  }
  const drives = new Set((cfg.trim.reportFreeOn || ['C:']).map((d) => String(d).slice(0, 2).toUpperCase()))
  for (const d of drives) {
    try {
      const s = statfsSync(d + '\\')
      parts.push(`${d} 盘现在剩 ${Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10} GB`)
    } catch {}
  }
  const summary = parts.join('；') || '没有配置清理项'
  log(summary)
  if (cfg.trim.notify && !dryRun) await notify(cfg, message(cfg, 'trimDone', { summary }), log)
  return { result: 'ok', freed: total, summary }
}
