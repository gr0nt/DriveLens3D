const { contextBridge, ipcRenderer } = require('electron');

let _progressCb = null;
ipcRenderer.on('scan-progress', (_e, data) => { if (_progressCb) _progressCb(data); });

contextBridge.exposeInMainWorld('api', {
  // ── Core scanning ────────────────────────────────────────────────────────────
  scanDrive:              (drivePath)       => ipcRenderer.invoke('scan-drive', drivePath),
  listDrives:             ()                => ipcRenderer.invoke('list-drives'),
  listFonts:              ()                => ipcRenderer.invoke('list-fonts'),
  getRuntimeCapabilities: ()                => ipcRenderer.invoke('get-runtime-capabilities'),

  // ── Scan progress ────────────────────────────────────────────────────────────
  onScanProgress:  (cb) => { _progressCb = cb; },
  offScanProgress: ()   => { _progressCb = null; },

  // ── File-system operations ───────────────────────────────────────────────────
  openInExplorer: (folderPath)        => ipcRenderer.invoke('open-in-explorer', folderPath),
  fsRename:       (oldPath, newName)  => ipcRenderer.invoke('fs-rename', oldPath, newName),
  fsDelete:       (filePath)          => ipcRenderer.invoke('fs-delete', filePath),
  fsCopy:         (filePath)          => ipcRenderer.invoke('fs-copy',   filePath),
  fsCut:          (filePath)          => ipcRenderer.invoke('fs-cut',    filePath),
  fsProperties:   (filePath)          => ipcRenderer.invoke('fs-properties', filePath),
  fsSmart:        ()                  => ipcRenderer.invoke('fs-smart'),
  fsStat:         (filePath)          => ipcRenderer.invoke('fs-stat',   filePath),
  fsOpen:         (filePath)          => ipcRenderer.invoke('fs-open',   filePath),
  fsOpenWith:     (filePath)          => ipcRenderer.invoke('fs-open-with', filePath),

  // ── Menu events (main → renderer) ────────────────────────────────────────────
  onMenuDriveSelected: (cb) => ipcRenderer.on('menu-drive-selected', (_e, v) => cb(v)),
  onMenuMode:          (cb) => ipcRenderer.on('menu-mode',           (_e, v) => cb(v)),
  onMenuTheme:         (cb) => ipcRenderer.on('menu-theme',          (_e, v) => cb(v)),
  onMenuNav:           (cb) => ipcRenderer.on('menu-nav',            (_e, v) => cb(v)),
  onMenuSettings:      (cb) => ipcRenderer.on('menu-settings',       ()      => cb()),
  onMenuAbout:         (cb) => ipcRenderer.on('menu-about',          ()      => cb()),
  onMenuHelp:          (cb) => ipcRenderer.on('menu-help',           ()      => cb()),
});
