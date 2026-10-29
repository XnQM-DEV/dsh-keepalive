// Default notification texts. Every one can be overridden in the config under
// "messages" (for example, rewritten in the AI character's own voice).
// {name} placeholders are filled in by fmt().

export const DEFAULT_MESSAGES = {
  down: '⚠️ DSH 整个掉了（进程都没了），已经让计划任务把它拉起来。',
  hung: '⚠️ DSH 卡住了：进程还在，但页面连续 {count} 次没应答，准备重启。',
  back: '✅ DSH 回来了。',
  stuck: '⚠️ 会话 {session} 有一轮对话 {minutes} 分钟没有任何动静了，可能卡在某个工具上。{action}',
  stuckActionRestart: '准备重启 DSH。',
  stuckActionNotify: '先不重启，需要的话手动处理。',
  restartReport: '【重启汇报 {time}】DSH 已重启（原因：{reason}）。\n{services}{selfcheck}\n这条是脚本自动发的。',
  restartFailed: '⛔ DSH 重启后一直没看到进程，可能没起来，请手动看一下。',
  gaveUp: '⛔ 最近一小时已经自动重启了 {count} 次，先停手不再自动重启，请人来看一下。',
  patchRestored: '🩹 插件配置被重置了，已经从备份 {backup} 恢复（{entries} 项）。重启 DSH 后生效。',
  patchDegraded: '⚠️ 插件配置只剩 {entries} 项，而且找不到可用的备份，请手动处理。',
  backupFailed: '⚠️ 备份「{job}」有 {errors} 处失败，详情看 {log}。',
  trimDone: '🧹 清理完成：{summary}',
  test: '🔔 这是一条测试消息：dsh-keepalive 的通知通道是通的。',
}

export const REASONS = {
  down: '进程没了',
  hung: '页面不应答',
  stuck: '一轮对话卡住',
  manual: '手动',
  rescue: '急救',
}

export function message(cfg, key, vars = {}) {
  const custom = cfg && cfg.messages && typeof cfg.messages[key] === 'string' ? cfg.messages[key] : null
  return fmt(custom ?? DEFAULT_MESSAGES[key] ?? key, vars)
}

export function fmt(template, vars = {}) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (all, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])))
}
