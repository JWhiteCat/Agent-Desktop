export const terminalMessages: Record<string, string> = {
  '未找到可用终端，请安装 x-terminal-emulator、GNOME Terminal、Konsole 或 xterm。': 'No supported terminal found. Install x-terminal-emulator, GNOME Terminal, Konsole, or xterm.',
  '终端启动确认超时；终端可能仍会稍后打开，请检查后再试。': 'Terminal launch confirmation timed out. The terminal may still open later; check before trying again.',
  '工作目录不存在：{path}': 'Working directory does not exist: {path}',
  '未找到程序：{program}': 'Program not found: {program}',
  '终端启动程序缺失，请重新构建或安装应用。': 'The terminal runner is missing. Rebuild or reinstall the application.',
  '命令已结束，退出码': 'Command finished with exit code',
  '命令启动失败': 'Command failed to start',
  '命令启动失败：{message}': 'Command failed to start: {message}',
  '按 Enter 关闭终端。': 'Press Enter to close the terminal.',
  '自定义命令不可用或已隐藏。': 'The custom command is unavailable or hidden.',
  '未找到会话或所属项目。': 'The session or its project was not found.'
}
