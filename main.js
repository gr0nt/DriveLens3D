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

let mainWindow = null;

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(Math.max(b,1)) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

function buildMenu(drives) {
  const driveItems = drives.map(d => ({
    label: `${d.letter}  (${fmtBytes(d.size - d.free)} used / ${fmtBytes(d.size)})`,
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
    title: 'DriveLens',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
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

async function getDiskSpaceFromPowerShell(drivePath) {
  return new Promise((resolve, reject) => {
    const driveLetter = (drivePath && drivePath[0]) || 'C';
    const cmd = `powershell -NoProfile -Command "Get-PSDrive -Name ${driveLetter} | Select-Object Used,Free | ConvertTo-Json"`;
    exec(cmd, { windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const obj = JSON.parse(stdout.trim());
        const free = Number(obj.Free  || 0);
        const used = Number(obj.Used  || 0);
        resolve({ free, size: free + used });
      } catch (e) { reject(e); }
    });
  });
}

ipcMain.handle('scan-drive', async (event, drivePath) => {
  try {
    let disk;
    try { disk = await checkDiskSpace(drivePath); }
    catch (e) { disk = await getDiskSpaceFromPowerShell(drivePath); }

    const free  = disk.free  ?? disk.Free  ?? 0;
    const total = disk.size  ?? disk.Capacity ?? 0;
    const used  = total - free;

    const onProgress = (data) => {
      try { event.sender.send('scan-progress', data); } catch (_) {}
    };

    const tree = await scanPath(drivePath, onProgress);
    return { free, total, used, tree };
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

ipcMain.handle('list-drives', async () => {
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
  return new Promise((resolve) => {
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
      { windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) { resolve([]); return; }
        try {
          let drives = JSON.parse(stdout.trim());
          if (!Array.isArray(drives)) drives = [drives];
          const result = drives
            .map(d => {
              const used = Number(d.used) || 0;
              const free = Number(d.free) || 0;
              const letter = String(d.letter || '').trim();
              const isNet = !!(d.net);
              return { letter: letter ? letter + ':\\' : '', size: used + free, free, isNet };
            })
            .filter(d => d.letter);
          buildMenu(result.filter(d => d.size > 0));
          resolve(result);
        } catch (_) { resolve([]); }
      });
  });
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

ipcMain.handle('fs-smart', async () => {
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
