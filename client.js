/**
 * Client half of the App launcher bundle: a right-sidebar tab that lists the
 * configurations of a VS Code launch.json and runs them. Every operation goes
 * through the `/launch` Host command (the same code path the `launcher` agent
 * tool uses), so the panel and the agent share one instance state.
 */
window.__ModuleLoader__.load({
  id: '@local/app-launcher',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const NS = 'appLauncher'
    const ID = '@local/app-launcher'

    const en = {
      title: 'App launcher',
      'guide.title': 'App launcher',
      'guide.description': 'Run the configurations of a VS Code launch.json',
      file: 'Launch file',
      load: 'Load',
      loading: 'Loading…',
      loaded: 'Loaded',
      refresh: 'Refresh',
      configs: 'Configurations',
      running: 'running',
      none: 'No configurations in this launch.json.',
      missing: 'launch.json not found. Put a .vscode/launch.json in the workspace, or enter another path above and load it.',
      parseError: 'Cannot read this launch.json:',
      draftDirty: 'The path above is not loaded. Click Load to switch; actions below apply to the loaded file.',
      idle: 'idle',
      start: 'Start',
      starting: 'Starting…',
      stop: 'Stop',
      stopping: 'Stopping…',
      restart: 'Restart',
      restarting: 'Restarting…',
      restartHint: 'Only a running application can restart',
      logs: 'Logs',
      logsHint: 'Start the application first',
      stopAll: 'Stop all',
      stopAllHint: 'Stop every application started from this launch file',
      logTitle: 'Logs ·',
      close: 'Close',
      reloadLogs: 'Reload',
      noLogs: '(no output yet)',
      expand: 'Fill panel',
      collapse: 'Collapse',
      orphanTitle: 'Running outside this launch.json',
      up: 'up',
      pid: 'pid',
      port: 'port',
      readinessPort: 'ready: port',
      readinessLog: 'ready: log',
      readinessAlive: 'ready: process',
      readinessAdopted: 'ready: re-adopted',
      'status.running': 'running',
      'status.starting': 'starting',
      'status.stopped': 'stopped',
      'status.failed': 'failed',
      'status.idle': 'idle',
      'status.unsupported': 'unsupported',
      'status.external': 'external',
      externalHint: 'started outside the panel; you can stop it here',
      'type.java': 'Java',
      'type.node': 'Node',
      'type.shell': 'Shell',
      memLabel: 'Mem',
      externalShort: '外部',
    }
    const zh = {
      title: '应用启动',
      'guide.title': '应用启动管理',
      'guide.description': '运行 VS Code launch.json 中声明的应用',
      file: '启动文件',
      load: '加载',
      loading: '加载中…',
      loaded: '已加载',
      refresh: '刷新',
      configs: '启动配置',
      running: '运行中',
      none: 'launch.json 中没有 configurations。',
      missing: '未找到 launch.json。请在工作区创建 .vscode/launch.json，或在上方输入其他路径后加载。',
      parseError: '无法读取该 launch.json：',
      draftDirty: '上方路径尚未加载。点击“加载”切换；下方操作作用于已加载的文件。',
      idle: '未运行',
      start: '启动',
      starting: '正在启动…',
      stop: '停止',
      stopping: '正在停止…',
      restart: '重启',
      restarting: '正在重启…',
      restartHint: '只有运行中的应用可以重启',
      logs: '日志',
      logsHint: '请先启动应用',
      stopAll: '全部停止',
      stopAllHint: '停止当前 launch 文件启动的所有应用',
      logTitle: '日志 ·',
      close: '关闭',
      reloadLogs: '重新加载',
      noLogs: '（暂无输出）',
      expand: '占满面板',
      collapse: '还原',
      orphanTitle: '此 launch.json 之外运行的应用',
      up: '已运行',
      pid: '进程',
      port: '端口',
      readinessPort: '就绪: 端口',
      readinessLog: '就绪: 日志',
      readinessAlive: '就绪: 进程',
      readinessAdopted: '就绪: 已接管',
      'status.running': '运行中',
      'status.starting': '启动中',
      'status.stopped': '已停止',
      'status.failed': '失败',
      'status.idle': '未运行',
      'status.unsupported': '不可启动',
      'status.external': '外部运行',
      externalHint: '面板之外启动，可直接停止',
      'type.java': 'Java',
      'type.node': 'Node',
      'type.shell': 'Shell',
    }

    const STYLE = `
.al-root{--al-actw:101px;display:flex;flex-direction:column;gap:12px;padding:0 14px 16px;box-sizing:border-box;height:100%;overflow-y:auto;font-size:13px;color:var(--dsw-alias-label-primary);scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2, var(--dsw-alias-border-l2)) transparent}
.al-root::-webkit-scrollbar{width:8px}
.al-root::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2, var(--dsw-alias-border-l2));border-radius:8px}
.al-root::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2, var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)))}
.al-root::-webkit-scrollbar-track{background:transparent}

/* ---- header (sticky) ---- */
.al-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:8px;padding:12px 0 10px;background:var(--dsw-alias-bg-base)}
.al-logo{width:26px;height:26px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.al-title{font-weight:600;font-size:14px;flex:1;letter-spacing:.01em}
.al-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;white-space:nowrap;padding:2px 9px 2px 7px;border-radius:999px;color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-2);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);border:1px solid transparent;border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, transparent)}
.al-badge-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}

/* ---- launch file ---- */
.al-file{display:flex;flex-direction:column;gap:5px}
.al-file-label{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.al-file-row{display:flex;gap:6px}
.al-file-input{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 8px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;transition:border-color .15s,box-shadow .15s}
.al-file-input:focus-visible{outline:none;border-color:var(--dsw-alias-label-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent)}
.al-file-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}

/* ---- messages ---- */
.al-error{border:1px solid var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 10px;font-size:12px;word-break:break-word;white-space:pre-wrap;line-height:1.45}
.al-hint{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5;word-break:break-word}

/* ---- section headers ---- */
.al-section{display:flex;align-items:center;gap:8px;padding-top:2px}
.al-section-title{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);flex:1}
.al-count{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}

/* ---- list & rows ---- */
.al-list{display:flex;flex-direction:column;gap:8px}
.al-row{display:flex;flex-direction:row;align-items:flex-start;gap:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;transition:border-color .15s,box-shadow .15s}
.al-row:hover{border-color:var(--dsw-alias-border-l2);box-shadow:0 1px 4px -2px rgba(0,0,0,.12)}
.al-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px}
.al-row-active{border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, var(--dsw-alias-border-l1));box-shadow:0 1px 6px -3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, transparent)}
.al-row-top{display:flex;align-items:center;gap:8px;min-width:0}
.al-dot{width:9px;height:9px;border-radius:50%;flex:none}
.al-dot-running{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent)}
.al-dot-external{background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent)}
.al-dot-starting{background:var(--dsw-alias-state-warn-primary);animation:al-pulse 1.3s ease-in-out infinite}
.al-dot-failed,.al-dot-unsupported{background:var(--dsw-alias-state-error-primary)}
.al-dot-stopped,.al-dot-idle{background:var(--dsw-alias-state-idle-primary)}
@keyframes al-pulse{0%,100%{opacity:1;box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 25%, transparent)}50%{opacity:.5;box-shadow:0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)}}
.al-name{font-weight:600;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.al-sub{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-left:17px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.al-row-error{font-size:11px;color:var(--dsw-alias-state-error-primary);word-break:break-word;padding-left:17px;line-height:1.4}

/* meta chips */
.al-chips{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding-left:17px;min-width:0}
.al-chip{display:inline-flex;align-items:center;font-size:10px;font-weight:600;line-height:1;padding:3px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap;letter-spacing:.02em}
.al-chip-type{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.al-chip-meta{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-weight:500}

/* status pill: content width, right-aligned inside the info column */
.al-pill{margin-left:auto;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;padding:2px 6px;border-radius:999px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid transparent;background:var(--dsw-alias-bg-layer-2)}
.al-pill-running{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent)}
.al-pill-starting{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent)}
.al-pill-external{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent)}
.al-pill-failed,.al-pill-unsupported{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)}
.al-pill-stopped,.al-pill-idle{color:var(--dsw-alias-label-secondary)}

/* ---- buttons ---- */
/* action block: dedicated right column, top-aligned with the app info (round button on the name row) */
.al-actions{flex:none;width:var(--al-actw);display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.al-actions-row{display:flex;gap:6px;align-items:center}
.al-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 10px;font-size:12px;font-weight:500;cursor:pointer;line-height:1.35;white-space:nowrap;transition:border-color .15s,background .15s,color .15s,transform .05s}
.al-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, var(--dsw-alias-bg-layer-2))}
.al-btn:active:not(:disabled){transform:translateY(1px)}
.al-btn:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
.al-btn:disabled{opacity:.45;cursor:default}
.al-btn-main{flex:1;background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb, var(--dsw-alias-label-primary) 35%, transparent);color:var(--dsw-alias-label-primary);font-weight:600}
.al-btn-main:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary) 18%, var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary)}
.al-btn-stop{flex:1;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 38%, transparent);color:var(--dsw-alias-state-error-primary);font-weight:600}
.al-btn-stop:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.al-btn-ghost{background:transparent;flex:none}
.al-btn-ghost:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.al-btn-danger{flex:none;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 38%, transparent);color:var(--dsw-alias-state-error-primary);font-weight:600}
.al-btn-danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.al-btn-head{flex:none;padding:4px 11px}
.al-btn-round{flex:none;width:auto;max-width:100%;overflow:hidden;text-overflow:ellipsis;border-radius:999px;padding:6px 20px;font-weight:600}
.al-ibtn{flex:none;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;cursor:pointer;transition:border-color .15s,background .15s,color .15s,transform .05s}
.al-ibtn:hover:not(:disabled){border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, var(--dsw-alias-bg-layer-2))}
.al-ibtn:active:not(:disabled){transform:translateY(1px)}
.al-ibtn:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
.al-ibtn:disabled{opacity:.4;cursor:default}

/* ---- logs ---- */
.al-logs{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:10px;padding:10px 12px}
.al-logs-expanded{position:sticky;bottom:12px;z-index:2;height:calc(100vh - 60px)}
@supports (height:100dvh){.al-logs-expanded{height:calc(100dvh - 60px)}}
.al-logs-head{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.al-logs-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.al-logs-actions{display:flex;gap:4px;flex:none}
.al-log-message{font-size:11px;color:var(--dsw-alias-state-warn-primary);margin-bottom:6px;word-break:break-word}
/* The log box keeps a fixed height (roughly half the viewport, clamped) so
   it is fully visible the moment the log opens, even before content loads.
   The Fill-panel toggle switches the pre to flex-grow to fill the full pane. */
.al-pre{margin:0;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;height:clamp(320px,calc(55vh - 160px),560px);overflow-y:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2, var(--dsw-alias-border-l2)) transparent}
.al-logs-expanded .al-pre{flex:1 1 0;min-height:0;height:auto}
.al-pre::-webkit-scrollbar{width:8px}
.al-pre::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2, var(--dsw-alias-border-l2));border-radius:8px}
.al-pre:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}

/* ---- empty ---- */
.al-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:16px 10px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}

/* ---- /launch chat rows ---- */
.al-cmd{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 0}
.al-cmd-name{font-weight:600;color:var(--dsw-alias-label-primary)}
.al-cmd-summary{flex:1 1 100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

    function fmtUp(ms) {
      if (ms === undefined || ms === null) return ''
      const s = Math.max(0, Math.round(ms / 1000))
      if (s < 60) return `${s}s`
      const m = Math.floor(s / 60)
      if (m < 60) return `${m}m ${s % 60}s`
      return `${Math.floor(m / 60)}h ${m % 60}m`
    }

    /** 16px launch glyph: a play mark between braces, for the tab and guide. */
    function LaunchGlyph({ size = 16, className }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 36 36', fill: 'none', 'aria-hidden': true, className,
      },
        h('path', {
          d: 'M11.5 5.5C8.6 5.5 8 7.4 8 10v3.2c0 2.3-1.4 3.6-3 4.8 1.6 1.2 3 2.5 3 4.8V26c0 2.6.6 4.5 3.5 4.5',
          stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M24.5 5.5c2.9 0 3.5 1.9 3.5 4.5v3.2c0 2.3 1.4 3.6 3 4.8-1.6 1.2-3 2.5-3 4.8V26c0 2.6-.6 4.5-3.5 4.5',
          stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', { d: 'M14.4 13.2 L23.4 18 L14.4 22.8 Z', fill: 'currentColor' }),
      )
    }

    /**
     * Hide the panel's own legacy /launch overview receipts: they were a
    /** Feather-style inline icons for the compact icon buttons. */
    const ICON_PATHS = {
      refresh: ['M23 4v6h-6', 'M1 20v-6h6', 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10', 'M1 14l4.64 4.36A9 9 0 0 0 20.49 15'],
      restart: ['M23 4v6h-6', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10'],
      logs: ['M4 17l6-6-6-6', 'M12 19h8'],
      close: ['M18 6L6 18', 'M6 6l12 12'],
      expand: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
      collapse: ['M4 14h6v6', 'M20 10h-6V4', 'M14 10l7-7', 'M3 21l7-7'],
    }
    function SvgIcon({ name, size = 14 }) {
      const paths = ICON_PATHS[name] || []
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        paths.map((d) => h('path', { d, stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' })))
    }

    /**
     * Hide the panel's own legacy /launch overview receipts: they were a
     * status-transport artifact, not a user-visible command. Other /launch
     * subcommands keep a compact row.
     */
    function LaunchCommandRow({ node }) {
      const args = typeof node.args === 'string' ? node.args.trim() : ''
      const text = node.outcome !== null && node.outcome !== undefined && typeof node.outcome.text === 'string' ? node.outcome.text : ''
      if (args === 'overview' || text.includes('"op":"overview"')) return null
      let summary = text
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text)
          summary = typeof parsed.message === 'string' ? parsed.message
            : typeof parsed.op === 'string' ? parsed.op
              : parsed.ok === false ? 'failed' : 'done'
        } catch { /* keep the raw text */ }
      }
      return h('div', { className: 'al-cmd' },
        h('span', { className: 'al-cmd-name' }, node.name ?? 'launch'),
        h('span', {}, node.outcome !== null && node.outcome !== undefined ? node.outcome.kind : 'running'),
        summary.length > 0 ? h('span', { className: 'al-cmd-summary' }, summary) : null,
      )
    }

    function Panel({ sessionId, callApi, active, t }) {
      const [data, setData] = useState(null)
      const [fileInput, setFileInput] = useState('')
      const [error, setError] = useState(null)
      // Per-row operation state: operating one app must not change the
      // buttons of rows that are starting/restarting on their own.
      const [rowOps, setRowOps] = useState({})
      const [globalOp, setGlobalOp] = useState(null)
      const anyBusy = globalOp !== null || Object.keys(rowOps).length > 0
      const isBusy = anyBusy
      const [logView, setLogView] = useState(null)
      const [logFill, setLogFill] = useState(false)
      const alive = useRef(true)
      const lastLoadAt = useRef(0)
      const dataRef = useRef(null)
      const fileInputRef = useRef('')
      const logRefData = useRef(null)
      const polling = useRef(false)
      const logBusy = useRef(false)
      const logRef = useRef(null)
      const preRef = useRef(null)
      // Follow the log tail while the user's scroll position stays at the
      // bottom of the pane; scrolling up detaches until they return to it.
      const stickBottom = useRef(true)
      // rAF id of the running smooth-follow animation (0 when idle).
      const lerpId = useRef(0)
      const cancelFollow = () => {
        if (lerpId.current !== 0) cancelAnimationFrame(lerpId.current)
        lerpId.current = 0
      }
      // Smoothly pin the pane to the tail: an exponential approach, so new
      // content landing mid-flight extends the motion instead of a second
      // jump. Any user input (wheel, pointer, touch, key) cancels the
      // animation and hands the viewport back to the user.
      const followToBottom = useCallback(() => {
        cancelFollow()
        const el = preRef.current
        if (el === null) return
        if (typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          el.scrollTop = el.scrollHeight
          return
        }
        const step = () => {
          const node = preRef.current
          if (node === null) { lerpId.current = 0; return }
          const gap = node.scrollHeight - node.clientHeight - node.scrollTop
          if (gap <= 1) { lerpId.current = 0; return }
          node.scrollTop = Math.ceil(node.scrollTop + gap * 0.3)
          lerpId.current = requestAnimationFrame(step)
        }
        lerpId.current = requestAnimationFrame(step)
      }, [])
      useEffect(() => () => cancelFollow(), [])

      useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])
      useEffect(() => { fileInputRef.current = fileInput }, [fileInput])
      useEffect(() => { logRefData.current = logView }, [logView])

      const applyOverview = useCallback((res, opts = {}) => {
        if (res === null || typeof res !== 'object') return
        dataRef.current = res
        setData(res)
        if (opts.syncInput === true && typeof res.file === 'string') setFileInput(res.file)
        if (opts.clearLog === true) setLogView(null)
        if (opts.clearError !== false) setError(null)
      }, [])

      const load = useCallback(async (force, opts = {}) => {
        if (sessionId === undefined) return
        const now = Date.now()
        if (!force && now - lastLoadAt.current < 60000) return
        lastLoadAt.current = now
        try {
          const res = await callApi({ op: 'overview' })
          if (!alive.current) return
          const typed = fileInputRef.current.trim()
          const syncInput = opts.forceInput === true
            || (opts.syncInput === true && (typed === '' || typed === res.file))
          applyOverview(res, {
            syncInput,
            clearError: opts.clearError !== false,
            clearLog: opts.clearLog === true,
          })
        } catch (e) {
          if (alive.current) setError(e instanceof Error ? e.message : String(e))
        }
      }, [callApi, applyOverview])

      // Background status refresh for the panel; it never rewrites the path
      // draft and never clears an error the user should still see.
      const refreshSilent = useCallback(async () => {
        if (dataRef.current === null || polling.current) return
        polling.current = true
        try {
          const res = await callApi({ op: 'overview' })
          if (alive.current) applyOverview(res, { clearError: false })
        } catch { /* background refresh is best-effort */ }
        finally { polling.current = false }
      }, [callApi, applyOverview])

      useEffect(() => { void load(false, { syncInput: true }) }, [load])
      useEffect(() => { if (active === true) void refreshSilent() }, [active, refreshSilent])

      const refresh = useCallback(async () => {
        setGlobalOp('refresh')
        setError(null)
        await load(true, { forceInput: true, syncInput: true, clearError: true })
        if (alive.current) setGlobalOp(null)
      }, [load])

      const useFile = useCallback(async (path) => {
        const target = path.trim()
        if (target === '') return false
        setGlobalOp('file')
        setError(null)
        try {
          const res = await callApi({ op: 'use', file: target })
          if (!alive.current) return false
          applyOverview(res, { syncInput: true, clearLog: true })
          lastLoadAt.current = Date.now()
          return true
        } catch (e) {
          if (alive.current) setError(e instanceof Error ? e.message : String(e))
          return false
        } finally {
          if (alive.current) setGlobalOp(null)
        }
      }, [callApi, applyOverview])

      const applyInstance = useCallback((res) => {
        if (res === null || typeof res !== 'object') return
        const inst = res.instance
        if (inst === undefined || inst === null || typeof inst !== 'object' || typeof inst.key !== 'string') return
        setData((prev) => {
          if (prev === null) return prev
          const list = Array.isArray(prev.instances) ? prev.instances.slice() : []
          const i = list.findIndex((x) => x.key === inst.key)
          if (i === -1) list.push(inst)
          else list[i] = inst
          const next = { ...prev, instances: list }
          dataRef.current = next
          return next
        })
      }, [])

      const doOp = useCallback(async (cfg, op, payload) => {
        const key = cfg !== null && typeof cfg === 'object' && typeof cfg.key === 'string' ? cfg.key : null
        if (key === null) setGlobalOp(op === 'stop-all' ? 'stopAll' : op)
        else setRowOps((m) => ({ ...m, [key]: op }))
        setError(null)
        try {
          const res = await callApi(payload)
          if (!alive.current) return
          if (res !== null && typeof res === 'object') {
            if (Array.isArray(res.instances)) {
              setData((prev) => {
                if (prev === null) return prev
                const next = { ...prev, instances: res.instances }
                dataRef.current = next
                return next
              })
            } else {
              applyInstance(res)
            }
            if (typeof res.logs === 'string' && cfg !== null && typeof cfg.name === 'string') {
              setLogView({ name: cfg.name, lines: res.logs, message: res.message })
              setLogFill(false)
            }
            if (res.ok === false && typeof res.message === 'string') setError(res.message)
            else { lastLoadAt.current = 0; void refreshSilent() }
          }
        } catch (e) {
          if (alive.current) setError(e instanceof Error ? e.message : String(e))
        } finally {
          if (alive.current) {
            if (key === null) setGlobalOp(null)
            else setRowOps((m) => { const n = { ...m }; delete n[key]; return n })
          }
        }
      }, [callApi, applyInstance])

      const start = useCallback((cfg) => {
        void doOp(cfg, 'start', { op: 'start', name: cfg.name })
      }, [doOp])
      const stop = useCallback((cfg) => {
        void doOp(cfg, 'stop', { op: 'stop', name: cfg.name })
      }, [doOp])
      const restart = useCallback((cfg) => {
        void doOp(cfg, 'restart', { op: 'restart', name: cfg.name })
      }, [doOp])
      const stopAll = useCallback(() => {
        void doOp({ name: 'all', key: null }, 'stop-all', { op: 'stopAll' })
      }, [doOp])

      const fetchLogs = useCallback(async (name) => {
        if (logBusy.current) return
        logBusy.current = true
        try {
          const res = await callApi({ op: 'logs', name, lines: 150 })
          if (!alive.current) return
          applyInstance(res)
          setLogView((cur) => (cur !== null && cur.name === name
            ? {
                name,
                lines: typeof res.lines === 'string' ? res.lines : cur.lines,
                message: typeof res.message === 'string' ? res.message : undefined,
              }
            : cur))
        } catch (e) {
          if (alive.current) setError(e instanceof Error ? e.message : String(e))
        } finally {
          logBusy.current = false
        }
      }, [callApi, applyInstance])

      const openLogs = useCallback((name) => {
        if (logView !== null && logView.name === name) { setLogView(null); setLogFill(false); return }
        setLogView({ name, lines: '', message: undefined })
        setLogFill(false)
        void fetchLogs(name)
      }, [logView, fetchLogs])

      const reloadLogs = useCallback(() => {
        const current = logRefData.current
        if (current !== null && current.name) return fetchLogs(current.name)
        return Promise.resolve()
      }, [fetchLogs])

      const logName = logView !== null ? logView.name : null

      useEffect(() => {
        if (logName === null) return undefined
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') void reloadLogs()
        }, 3_000)
        return () => clearInterval(timer)
      }, [logName, reloadLogs])

      useEffect(() => {
        if (logName === null) return
        stickBottom.current = true
        followToBottom()
        // Align the card's bottom (the latest lines) with the panel bottom.
        logRef.current?.scrollIntoView({ block: 'end' })
      }, [logName, followToBottom])

      // Grow/shrink (Fill-panel toggle) changes the card's flow height, which
      // reflows the panel scroll. Re-anchor the view to the latest lines:
      // the panel aligns to the card bottom and the pane re-follows the tail
      // when the user was following; a detached (scrolled-up) pane keeps its
      // reading position untouched.
      useEffect(() => {
        if (logName === null) return
        logRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
        if (stickBottom.current) followToBottom()
      }, [logFill, followToBottom])

      const logLines = logView !== null ? logView.lines : null

      // Keep the pane pinned to the tail when new log content arrives while
      // the user's scroll position is at (or near) the bottom.
      useEffect(() => {
        if (logName === null || !stickBottom.current) return
        followToBottom()
      }, [logLines, logName, followToBottom])

      const configs = data !== null && Array.isArray(data.configs) ? data.configs : []
      const instances = data !== null && Array.isArray(data.instances) ? data.instances : []
      const knownKeys = new Set(configs.map((c) => c.key))
      const orphans = instances.filter((i) => !knownKeys.has(i.key))
      const instanceOf = (key) => instances.find((i) => i.key === key)
      const running = instances.filter((i) => i.status === 'running' || i.status === 'starting').length
      const externalAny = configs.some((c) => c.external !== undefined && c.external !== null)
      const hasLive = running > 0 || externalAny
      const loading = data === null && error === null
      const fileError = data !== null && typeof data.error === 'string' ? data.error : null
      const missing = data !== null && data.exists === false && data.errorCode === 'missing'
      const draftDirty = data !== null && fileInput.trim() !== '' && fileInput.trim() !== data.file

      useEffect(() => {
        if (!hasLive) return undefined
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') void refreshSilent()
        }, 2_500)
        return () => clearInterval(timer)
      }, [hasLive, refreshSilent])

      useEffect(() => {
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void refreshSilent()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [refreshSilent])

      const logBlock = logView === null ? null : h('div', { className: `al-logs${logFill ? ' al-logs-expanded' : ''}`, ref: logRef },
        h('div', { className: 'al-logs-head' },
          h('span', { className: 'al-logs-title' }, `${t('logTitle')} ${logView.name}`),
          h('span', { className: 'al-logs-actions' },
            h('button', {
              type: 'button', className: 'al-ibtn',
              'aria-label': logFill ? t('collapse') : t('expand'), title: logFill ? t('collapse') : t('expand'),
              'aria-pressed': logFill,
              onClick: () => setLogFill((v) => !v),
            }, h(SvgIcon, { name: logFill ? 'collapse' : 'expand' })),
            h('button', {
              type: 'button', className: 'al-ibtn',
              'aria-label': t('reloadLogs'), title: t('reloadLogs'),
              onClick: () => void reloadLogs(),
            }, h(SvgIcon, { name: 'refresh' })),
            h('button', {
              type: 'button', className: 'al-ibtn',
              'aria-label': t('close'), title: t('close'),
              onClick: () => { setLogView(null); setLogFill(false) },
            }, h(SvgIcon, { name: 'close' })),
          ),
        ),
        logView.message !== undefined && logView.message !== null && logView.message !== ''
          ? h('div', { className: 'al-log-message' }, logView.message)
          : null,
        h('pre', {
          className: 'al-pre', role: 'log', 'aria-live': 'polite', tabIndex: 0,
          'aria-label': `${t('logTitle')} ${logView.name}`,
          ref: preRef,
          onScroll: (e) => {
            const el = e.currentTarget
            stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 8
          },
          // User input takes over the viewport: stop the smooth follow.
          onWheel: cancelFollow,
          onPointerDown: cancelFollow,
          onTouchStart: cancelFollow,
          onKeyDown: cancelFollow,
        }, logView.lines.length > 0 ? logView.lines : t('noLogs')),
      )

      const stopExternal = (cfg) => {
        void doOp(cfg, 'stop', { op: 'stopExternal', name: cfg.name, pids: cfg.external.pids })
      }

      const configRows = configs.map((cfg) => {
        const inst = instanceOf(cfg.key)
        const isActive = inst !== undefined && (inst.status === 'running' || inst.status === 'starting')
        const isExternal = !isActive && cfg.external !== undefined && cfg.external !== null
          && Array.isArray(cfg.external.pids) && cfg.external.pids.length > 0
        const statusKey = !cfg.supported ? 'unsupported' : (inst !== undefined ? inst.status : (isExternal ? 'external' : 'idle'))
        const myOp = rowOps[cfg.key]
        const rowLocked = myOp !== undefined || globalOp !== null
        const chips = []
        const typeKey = `type.${cfg.type}`
        const typeLabel = t(typeKey)
        chips.push(h('span', { className: 'al-chip al-chip-type', key: 'type' }, typeLabel === typeKey ? cfg.type : typeLabel))
        if (cfg.port !== null && cfg.port !== undefined) chips.push(h('span', { className: 'al-chip al-chip-meta', key: 'port' }, `${t('port')} ${cfg.port}`))
        if (inst !== undefined && inst.pid !== undefined && inst.pid !== null) chips.push(h('span', { className: 'al-chip al-chip-meta', key: 'pid' }, `${t('pid')} ${inst.pid}`))
        if (inst !== undefined && inst.uptimeMs !== undefined) chips.push(h('span', { className: 'al-chip al-chip-meta', key: 'up' }, `${t('up')} ${fmtUp(inst.uptimeMs)}`))
        if (inst !== undefined && inst.cpuPct !== undefined && inst.cpuPct !== null) chips.push(h('span', { className: 'al-chip al-chip-meta', key: 'cpu', title: 'CPU usage of one core' }, `CPU ${inst.cpuPct}%`))
        if (inst !== undefined && inst.memMb !== undefined && inst.memMb !== null) chips.push(h('span', { className: 'al-chip al-chip-meta', key: 'mem' }, `${t('memLabel')} ${inst.memMb}MB`))
        if (isExternal) chips.push(h('span', { className: 'al-chip al-chip-meta', key: 'ext', title: t('externalHint') }, `${t('externalShort')} pid ${cfg.external.pids.join(', ')}`))
        if (inst !== undefined && inst.readiness) {
          const key = `readiness${inst.readiness.charAt(0).toUpperCase()}${inst.readiness.slice(1)}`
          const label = t(key)
          if (label !== key) chips.push(h('span', { className: 'al-chip', key: 'ready' }, label))
        }
        const sub = cfg.mainClass || cfg.cwd || ''
        const reason = cfg.error !== null && cfg.error !== undefined && cfg.error !== ''
          ? cfg.error
          : (inst !== undefined && inst.failReason ? inst.failReason : null)
        const actionDisabled = rowLocked || draftDirty || !cfg.supported
        const mainLabel = myOp === 'restart' ? t('restarting')
          : myOp === 'start' ? t('starting')
            : myOp === 'stop' ? t('stopping')
              : (isActive || isExternal) ? t('stop') : t('start')
        const mainAria = myOp === 'restart' ? t('restarting') : (isActive || isExternal) ? t('stop') : t('start')
        const mainVariant = (isActive || isExternal || myOp === 'stop') ? 'al-btn-stop' : 'al-btn-main'
        const row = h('div', { className: `al-row${statusKey === 'running' ? ' al-row-active' : ''}`, key: cfg.key },
          h('div', { className: 'al-info' },
            h('div', { className: 'al-row-top' },
              h('span', { className: `al-dot al-dot-${statusKey}`, 'aria-hidden': true }),
              h('span', { className: 'al-name', title: cfg.name }, cfg.name),
              h('span', { className: `al-pill al-pill-${statusKey}` }, t(`status.${statusKey}`)),
            ),
            sub !== '' ? h('div', { className: 'al-sub', title: sub }, sub) : null,
            chips.length > 0 ? h('div', { className: 'al-chips' }, chips) : null,
            reason !== null ? h('div', { className: 'al-row-error' }, reason) : null,
          ),
          h('div', { className: 'al-actions' },
            h('button', {
              type: 'button', className: `al-btn al-btn-round ${mainVariant}`,
              disabled: actionDisabled,
              'aria-label': `${mainAria} ${cfg.name}`,
              'aria-busy': myOp !== undefined,
              title: cfg.supported ? undefined : cfg.error,
              onClick: () => (isActive ? stop(cfg) : (isExternal ? stopExternal(cfg) : start(cfg))),
            }, mainLabel),
            h('div', { className: 'al-actions-row' },
              h('button', {
                type: 'button', className: 'al-ibtn',
                disabled: actionDisabled || !isActive,
                'aria-label': `${t('restart')} ${cfg.name}`,
                'aria-busy': myOp === 'restart',
                title: `${t('restart')}${isActive ? '' : ' · ' + t('restartHint')}`,
                onClick: () => restart(cfg),
              }, h(SvgIcon, { name: 'restart' })),
              h('button', {
                type: 'button', className: 'al-ibtn',
                disabled: draftDirty || inst === undefined,
                'aria-label': `${t('logs')} ${cfg.name}`,
                title: `${t('logs')}${inst === undefined ? ' · ' + t('logsHint') : ''}`,
                onClick: () => openLogs(cfg.name),
              }, h(SvgIcon, { name: 'logs' })),
            ),
          ),
        )
        return h(React.Fragment, { key: cfg.key },
          row,
          logView !== null && logView.name === cfg.name ? logBlock : null,
        )
      })

      const orphanRows = orphans.map((inst) => {
        const statusKey = inst.status
        const chips = []
        if (inst.port !== undefined && inst.port !== null) chips.push(h('span', { className: 'al-chip al-chip-meta', key: 'port' }, `${t('port')} ${inst.port}`))
        if (inst.pid !== undefined && inst.pid !== null) chips.push(h('span', { className: 'al-chip al-chip-meta', key: 'pid' }, `${t('pid')} ${inst.pid}`))
        if (inst.uptimeMs !== undefined) chips.push(h('span', { className: 'al-chip al-chip-meta', key: 'up' }, `${t('up')} ${fmtUp(inst.uptimeMs)}`))
        if (inst.cpuPct !== undefined && inst.cpuPct !== null) chips.push(h('span', { className: 'al-chip al-chip-meta', key: 'cpu' }, `CPU ${inst.cpuPct}%`))
        if (inst.memMb !== undefined && inst.memMb !== null) chips.push(h('span', { className: 'al-chip al-chip-meta', key: 'mem' }, `${t('memLabel')} ${inst.memMb}MB`))
        const sub = inst.cwd || ''
        const myOp = rowOps[inst.key]
        const stopDisabled = myOp !== undefined || globalOp !== null || draftDirty || (inst.status !== 'running' && inst.status !== 'starting')
        const row = h('div', { className: `al-row${statusKey === 'running' ? ' al-row-active' : ''}`, key: `orphan-${inst.key}` },
          h('div', { className: 'al-info' },
            h('div', { className: 'al-row-top' },
              h('span', { className: `al-dot al-dot-${statusKey}`, 'aria-hidden': true }),
              h('span', { className: 'al-name', title: inst.name }, inst.name),
              h('span', { className: `al-pill al-pill-${statusKey}` }, t(`status.${statusKey}`)),
            ),
            sub !== '' ? h('div', { className: 'al-sub', title: sub }, sub) : null,
            chips.length > 0 ? h('div', { className: 'al-chips' }, chips) : null,
            inst.failReason ? h('div', { className: 'al-row-error' }, inst.failReason) : null,
          ),
          h('div', { className: 'al-actions' },
            h('button', {
              type: 'button', className: 'al-btn al-btn-round al-btn-stop',
              disabled: stopDisabled,
              'aria-label': `${t('stop')} ${inst.name}`,
              'aria-busy': myOp === 'stop',
              onClick: () => void doOp(inst, 'stop', { op: 'stop', name: inst.name }),
            }, myOp === 'stop' ? t('stopping') : t('stop')),
            h('div', { className: 'al-actions-row' },
              h('button', {
                type: 'button', className: 'al-ibtn',
                disabled: draftDirty,
                'aria-label': `${t('logs')} ${inst.name}`,
                title: t('logs'),
                onClick: () => openLogs(inst.name),
              }, h(SvgIcon, { name: 'logs' })),
            ),
          ),
        )
        return h(React.Fragment, { key: `orphan-${inst.key}` },
          row,
          logView !== null && logView.name === inst.name ? logBlock : null,
        )
      })

      const logShown = logView !== null && (
        configs.some((c) => c.name === logView.name) || orphans.some((o) => o.name === logView.name)
      )

      return h('div', { className: 'al-root', 'aria-busy': isBusy },
        h('style', { 'data-plugin-css': 'app-launcher' }, STYLE),
        h('div', { className: 'al-head' },
          h('span', { className: 'al-logo', 'aria-hidden': true }, h(LaunchGlyph, { size: 15 })),
          h('span', { className: 'al-title' }, t('title')),
          running > 0
            ? h('span', { className: 'al-badge', title: t('stopAllHint') },
              h('span', { className: 'al-badge-dot', 'aria-hidden': true }),
              `${running} ${t('running')}`,
            )
            : null,
          h('button', {
            type: 'button', className: 'al-ibtn', title: t('refresh'), 'aria-label': t('refresh'),
            disabled: isBusy, 'aria-busy': globalOp === 'refresh',
            onClick: () => void refresh(),
          }, h(SvgIcon, { name: 'refresh' })),
        ),
        h('div', { className: 'al-file' },
          h('label', { className: 'al-file-label', htmlFor: 'al-file-input' }, t('file')),
          h('div', { className: 'al-file-row' },
            h('input', {
              id: 'al-file-input', className: 'al-file-input', value: fileInput, spellCheck: false,
              placeholder: '${workspaceFolder}/.vscode/launch.json',
              'aria-invalid': error !== null || fileError !== null,
              'aria-describedby': error !== null ? 'al-op-error' : (fileError !== null ? 'al-file-error' : undefined),
              onChange: (e) => setFileInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') void useFile(fileInput.trim()) },
            }),
            h('button', {
              type: 'button', className: 'al-btn',
              disabled: isBusy || fileInput.trim().length === 0,
              onClick: () => void useFile(fileInput.trim()),
            }, globalOp === 'file' ? t('loading') : t('load')),
          ),
          draftDirty
            ? h('div', { className: 'al-hint' }, `${t('draftDirty')} ${t('loaded')}: ${data.file}`)
            : null,
        ),
        error !== null
          ? h('div', { className: 'al-error', role: 'alert', id: 'al-op-error' }, error)
          : null,
        fileError !== null && !missing
          ? h('div', { className: 'al-error', role: 'alert', id: 'al-file-error' }, `${t('parseError')} ${fileError}`)
          : null,
        missing ? h('div', { className: 'al-hint' }, t('missing')) : null,
        h('div', { className: 'al-section' },
          h('span', { className: 'al-section-title' }, t('configs')),
          h('span', { className: 'al-count' }, `${configs.length}`),
          running > 0
            ? h('button', {
                type: 'button', className: 'al-btn al-btn-danger', disabled: isBusy || draftDirty,
                title: t('stopAllHint'),
                onClick: stopAll,
              }, globalOp === 'stopAll' ? t('stopping') : t('stopAll'))
            : null,
        ),
        loading
          ? h('div', { className: 'al-empty' }, t('loading'))
          : (configs.length === 0
            ? (missing || fileError !== null || error !== null ? null : h('div', { className: 'al-empty' }, t('none')))
            : h('div', { className: 'al-list' }, configRows)),
        orphans.length > 0
          ? h('div', {},
            h('div', { className: 'al-section' },
              h('span', { className: 'al-section-title' }, `${t('orphanTitle')} (${orphans.length})`),
            ),
            h('div', { className: 'al-list' }, orphanRows),
          )
          : null,
        logView !== null && !logShown ? logBlock : null,
      )
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'app-launcher: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: 'launcher',
          priority: 'extension',
          title: () => t('title'),
          guide: [{
            id: 'launcher',
            order: 41,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
            icon: LaunchGlyph,
          }],
        }), 'app-launcher: sidebar tab type')

        ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview',
          key: 'launch',
        }, LaunchCommandRow))

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
          locale: NS,
          inject: (sessionId) => ({
            sessionId,
            callApi: (payload, signal) => (async () => {
              if (sessionId === undefined) throw new Error('session is unavailable')
              let response
              try {
                response = await fetch('/app-launcher/api', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', 'x-app-launcher': '1' },
                  body: JSON.stringify({ sessionId, ...payload }),
                  signal,
                })
              } catch (e) {
                if (signal !== undefined && signal.aborted) throw new Error('request aborted')
                throw new Error(e instanceof Error ? e.message : 'launcher request failed')
              }
              let data = null
              try { data = await response.json() } catch { /* malformed body handled below */ }
              if (!response.ok || data === null || data.ok !== true) {
                const message = data !== null && typeof data === 'object' && data.error !== undefined && data.error !== null
                  && typeof data.error.message === 'string' ? data.error.message : ''
                throw new Error(message.length > 0 ? message : `launcher request failed (${response.status})`)
              }
              return data.value
            })(),
          }),
        }, Panel))
      },
    }
  },
})
