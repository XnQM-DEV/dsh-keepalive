// Small shared helpers: time stamps, logging, JSON files, child processes.
// No third-party dependencies on purpose: this file is also copied to a stable
// folder and run by Windows scheduled tasks with DSH's bundled node.exe.

import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const pad = (n) => String(n).padStart(2, '0')

/** 2026-10-30 04:30:00 */
export function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 20261030 */
export function dayStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** 20261030-043000 */
export function fileStamp(d = new Date()) {
  return `${dayStamp(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 10-30 04:30:00 (short, for messages) */
export function shortStamp(d = new Date()) {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

/**
 * A logger that appends one line per call to `file` (UTF-8) and can echo to
 * the console. The file is rotated to `<file>.1` once it passes 1 MB.
 * `file` may be null (console only, used by dry runs).
 */
export function makeLogger(file, tag, { echo = false } = {}) {
  const log = (msg) => {
    const line = `${stamp()} [${tag}] ${msg}`
    if (echo) console.log(line)
    if (!file) return
    try {
      ensureDir(dirname(file))
      try {
        if (statSync(file).size > 1024 * 1024) renameSync(file, file + '.1')
      } catch {}
      appendFileSync(file, line + '\r\n', 'utf8')
    } catch {}
  }
  log.file = file
  log.tag = tag
  return log
}

export function readJson(file, fallback = null) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** Like readJson but throws a readable error when the file exists and is broken. */
export function readJsonStrict(file) {
  let text = readFileSync(file, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`配置文件不是合法的 JSON：${file}\n${error.message}`)
  }
}

/** Atomic JSON write (temp file + rename). */
export function writeJson(file, obj) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/** UTF-8 with BOM, so Notepad on older Windows shows Chinese correctly. */
export function writeTextBom(file, text) {
  ensureDir(dirname(file))
  writeFileSync(file, '﻿' + text, 'utf8')
}

export function removeFile(file) {
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

function decodeOutput(buf, encoding) {
  if (!buf || !buf.length) return ''
  if (encoding === 'utf8') return buf.toString('utf8')
  // Windows console tools print in the OEM code page (GBK on Chinese Windows).
  const s = buf.toString('utf8')
  if (!s.includes('�')) return s
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return s
  }
}

/** Run a command and wait. Never throws. */
export function runSync(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    windowsHide: true,
    timeout: opts.timeoutMs ?? 60000,
    cwd: opts.cwd,
    env: opts.env,
    input: typeof opts.input === 'string' ? Buffer.from(opts.input, 'utf8') : opts.input,
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    code: typeof r.status === 'number' ? r.status : -1,
    stdout: decodeOutput(r.stdout, opts.encoding),
    stderr: decodeOutput(r.stderr, opts.encoding),
    error: r.error ? String(r.error.message || r.error) : '',
  }
}

/** Quote a string for a PowerShell single-quoted literal. */
export function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/**
 * Run a PowerShell 5.1 script passed as -EncodedCommand (UTF-16), so
 * non-ASCII paths survive, and read its output as UTF-8.
 */
export function powershell(script, { timeoutMs = 60000 } = {}) {
  const full =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' +
    "$ErrorActionPreference = 'SilentlyContinue'\n" +
    "$ProgressPreference = 'SilentlyContinue'\n" +
    script
  const b64 = Buffer.from(full, 'utf16le').toString('base64')
  return runSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
    { timeoutMs, encoding: 'utf8' },
  )
}

/**
 * Start a program and do not wait for it. `hidden` hides console windows
 * (use false for GUI apps such as DSH itself, or its window may start hidden).
 */
export function spawnDetached(cmd, args = [], { cwd, env, hidden = true } = {}) {
  const e = { ...process.env, ...(env || {}) }
  // DSH's own CLI sets this; a GUI Electron app started with it would run as plain node.
  delete e.ELECTRON_RUN_AS_NODE
  const child = spawn(cmd, args, { cwd, env: e, detached: true, stdio: 'ignore', windowsHide: hidden })
  child.on('error', () => {})
  child.unref()
  return child.pid
}

/**
 * Run a program with no pipes (stdio ignored) and wait for it to exit, with a
 * timeout. Pipes are avoided on purpose: scripts that start background
 * processes keep a pipe open and the caller would wait forever.
 */
export function runNoPipe(cmd, args = [], { cwd, env, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let done = false
    const e = { ...process.env, ...(env || {}) }
    delete e.ELECTRON_RUN_AS_NODE
    let child
    try {
      child = spawn(cmd, args, { cwd, env: e, stdio: 'ignore', windowsHide: true })
    } catch (error) {
      resolve({ code: -1, timedOut: false, error: String(error.message || error) })
      return
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill()
      } catch {}
      resolve({ code: -1, timedOut: true, error: '' })
    }, timeoutMs)
    child.on('error', (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: -1, timedOut: false, error: String(error.message || error) })
    })
    child.on('exit', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: typeof code === 'number' ? code : -1, timedOut: false, error: '' })
    })
  })
}

/** Normalise "a" | ["a"] | undefined to an array. */
export function arr(x) {
  if (x === undefined || x === null) return []
  return Array.isArray(x) ? x : [x]
}

/** Is `child` the same as, or inside, `parent`? (case-insensitive, Windows paths) */
export function isInside(child, parent) {
  const norm = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p + '\\')
}

export function fileExists(p) {
  try {
    return !!p && existsSync(p)
  } catch {
    return false
  }
}

export function formatMB(bytes) {
  return (Math.round((bytes / 1024 / 1024) * 10) / 10).toString() + ' MB'
}
