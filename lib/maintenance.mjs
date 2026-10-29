// Maintenance mode: while the flag file exists (and is younger than
// maintenance.maxMinutes), nothing restarts DSH or touches its files. The flag
// expires on its own so a forgotten flag can never leave DSH unguarded.

import { statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensureDir, removeFile, stamp } from './util.mjs'

export function maintenanceStatus(cfg, now = Date.now()) {
  const file = cfg.maintenance.flagFile
  const maxMinutes = Number(cfg.maintenance.maxMinutes) || 120
  try {
    const st = statSync(file)
    const ageMinutes = (now - st.mtimeMs) / 60000
    return {
      on: ageMinutes < maxMinutes,
      expired: ageMinutes >= maxMinutes,
      ageMinutes: Math.max(0, Math.floor(ageMinutes)),
      leftMinutes: Math.max(0, Math.ceil(maxMinutes - ageMinutes)),
      maxMinutes,
      file,
    }
  } catch {
    return { on: false, expired: false, ageMinutes: 0, leftMinutes: 0, maxMinutes, file }
  }
}

/**
 * Returns true when maintenance mode is active (the caller should skip its
 * work). An expired flag is removed and logged.
 */
export function inMaintenance(cfg, log, { dryRun = false } = {}) {
  const s = maintenanceStatus(cfg)
  if (s.on) {
    log(`维护模式中（已 ${s.ageMinutes} 分钟，还剩 ${s.leftMinutes} 分钟）→ 跳过`)
    return true
  }
  if (s.expired) {
    if (!dryRun) removeFile(s.file)
    log(`维护标记超过 ${s.maxMinutes} 分钟，已自动失效，恢复守护`)
  }
  return false
}

export function enterMaintenance(cfg, note = '') {
  ensureDir(dirname(cfg.maintenance.flagFile))
  writeFileSync(cfg.maintenance.flagFile, `${stamp()} ${note}`.trim() + '\r\n', 'utf8')
  return maintenanceStatus(cfg)
}

export function exitMaintenance(cfg) {
  return removeFile(cfg.maintenance.flagFile)
}
