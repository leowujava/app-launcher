# 应用启动管理 (App launcher)

在 DSH 右侧边栏读取工作区的 VS Code `launch.json`,把其中的启动配置当作可管理的应用:启动、停止、重启、查看日志,一键全部停止。面板、`/launch` 命令和 `launcher` 智能体工具共用同一套 Host 实例管理。面板在应用启动或运行期间每约 2.5 秒静默刷新状态；其余时间,智能体或其他会话启动的实例会在下一次手动刷新后出现。

## 面板位置

1. 打开右侧边栏,在引导页点击 **应用启动管理** 卡片(或直接切换 **应用启动** 标签页)。
2. 面板默认加载 `工作区/.vscode/launch.json`;也可以在上方输入其他路径后点 **加载**。
3. 每个配置显示类型、端口或 `mainClass`/工作目录、状态、进程号、已运行时长、CPU 占用与内存占用(CPU/内存取自 `/proc`,按该实例整棵进程树汇总,运行中每约 2.5 秒刷新),并提供 **启动/停止 · 重启 · 日志**。
4. 有实例运行时显示 **全部停止**,停止当前 launch 文件启动的所有应用;修改 `launch.json` 后点 **刷新** 重新读取。
5. 启动按钮立即返回,应用在后台继续就绪检测;状态、端口和日志会自动更新,超时或失败时行内显示原因。
6. 面板的读取和按钮操作走同源 HTTP 接口,不会在对话中插入 `/launch` 命令记录;只有手动输入 `/launch` 时才会看到命令结果。旧版面板产生的 `launch overview` 聊天记录会被隐藏,其余 `/launch` 结果压缩为单行摘要。

`launch.json` 支持 JSONC:注释和尾随逗号可以正常解析。

## 支持的启动配置

| type | 启动方式 | 主要字段 |
| --- | --- | --- |
| `java` | 在 `mainClass` 所属 Maven 模块执行 `mvn spring-boot:run`(模块内有 `mvnw` 时优先用 `./mvnw`) | `mainClass`、`vmArgs`、`args`、`cwd`/`module`(可选)、`port`(可选) |
| `node` / `pwa-node` | `runtimeExecutable` + `runtimeArgs`;没有 `runtimeExecutable` 时用 `program` 或 `npm run dev` | `cwd`、`runtimeExecutable`、`runtimeArgs`、`program`、`args`、`env`、`envFile`、`port`(可选) |
| `shell` / `bash` | 通过平台 shell 执行 `command` | `command`、`cwd`、`env`、`envFile`、`port`(可选) |

Node 配置的 `runtimeExecutable` 若写成绝对路径且在本机不存在,插件会按同名命令从 `PATH` 回退(例如 `/config/.nvm/.../npm` 回退到系统 `npm`),并在日志首行注明;完全找不到时该配置会直接标为不可启动。

通用字段:`name`、`type`、`request`(仅 `launch`)、`cwd`、`env`、`envFile`。字符串中可用 `${workspaceFolder}`、`${workspaceRoot}`、`${workspaceFolderBasename}`、`${env:NAME}`、`${userHome}`。

Java 配置没有写 `cwd` 时,插件在工作区内查找 `src/main/java/<mainClass 路径>.java`,把包含它的目录作为 Maven 模块目录,因此多模块仓库可直接复用现有 `launch.json`。模块必须能独立运行 `spring-boot:run`:兄弟模块若尚未安装到本地仓库,请先在仓库根执行一次 `mvn -DskipTests install`。

## 示例

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "java",
      "name": "Run Java SpiderServiceApplication",
      "request": "launch",
      "mainClass": "com.collect.spider.SpiderServiceApplication",
      "vmArgs": "-Dspring.profiles.active=local",
      "port": 8081
    },
    {
      "type": "node",
      "name": "Run Node.js Admin Web",
      "request": "launch",
      "cwd": "${workspaceFolder}/crawler-admin-web",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev"],
      "port": 5173
    }
  ]
}
```

`port` 是本插件扩展字段:给出后用它做就绪探测;若启动参数里没有出现 `server.port`,Java 配置还会追加 `--server.port=<port>`(这会覆盖 `application.yml` 中的端口,不需要改端口时请省略 `port`)。不写 `port` 时:Java 会尝试从模块 `application*.yml`/`properties` 读取 `server.port` 做端口探测,读不到则等待 Spring Boot 的就绪日志(`Started ... in ... seconds`、`Tomcat started on port` 等);Node/shell 在进程存活约 3 秒后视为运行中。

## 命令与工具

`/launch` 命令(右侧边栏面板和聊天输入框共用):

| 调用 | 作用 |
| --- | --- |
| `/launch overview [file]` | 当前配置 + 实例概览(JSON) |
| `/launch use <file>` | 切换并记住当前工作区的 launch 文件 |
| `/launch start <name> [--no-wait]` | 启动指定配置;`--no-wait` 立即返回并后台等待就绪 |
| `/launch stop <name|all>` | 停止指定配置或当前文件下全部运行中的应用 |
| `/launch restart <name> [--no-wait]` | 停止后重新启动;`--no-wait` 立即返回 |
| `/launch logs <name> [lines]` | 查看日志尾部(默认 100 行,最多 500) |

`launcher` 智能体工具提供同等的 `list`、`start`、`stop`、`restart`、`logs`、`stopAll`、`stopExternal` 动作;`file` 参数可指向任意 `launch.json`。

## 配置项

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `mvnPath` | `mvn` | Java 配置使用的 Maven 可执行文件 |
| `startTimeoutMs` | `180000` | Java 配置等待就绪的最长时间;超时后进程继续运行并在行内显示原因 |
| `nodeReadyTimeoutMs` | `20000` | Node/shell 等待就绪日志的时间,超时后存活进程按运行中处理 |
| `maxLogBytes` | `65536` | 每个实例保留的日志尾部大小 |
| `mavenOpts` | `""` | 追加到 `MAVEN_OPTS` 的 JVM 参数 |

## 限制

- Java 配置通过 Spring Boot Maven 插件启动,不适用于没有 `spring-boot-maven-plugin` 的普通 Java 程序,也不支持 `attach`、`compounds` 和调试断点。
- 面板 HTTP 接口只接受带 `x-app-launcher: 1` 头的同源 JSON POST,并按会话 ID 绑定当前工作区。
- 实例按插件激活周期跟踪。DSH 重启或插件重载后,之前启动且仍在运行的进程会按工作目录自动识别为 **外部运行**(行内显示进程号),可以直接停止;面板之外(如 VS Code、终端)启动的应用同样可见可停(`launcher` 工具的 `stopExternal` 动作可用 `list` 返回的 pids)。
- 包装进程意外退出而应用进程仍在运行时(例如 `mvn spring-boot:run` 的 JVM 在 mvn 退出后继续提供服务),面板会自动接管存活进程(状态「运行中 · 已接管」),仍可停止、重启。
- 插件卸载时只终止它正在跟踪的运行中实例;外部进程不受影响。
- 应用运行中修改或删除 `launch.json` 里的配置时,实例不会消失,会出现在 **此 launch.json 之外运行的应用** 区域,仍可停止和查看日志。
- 就绪判断基于端口或日志。端口被本插件以外的进程占用时可能被误判为已就绪;插件在启动前会检测显式 `port` 是否已被占用并直接报错。
- Java 配置未显式给出 `port` 时,插件会读取模块 `src/main/resources/application*.yml`/`properties` 里的 `server.port`(优先 `-Dspring.profiles.active` 对应的 profile 文件)用于就绪探测与端口冲突检测,不会修改应用实际端口;`launch.json` 中显式的 `port` 字段仍会追加 `--server.port` 并覆盖应用配置。
- 同一 `launch.json` 内配置名必须唯一;重名配置会以错误行显示且不能启动。
- 停止使用 SIGTERM 发送给进程组,10 秒后升级为 SIGKILL;强制结束可能跳过应用自身的优雅关闭逻辑。
- CPU 占用按 1 核百分比计,统计整棵进程树,多线程构建/高负载时可超过 100%;内存为进程树 RSS 之和,包含包装进程(mvn/npm)。首次采样后约 2.5 秒出现 CPU 数值。
- 不同应用的操作互相独立:一个应用启动/重启中,其他应用的按钮状态不受影响;同一应用上的并发操作(面板、/launch、launcher 工具)在宿主侧按配置串行执行,重启 = 停止 + 启动,期间该行的按钮保持「正在重启…」直到完成。
