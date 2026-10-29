# dsh-keepalive · DSH 保活守护

让 DeepSeek Harness（DSH）桌面版里的 AI 角色一直在线：**DSH 掉了、卡了会自动拉起来并发 QQ 通知**，另外管着维护模式、插件配置恢复、每日备份、磁盘清理和登录 cookie 清理。

只支持 **Windows**。没有任何 npm 依赖，只用 DSH 自带的 node.exe。

---

## 它分成两半

| | 跑在哪里 | 做什么 |
|---|---|---|
| **外面的看门狗**（主要部分） | Windows 计划任务，从一份固定的副本运行（`<dataDir>\runtime`） | 心跳检查、重启、备份、清理、插件配置恢复 |
| **DSH 里的宿主半边**（可选） | DSH 里面（`lib/host.js`） | 每分钟写一次心跳文件；发现「一轮对话很久没动静」；提供状态接口 |

为什么看门狗必须在外面：插件跑在 DSH 里，**DSH 一挂它也跟着挂**，没法自己把自己救回来。所以重启这类事交给 Windows 计划任务。宿主半边只负责「报信」，不装也能用。

---

## 能做什么

- **心跳检查**（每 5 分钟）
  - DSH 进程整个没了 → 立刻重启，发一条「掉了」
  - 进程在、但网页端口连续 3 次不应答 → 重启，发一条「卡住了」
  - 恢复后发一条「回来了」；连续掉线不会刷屏
  - 读不到进程列表时**什么都不做**（宁可漏一次，也不误杀正常的 DSH）
- **一轮对话卡住的提醒**（需要装宿主半边）：一轮对话开始后超过 45 分钟没有任何新动静（比如某个工具调用卡死），发通知。默认只通知，可以改成直接重启。端口检查发现不了这种情况——网页照样能打开。
- **重启流程**：结束 DSH → 清掉过期的登录 cookie → 启动 → 没起来再试一次 → 拉起依赖的服务（比如 QQ 后端） → 跑你的自检脚本 → 写一份重启汇报文件 → 发通知。
  - 冷却时间（默认 3 分钟内不重复重启）和次数上限（默认一小时最多 4 次，超过就停手并通知你），不会无限重启。
- **维护模式**：你要手动关掉 DSH 改东西时打开它，期间不重启、不改插件配置；默认 2 小时后自动失效，忘了关也不会一直没人守。
- **急救**：一键退出维护模式、结束卡住的 DSH、清 cookie、重启。
- **插件配置守护**：DSH 有时会把 profile 的 `cordis.patch.yml` 重置成空壳（插件全没了）。发现后从同目录里**最新的健康备份**恢复（不是最大的那个——旧的大备份可能还列着你故意删掉的插件），坏文件先另存一份。
- **每日备份**：按配置把文件和文件夹复制到 `目标\年月日\`，只保留最近 N 天。支持排除（`node_modules`、`/tmp` 这种）、通配符（`*.sh`）、改名。文件夹里的链接/联接点一律跳过，不会顺着链接把整块盘拷进来。
- **磁盘清理**：只删你列出的文件夹里超过 N 天的文件。**DSH 的附件库、会话、存储、profile、插件目录永远受保护**（删附件库里任何一张图，DSH 之后每一轮都会报 `DeepSeek Messages transport failed`）。
- **登录 cookie 清理**：DSH 每启动一次就多一个 `dsh-auth-*` cookie、从来不清，攒到 70 个左右请求头超过 16 KB，DSH 就打不开了（`Web authentication failed`）。每次重启前自动清掉旧的（DSH 每次启动都会重新发一个，删旧的没有副作用）。
- **通知**：QQ（OneBot v11：NapCat / SnowLuma / LLOneBot）、通用 webhook、或者运行任意命令。

## 做不到的

- 不能替你扫码登录 QQ。QQ 后端需要扫码时只能报告。
- 不能修复 DSH 本身的问题，只是把它重新拉起来。
- 电脑关机、睡眠、没登录 Windows 时不工作（计划任务按「用户登录时运行」）。
- 只支持 Windows。
- 如果 DSH 更新后自带 node.exe 换了位置，计划任务会找不到它——`doctor` 会报出来，改配置里的 `nodePath` 再 `install` 一次即可。

---

## 安装

### 第 1 步：生成配置

```bash
dsh-keepalive init
```

会在 `C:\Users\你\.dsh\keepalive.config.json` 生成配置，并自动填好：正在运行的 DSH 主程序位置、`qq-bridge-config.json`（如果有）作为 QQ 通知来源。用记事本打开看一遍，模板里每一节都有中文说明。

没有全局安装时可以这样运行（用 DSH 自带的 node）：

```bash
"%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" bin\dsh-keepalive.mjs init
```

或者直接双击包里的 **`安装守护.cmd`**：它会依次执行 init（没有配置才生成）→ doctor → install。

### 第 2 步：检查

```bash
dsh-keepalive doctor
```

只读，不改任何东西。会告诉你 DSH 现在是否正常、通知通道能不能用、每个备份要复制多少项、哪些计划任务装了没有。

想先看看每个功能「会做什么」，任何命令都可以加 `--dry-run`（不改文件、不发通知、不写日志）：

```bash
dsh-keepalive tick --dry-run
dsh-keepalive backup --all --dry-run
dsh-keepalive install --dry-run
```

### 第 3 步：安装看门狗

```bash
dsh-keepalive install --elevate
```

先列出要做的事，**你输入 y 才会执行**：

1. 把运行文件复制到 `<dataDir>\runtime`（计划任务从这里跑，以后更新或移除 DSH 里的插件都不影响它）
2. 创建计划任务（默认 `DSHKeepalive-Tick` 每 5 分钟、`DSHKeepalive-Restart` 按需触发；备份和清理任务在配置里打开才会创建）
3. 在 `<dataDir>` 里生成四个双击小工具：`进入维护模式.cmd`、`退出维护模式.cmd`、`DSH急救.cmd`、`查看守护状态.cmd`（同名文件已存在、又不是本插件生成的，**不会覆盖**）

重启任务以最高权限运行（DSH 可能是以管理员身份启动的，普通权限结束不了它），所以需要管理员。加了 `--elevate` 会弹出 UAC 窗口；不加的话这个任务会被跳过，其他照装。

以前自己搭过守护任务？把它们的名字写进配置的 `legacy.tasks`，`install --disable-legacy` 会**停用（不删除）**它们，`uninstall` 时自动重新启用。

### 第 4 步（可选）：把宿主半边装进 DSH

```bash
dsh-keepalive link-into-dsh
```

同样先列计划、问你。它**不运行 pnpm**，只做三件事：把插件复制到 `~\.dsh\plugins\dsh-keepalive`、在 profile 的 `node_modules` 里建一个指向它的链接、在 profile 的 `package.json` 里登记（改之前先备份）。重启 DSH 后生效。

也可以用 DSH 的插件市场 / `dsh plugin add dsh-keepalive` 安装，效果一样；但那条路会在 profile 里运行 pnpm，有的机器上 pnpm 会顺手清掉别的包，介意的话用上面的命令。

---

## 日常

| 想做的事 | 命令 / 双击 |
|---|---|
| 手动关 DSH 改东西 | `进入维护模式.cmd`，或 `dsh-keepalive maintenance on` |
| 改完了 | `退出维护模式.cmd`，或 `maintenance off`（忘了也行，2 小时后自动失效） |
| DSH 卡死打不开 | `DSH急救.cmd`，或 `dsh-keepalive rescue` |
| 看看守护在不在、上次重启和备份怎样 | `查看守护状态.cmd`，或 `dsh-keepalive status` |
| 试一下 QQ 通知 | `dsh-keepalive notify-test` |

装了宿主半边的话，DSH 里打开 `/dsh-keepalive/` 是一个简单的状态页，可以直接开关维护模式；`/dsh-keepalive/status` 返回 JSON。

日志在 `<dataDir>\logs\keepalive.log`，状态在 `<dataDir>\state\`。

---

## 配置

完整模板见 `keepalive.config.example.json`。要点：

- **占位符**：`${DSH_HOME}`（默认 `C:\Users\你\.dsh`）、`${DATA_DIR}`（`dataDir`）、`${APPDATA}`、`${LOCALAPPDATA}`、`${USERPROFILE}`、`${DESKTOP}`、`${TEMP}`、`${env:任意环境变量}`。路径用 `/` 或 `\\` 都行。
- **以 `//` 开头的键是说明**，程序会忽略。
- 对象会和默认值合并；**数组会整个替换**默认值（比如写了 `tasks` 就要写全）。

### 通知（`notify.channels`）

QQ 推荐这样写，**令牌和 QQ 号不进这个配置文件**，发送时才从别的文件里读：

```json
{
  "type": "onebot",
  "enabled": true,
  "fromFile": { "path": "${DSH_HOME}/qq-bridge-config.json", "urlField": "NapCat", "tokenField": "令牌", "userIdField": "私聊QQ" },
  "tokenIn": "query"
}
```

也可以直接写 `url`、`userId`、`groupId`、`token`。`tokenIn` 为 `header` 时用 `Authorization: Bearer`。

webhook：`{ "type": "webhook", "url": "...", "bodyTemplate": { "text": "{{text}}" }, "headers": {} }`
命令：`{ "type": "command", "command": "node.exe", "args": ["my-notify.js", "{{file}}"] }`（`{{file}}` 是一个装着消息的 UTF-8 临时文件，`{{text}}` 是消息本身）

### 消息（`messages`）

想换成角色自己的口吻就改这里。可用的键和占位符：

| 键 | 什么时候 | 占位符 |
|---|---|---|
| `down` | 进程没了 | |
| `hung` | 不应答，准备重启 | `{count}` |
| `back` | 恢复了 | |
| `stuck` | 一轮对话很久没动静 | `{session}` `{minutes}` `{action}` |
| `restartReport` | 重启汇报 | `{time}` `{reason}` `{services}` `{selfcheck}` |
| `restartFailed` | 重启后没起来 | |
| `gaveUp` | 一小时内重启太多次，停手 | `{count}` |
| `patchRestored` / `patchDegraded` | 插件配置恢复 / 没有可用备份 | `{backup}` `{entries}` |
| `backupFailed` | 备份有失败 | `{job}` `{errors}` `{log}` |
| `trimDone` | 清理完成（`trim.notify` 打开时） | `{summary}` |

### 依赖的服务（`services`）

```json
{ "name": "QQ 后端", "port": 3000, "command": "D:/snowluma/node.exe", "args": ["index.mjs"], "cwd": "D:/snowluma", "startWaitSeconds": 15, "when": ["restart"] }
```

端口没在监听才会启动。`when` 里写 `restart` = 重启 DSH 后检查；写 `watch` = 每次心跳都检查（开机后也会被拉起来）。没写 `command` 的只报告。

### 备份（`backup.jobs`）

```json
"f-drive": {
  "dest": "F:/backups",
  "keepDays": 7,
  "notifyOnError": true,
  "items": [
    { "src": "${DSH_HOME}/sessions", "required": true },
    { "src": "F:/work", "exclude": ["node_modules", "/tmp", "/tmp-*"] },
    { "src": "F:/work/*.sh", "into": "scripts" },
    { "src": "F:/memory", "as": "auto-memory" },
    { "src": "${DSH_HOME}/storages/workspace.json", "into": "config" }
  ]
}
```

- `exclude`：不带 `/` 的（`node_modules`）在任何一层都排除；带 `/` 开头的（`/tmp`）只排除这一项的最上层。`*` 是通配符。
- `required: true` 的项找不到算失败；其他找不到就跳过。
- 清旧备份时**只删名字正好是 8 位数字的子文件夹**，目标文件夹本身和别的东西不会动。
- 再配一个计划任务每天跑它：`{ "id": "backup-f", "name": "DSHKeepalive-Backup-F", "run": ["backup", "f-drive"], "dailyAt": "04:30" }`

### 清理（`trim`）

```json
"trim": {
  "protect": ["F:/my-important-stuff"],
  "jobs": [ { "name": "抽帧", "path": "F:/shots/video", "olderThanDays": 7, "pattern": "*.jpg", "recurse": false } ]
}
```

`protect` 是**追加**到内置保护名单上的。一个清理项的文件夹只要是、包含、或者在受保护路径里面（链接会先解析到真实位置再判断），整项都会被拒绝；整个磁盘根目录也会被拒绝。

### 计划任务（`tasks`）

每项：`id`、`name`（任务名，可改）、`run`（命令和参数）、`everyMinutes` / `atLogon` + `logonDelaySeconds` / `dailyAt: "04:30"` / `onDemand`、`elevated`、`enabled`、`timeLimitMinutes`。`id` 为 `restart` 的那个会被心跳和急救调用。

---

## 安全设计

- 包里**没有任何秘密**；QQ 令牌和 QQ 号可以一直留在别的文件里，日志里也不会出现。
- **不运行 pnpm**，不改 profile 的 `cordis.patch.yml`（插件配置守护只会把它恢复成你自己的备份）。
- **不依赖 sharp 或任何原生模块**（插件自带的 sharp 会和 DSH 自己的冲突，之后每次发图都失败）。
- 安装、卸载、装进 DSH 都会**先列出要做的事并等你确认**；改 `package.json` 前先备份。
- 不覆盖、不删除不是自己生成的文件；卸载只删自己建的任务和小工具，配置、日志、备份都保留。
- `.cmd` 小工具内容是纯 ASCII（路径里有中文时按系统 ANSI 编码写，不用 `chcp`），中文提示由 node 打印，不会出现乱码切坏命令的问题。

## 卸载

```bash
dsh-keepalive uninstall          # 删计划任务和小工具，恢复被停用的旧任务
dsh-keepalive uninstall --purge  # 连 runtime 运行文件一起删
dsh-keepalive unlink-from-dsh    # 把宿主半边从 DSH 里拿掉（--purge 连插件文件夹一起删）
```

或者双击 **`卸载守护.cmd`**。以最高权限建的任务需要以管理员身份删除。

## 测试

```bash
npm test
```

在临时文件夹里跑 25 组测试（心跳的各种情况、重启限流、备份排除规则、清理的保护规则、cookie 清理、计划任务 XML、安装/卸载、装进 DSH、宿主半边、包里有没有秘密）。不会结束或启动任何真实进程，不建计划任务，不往外发消息。

## 许可

MIT
