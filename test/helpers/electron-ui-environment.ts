// Native desktop runners can open Electron directly. Linux needs a graphical
// session (or an explicitly supplied Xvfb display); headless npm test skips these
// UI checks rather than silently disabling Chromium's sandbox to launch them.
export const canRunElectronUi = process.platform === 'win32' || process.platform === 'darwin'
  || (process.platform === 'linux' && !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY))
