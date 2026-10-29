// Everything that touches the real machine (processes, ports, scheduled
// tasks) goes through this object, so tests can swap it for a fake.

import net from 'node:net'
import { dirname } from 'node:path'
import { arr, powershell, psQuote, runSync, sleep, spawnDetached } from './util.mjs'

function parseTasklistCsv(text, wanted) {
  const want = new Set(wanted.map((n) => n.toLowerCase()))
  const procs = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/)
    if (!m) continue
    const image = m[1].toLowerCase()
    const bare = image.replace(/\.exe$/, '')
    if (want.has(image) || want.has(bare)) procs.push({ pid: Number(m[2]), name: m[1] })
  }
  return procs
}

export function realSystem() {
  return {
    sleep,

    /**
     * Running processes with these names, and the TCP ports they listen on.
     * Returns ok:false when the process list could not be read at all; the
     * caller must then do nothing (never restart on missing information).
     */
    listProcesses(names) {
      const bare = names.map((n) => String(n).replace(/\.exe$/i, ''))
      const script = `
$names = @(${bare.map(psQuote).join(',')})
$p = @(Get-Process -Name $names | ForEach-Object { [pscustomobject]@{ pid = [int]$_.Id; name = [string]$_.ProcessName } })
$ids = @($p | ForEach-Object { $_.pid })
$l = @()
if ($ids.Count -gt 0) {
  $l = @(Get-NetTCPConnection -State Listen | Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object { [pscustomobject]@{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess } })
}
ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ ok = $true; procs = $p; listen = $l })
`
      const r = powershell(script, { timeoutMs: 45000 })
      try {
        const j = JSON.parse(r.stdout.trim())
        if (j && j.ok) return { ok: true, procs: arr(j.procs), listen: arr(j.listen), via: 'powershell' }
      } catch {}
      // Fallback: tasklist (no port information).
      const t = runSync('tasklist', ['/fo', 'csv', '/nh'], { timeoutMs: 30000 })
      if (t.code === 0 && t.stdout.includes('","')) {
        return { ok: true, procs: parseTasklistCsv(t.stdout, names), listen: [], via: 'tasklist' }
      }
      return { ok: false, procs: [], listen: [], error: (r.stderr || r.error || t.error || 'unknown').slice(0, 200) }
    },

    pidAlive(pid) {
      if (!pid) return false
      try {
        process.kill(Number(pid), 0)
        return true
      } catch (error) {
        return error.code === 'EPERM'
      }
    },

    /** Any HTTP answer below 500 proves the server is alive (401/403 included). */
    async httpAnswers(port, timeoutMs = 3000) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          method: 'HEAD',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
        return res.status < 500
      } catch {
        return false
      }
    },

    portOpen(port, timeoutMs = 800) {
      return new Promise((resolve) => {
        const s = net.connect({ port: Number(port), host: '127.0.0.1' })
        const done = (v) => {
          try {
            s.destroy()
          } catch {}
          resolve(v)
        }
        s.setTimeout(timeoutMs, () => done(false))
        s.once('connect', () => done(true))
        s.once('error', () => done(false))
      })
    },

    killByName(names) {
      return names.map((n) => {
        const image = /\.exe$/i.test(n) ? n : n + '.exe'
        const r = runSync('taskkill', ['/f', '/t', '/im', image], { timeoutMs: 30000 })
        return { name: image, code: r.code }
      })
    },

    /** Kill node.exe processes whose command line contains `pattern` (never this process). */
    killNodeMatching(pattern) {
      if (!pattern) return 0
      const script = `
$me = ${process.pid}
$n = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -and $_.CommandLine.ToLower().Contains(${psQuote(String(pattern).toLowerCase())}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $n++ }
$n
`
      const r = powershell(script)
      return Number(String(r.stdout).trim()) || 0
    },

    startDsh(exe) {
      return spawnDetached(exe, [], { cwd: dirname(exe), hidden: false })
    },

    startService(svc) {
      return spawnDetached(svc.command, svc.args || [], {
        cwd: svc.cwd || dirname(svc.command),
        env: svc.env || undefined,
        hidden: svc.hidden !== false,
      })
    },

    isAdmin() {
      return runSync('net', ['session'], { timeoutMs: 15000 }).code === 0
    },

    taskExists(name) {
      return runSync('schtasks', ['/query', '/tn', name], { timeoutMs: 20000 }).code === 0
    },

    /** { exists, enabled } for a scheduled task (read only). */
    taskInfo(name) {
      const r = runSync('schtasks', ['/query', '/tn', name, '/xml'], { timeoutMs: 20000 })
      if (r.code !== 0) return { exists: false, enabled: false }
      const settings = (r.stdout.match(/<Settings>([\s\S]*?)<\/Settings>/) || [])[1] || ''
      const disabled = /<Enabled>\s*false\s*<\/Enabled>/i.test(settings)
      return { exists: true, enabled: !disabled }
    },

    runTask(name) {
      const r = runSync('schtasks', ['/run', '/tn', name], { timeoutMs: 20000 })
      return { ok: r.code === 0, out: (r.stdout + r.stderr).trim() }
    },

    createTaskFromXml(name, xmlFile) {
      const r = runSync('schtasks', ['/create', '/tn', name, '/xml', xmlFile, '/f'], { timeoutMs: 30000 })
      return { ok: r.code === 0, out: (r.stdout + r.stderr).trim() }
    },

    deleteTask(name) {
      const r = runSync('schtasks', ['/delete', '/tn', name, '/f'], { timeoutMs: 30000 })
      return { ok: r.code === 0, out: (r.stdout + r.stderr).trim() }
    },

    setTaskEnabled(name, enabled) {
      const r = runSync('schtasks', ['/change', '/tn', name, enabled ? '/enable' : '/disable'], { timeoutMs: 30000 })
      return { ok: r.code === 0, out: (r.stdout + r.stderr).trim() }
    },

    /** DOMAIN\user of whoever runs this (used in task XML). */
    currentUser() {
      const domain = process.env.USERDOMAIN || ''
      const user = process.env.USERNAME || ''
      return domain ? `${domain}\\${user}` : user
    },

    /** Path of a running process with this name, for `init` auto-detection. */
    processPath(name) {
      const bare = String(name).replace(/\.exe$/i, '')
      const r = powershell(`(Get-Process -Name ${psQuote(bare)} | Where-Object { $_.Path } | Select-Object -First 1).Path`)
      return String(r.stdout || '').trim()
    },
  }
}
