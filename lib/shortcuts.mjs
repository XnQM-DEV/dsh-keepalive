// Double-click helpers (.cmd files): enter / leave maintenance mode, the
// emergency restart, and a status window. Their content is ASCII apart from
// paths; when a path has Chinese characters the file is written in the system
// ANSI code page (GBK on Chinese Windows) with no chcp, which is what cmd.exe
// reads correctly. All Chinese text the user sees is printed by node.exe.
// A file that already exists and was not made by this plugin is never overwritten.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runtimeDir } from './config.mjs'
import { ensureDir, powershell, psQuote } from './util.mjs'

export const MARK = 'rem dsh-keepalive helper'

export function shortcutPlan(cfg) {
  const dir = cfg.shortcuts.dir || cfg.dataDir
  const n = cfg.shortcuts.names || {}
  const items = [
    ['maintenanceOn', ['maintenance', 'on'], 'pause'],
    ['maintenanceOff', ['maintenance', 'off'], 'pause'],
    ['rescue', ['rescue'], 'timeout /t 15'],
    ['status', ['status'], 'pause'],
  ]
  return items.filter(([key]) => n[key]).map(([key, args, end]) => ({ key, file: join(dir, n[key]), args, end }))
}

export function shortcutContent(cfg, item) {
  const cli = join(runtimeDir(cfg), 'bin', 'dsh-keepalive.mjs')
  return [
    '@echo off',
    `${MARK} (made by "dsh-keepalive install"; safe to delete)`,
    `"${cfg.nodePath}" --no-warnings "${cli}" --config "${cfg._file}" ${item.args.join(' ')}`,
    item.end,
    '',
  ].join('\r\n')
}

/** Write text in the system ANSI code page (plain ASCII is written directly). */
export function writeAnsi(file, text) {
  ensureDir(dirname(file))
  if (/^[\x00-\x7f]*$/.test(text)) {
    writeFileSync(file, text, 'latin1')
    return
  }
  const tmp = file + '.utf8-tmp'
  writeFileSync(tmp, text, 'utf8')
  const r = powershell(
    `$t = [IO.File]::ReadAllText(${psQuote(tmp)}, [Text.Encoding]::UTF8); [IO.File]::WriteAllText(${psQuote(file)}, $t, [Text.Encoding]::Default); Remove-Item -LiteralPath ${psQuote(tmp)} -Force; 'ok'`,
  )
  if (!String(r.stdout).includes('ok')) throw new Error('写 ANSI 文件失败：' + file)
}

function isOurs(file) {
  try {
    return readFileSync(file, 'latin1').includes(MARK)
  } catch {
    return false
  }
}

export function writeShortcuts(cfg, env) {
  const { log } = env
  const written = []
  for (const item of shortcutPlan(cfg)) {
    if (existsSync(item.file) && !isOurs(item.file)) {
      log(`已经有同名文件，而且不是本插件生成的，没有覆盖：${item.file}`)
      continue
    }
    try {
      writeAnsi(item.file, shortcutContent(cfg, item))
      written.push(item.file)
      log(`✓ 已生成 ${item.file}`)
    } catch (error) {
      log(`✗ 生成 ${item.file} 失败：${error.message}`)
    }
  }
  return written
}

export function removeShortcuts(files, env) {
  for (const f of files || []) {
    if (!existsSync(f)) continue
    if (!isOurs(f)) {
      env.log(`没删 ${f}：不是本插件生成的`)
      continue
    }
    try {
      unlinkSync(f)
      env.log(`已删除 ${f}`)
    } catch (error) {
      env.log(`删除 ${f} 失败：${error.message}`)
    }
  }
}
