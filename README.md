# DriveLens3D

**DriveLens3D** is a Windows desktop app that turns disk usage analysis into an interactive 3D experience. Explore your drives through six visualization modes powered by Three.js, with real-time scanning, S.M.A.R.T. diagnostics, and built-in file management to quickly answer the question: "Where did all my free space go?"

![DriveLens3D Screenshot](assets/screenshot.png)

---

## Features

### Visualization Modes
| Mode | Description |
|------|-------------|
| **3D Treemap** | Squarified treemap with height-proportional boxes |
| **Sunburst** | Concentric ring chart with kick-out hover effect |
| **Bar Chart** | Horizontal bars sorted by size |
| **Stacked** | Vertical stacked bars with file-type color breakdown |
| **City** | 3D city skyline — folders become buildings |
| **Galaxy** | Solar system layout — folders as planets orbiting a central sun |

### Themes
- **Cosmos** — Deep space blue
- **Neon City** — Cyberpunk purple/magenta
- **Ember** — Warm fire orange/red
- **Nature** — Forest green
- **Ocean** — Deep sea teal/cyan
- **Aurora** — Northern lights green/purple

### Backgrounds
Four distinct background modes, switchable at any time from the sidebar:

| Mode | Appearance |
|------|------------|
| **Solid** | Flat colour from the active theme |
| **Sky** | Vertical gradient matching theme palette (dark top → theme accent) |
| **Gradient** | Horizontal sweep — vivid centred glow fading to dark edges; visually opposite to Sky |
| **Matrix** | Animated katakana/digit rain on black, updated every frame in real time |

### File Management
Right-click any item in the visualization for:
- **Rename** — In-place rename with path rewrite
- **Delete** — Send to Recycle Bin (reversible)
- **Copy / Cut** — Place on Windows clipboard for paste in Explorer
- **Properties** — Opens Windows file properties dialog

### Diagnostics
- **S.M.A.R.T.** — Physical disk health, temperature, power-on hours, read/write errors, wear level, and latency (requires Administrator; not available in VM-safe mode)
- **Disk Usage HUD** — Always-visible bottom bar showing used/total/percentage
- **Real-time scan progress** — Status bar and viewport overlay both update with `Scanning… X%` as each top-level folder is processed

### Navigation
- Drill into folders by clicking
- Breadcrumb trail for quick navigation
- Copy path to clipboard with one click
- Open current folder in Windows Explorer

---

## Installation

### Prerequisites
- Windows 10 or later
- [Node.js](https://nodejs.org/) (v18+)
- [Git](https://git-scm.com/)

### Steps

```bash
git clone https://github.com/gr0nt/drivelens3d.git
cd drivelens3d
npm install
npm start
```

### Running inside a VM (Proxmox, Hyper-V, VirtualBox, etc.)

Use the dedicated VM-safe launch script:

```bash
npm run start:vm
```

Or set the environment variable instead:

```bash
DRIVELENS_VM_SAFE=1 npm start
```

The `--vm-safe` / `DRIVELENS_VM_SAFE=1` flag activates the following automatically:

| What changes | Why |
|---|---|
| Hardware acceleration disabled (`app.disableHardwareAcceleration()`) | Avoids D3D11/ANGLE crashes on virtual GPU drivers |
| SwiftShader software renderer (`--use-angle=swiftshader`) | Provides a stable WebGL fallback without a real GPU |
| Default mode switched to **Bar Chart** | 3D modes (Treemap, City, Galaxy) are GPU-heavy; flat modes are reliable |
| City and Galaxy mode buttons hidden | Prevents launching modes that may crash or render blank in software mode |
| S.M.A.R.T. diagnostics disabled | VMs expose virtual disks, not physical hardware — the data would be meaningless |

> **Tip:** If drives still don't appear after launching, the app falls back to probing drive letters `C:` through `Z:` directly via `checkDiskSpace`. Drives whose capacity can't be determined are still listed as `X:\  (size unknown)` so you can scan them.

---

## Usage

1. **Launch** — The app automatically scans all drives on startup
2. **Select Drive** — Use the dropdown or Drive menu to choose a specific drive
3. **Scan** — Click "Scan" to perform a full directory scan
4. **Explore** — Click folders to drill in; press `Esc` to go back
5. **Visualize** — Switch modes with the Visualization buttons
6. **Theme** — Choose a color theme from the Theme section
7. **Settings** — Click ⚙ Settings to configure defaults

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Esc` | Go up one level |
| `Home` | Go to root |
| `W` / `↑` | Walk forward (City mode) |
| `S` / `↓` | Walk backward (City mode) |
| `A` / `←` | Walk left (City mode) |
| `D` / `→` | Walk right (City mode) |
| Right-click | Open file context menu |

---

## Mapped Network Drives

DriveLens detects mapped network drives automatically via `Win32_LogicalDisk`. Ensure the network drive is connected before launching or clicking Scan.

---

## S.M.A.R.T. Diagnostics

S.M.A.R.T. data is retrieved via `Get-PhysicalDisk` and `Get-StorageReliabilityCounter` (Windows Storage module). For full access, **run as Administrator**.

Right-click a drive in the **All Drives** visualization → **S.M.A.R.T. Diagnostics**.

> S.M.A.R.T. is automatically disabled in VM-safe mode. Virtual disks don't expose physical health counters, so the feature returns a friendly message rather than failing noisily.

---

## Settings

Access via the ⚙ Settings button (bottom of sidebar) or **Help → Settings** in the menu bar.

| Setting | Description |
|---------|-------------|
| Default Mode | Visualization mode on startup |
| Default Theme | Color theme on startup |
| Show Free Space Tiles | Toggle free space display in visualizations |
| Label Threshold | Minimum % to show a label (lower = more labels, higher = cleaner scene) |
| Label Font Size | Scale of 3D labels — 24 px (small) to 120 px (large); default 56 px |
| Animation Speed | Speed of galaxy particle animations |
| Recursion Count | How many ring/orbit levels Sunburst and Galaxy render: 1, 2, 3, 5, or **All** (unlimited depth, auto-generates additional rings beyond the five predefined levels) |

Settings are saved automatically to `localStorage`.

> **Known fix:** The Label Threshold slider previously corrupted WebGL lighting state when dragged rapidly, requiring an app restart to recover. This is now debounced — the scene only rebuilds 120 ms after the slider stops moving, preventing GPU state corruption.

---

## Architecture

```
drivelens/
├── main.js          # Electron main process (IPC handlers, menu, file ops)
├── preload.js       # Context bridge (secure IPC bridge)
├── scanner.js       # Recursive file system scanner
├── renderer/
│   ├── index.html   # App shell with sidebar, HUD, modals
│   └── renderer.js  # Three.js visualizations + UI logic
├── assets/
│   └── icon.png     # App icon
└── package.json
```

### IPC Channels
| Channel | Direction | Description |
|---------|-----------|-------------|
| `scan-drive` | renderer→main | Start full directory scan |
| `list-drives` | renderer→main | Get all local + network drives |
| `list-fonts` | renderer→main | Enumerate system fonts |
| `get-runtime-capabilities` | renderer→main | Query platform/VM-safe flags |
| `scan-progress` | main→renderer | Progress updates during scan |
| `open-in-explorer` | renderer→main | Open path in Windows Explorer |
| `fs-rename` | renderer→main | Rename file/folder |
| `fs-delete` | renderer→main | Move to Recycle Bin |
| `fs-copy` | renderer→main | Copy to clipboard (CF_HDROP) |
| `fs-cut` | renderer→main | Cut to clipboard (CF_HDROP + DROPEFFECT_MOVE) |
| `fs-properties` | renderer→main | Open Windows Properties dialog |
| `fs-smart` | renderer→main | Read S.M.A.R.T. diagnostics (disabled in VM-safe mode) |
| `menu-*` | main→renderer | Menu bar actions |

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Contributing

Pull requests welcome! Please open an issue first to discuss major changes.
