// Patch guard: when DSH resets the profile's cordis.patch.yml to a stub (all
// plugin mounts gone), put back the NEWEST healthy backup that sits next to it
// (cordis.patch.yml.bak-*, .pre-* ...). "Healthy" = at least minEntries
// `name:` entries and, when possible, valid YAML whose top level is a list.
// The newest healthy one is used, not the biggest: an old big backup can still
// list plugins that were removed on purpose.
// Before restoring, the broken file is copied to <dataDir>/patch-guard/.

import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { inMaintenance } from './maintenance.mjs'
import { message } from './messages.mjs'
import { notify } from './notify.mjs'
import { ensureDir, fileStamp } from './util.mjs'

export function countEntries(text) {
  const m = String(text).match(/^[ \t]*(?:-[ \t]+)?name[ \t]*:/gm)
  return m ? m.length : 0
}

let yamlCache
function loadYaml(cfg, log) {
  if (yamlCache !== undefined) return yamlCache
  yamlCache = null
  try {
    const req = createRequire(cfg.patchGuard.yamlFrom)
    yamlCache = req('yaml')
  } catch (error) {
    log(`找不到 yaml 模块（${cfg.patchGuard.yamlFrom}），只按条目数判断`)
  }
  return yamlCache
}

export function checkPatchFile(file, cfg, log) {
  if (!existsSync(file)) return { ok: false, entries: 0, why: '文件不存在' }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, entries: 0, why: '读不了：' + error.message }
  }
  const entries = countEntries(text)
  const min = Number(cfg.patchGuard.minEntries) || 1
  if (entries < min) return { ok: false, entries, why: `只有 ${entries} 项（少于 ${min}）` }
  if (cfg.patchGuard.validateYaml !== false) {
    const yaml = loadYaml(cfg, log)
    if (yaml) {
      try {
        const doc = yaml.parse(text)
        if (!Array.isArray(doc)) return { ok: false, entries, why: '顶层不是列表' }
      } catch (error) {
        return { ok: false, entries, why: 'YAML 语法错误：' + String(error.message).split('\n')[0] }
      }
    }
  }
  return { ok: true, entries }
}

export async function patchGuard(cfg, env) {
  const { log, dryRun } = env
  const pg = cfg.patchGuard
  if (!pg.enabled) return { result: 'disabled' }
  if (inMaintenance(cfg, log, { dryRun })) return { result: 'maintenance' }

  const file = pg.file
  const now = checkPatchFile(file, cfg, log)
  if (now.ok) return { result: 'ok', entries: now.entries }

  log(`插件配置不正常：${now.why}，去找备份`)
  const dir = dirname(file)
  const base = basename(file)
  let candidates = []
  try {
    candidates = readdirSync(dir)
      .filter((n) => n !== base && n.startsWith(base))
      .map((n) => {
        const full = join(dir, n)
        try {
          const st = statSync(full)
          return st.isFile() ? { name: n, full, mtime: st.mtimeMs } : null
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
  } catch {}

  let best = null
  for (const c of candidates) {
    const r = checkPatchFile(c.full, cfg, log)
    if (r.ok) {
      best = { ...c, entries: r.entries }
      break
    }
  }

  if (!best) {
    log(`没有可用的备份（看了 ${candidates.length} 个），保持现状`)
    if (pg.notify) await notify(cfg, message(cfg, 'patchDegraded', { entries: now.entries }), log, { dryRun })
    return { result: 'degraded', entries: now.entries }
  }

  if (dryRun) {
    log(`[试运行] 会用 ${best.name}（${best.entries} 项）恢复`)
    return { result: 'dry-run', backup: best.name }
  }
  if (existsSync(file)) {
    try {
      const keep = ensureDir(join(cfg.dataDir, 'patch-guard'))
      copyFileSync(file, join(keep, `${base}.broken-${fileStamp()}`))
    } catch {}
  }
  copyFileSync(best.full, file)
  log(`已用 ${best.name} 恢复（${best.entries} 项）`)
  if (pg.notify) await notify(cfg, message(cfg, 'patchRestored', { backup: best.name, entries: best.entries }), log)
  return { result: 'restored', backup: best.name, entries: best.entries }
}
