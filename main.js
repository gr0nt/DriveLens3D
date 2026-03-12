/**
 * main.js — DriveLens 3D  (Electron main process)
 *
 * This file runs in Node.js (not the browser).  It is responsible for:
 *
 *  • Creating and managing the BrowserWindow (createWindow).
 *  • Building the native application menu (buildMenu).
 *  • Handling all IPC calls from the renderer process via ipcMain.handle().
 *
 * IPC handlers (invoked by renderer/renderer.js via window.api.*):
 *  scan-drive        — recursively scan a drive/path and return a size tree
 *  list-drives       — enumerate all local + network drives via PowerShell
 *  open-in-explorer  — reveal a path in Windows Explorer
 *  fs-rename         — rename a file or folder
 *  fs-delete         — move a file to the Recycle Bin (shell.trashItem)
 *  fs-copy / fs-cut  — write a file path to the clipboard as CF_HDROP
 *  fs-properties     — show the native Windows Properties dialog
 *  fs-stat           — return created/modified/accessed dates for a path
 *  fs-open           — open a file with its default application
 *  fs-smart          — query S.M.A.R.T. data via PowerShell + WMI
 *  list-fonts        — enumerate installed system fonts
 */
const { app, BrowserWindow, ipcMain, Menu, shell, clipboard } = require('electron');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const checkDiskSpace = require('check-disk-space');
const { exec }    = require('child_process');
const { scanPath } = require('./scanner');

const isWindows = process.platform === 'win32';

// VM / bad-driver survival mode.
// Activated by: DRIVELENS_VM_SAFE=1 env var, or --vm-safe / --disable-gpu CLI flags.
// Must happen before app.whenReady().
const vmSafe =
  process.env.DRIVELENS_VM_SAFE === '1' ||
  process.argv.includes('--vm-safe') ||
  process.argv.includes('--disable-gpu');

if (vmSafe) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

let mainWindow = null;

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(Math.max(b,1)) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

function buildMenu(drives) {
  const driveItems = drives.map(d => ({
    label: d.size > 0
      ? `${d.letter}  (${fmtBytes(d.size - d.free)} used / ${fmtBytes(d.size)})`
      : `${d.letter}  (size unknown)`,
    click: () => { if (mainWindow) mainWindow.webContents.send('menu-drive-selected', d.letter); }
  }));
  if (driveItems.length) driveItems.push({ type: 'separator' });
  driveItems.push({
    label: '⊞ All Drives',
    click: () => { if (mainWindow) mainWindow.webContents.send('menu-drive-selected', '__all__'); }
  });

  const template = [
    {
      label: 'Drive',
      submenu: driveItems
    },
    {
      label: 'View',
      submenu: [
        { label: '3D Treemap', click: () => mainWindow?.webContents.send('menu-mode', 'treemap') },
        { label: 'Sunburst',   click: () => mainWindow?.webContents.send('menu-mode', 'sunburst') },
        { label: 'Bar Chart',  click: () => mainWindow?.webContents.send('menu-mode', 'bar') },
        { label: 'Stacked',    click: () => mainWindow?.webContents.send('menu-mode', 'stacked') },
        { label: 'City',       click: () => mainWindow?.webContents.send('menu-mode', 'city') },
        { label: 'Galaxy',     click: () => mainWindow?.webContents.send('menu-mode', 'galaxy') },
      ]
    },
    {
      label: 'Theme',
      submenu: [
        { label: 'Cosmos',    click: () => mainWindow?.webContents.send('menu-theme', 'cosmos') },
        { label: 'Neon City', click: () => mainWindow?.webContents.send('menu-theme', 'neon') },
        { label: 'Ember',     click: () => mainWindow?.webContents.send('menu-theme', 'ember') },
        { label: 'Nature',    click: () => mainWindow?.webContents.send('menu-theme', 'nature') },
        { label: 'Ocean',     click: () => mainWindow?.webContents.send('menu-theme', 'ocean') },
        { label: 'Aurora',    click: () => mainWindow?.webContents.send('menu-theme', 'aurora') },
      ]
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Go Up',      accelerator: 'Escape', click: () => mainWindow?.webContents.send('menu-nav', 'up') },
        { label: 'Go to Root', accelerator: 'Home',   click: () => mainWindow?.webContents.send('menu-nav', 'root') },
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Settings…',          click: () => mainWindow?.webContents.send('menu-settings') },
        { label: 'Keyboard Shortcuts', click: () => mainWindow?.webContents.send('menu-help') },
        { type: 'separator' },
        { label: 'About DriveLens',    click: () => mainWindow?.webContents.send('menu-about') },
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'DriveLens',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#0b1020',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    }
  });

  // Don't flash a white frame — only show once the renderer is ready to paint.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer crashed:', details);
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('Renderer became unresponsive');
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  buildMenu([]);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Disk space helpers ────────────────────────────────────────────────────────
// We try three increasingly compatible approaches and take the first one that
// returns a non-zero size.  This is necessary because:
//   • check-disk-space v2 uses `wmic`, which was removed in Windows 11 22H2+
//   • Get-PSDrive returns null Used/Free on Proxmox VirtIO virtual disks
//   • Get-Volume works reliably on all modern Windows 10/11 including VMs

// Approach 1 — Get-Volume (most reliable on modern Windows, works on Proxmox VMs)
async function getDiskSpaceGetVolume(drivePath) {
  return new Promise((resolve, reject) => {
    const letter = (drivePath && drivePath[0]) || 'C';
    const cmd = `powershell -NoProfile -Command "Get-Volume -DriveLetter '${letter}' | Select-Object Size,SizeRemaining | ConvertTo-Json"`;
    exec(cmd, { windowsHide: true, encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const obj  = JSON.parse(stdout.trim());
        const free = Number(obj.SizeRemaining ?? 0);
        const size = Number(obj.Size          ?? 0);
        if (!size) return reject(new Error('Get-Volume returned zero size'));
        resolve({ free, size });
      } catch (e) { reject(e); }
    });
  });
}

// Approach 2 — Get-PSDrive (works on most local drives, may return null on VMs)
async function getDiskSpaceFromPowerShell(drivePath) {
  return new Promise((resolve, reject) => {
    const letter = (drivePath && drivePath[0]) || 'C';
    const cmd = `powershell -NoProfile -Command "Get-PSDrive -Name '${letter}' | Select-Object Used,Free | ConvertTo-Json"`;
    exec(cmd, { windowsHide: true, encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const obj  = JSON.parse(stdout.trim());
        const free = Number(obj.Free ?? 0);
        const used = Number(obj.Used ?? 0);
        if (!free && !used) return reject(new Error('Get-PSDrive returned zeroes'));
        resolve({ free, size: free + used });
      } catch (e) { reject(e); }
    });
  });
}

// Approach 3 — WMI Win32_LogicalDisk (widely supported, deprecated but still present)
async function getDiskSpaceWMI(drivePath) {
  return new Promise((resolve, reject) => {
    const letter = ((drivePath && drivePath[0]) || 'C').toUpperCase() + ':';
    const cmd = `powershell -NoProfile -Command "Get-WmiObject Win32_LogicalDisk -Filter 'DeviceID=''${letter}''' | Select-Object Size,FreeSpace | ConvertTo-Json"`;
    exec(cmd, { windowsHide: true, encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const obj  = JSON.parse(stdout.trim());
        const free = Number(obj.FreeSpace ?? 0);
        const size = Number(obj.Size      ?? 0);
        if (!size) return reject(new Error('WMI returned zero size'));
        resolve({ free, size });
      } catch (e) { reject(e); }
    });
  });
}

// getDiskInfo — tries each approach in turn; falls back to zeroes if all fail
// so the filesystem scan itself is never blocked by a disk-info query failure.
async function getDiskInfo(drivePath) {
  for (const fn of [getDiskSpaceGetVolume, getDiskSpaceFromPowerShell, getDiskSpaceWMI]) {
    try {
      const d = await fn(drivePath);
      if (d && d.size > 0) return d;
    } catch (_) { /* try next */ }
  }
  // Last resort: check-disk-space npm module (uses wmic; may fail on Win11 22H2+)
  try {
    const d = await checkDiskSpace(drivePath);
    if (d && (d.size || d.free)) return { free: d.free ?? 0, size: d.size ?? 0 };
  } catch (_) {}
  // All methods failed — return zeroes so the scan still runs
  return { free: 0, size: 0 };
}

ipcMain.handle('scan-drive', async (event, drivePath) => {
  try {
    // Get disk space info (gracefully degrades to 0 on incompatible systems)
    const disk  = await getDiskInfo(drivePath);
    const free  = disk.free;
    const total = disk.size;
    const used  = Math.max(0, total - free);

    const onProgress = (data) => {
      try { event.sender.send('scan-progress', data); } catch (_) {}
    };

    const tree = await scanPath(drivePath, onProgress);
    return { free, total, used, tree };
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

// Reports runtime environment flags to the renderer so it can disable features
// that don't work (e.g. S.M.A.R.T. in a VM, shell ops on non-Windows).
ipcMain.handle('get-runtime-capabilities', async () => ({
  platform:              process.platform,
  isWindows,
  vmSafe,
  smartSupported:        isWindows && !vmSafe,
  shellFeaturesSupported: isWindows,
  recommendedMode:       vmSafe ? 'bar' : 'treemap',
}));

ipcMain.handle('list-drives', async () => {
  if (!isWindows) return [];

  // ── Primary: PowerShell with four-method fallback chain ──────────────────────
  // Each method is wrapped in try/catch so a single failure doesn't abort the script.
  // Results are merged into a hashtable keyed by drive letter; best data wins.
  const script = [
    `$drives = @()`,
    `Get-PSDrive -PSProvider FileSystem | ForEach-Object {`,
    `  $drives += [PSCustomObject]@{letter=$_.Name;used=if($_.Used -ne $null){[long]$_.Used}else{0};free=if($_.Free -ne $null){[long]$_.Free}else{0};net=0}`,
    `}`,
    `Get-WmiObject Win32_LogicalDisk | Where-Object {$_.DriveType -eq 4} | ForEach-Object {`,
    `  $l = $_.DeviceID.TrimEnd(':')`,
    `  if (-not ($drives | Where-Object {$_.letter -eq $l})) {`,
    `    $sz = if($_.Size){[long]$_.Size}else{0}`,
    `    $fr = if($_.FreeSpace){[long]$_.FreeSpace}else{0}`,
    `    $drives += [PSCustomObject]@{letter=$l;used=$sz-$fr;free=$fr;net=1}`,
    `  }`,
    `}`,
    `$drives | ConvertTo-Json -Compress`,
  ].join('\n');

  const tmp = path.join(os.tmpdir(), 'dl_drives.ps1');
  await fs.promises.writeFile(tmp, script, 'utf8');

  const psResult = await new Promise((resolve) => {
    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
      { windowsHide: true, encoding: 'utf8', timeout: 20000 },
      (_err, stdout) => {
        try {
          let drives = JSON.parse((stdout || '').trim());
          if (!Array.isArray(drives)) drives = drives ? [drives] : [];
          resolve(
            drives
              .map(d => {
                const used   = Number(d.used) || 0;
                const free   = Number(d.free) || 0;
                const letter = String(d.letter || '').trim();
                return { letter: letter ? `${letter}:\\` : '', size: used + free, free, isNet: !!d.net };
              })
              .filter(d => d.letter)
          );
        } catch {
          resolve(null);
        }
      }
    );
  });

  if (psResult && psResult.length) {
    buildMenu(psResult.filter(d => d.size > 0));
    return psResult;
  }

  // ── Fallback: brute-force all common drive letters via checkDiskSpace ─────────
  // Catches cases where PowerShell is unavailable or returns nothing (e.g. locked-down VMs).
  const fallback = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:\\`;
    try {
      const disk = await checkDiskSpace(drive);
      fallback.push({ letter: drive, size: Number(disk.size || 0), free: Number(disk.free || 0), isNet: false });
    } catch (_) {}
  }

  buildMenu(fallback.filter(d => d.size > 0));
  return fallback;
});

ipcMain.handle('open-in-explorer', async (_event, folderPath) => {
  await shell.openPath(folderPath);
});

// ── File-system context-menu actions ──────────────────────────────────────────

function buildHDROP(filePath) {
  // DROPFILES struct (20 bytes): pFiles offset, pt.x, pt.y, fNC, fWide(=1 for unicode)
  const header = Buffer.alloc(20);
  header.writeUInt32LE(20, 0);
  header.writeUInt32LE(1,  16); // fWide
  const pathBuf = Buffer.from(filePath + '\0\0', 'utf16le');
  return Buffer.concat([header, pathBuf]);
}

ipcMain.handle('fs-rename', async (_event, oldPath, newName) => {
  try {
    const newPath = path.join(path.dirname(oldPath), newName);
    await fs.promises.rename(oldPath, newPath);
    return { ok: true, newPath };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs-delete', async (_event, filePath) => {
  try {
    await shell.trashItem(filePath);
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs-copy', async (_event, filePath) => {
  try {
    clipboard.writeBuffer('CF_HDROP', buildHDROP(filePath));
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs-cut', async (_event, filePath) => {
  try {
    clipboard.writeBuffer('CF_HDROP', buildHDROP(filePath));
    const dropEffect = Buffer.alloc(4);
    dropEffect.writeUInt32LE(2, 0); // DROPEFFECT_MOVE
    clipboard.writeBuffer('Preferred DropEffect', dropEffect);
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs-properties', async (_event, filePath) => {
  // Invoke the native Windows "Properties" dialog using the Shell.Application COM
  // object.  We write the script to a temp .ps1 file to avoid shell-quoting
  // nightmares with paths that contain spaces, apostrophes, or brackets.
  // Start-Sleep keeps the PowerShell host alive long enough for the dialog to
  // remain open after InvokeVerb() returns.
  try {
    const dir  = path.dirname(filePath).replace(/'/g, "''");
    const name = path.basename(filePath).replace(/'/g, "''");
    const script = [
      `$sh     = New-Object -ComObject Shell.Application`,
      `$folder = $sh.Namespace('${dir}')`,
      `if ($folder) {`,
      `  $item = $folder.ParseName('${name}')`,
      `  if ($item) { $item.InvokeVerb('Properties') }`,
      `}`,
      `# Keep the host alive so the modeless Properties dialog stays open`,
      `Start-Sleep -Seconds 120`,
    ].join('\n');
    const tmp = path.join(os.tmpdir(), 'dl_props.ps1');
    await fs.promises.writeFile(tmp, script, 'utf8');
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
      { windowsHide: false });
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs-smart', async (_event, driveOrPath) => {
  if (!isWindows) {
    return { unsupported: true, reason: 'S.M.A.R.T. is Windows-only in this app.' };
  }
  if (vmSafe) {
    return {
      unsupported: true,
      reason: 'S.M.A.R.T. disabled in VM-safe mode because the guest usually sees virtual disks, not physical hardware.',
    };
  }
  // eslint-disable-next-line no-unused-vars
  void driveOrPath; // reserved for future per-drive filtering
  // Write PS1 to temp file to avoid double-quote nesting in cmd.exe
  const script = [
    `# Build map: disk number -> drive letters`,
    `$diskLetters = @{}`,
    `try {`,
    `  Get-Partition | Where-Object {$_.DriveLetter} | ForEach-Object {`,
    `    $n = $_.DiskNumber`,
    `    if (-not $diskLetters.ContainsKey($n)) { $diskLetters[$n] = [System.Collections.ArrayList]@() }`,
    `    [void]$diskLetters[$n].Add([string]$_.DriveLetter + ':')`,
    `  }`,
    `} catch {}`,
    `$out = @()`,
    `Get-PhysicalDisk | ForEach-Object {`,
    `  $d = $_`,
    `  $rc = try { Get-StorageReliabilityCounter -PhysicalDisk $d -EA Stop } catch { $null }`,
    `  $diskIdx = try { ($d | Get-Disk -EA Stop).Number } catch { $null }`,
    `  $letters = if($diskIdx -ne $null -and $diskLetters.ContainsKey($diskIdx)){ ($diskLetters[$diskIdx] -join ', ') } else { '' }`,
    `  $out += [PSCustomObject]@{`,
    `    Name            = $d.FriendlyName`,
    `    Drives          = $letters`,
    `    MediaType       = $d.MediaType`,
    `    SizeGB          = [math]::Round($d.Size/1GB,2)`,
    `    Health          = $d.HealthStatus`,
    `    Status          = $d.OperationalStatus`,
    `    TemperatureC    = if($rc){$rc.Temperature}else{$null}`,
    `    PowerOnHours    = if($rc){$rc.PowerOnHours}else{$null}`,
    `    ReadErrors      = if($rc){$rc.ReadErrorsTotal}else{$null}`,
    `    WriteErrors     = if($rc){$rc.WriteErrorsTotal}else{$null}`,
    `    Wear            = if($rc){$rc.Wear}else{$null}`,
    `    ReadLatencyMs   = if($rc){[math]::Round($rc.ReadLatencyMax/1000,2)}else{$null}`,
    `    WriteLatencyMs  = if($rc){[math]::Round($rc.WriteLatencyMax/1000,2)}else{$null}`,
    `  }`,
    `}`,
    `$out | ConvertTo-Json -Compress`,
  ].join('\n');
  const tmp = path.join(os.tmpdir(), 'dl_smart.ps1');
  await fs.promises.writeFile(tmp, script, 'utf8');
  return new Promise((resolve) => {
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
      { windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) { resolve({ error: err.message }); return; }
        try {
          let data = JSON.parse(stdout.trim());
          if (!Array.isArray(data)) data = [data];
          resolve({ disks: data });
        } catch (e) { resolve({ error: stdout || e.message }); }
      });
  });
});

ipcMain.handle('fs-stat', async (_event, filePath) => {
  try {
    const st = await fs.promises.stat(filePath);
    return {
      created:  st.birthtime.toISOString(),
      modified: st.mtime.toISOString(),
      accessed: st.atime.toISOString(),
      size:     st.size,
      isDir:    st.isDirectory(),
    };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs-open', async (_event, filePath) => {
  try {
    const err = await shell.openPath(filePath);
    return err ? { error: err } : { ok: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs-open-with', async (_event, filePath) => {
  try {
    const escaped = filePath.replace(/"/g, '\\"');
    exec(`rundll32.exe shell32.dll,OpenAs_RunDLL "${escaped}"`, { windowsHide: false });
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('list-fonts', async () => {
  try {
    const fontsDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts');
    const files = await fs.promises.readdir(fontsDir);
    const seen = new Set();
    const names = [];
    for (const f of files) {
      if (!/\.(ttf|otf)$/i.test(f)) continue;
      let name = f.replace(/\.[^.]+$/, '')
                  .replace(/[-_ ](Bold|Italic|Regular|Light|Medium|Thin|Black|Heavy|Semibold|ExtraBold|ExtraLight|Condensed|Narrow).*$/i, '')
                  .replace(/[-_]/g, ' ')
                  .trim();
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        names.push(name);
      }
    }
    return names.sort().slice(0, 100);
  } catch (_) {
    return ['Arial', 'Calibri', 'Consolas', 'Courier New', 'Georgia',
            'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana'];
  }
});
