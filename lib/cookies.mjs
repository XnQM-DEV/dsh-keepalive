// Remove stale DSH login cookies (dsh-auth-*) for 127.0.0.1 / localhost.
// Every DSH launch adds one and none are cleaned up; after ~70 launches the
// request header passes 16 KB, the host answers 431 and DSH no longer opens
// ("desktop welcome: Web authentication failed"). DSH mints a fresh cookie on
// every launch, so removing the old ones is harmless. Nothing else in the
// cookie store is touched. Only works while DSH is closed (the store is locked).

import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir } from './util.mjs'

const WHERE = "host_key IN ('127.0.0.1', 'localhost') AND name LIKE 'dsh-auth-%'"

async function openDb(file, readOnly) {
  const { DatabaseSync } = await import('node:sqlite')
  return readOnly ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file)
}

/** Count DSH login cookies without changing anything (may fail while DSH runs). */
export async function countAuthCookies(file) {
  if (!file || !existsSync(file)) return { ok: false, count: 0, message: '找不到 cookie 文件：' + file }
  try {
    const db = await openDb(file, true)
    try {
      const n = db.prepare('SELECT COUNT(*) AS n FROM cookies WHERE ' + WHERE).get().n
      return { ok: true, count: Number(n) }
    } finally {
      db.close()
    }
  } catch (error) {
    return { ok: false, count: 0, message: String((error && error.message) || error) }
  }
}

export async function clearAuthCookies(cfg, env) {
  const { sys, dryRun } = env
  const file = cfg.dsh.cookieStore
  if (!file || !existsSync(file)) return { ok: true, removed: 0, message: '没找到 cookie 文件，不用清：' + file }
  if (dryRun) {
    const c = await countAuthCookies(file)
    return { ok: true, removed: 0, message: c.ok ? `[试运行] 会删掉 ${c.count} 个旧的登录 cookie` : `[试运行] 现在读不了 cookie 文件（DSH 开着时是锁住的）：${c.message}` }
  }
  let lastError = ''
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const db = await openDb(file, false)
      try {
        db.exec('PRAGMA busy_timeout = 1000')
        const n = Number(db.prepare('SELECT COUNT(*) AS n FROM cookies WHERE ' + WHERE).get().n)
        if (n > 0 && cfg.cookies && cfg.cookies.backupDir) {
          try {
            ensureDir(cfg.cookies.backupDir)
            copyFileSync(file, join(cfg.cookies.backupDir, 'Cookies'))
          } catch {}
        }
        db.prepare('DELETE FROM cookies WHERE ' + WHERE).run()
        const left = Number(db.prepare('SELECT COUNT(*) AS n FROM cookies').get().n)
        return { ok: true, removed: n, message: `删掉了 ${n} 个旧的 DSH 登录 cookie，其余 ${left} 个没动` }
      } finally {
        db.close()
      }
    } catch (error) {
      lastError = String((error && error.message) || error)
      await sys.sleep(1000)
    }
  }
  return { ok: false, removed: 0, message: '清理 cookie 失败（DSH 是不是还开着？）：' + lastError }
}
