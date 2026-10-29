// Configuration: built-in defaults + the user's JSON file, with ${PLACEHOLDER}
// expansion. Every machine-specific value (paths, QQ target, ports, task
// names) comes from the user's file; nothing secret lives in this package.

import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonStrict } from './util.mjs'

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function dshHomeDefault() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function defaultConfigPath() {
  return process.env.DSH_KEEPALIVE_CONFIG || join(dshHomeDefault(), 'keepalive.config.json')
}

/** Built-in defaults. Arrays in the user's file replace these; objects merge. */
export function defaults() {
  return {
    dshHome: '',
    dataDir: '${DSH_HOME}/keepalive',
    nodePath: '${DSH_HOME}/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe',
    backupDir: '${DATA_DIR}/backups',
    dsh: {
      exe: '',
      processNames: ['DeepSeek Harness.exe'],
      extraPorts: [],
      minPort: 1025,
      probeTimeoutSeconds: 3,
      noPortThreshold: 6,
      profileDir: '${DSH_HOME}/profiles/desktop',
      pluginsDir: '${DSH_HOME}/plugins',
      cookieStore: '${APPDATA}/@deepseek-ai/dsh-desktop/Network/Cookies',
      rescueKillNodePattern: '',
    },
    maintenance: {
      flagFile: '${DATA_DIR}/maintenance.flag',
      maxMinutes: 120,
    },
    heartbeat: {
      enabled: true,
      hungThreshold: 3,
      notify: true,
      stuckTurnAction: 'notify',
    },
    host: {
      pulseSeconds: 60,
      stuckTurnMinutes: 45,
    },
    restart: {
      enabled: true,
      cooldownMinutes: 3,
      maxPerHour: 4,
      killWaitSeconds: 4,
      startTimeoutSeconds: 60,
      retryOnce: true,
      settleSeconds: 20,
      clearAuthCookies: true,
      notify: true,
      reportFile: '${DATA_DIR}/restart-report.txt',
      selfcheck: {
        enabled: false,
        command: '',
        args: [],
        cwd: '',
        timeoutSeconds: 180,
        readFile: '',
        summaryPattern: '小结',
      },
    },
    services: [],
    patchGuard: {
      enabled: false,
      file: '${DSH_HOME}/profiles/desktop/cordis.patch.yml',
      minEntries: 1,
      validateYaml: true,
      yamlFrom: '${DSH_HOME}/profiles/desktop/package.json',
      notify: false,
    },
    backup: {
      jobs: {},
    },
    trim: {
      protect: [],
      jobs: [],
      notify: false,
    },
    cookies: {
      backupDir: '${DATA_DIR}/cookies-last',
    },
    notify: {
      channels: [],
    },
    messages: {},
    tasks: [
      {
        id: 'tick',
        name: 'DSHKeepalive-Tick',
        run: ['tick'],
        everyMinutes: 5,
        atLogon: true,
        logonDelaySeconds: 60,
        elevated: false,
        enabled: true,
        timeLimitMinutes: 10,
      },
      {
        id: 'restart',
        name: 'DSHKeepalive-Restart',
        run: ['restart'],
        onDemand: true,
        elevated: true,
        enabled: true,
        timeLimitMinutes: 15,
      },
    ],
    legacy: {
      tasks: [],
    },
    shortcuts: {
      enabled: true,
      dir: '${DATA_DIR}',
      names: {
        maintenanceOn: '进入维护模式.cmd',
        maintenanceOff: '退出维护模式.cmd',
        rescue: 'DSH急救.cmd',
        status: '查看守护状态.cmd',
      },
    },
  }
}

/** Paths that trim must never delete from, whatever the user's config says. */
export function builtInProtect() {
  return [
    '${DSH_HOME}/attachments',
    '${DSH_HOME}/sessions',
    '${DSH_HOME}/storages',
    '${DSH_HOME}/profiles',
    '${DSH_HOME}/plugins',
    '${DSH_HOME}/dsh-runtimes',
    '${DATA_DIR}',
  ]
}

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('//')) continue // "//": "comment" keys
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v
  }
  return out
}

export function baseVars() {
  const home = homedir()
  return {
    USERPROFILE: process.env.USERPROFILE || home,
    APPDATA: process.env.APPDATA || join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'),
    TEMP: process.env.TEMP || tmpdir(),
    DESKTOP: join(process.env.USERPROFILE || home, 'Desktop'),
    PACKAGE_ROOT,
  }
}

/** Replace ${NAME} and ${env:NAME}; unknown names are left as they are. */
export function expand(str, vars) {
  if (typeof str !== 'string') return str
  return str.replace(/\$\{(env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, isEnv, name) => {
    if (isEnv) return process.env[name] ?? all
    return vars[name] ?? all
  })
}

/** "C:/a/b/../c" -> "C:\a\c". Only whole strings that start with a drive letter. */
function tidyPath(s) {
  return /^[A-Za-z]:[\\/]/.test(s) ? win32.normalize(s) : s
}

export function expandAll(value, vars) {
  if (typeof value === 'string') return tidyPath(expand(value, vars))
  if (Array.isArray(value)) return value.map((v) => expandAll(v, vars))
  if (isPlainObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = expandAll(v, vars)
    return out
  }
  return value
}

/**
 * Load the config file (or only defaults when allowMissing and the file is
 * absent). Adds `_file`, `_exists` and `_vars` for the rest of the code.
 */
export function loadConfig(file = defaultConfigPath(), { allowMissing = false } = {}) {
  const abs = resolve(file)
  let user = {}
  const exists = existsSync(abs)
  if (exists) user = readJsonStrict(abs)
  else if (!allowMissing) {
    throw new Error(`找不到配置文件：${abs}\n先运行「dsh-keepalive init」生成一份，改好再用。`)
  }
  const merged = deepMerge(defaults(), user || {})
  const vars = baseVars()
  vars.DSH_HOME = resolve(merged.dshHome ? expand(merged.dshHome, vars) : dshHomeDefault())
  vars.DATA_DIR = resolve(expand(merged.dataDir, vars))
  const cfg = expandAll(merged, vars)
  cfg.dataDir = vars.DATA_DIR
  cfg.dshHome = vars.DSH_HOME
  cfg.trim.protect = [...builtInProtect(), ...(cfg.trim.protect || [])].map((p) => tidyPath(expand(p, vars)))
  cfg._file = abs
  cfg._exists = exists
  cfg._vars = vars
  return cfg
}

export function findTask(cfg, id) {
  return (cfg.tasks || []).find((t) => t && t.id === id) || null
}

/** Folder the scheduled tasks run from (a stable copy, outside node_modules). */
export function runtimeDir(cfg) {
  return join(cfg.dataDir, 'runtime')
}

export function logFile(cfg) {
  return join(cfg.dataDir, 'logs', 'keepalive.log')
}

export function stateDir(cfg) {
  return join(cfg.dataDir, 'state')
}
