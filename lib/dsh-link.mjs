// Put the plugin into (or take it out of) a DSH profile WITHOUT running pnpm.
//
// This mirrors what the other local plugins on such a machine look like:
//   <plugins>\dsh-keepalive                       a copy of this package
//   <profile>\node_modules\dsh-keepalive          a junction to that copy
//   <profile>\package.json  dependencies          "dsh-keepalive": "link:<plugins>/dsh-keepalive"
//                           dsh.profile.bundles   "dsh-keepalive"
// The package has no dependencies, so nothing has to be installed. pnpm is
// deliberately not run: on some machines it pruned dozens of packages.
// package.json is backed up before it is changed.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_ROOT } from './config.mjs'
import { fileStamp, isInside, readJson } from './util.mjs'

const NAME = 'dsh-keepalive'

export function linkPlan(cfg) {
  const profileDir = cfg.dsh.profileDir
  const pluginDir = join(cfg.dsh.pluginsDir, NAME)
  return {
    profileDir,
    pkgJson: join(profileDir, 'package.json'),
    pluginDir,
    linkPath: join(profileDir, 'node_modules', NAME),
    spec: 'link:' + pluginDir.replace(/\\/g, '/'),
  }
}

function readPkg(file) {
  const raw = readFileSync(file, 'utf8')
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return { json: JSON.parse(text), eol: raw.includes('\r\n') ? '\r\n' : '\n', bom: raw.charCodeAt(0) === 0xfeff }
}

function writePkg(file, pkg, json) {
  let text = JSON.stringify(json, null, 2) + '\n'
  if (pkg.eol === '\r\n') text = text.replace(/\n/g, '\r\n')
  writeFileSync(file, (pkg.bom ? '﻿' : '') + text, 'utf8')
}

function linkTarget(p) {
  try {
    const st = lstatSync(p)
    return { exists: true, isLink: st.isSymbolicLink(), real: realpathSync(p) }
  } catch {
    return { exists: false, isLink: false, real: '' }
  }
}

function packageFiles() {
  const pkg = readJson(join(PACKAGE_ROOT, 'package.json'), {})
  return ['package.json', ...(pkg.files || [])]
}

export async function linkIntoDsh(cfg, env, opts = {}) {
  const { log, dryRun } = env
  const p = linkPlan(cfg)
  if (!existsSync(p.pkgJson)) {
    log(`找不到 DSH profile 的 package.json：${p.pkgJson}（检查配置里的 dsh.profileDir）`)
    return { result: 'blocked' }
  }
  const pkg = readPkg(p.pkgJson)
  const deps = pkg.json.dependencies || {}
  const bundles = (pkg.json.dsh && pkg.json.dsh.profile && pkg.json.dsh.profile.bundles) || []
  const link = linkTarget(p.linkPath)
  const samePlace = isInside(PACKAGE_ROOT, p.pluginDir) && isInside(p.pluginDir, PACKAGE_ROOT)

  if (link.exists && !(link.isLink && link.real.toLowerCase() === (existsSync(p.pluginDir) ? realpathSync(p.pluginDir) : p.pluginDir).toLowerCase())) {
    log(`${p.linkPath} 已经存在，而且不是指向 ${p.pluginDir} 的链接；为了安全不动它。`)
    return { result: 'blocked' }
  }

  log('将要做的事（不会运行 pnpm）：')
  log(samePlace ? `  1. 插件已经在 ${p.pluginDir}，不用复制` : `  1. 把插件复制到 ${p.pluginDir}`)
  log(`  2. 备份 ${p.pkgJson} 到 ${cfg.backupDir}`)
  log(deps[NAME] === p.spec ? '  3. dependencies 里已经有它' : `  3. 在 dependencies 里加上 "${NAME}": "${p.spec}"`)
  log(bundles.includes(NAME) ? '  4. dsh.profile.bundles 里已经有它' : `  4. 在 dsh.profile.bundles 里加上 "${NAME}"`)
  log(link.exists ? '  5. node_modules 里的链接已经在' : `  5. 建立链接 ${p.linkPath} → ${p.pluginDir}`)
  log('  之后重启 DSH，插件的宿主半边才会加载。')
  if (dryRun) {
    log('[试运行] 什么都没改。')
    return { result: 'dry-run', plan: p }
  }
  if (!opts.yes) {
    const ok = env.confirm ? await env.confirm('确认把插件装进 DSH 吗？输入 y 回车确认：') : false
    if (!ok) {
      log('已取消，什么都没改。')
      return { result: 'cancelled' }
    }
  }

  if (!samePlace) {
    mkdirSync(p.pluginDir, { recursive: true })
    for (const f of packageFiles()) {
      const from = join(PACKAGE_ROOT, f)
      if (existsSync(from)) cpSync(from, join(p.pluginDir, f), { recursive: true })
    }
    log(`✓ 已复制到 ${p.pluginDir}`)
  }
  const bak = join(cfg.backupDir, `dsh-link-${fileStamp()}`)
  mkdirSync(bak, { recursive: true })
  cpSync(p.pkgJson, join(bak, 'package.json'))
  log(`✓ 已备份 package.json 到 ${bak}`)

  const json = pkg.json
  json.dependencies = { ...(json.dependencies || {}), [NAME]: p.spec }
  json.dsh = json.dsh || {}
  json.dsh.profile = json.dsh.profile || {}
  json.dsh.profile.bundles = json.dsh.profile.bundles || []
  if (!json.dsh.profile.bundles.includes(NAME)) json.dsh.profile.bundles.push(NAME)
  writePkg(p.pkgJson, pkg, json)
  log('✓ 已改好 package.json')

  if (!link.exists) {
    mkdirSync(join(p.profileDir, 'node_modules'), { recursive: true })
    symlinkSync(p.pluginDir, p.linkPath, 'junction')
    log(`✓ 已建立链接 ${p.linkPath}`)
  }
  log('完成。重启 DSH 后生效（可以先进入维护模式再手动重启）。')
  return { result: 'ok', backup: bak }
}

export async function unlinkFromDsh(cfg, env, opts = {}) {
  const { log, dryRun } = env
  const p = linkPlan(cfg)
  if (!existsSync(p.pkgJson)) {
    log(`找不到 ${p.pkgJson}`)
    return { result: 'blocked' }
  }
  const pkg = readPkg(p.pkgJson)
  const link = linkTarget(p.linkPath)
  const hasDep = !!(pkg.json.dependencies && pkg.json.dependencies[NAME])
  const bundles = (pkg.json.dsh && pkg.json.dsh.profile && pkg.json.dsh.profile.bundles) || []
  log('将要做的事（不会运行 pnpm）：')
  log(`  备份 ${p.pkgJson}`)
  if (hasDep) log(`  从 dependencies 里去掉 ${NAME}`)
  if (bundles.includes(NAME)) log(`  从 dsh.profile.bundles 里去掉 ${NAME}`)
  if (link.exists && link.isLink) log(`  删除链接 ${p.linkPath}（只删链接，不删插件文件）`)
  if (opts.purge) log(`  删除插件文件夹 ${p.pluginDir}`)
  log('  计划任务（外面的看门狗）不受影响，要停它请运行 uninstall。')
  if (dryRun) {
    log('[试运行] 什么都没改。')
    return { result: 'dry-run' }
  }
  if (!opts.yes) {
    const ok = env.confirm ? await env.confirm('确认从 DSH 里移除插件吗？输入 y 回车确认：') : false
    if (!ok) {
      log('已取消，什么都没改。')
      return { result: 'cancelled' }
    }
  }
  const bak = join(cfg.backupDir, `dsh-unlink-${fileStamp()}`)
  mkdirSync(bak, { recursive: true })
  cpSync(p.pkgJson, join(bak, 'package.json'))
  const json = pkg.json
  if (json.dependencies) delete json.dependencies[NAME]
  if (json.dsh && json.dsh.profile && Array.isArray(json.dsh.profile.bundles)) {
    json.dsh.profile.bundles = json.dsh.profile.bundles.filter((b) => b !== NAME)
  }
  writePkg(p.pkgJson, pkg, json)
  log('✓ 已改好 package.json（备份在 ' + bak + '）')
  if (link.exists && link.isLink) {
    rmdirSync(p.linkPath)
    log('✓ 已删除链接')
  }
  if (opts.purge && existsSync(p.pluginDir) && !isInside(PACKAGE_ROOT, p.pluginDir)) {
    rmSync(p.pluginDir, { recursive: true, force: true })
    log('✓ 已删除插件文件夹')
  }
  log('完成。重启 DSH 后生效。')
  return { result: 'ok', backup: bak }
}
