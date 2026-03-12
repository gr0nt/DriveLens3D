/**
 * renderer.js — DriveLens 3D
 *
 * This is the main renderer module.  It is loaded as an ES module from
 * index.html and runs entirely in the Electron renderer process.
 *
 * Responsibilities
 * ────────────────
 *  • Initialise the Three.js scene, camera, renderer, post-processing stack,
 *    and OrbitControls (initThree).
 *  • Apply and switch between the 7 visual themes (applyTheme).
 *  • Render six distinct visualisation modes — each is a standalone function:
 *      renderTreemap   — squarified 3D treemap
 *      renderSunburst  — concentric ring chart (configurable depth)
 *      renderBarChart  — horizontal bar chart sorted largest-first
 *      renderStacked   — stacked bar chart by file-type colour
 *      renderCity      — 3D city where building height ∝ file size
 *      renderGalaxy    — solar-system metaphor; drives become stars at root
 *  • Manage navigation state (navStack) and animated transitions.
 *  • Handle mouse hover, click, and right-click (context menu).
 *  • Update sidebar / HUD / right-panel UI to reflect the current selection.
 *  • Persist user settings to localStorage (settings object).
 *
 * IPC bridge (window.api) is exposed by preload.js and used here for:
 *  scanning drives, file operations (open/rename/delete/copy/cut/properties),
 *  S.M.A.R.T. data retrieval, and menu event listeners.
 */
import * as THREE from 'three';
import { OrbitControls }    from 'three/addons/controls/OrbitControls.js';
import { EffectComposer }   from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }       from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }  from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }       from 'three/addons/postprocessing/OutputPass.js';

// ── Scene-scale constants ─────────────────────────────────────────────────────
// WORLD  — diameter of the usable world in Three.js units
// TMAP   — treemap grid size (items are mapped onto a TMAP×TMAP square)
// BOX_*  — min/max height for treemap boxes, scaled by log(size)
// GAP    — margin between treemap tiles
const WORLD = 200, TMAP = 100, BOX_MIN_H = 0.6, BOX_MAX_H = 52, GAP = 0.35;

// ── Easing ────────────────────────────────────────────────────────────────────
// easeOutBack gives the scale-in animation a satisfying "overshoot and settle"
// feel when new objects appear after a navigation transition.
function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}


// ── Sky gradient textures ──────────────────────────────────────────────────────
// Each entry defines colour stops for a vertical gradient that is rendered as
// the Three.js scene.background texture.  Colours should be visually distinct
// between themes — especially Ocean (deep saturated blue) vs Aurora (dark
// teal-green night sky).
const THEME_SKY_STOPS = {
  // Neon City: deep purple-violet night sky
  neon:   [[0,'#0a0018'],[0.38,'#1e0040'],[0.52,'#330060'],[0.65,'#180030'],[1,'#050008']],
  // Ember: smouldering dark orange–brown sky (like a distant wildfire glow)
  ember:  [[0,'#120200'],[0.35,'#2e0800'],[0.55,'#3d0c00'],[0.75,'#1a0400'],[1,'#050100']],
  // Nature: deep forest-canopy green, almost no blue
  nature: [[0,'#011004'],[0.40,'#012808'],[0.55,'#003010'],[0.75,'#011405'],[1,'#010802']],
  // Ocean: rich deep-sea blue — bright enough to feel like underwater, not outer space
  ocean:  [[0,'#001c3a'],[0.30,'#003366'],[0.50,'#004880'],[0.70,'#002448'],[1,'#000f20']],
  // Aurora: dark arctic night sky — clearly distinct greens, no confusion with ocean
  aurora: [[0,'#000510'],[0.25,'#00150a'],[0.50,'#003020'],[0.72,'#001810'],[1,'#000206']],
};

function makeSkyTexture(themeName) {
  const stops = THEME_SKY_STOPS[themeName];
  if (!stops) return null;
  const h = 512;
  const cvs = document.createElement('canvas');
  cvs.width = 1; cvs.height = h;
  const ctx = cvs.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  for (const [pos, col] of stops) grad.addColorStop(pos, col);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1, h);
  return new THREE.CanvasTexture(cvs);
}

// ── Category / colour map ─────────────────────────────────────────────────────
const CATEGORIES = {
  video:       { exts: ['mp4','mkv','avi','mov','wmv','webm','flv','m4v','vob'],         color: 0xe74c3c },
  images:      { exts: ['jpg','jpeg','png','gif','bmp','webp','tiff','tif','raw','svg','ico','heic','avif'], color: 0x2ecc71 },
  audio:       { exts: ['mp3','wav','flac','aac','ogg','wma','m4a','opus','aiff'],        color: 0xf39c12 },
  archives:    { exts: ['zip','rar','7z','tar','gz','bz2','xz','iso','cab','dmg'],        color: 0x9b59b6 },
  code:        { exts: ['js','ts','jsx','tsx','mjs','py','java','cs','cpp','c','h','go','rs','rb','php','html','css','scss','sh','ps1','yaml','yml','json','xml','toml'], color: 0x1abc9c },
  documents:   { exts: ['pdf','doc','docx','txt','md','rtf','xls','xlsx','csv','ppt','pptx','odt','ods'], color: 0x3498db },
  executables: { exts: ['exe','dll','msi','bat','cmd','sys','bin','so','dylib'],          color: 0xf1c40f },
  model3d:    { exts: ['stl','3mf','obj','fbx','gltf','glb','ply','dae','blend','max','c4d','wrl','step','stp','iges'], color: 0xe67e22 },
  fonts:      { exts: ['ttf','otf','woff','woff2','eot'],                                                               color: 0xd35400 },
  database:   { exts: ['db','sqlite','sqlite3','sql','mdb','accdb','dbf'],                                              color: 0x16a085 },
};
const COLOR_FOLDER = 0x4a90d9, COLOR_FREE = 0xd0e8ff, COLOR_USED = 0x4f8cff, COLOR_DEFAULT = 0x7f8c8d;
const CAT_COLORS = Object.fromEntries(Object.entries(CATEGORIES).map(([k,v]) => [k, v.color]));
CAT_COLORS.other = COLOR_DEFAULT;
const ALL_CATS = [...Object.keys(CATEGORIES), 'other'];
const EXT_TO_CAT = {};
for (const [cat, { exts }] of Object.entries(CATEGORIES)) for (const e of exts) EXT_TO_CAT[e] = cat;

function getCategory(filename) {
  return EXT_TO_CAT[filename.split('.').pop().toLowerCase()] ?? 'other';
}
function nodeColor(name, isFolder) {
  if (name === 'Free Space') return COLOR_FREE;
  if (name === 'Used') return COLOR_USED;
  if (isFolder) return COLOR_FOLDER;
  return CAT_COLORS[getCategory(name)];
}
function getTypeSizes(node) {
  const out = Object.fromEntries(ALL_CATS.map(c => [c, 0]));
  (function walk(n) {
    if (!n.children?.length) out[getCategory(n.name)] += n.size || 0;
    else n.children.forEach(walk);
  })(node);
  return out;
}

// ── Themes ────────────────────────────────────────────────────────────────────
const THEMES = {
  cosmos: {
    bg: 0x020210, fog: 0x020210, ground: 0x040412, grid: [0x0a0a28, 0x080820],
    ambient: [0x1a2040, 4], sunColor: 0xffffff, sunIntensity: 2.8,
    fillColor: 0x3355aa, fillIntensity: 0.8,
    accent: new THREE.Color(0x4f8cff),
    bloom: { strength: 0.45, radius: 0.55, threshold: 0.75 },
    ptColor: 0x2244aa,
    flashColor: 'rgba(79,140,255,0.5)',
    skyClass: null,
  },
  neon: {
    bg: 0x000008, fog: 0x000008, ground: 0x00000d, grid: [0x0d001a, 0x09000f],
    ambient: [0x150028, 5], sunColor: 0xff44ff, sunIntensity: 2.0,
    fillColor: 0x00ffff, fillIntensity: 0.6,
    accent: new THREE.Color(0xff00ff),
    bloom: { strength: 0.9, radius: 0.7, threshold: 0.55 },
    ptColor: 0xaa00cc,
    flashColor: 'rgba(255,0,255,0.5)',
    skyClass: 'neon-sky',
  },
  ember: {
    bg: 0x080200, fog: 0x080200, ground: 0x0d0300, grid: [0x1a0500, 0x140400],
    ambient: [0x200800, 4.5], sunColor: 0xff8833, sunIntensity: 2.5,
    fillColor: 0xff3300, fillIntensity: 0.5,
    accent: new THREE.Color(0xff6600),
    bloom: { strength: 0.6, radius: 0.55, threshold: 0.65 },
    ptColor: 0xcc3300,
    flashColor: 'rgba(255,100,0,0.5)',
    skyClass: 'ember-sky',
  },
  nature: {
    bg: 0x010a02, fog: 0x010a02, ground: 0x020e04, grid: [0x051a06, 0x041404],
    ambient: [0x0d2010, 4], sunColor: 0xaaffaa, sunIntensity: 2.5,
    fillColor: 0x00ff88, fillIntensity: 0.5,
    accent: new THREE.Color(0x00ff88),
    bloom: { strength: 0.35, radius: 0.45, threshold: 0.7 },
    ptColor: 0x006633,
    flashColor: 'rgba(0,255,136,0.4)',
    skyClass: 'nature-sky',
  },
  ocean: {
    // Deep ocean blue — clearly distinct from the aurora (green) theme
    bg: 0x001020, fog: 0x001830, ground: 0x001530, grid: [0x003060, 0x002040],
    ambient: [0x002850, 5.0], sunColor: 0x00aaff, sunIntensity: 2.4,
    fillColor: 0x0055bb, fillIntensity: 0.7,
    accent: new THREE.Color(0x00aaff),
    bloom: { strength: 0.6, radius: 0.55, threshold: 0.60 },
    ptColor: 0x0044aa,
    flashColor: 'rgba(0,160,255,0.50)',
    skyClass: 'ocean-sky',
  },
  aurora: {
    bg: 0x000508, fog: 0x000508, ground: 0x000d10, grid: [0x001a15, 0x001210],
    ambient: [0x050a10, 3.5], sunColor: 0x88ffcc, sunIntensity: 1.8,
    fillColor: 0xcc00ff, fillIntensity: 0.5,
    accent: new THREE.Color(0x00ffaa),
    bloom: { strength: 0.7, radius: 0.6, threshold: 0.6 },
    ptColor: 0x005533,
    flashColor: 'rgba(0,255,160,0.45)',
    skyClass: 'aurora-sky',
  },
  custom: {
    bg: 0x020210, fog: 0x020210, ground: 0x040412, grid: [0x0a0a28, 0x080820],
    ambient: [0x1a2040, 4], sunColor: 0xffffff, sunIntensity: 2.5,
    fillColor: 0x3355aa, fillIntensity: 0.7,
    accent: new THREE.Color(0x4f8cff),
    bloom: { strength: 0.5, radius: 0.55, threshold: 0.7 },
    ptColor: 0x2244aa,
    flashColor: 'rgba(180,100,255,0.5)',
    skyClass: null,
  },
};

// ── DOM ────────────────────────────────────────────────────────────────────────
const container    = document.getElementById('canvas-container');
const statusEl     = document.getElementById('status');
const scanBtn      = document.getElementById('scan-btn');
const driveSelect  = document.getElementById('drive-select');
const progressWrap = document.getElementById('progress-wrap');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const scanPulse    = document.getElementById('scan-pulse');
const breadcrumbEl    = document.getElementById('breadcrumb');
const openExplorerBtn = document.getElementById('open-explorer-btn');
const copyPathBtn     = document.getElementById('copy-path-btn');
const ctxMenu         = document.getElementById('ctx-menu');
const ctxDriveMenu    = document.getElementById('ctx-drive-menu');
const infoPanel    = document.getElementById('info-panel');
const diskBarUsed  = document.getElementById('disk-bar-used');
const diskBarLabel = document.getElementById('disk-bar-label');
const tooltip      = document.getElementById('tooltip');
const ttName       = document.getElementById('tt-name');
const ttInfo       = document.getElementById('tt-info');
const ttCat        = document.getElementById('tt-cat');
const ttPreview    = document.getElementById('tt-preview');
const ttImg        = document.getElementById('tt-img');
const ttVid        = document.getElementById('tt-vid');
const hudBarFill   = document.getElementById('hud-bar-fill');
const hudText      = document.getElementById('hud-text');
const labelSlider  = document.getElementById('label-threshold');
const labelPct     = document.getElementById('label-pct');
const rpContent    = document.getElementById('rp-content');
const rpPlaceholder= document.getElementById('rp-placeholder');
const rpName       = document.getElementById('rp-name');
const rpSize       = document.getElementById('rp-size');
const rpBarFill    = document.getElementById('rp-bar-fill');
const rpSub        = document.getElementById('rp-sub');
const rpTypeGrid   = document.getElementById('rp-type-grid');
const smartOverlay   = document.getElementById('smart-overlay');
const smartBody      = document.getElementById('smart-body');
const smartLoading   = document.getElementById('smart-loading');
const vpOverlay      = document.getElementById('viewport-overlay');
const vpOverlayText  = document.getElementById('vp-overlay-text');
const drivesList     = document.getElementById('drives-list');
const ttChildren     = document.getElementById('tt-children');
const settingsOverlay = document.getElementById('settings-overlay');
const aboutOverlay   = document.getElementById('about-overlay');
const helpOverlay    = document.getElementById('help-overlay');

// ── Three.js state ────────────────────────────────────────────────────────────
let scene, camera, renderer3, controls, raycaster, composer, bloomPass;
// sceneObjects — every mesh/line/points added this frame (cleared on navigation)
// clickable    — subset of sceneObjects that respond to hover/click/right-click
// hovered      — the mesh currently highlighted by mouse-over (null = none)
// ctxNode      — the file-system node targeted by the last right-click
let sceneObjects = [], clickable = [], hovered = null, ctxNode = null;
let clock = new THREE.Clock();
// galaxyUniforms — ShaderMaterial uniforms for the galaxy particle shader;
// updated every frame with the elapsed time so particles twinkle.
let galaxyUniforms = null;

// ── Transition animation state ────────────────────────────────────────────────
// tAnim drives the "flash + scale-in" effect played on every navigation.
// dur   — duration in seconds (scaled by settings.animSpeed)
// dir   — +1 = drill in (zoom), -1 = navigate up (zoom out)
// cb    — callback that actually swaps the scene (called at the midpoint)
const tAnim = { active: false, t: 0, dur: 0.55, executed: false, cb: null, dir: 1 };

// ── Viewport background mode ──────────────────────────────────────────────────
// 'solid'    — flat scene.background colour from the active theme
// 'sky'      — same as gradient (alias kept for UI button labels)
// 'gradient' — canvas-rendered vertical gradient as scene.background texture
let viewportBgMode = 'gradient';

// ── App state ─────────────────────────────────────────────────────────────────
let currentMode  = 'sunburst';
let currentTheme = 'aurora';
const currentFont = 'Gotham';   // hardcoded — font selector removed
let labelThreshold = 2;         // items smaller than this % of parent are not labelled
// navStack — ordered breadcrumb: navStack[0] = root, last = current folder.
// All navigation pushes/pops this array and calls showLevel().
const navStack   = [];
let allDrives    = [];
let driveRoot         = null;   // top-level scanned root (used for "% of drive" maths)
let driveTotal        = 0;      // total drive capacity in bytes
let ctxDriveNode      = null;   // node targeted by drive-level right-click
let currentDriveLabel = '';     // label shown in the bottom HUD (e.g. "C:\" or "All Drives")

// ── Persistent settings ───────────────────────────────────────────────────────
let settings = {
  defaultMode: 'sunburst', defaultTheme: 'aurora', defaultBgMode: 'gradient',
  showFreeSpace: true, labelThresholdDefault: 2, animSpeed: 1.0,
  // recursionDepth applies to Sunburst and Galaxy.
  // 1 = one ring/level, 2 = two levels, 3 = three levels, 0 = unlimited (All)
  recursionDepth: 3,
};
(function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('dl-settings') || '{}');
    Object.assign(settings, s);
    currentMode     = settings.defaultMode   || 'sunburst';
    currentTheme    = settings.defaultTheme  || 'aurora';
    viewportBgMode  = settings.defaultBgMode || 'gradient';
    labelThreshold = settings.labelThresholdDefault ?? 2;
    labelSlider && (labelSlider.value = labelThreshold);
    labelPct    && (labelPct.textContent = labelThreshold + '%');
    // Activate correct buttons
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentMode));
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === currentTheme));
    document.querySelectorAll('.bg-opt-btn').forEach(b => b.classList.toggle('active', b.dataset.bg === viewportBgMode));
  } catch (_) {}
})();
function saveSettings() {
  try { localStorage.setItem('dl-settings', JSON.stringify(settings)); } catch (_) {}
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// Restore custom theme from localStorage before initThree so it's ready
(function restoreCustomTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem('dl-custom-theme') || '{}');
    if (!saved.bg) return;
    function hexToInt(hex) { return parseInt((hex||'').replace('#',''), 16) || 0; }
    const acc = new THREE.Color(hexToInt(saved.accent || '#4f8cff'));
    THEMES.custom = {
      bg: hexToInt(saved.bg), fog: hexToInt(saved.fog || saved.bg), ground: hexToInt(saved.bg),
      grid: [hexToInt(saved.grid||'#0a0a28'), hexToInt(saved.grid||'#0a0a28')],
      ambient: [hexToInt(saved.bg), 4], sunColor: hexToInt(saved.sun||'#ffffff'), sunIntensity: 2.5,
      fillColor: hexToInt(saved.fill||'#3355aa'), fillIntensity: 0.7,
      accent: acc,
      bloom: { strength: parseFloat(saved.bloom||'0.5'), radius: 0.55, threshold: 0.7 },
      ptColor: hexToInt(saved.fill||'#3355aa'),
      flashColor: `rgba(${acc.r*255|0},${acc.g*255|0},${acc.b*255|0},0.5)`,
      skyClass: null,
    };
  } catch (_) {}
})();

initThree();
animate();
loadDrives();
bindMenuEvents();
initCollapsibleSidebar();

// ── Three.js setup ────────────────────────────────────────────────────────────
// Initialises the WebGL renderer, scene, camera, post-processing stack,
// OrbitControls, raycaster, and all DOM event listeners.  Called once on boot.
function initThree() {
  scene = new THREE.Scene();
  applyTheme(currentTheme);

  const w = container.clientWidth, h = container.clientHeight;
  camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 2000);
  camera.position.set(0, 140, 170);

  renderer3 = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer3.setPixelRatio(window.devicePixelRatio);
  renderer3.setSize(w, h);
  renderer3.domElement.style.position = 'relative';
  renderer3.domElement.style.zIndex   = '2';
  // Re-apply clear color now that renderer3 exists (applyTheme ran before it was ready)
  applyViewportBg(currentTheme);
  renderer3.shadowMap.enabled = true;
  renderer3.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer3.toneMapping = THREE.NoToneMapping; // OutputPass handles tone-mapping
  container.appendChild(renderer3.domElement);

  // Post-processing
  composer = new EffectComposer(renderer3);
  composer.addPass(new RenderPass(scene, camera));
  const t = THEMES[currentTheme];
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), t.bloom.strength, t.bloom.radius, t.bloom.threshold);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass(THREE.ACESFilmicToneMapping, 1.1));

  controls = new OrbitControls(camera, renderer3.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 5;
  controls.maxDistance = 800;
  controls.maxPolarAngle = Math.PI / 2.05;

  raycaster = new THREE.Raycaster();

  window.addEventListener('resize', onResize);
  renderer3.domElement.addEventListener('mousemove', onMouseMove);
  renderer3.domElement.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKey);

  // Fire click actions on mousedown (press), not mouseup (release)
  // Guard against drag: if mouse moves >5px between down and up, treat as orbit not click
  let _pdx = 0, _pdy = 0, _pdrg = false;
  renderer3.domElement.addEventListener('pointerdown', e => {
    _pdx = e.clientX; _pdy = e.clientY; _pdrg = false;
  });
  renderer3.domElement.addEventListener('pointermove', e => {
    if (e.buttons && Math.hypot(e.clientX - _pdx, e.clientY - _pdy) > 5) _pdrg = true;
  });
  renderer3.domElement.addEventListener('pointerup', e => {
    if (!_pdrg && e.button === 0) onClick(e);
  });
}

function applyViewportBg(themeName) {
  const t    = THEMES[themeName] || THEMES.cosmos;
  const vpBg = document.getElementById('viewport-bg');
  const aurora = document.getElementById('vp-aurora-bands');

  aurora.style.display = 'none';
  vpBg.classList.remove('show');

  const wantSky = viewportBgMode === 'sky' || viewportBgMode === 'gradient';
  if (!wantSky || !t.skyClass) {
    // Solid mode: flat scene background colour
    scene.background = new THREE.Color(t.bg);
    if (renderer3) renderer3.setClearColor(t.bg, 1);
    return;
  }

  // Sky / gradient mode: render gradient as CanvasTexture inside Three.js
  // (CSS approach can't show through the opaque EffectComposer/bloom canvas)
  const skyTex = makeSkyTexture(themeName);
  if (skyTex) {
    scene.background = skyTex;
    if (renderer3) renderer3.setClearColor(0x000000, 1);
  } else {
    scene.background = new THREE.Color(t.bg);
    if (renderer3) renderer3.setClearColor(t.bg, 1);
  }

  // Show aurora overlay above canvas for aurora theme
  if (themeName === 'aurora') {
    vpBg.classList.add('show');
    aurora.style.display = 'block';
  }
}

function applyTheme(name) {
  const t = THEMES[name];
  // Background handled per viewportBgMode
  scene.fog = new THREE.FogExp2(t.fog, 0.004);
  applyViewportBg(name);
  // Remove old lights, add new ones
  scene.children.filter(c => c.isLight).forEach(l => scene.remove(l));
  scene.add(new THREE.AmbientLight(t.ambient[0], t.ambient[1]));
  const sun = new THREE.DirectionalLight(t.sunColor, t.sunIntensity);
  sun.position.set(80, 180, 100);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -200;
  sun.shadow.camera.right = sun.shadow.camera.top  =  200;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(t.fillColor, t.fillIntensity);
  fill.position.set(-100, 60, -100);
  scene.add(fill);
  // Accent point light
  const pt = new THREE.PointLight(t.ptColor, 2, 400);
  pt.position.set(0, 120, 0);
  scene.add(pt);
  if (bloomPass) {
    bloomPass.strength  = t.bloom.strength;
    bloomPass.radius    = t.bloom.radius;
    bloomPass.threshold = t.bloom.threshold;
  }
}

function onResize() {
  const w = container.clientWidth, h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer3.setSize(w, h);
  composer.setSize(w, h);
  if (bloomPass) bloomPass.resolution.set(w, h);
}

// ── Viewport overlay ──────────────────────────────────────────────────────────
function showVpOverlay(text) {
  vpOverlayText.textContent = text || 'Working…';
  vpOverlay.classList.add('active');
}
function hideVpOverlay() {
  vpOverlay.classList.remove('active');
}

// ── Settings modal ────────────────────────────────────────────────────────────
(function initSettingsModal() {
  const sm  = document.getElementById('set-default-mode');
  const st  = document.getElementById('set-default-theme');
  const sf  = document.getElementById('set-show-free');
  const sl  = document.getElementById('set-label-thresh');
  const slp = document.getElementById('set-label-pct');
  const sa  = document.getElementById('set-anim-speed');
  const sap = document.getElementById('set-anim-pct');
  const srd = document.getElementById('set-recursion-depth'); // new: recursion count

  // Populate controls from current settings values
  function syncUI() {
    if (sm) sm.value = settings.defaultMode;
    if (st) st.value = settings.defaultTheme;
    if (sf) sf.checked = settings.showFreeSpace !== false;
    if (sl) { sl.value = settings.labelThresholdDefault ?? 2; slp.textContent = sl.value + '%'; }
    if (sa) { sa.value = settings.animSpeed ?? 1; sap.textContent = parseFloat(sa.value).toFixed(1) + '×'; }
    if (srd) srd.value = String(settings.recursionDepth ?? 3);
  }
  if (sm) sm.addEventListener('change', () => { settings.defaultMode = sm.value; saveSettings(); });
  if (st) st.addEventListener('change', () => { settings.defaultTheme = st.value; saveSettings(); });
  if (sf) sf.addEventListener('change', () => {
    settings.showFreeSpace = sf.checked;
    saveSettings();
    if (navStack.length) showLevel(navStack[navStack.length - 1]);
  });
  if (sl) sl.addEventListener('input', () => {
    settings.labelThresholdDefault = parseFloat(sl.value);
    labelThreshold = settings.labelThresholdDefault;
    slp.textContent = sl.value + '%';
    labelSlider.value = sl.value; labelPct.textContent = sl.value + '%';
    saveSettings();
    if (navStack.length) showLevel(navStack[navStack.length - 1]);
  });
  if (sa) sa.addEventListener('input', () => {
    settings.animSpeed = parseFloat(sa.value);
    sap.textContent = settings.animSpeed.toFixed(1) + '×';
    saveSettings();
  });
  // Recursion depth: how many sub-levels Sunburst and Galaxy render.
  // 0 means unlimited ("All"). Changing re-renders the active view immediately.
  if (srd) srd.addEventListener('change', () => {
    settings.recursionDepth = parseInt(srd.value, 10);
    saveSettings();
    if (navStack.length) showLevel(navStack[navStack.length - 1]);
  });

  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => { syncUI(); settingsOverlay.classList.add('open'); });
  document.getElementById('settings-close')?.addEventListener('click', () => settingsOverlay.classList.remove('open'));
  settingsOverlay?.addEventListener('click', e => { if (e.target === settingsOverlay) settingsOverlay.classList.remove('open'); });

  document.getElementById('about-close')?.addEventListener('click', () => aboutOverlay.classList.remove('open'));
  aboutOverlay?.addEventListener('click', e => { if (e.target === aboutOverlay) aboutOverlay.classList.remove('open'); });

  document.getElementById('help-close')?.addEventListener('click', () => helpOverlay.classList.remove('open'));
  helpOverlay?.addEventListener('click', e => { if (e.target === helpOverlay) helpOverlay.classList.remove('open'); });

  // ── Custom theme builder ───────────────────────────────────────────────────
  const custBg     = document.getElementById('cust-bg');
  const custFog    = document.getElementById('cust-fog');
  const custGrid   = document.getElementById('cust-grid');
  const custSun    = document.getElementById('cust-sun');
  const custFill   = document.getElementById('cust-fill');
  const custAccent = document.getElementById('cust-accent');
  const custBloom  = document.getElementById('cust-bloom');
  const custBloomV = document.getElementById('cust-bloom-val');
  const custApply  = document.getElementById('cust-apply');
  const custSave   = document.getElementById('cust-save');

  function hexToInt(hex) { return parseInt(hex.replace('#',''), 16); }

  function buildCustomTheme() {
    const bg  = hexToInt(custBg?.value  || '#020210');
    const fog = hexToInt(custFog?.value || '#020210');
    const grd = hexToInt(custGrid?.value || '#0a0a28');
    const sun = hexToInt(custSun?.value  || '#ffffff');
    const fil = hexToInt(custFill?.value || '#3355aa');
    const acc = new THREE.Color(hexToInt(custAccent?.value || '#4f8cff'));
    const blm = parseFloat(custBloom?.value || '0.5');
    THEMES.custom = {
      bg, fog, ground: bg, grid: [grd, grd],
      ambient: [bg, 4], sunColor: sun, sunIntensity: 2.5,
      fillColor: fil, fillIntensity: 0.7,
      accent: acc,
      bloom: { strength: blm, radius: 0.55, threshold: 0.7 },
      ptColor: fil,
      flashColor: `rgba(${acc.r*255|0},${acc.g*255|0},${acc.b*255|0},0.5)`,
      skyClass: null,
    };
    return THEMES.custom;
  }

  // Sync pickers to saved custom values if any
  function loadCustomPickers() {
    try {
      const saved = JSON.parse(localStorage.getItem('dl-custom-theme') || '{}');
      if (saved.bg      && custBg)     custBg.value     = saved.bg;
      if (saved.fog     && custFog)    custFog.value    = saved.fog;
      if (saved.grid    && custGrid)   custGrid.value   = saved.grid;
      if (saved.sun     && custSun)    custSun.value    = saved.sun;
      if (saved.fill    && custFill)   custFill.value   = saved.fill;
      if (saved.accent  && custAccent) custAccent.value = saved.accent;
      if (saved.bloom   && custBloom)  { custBloom.value = saved.bloom; if(custBloomV) custBloomV.textContent = saved.bloom; }
    } catch (_) {}
  }
  loadCustomPickers();

  if (custBloom) custBloom.addEventListener('input', () => {
    if (custBloomV) custBloomV.textContent = parseFloat(custBloom.value).toFixed(2);
  });

  if (custApply) custApply.addEventListener('click', () => {
    buildCustomTheme();
    if (currentTheme === 'custom') {
      applyTheme('custom');
      if (navStack.length) {
        const node = navStack[navStack.length - 1];
        navigateWithTransition(node, 1, () => showLevel(node));
      }
    }
  });

  if (custSave) custSave.addEventListener('click', () => {
    buildCustomTheme();
    // Persist picker state
    try {
      localStorage.setItem('dl-custom-theme', JSON.stringify({
        bg: custBg?.value, fog: custFog?.value, grid: custGrid?.value,
        sun: custSun?.value, fill: custFill?.value, accent: custAccent?.value,
        bloom: custBloom?.value,
      }));
    } catch (_) {}
    // Activate
    currentTheme = 'custom';
    settings.defaultTheme = 'custom'; saveSettings();
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === 'custom'));
    applyTheme('custom');
    if (navStack.length) {
      const node = navStack[navStack.length - 1];
      navigateWithTransition(node, 1, () => showLevel(node));
    }
    settingsOverlay.classList.remove('open');
  });

  const custReset = document.getElementById('cust-reset');
  if (custReset) custReset.addEventListener('click', () => {
    localStorage.removeItem('dl-custom-theme');
    // Reset pickers to cosmos defaults
    if (custBg)     custBg.value     = '#020210';
    if (custFog)    custFog.value    = '#020210';
    if (custGrid)   custGrid.value   = '#0a0a28';
    if (custSun)    custSun.value    = '#ffffff';
    if (custFill)   custFill.value   = '#3355aa';
    if (custAccent) custAccent.value = '#4f8cff';
    if (custBloom)  { custBloom.value = '0.5'; if(custBloomV) custBloomV.textContent = '0.50'; }
    // Reset THEMES.custom to cosmos clone
    THEMES.custom = { ...THEMES.cosmos, skyClass: null };
    if (currentTheme === 'custom') {
      currentTheme = 'cosmos';
      settings.defaultTheme = 'cosmos'; saveSettings();
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === 'cosmos'));
      applyTheme('cosmos');
    }
  });
})();

// ── Drive list ────────────────────────────────────────────────────────────────
async function loadDrives() {
  try {
    allDrives = await window.api.listDrives();
    driveSelect.innerHTML = '<option value="">— choose drive —</option>';

    if (allDrives.length === 0) {
      // Fallback: offer common drives
      const fallback = document.createElement('option');
      fallback.value = 'C:\\'; fallback.textContent = 'C:\\ (fallback)';
      driveSelect.appendChild(fallback);
    } else {
      for (const d of allDrives) {
        const o = document.createElement('option');
        o.value = d.letter;
        if (d.size > 0) {
          o.textContent = `${d.letter}  ${fmt(d.size - d.free)} / ${fmt(d.size)}`;
        } else {
          o.textContent = `${d.letter}  (size unknown)`;
        }
        driveSelect.appendChild(o);
      }
    }

    const allOpt = document.createElement('option');
    allOpt.value = '__all__'; allOpt.textContent = '⊞ All Drives';
    driveSelect.appendChild(allOpt);

    statusEl.textContent = `${allDrives.length} drive(s) found`;
    buildDrivesList();
    loadSmartToRightPanel();   // ← auto SMART scan on startup
    // Auto-show All Drives on startup
    if (allDrives.length) {
      driveSelect.value = '__all__';
      const root = buildAllDrivesRoot();
      driveRoot  = root;
      driveTotal = root.size;
      const allUsed = allDrives.reduce((s, d) => s + (d.size - d.free), 0);
      const allPct  = root.size > 0 ? (allUsed / root.size) * 100 : 0;
      diskBarUsed.style.width  = allPct.toFixed(1) + '%';
      diskBarLabel.textContent = `${fmt(allUsed)} used of ${fmt(root.size)} (${allPct.toFixed(1)}%)`;
      updateHUD(allUsed, root.size, 'All Drives');
      navStack.length = 0; navStack.push(root);
      showLevel(root);
    }
  } catch (_) {
    driveSelect.innerHTML = '<option value="">— choose drive —</option><option value="C:\\">C:\\ (fallback)</option><option value="__all__">⊞ All Drives</option>';
  }
}

function buildDrivesList() {
  drivesList.innerHTML = '';
  const GRAD_COLORS = ['#4f8cff,#a78bfa', '#e74c3c,#f39c12', '#2ecc71,#1abc9c', '#f39c12,#e67e22'];
  allDrives.filter(d => d.size > 0).forEach((d, i) => {
    const used = d.size - d.free;
    const pct  = (used / d.size) * 100;
    const grad = GRAD_COLORS[i % GRAD_COLORS.length];
    const row  = document.createElement('div');
    row.className = 'drive-row';
    row.innerHTML = `
      <div class="drive-row-header">
        <span class="drive-row-letter">${d.letter}</span>
        <span>${fmt(used)} / ${fmt(d.size)}</span>
      </div>
      <div class="drive-bar-track">
        <div class="drive-bar-used" style="width:${pct.toFixed(1)}%;background:linear-gradient(90deg,${grad})"></div>
      </div>
      <div class="drive-bar-label">${pct.toFixed(1)}% used</div>`;
    drivesList.appendChild(row);
  });
  if (!drivesList.children.length)
    drivesList.innerHTML = '<div style="font-size:9px;color:#333">No drives found</div>';
}

// ── SMART in right panel ──────────────────────────────────────────────────────
async function loadSmartToRightPanel() {
  const loading = document.getElementById('rp-smart-loading');
  const body    = document.getElementById('rp-smart-body');
  if (!loading || !body) return;
  loading.style.display = 'block';
  body.innerHTML = '';
  try {
    const res = await window.api.fsSmart();
    loading.style.display = 'none';
    if (res.error || !res.disks?.length) {
      body.innerHTML = '<div style="font-size:9px;color:#333;padding:2px 0">No S.M.A.R.T. data<br>(run as Admin for full access)</div>';
      return;
    }
    for (const d of res.disks) {
      const health = (d.Health || '').toLowerCase();
      const hClass = health === 'healthy' ? 'good' : health === 'warning' ? 'warn' : 'bad';
      const temp   = d.TemperatureC;
      const tClass = !temp ? '' : temp < 45 ? 'good' : temp < 60 ? 'warn' : 'bad';
      const rows = [
        ['Health',  d.Health || '—',                             hClass],
        ['Temp',    temp != null ? temp + ' °C' : 'N/A',        tClass],
        ['Type',    d.MediaType || '—',                          ''],
        ['Size',    d.SizeGB ? d.SizeGB + ' GB' : '—',          ''],
        ['Hrs',     d.PowerOnHours != null ? d.PowerOnHours + ' h' : 'N/A', ''],
        ['Rd Err',  d.ReadErrors  != null ? d.ReadErrors  : 'N/A', d.ReadErrors  > 0 ? 'warn' : 'good'],
        ['Wr Err',  d.WriteErrors != null ? d.WriteErrors : 'N/A', d.WriteErrors > 0 ? 'warn' : 'good'],
        ['Wear',    d.Wear != null ? d.Wear + '%' : 'N/A',      d.Wear > 80 ? 'bad' : d.Wear > 50 ? 'warn' : 'good'],
      ].filter(([, v]) => v && v !== 'N/A' || true);

      const rowsHtml = rows.map(([k, v, cls]) =>
        `<div class="rp-smart-row"><span class="rp-smart-k">${k}</span><span class="rp-smart-v ${cls||''}">${v}</span></div>`
      ).join('');
      const driveTag = d.Drives ? `<span class="rp-smart-drives">${d.Drives}</span>` : '';
      body.innerHTML +=
        `<div class="rp-smart-disk"><div class="rp-smart-disk-name">${d.Name || 'Disk'}${driveTag}</div>${rowsHtml}</div>`;
    }
  } catch (_) {
    if (loading) loading.style.display = 'none';
    body.innerHTML = '<div style="font-size:9px;color:#333">S.M.A.R.T. unavailable</div>';
  }
}

// Toggle SMART collapse
(function() {
  const toggle = document.getElementById('rp-smart-toggle');
  const body   = document.getElementById('rp-smart-body');
  const load   = document.getElementById('rp-smart-loading');
  const caret  = document.getElementById('rp-smart-caret');
  if (!toggle) return;
  let open = true;
  toggle.addEventListener('click', () => {
    open = !open;
    if (body)  body.style.display  = open ? 'flex' : 'none';
    if (load)  load.style.display  = open ? 'block' : 'none';
    if (caret) caret.classList.toggle('open', open);
  });
  // Start expanded; caret points up
  if (caret) caret.classList.add('open');
})();


// ── IPC menu events ────────────────────────────────────────────────────────────
function bindMenuEvents() {
  window.api.onMenuDriveSelected(v => {
    driveSelect.value = v;
    scanBtn.click();
  });
  window.api.onMenuMode(v => {
    const btn = document.querySelector(`.mode-btn[data-mode="${v}"]`);
    if (btn) btn.click();
  });
  window.api.onMenuTheme(v => {
    const btn = document.querySelector(`.theme-btn[data-theme="${v}"]`);
    if (btn) btn.click();
  });
  window.api.onMenuNav(v => {
    if (v === 'up') navigateUp();
    else if (v === 'root') {
      if (navStack.length > 1) {
        const root = navStack[0];
        navigateWithTransition(root, -1, () => { navStack.splice(1); showLevel(navStack[0]); });
      }
    }
  });
  if (window.api.onMenuSettings) window.api.onMenuSettings(() => {
    document.getElementById('settings-btn')?.click();
  });
  if (window.api.onMenuAbout) window.api.onMenuAbout(() => {
    aboutOverlay.classList.add('open');
  });
  if (window.api.onMenuHelp) window.api.onMenuHelp(() => {
    helpOverlay.classList.add('open');
  });
}

// ── Mode buttons ──────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentMode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
    controls.maxPolarAngle = currentMode === 'treemap' ? Math.PI / 2.05 : Math.PI;
    if (navStack.length) {
      const node = navStack[navStack.length - 1];
      navigateWithTransition(node, 1, () => showLevel(node));
    }
  });
});

// ── Theme buttons ─────────────────────────────────────────────────────────────
document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTheme = btn.dataset.theme;
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b === btn));
    const savedPos    = camera.position.clone();
    const savedTarget = controls.target.clone();
    applyTheme(currentTheme);
    settings.defaultTheme = currentTheme; saveSettings();
    if (navStack.length) {
      const node = navStack[navStack.length - 1];
      navigateWithTransition(node, 1, () => {
        showLevel(node);
        camera.position.copy(savedPos);
        controls.target.copy(savedTarget);
        controls.update();
      });
    }
  });
});

// ── Viewport background option buttons ────────────────────────────────────────
document.querySelectorAll('.bg-opt-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    viewportBgMode = btn.dataset.bg;
    settings.defaultBgMode = viewportBgMode; saveSettings();
    document.querySelectorAll('.bg-opt-btn').forEach(b => b.classList.toggle('active', b === btn));
    applyViewportBg(currentTheme);
    if (navStack.length) {
      const node = navStack[navStack.length - 1];
      navigateWithTransition(node, 1, () => showLevel(node));
    }
  });
});

// ── Label threshold control ───────────────────────────────────────────────────
labelSlider.addEventListener('input', () => {
  labelThreshold = parseFloat(labelSlider.value);
  labelPct.textContent = labelThreshold + '%';
  if (navStack.length) showLevel(navStack[navStack.length - 1]);
});

// ── Scan ──────────────────────────────────────────────────────────────────────
scanBtn.addEventListener('click', async () => {
  const driveVal = driveSelect.value;
  if (!driveVal) { statusEl.textContent = 'Please select a drive.'; return; }

  if (driveVal === '__all__') {
    const root = buildAllDrivesRoot();
    driveRoot  = root;
    driveTotal = root.size;
    const allUsed = allDrives.reduce((s, d) => s + (d.size - d.free), 0);
    const allPct  = root.size > 0 ? (allUsed / root.size) * 100 : 0;
    diskBarUsed.style.width  = allPct.toFixed(1) + '%';
    diskBarLabel.textContent = `${fmt(allUsed)} used of ${fmt(root.size)} (${allPct.toFixed(1)}%)`;
    updateHUD(allUsed, root.size, 'All Drives');
    navStack.length = 0; navStack.push(root);
    showLevel(root);
    statusEl.textContent = 'Showing all drives — click to explore';
    return;
  }

  scanBtn.disabled = true;
  progressWrap.style.display = 'flex';
  scanPulse.style.display = 'block';
  progressFill.style.width = '1%';
  progressText.textContent = '0%';
  statusEl.textContent = 'Scanning…';
  showVpOverlay('Scanning ' + driveVal.replace(/\\+$/, '') + '…');

  window.api.onScanProgress(({ pct, done, total }) => {
    progressFill.style.width = pct + '%';
    progressText.textContent = `${pct}%  (${done} / ${total} items)`;
  });

  try {
    const res = await window.api.scanDrive(driveVal);
    if (res.error) throw new Error(res.error);
    const { free, total, used, tree } = res;

    const pct = total > 0 ? (used / total) * 100 : 0;
    diskBarUsed.style.width = pct.toFixed(1) + '%';
    diskBarLabel.textContent = `${fmt(used)} used of ${fmt(total)} (${pct.toFixed(1)}%)`;

    const root = {
      name: driveVal, size: total, path: driveVal,
      children: [
        { name: 'Free Space', size: free, path: driveVal, children: [] },
        ...(tree.children || []),
      ],
    };
    driveRoot  = root;
    driveTotal = total;
    updateHUD(used, total, driveVal.replace(/\\+$/, ''));
    navStack.length = 0; navStack.push(root);
    showLevel(root);
    statusEl.textContent = 'Done — click folders to explore';
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  } finally {
    scanBtn.disabled = false;
    window.api.offScanProgress();
    progressFill.style.width = '100%';
    progressText.textContent = '100%';
    scanPulse.style.display = 'none';
    hideVpOverlay();
    setTimeout(() => { progressWrap.style.display = 'none'; }, 1200);
  }
});

function buildAllDrivesRoot() {
  return {
    name: 'All Drives',
    size: allDrives.reduce((s, d) => s + d.size, 0),
    path: '',
    children: allDrives.map(d => ({
      name: d.letter, size: d.size, path: d.letter,
      _isDriveStub: true,      // marks node as needing a scan before drilling
      _driveUsed: d.size - d.free,
      _driveFree: d.free,
      _scanned: false,
      children: [
        { name: 'Free Space', size: d.free,          path: d.letter, children: [] },
        { name: 'Used',       size: d.size - d.free, path: d.letter, children: [] },
      ],
    })),
  };
}

// ── Scan a drive on-demand and drill into it from All Drives view ─────────────
async function scanAndDrillDrive(driveNode) {
  showVpOverlay('Scanning ' + driveNode.name + '…');
  scanBtn.disabled = true;
  try {
    const res = await window.api.scanDrive(driveNode.path);
    if (res.error) throw new Error(res.error);
    const { free, total, used, tree } = res;
    // Replace stub children with real scan data
    driveNode.children = [
      { name: 'Free Space', size: free, path: driveNode.path, children: [] },
      ...(tree.children || []),
    ];
    driveNode.size    = total;
    driveNode._scanned = true;
    driveTotal = total;
    updateHUD(used, total, driveNode.name);
    navigateWithTransition(driveNode, 1, () => { navStack.push(driveNode); showLevel(driveNode); });
    statusEl.textContent = 'Done — click folders to explore';
  } catch (err) {
    statusEl.textContent = 'Scan error: ' + err.message;
    alert('Scan failed: ' + err.message);
  } finally {
    scanBtn.disabled = false;
    hideVpOverlay();
  }
}

// ── Transition flash ──────────────────────────────────────────────────────────
const _transFlash = document.getElementById('trans-flash');

function fireTransitionFlash(direction = 1) {
  const t = THEMES[currentTheme] || THEMES.cosmos;
  _transFlash.style.background = direction > 0
    ? `radial-gradient(ellipse at center,${t.flashColor} 0%,transparent 72%)`
    : `radial-gradient(ellipse at center,rgba(0,0,0,0.6) 0%,transparent 72%)`;
  _transFlash.classList.add('pop');
  requestAnimationFrame(() => requestAnimationFrame(() => _transFlash.classList.remove('pop')));
}

// Navigate to a node with a premium transition animation
function navigateWithTransition(node, direction = 1, callback = null) {
  if (tAnim.active) {
    // If already animating, skip and do immediately
    if (callback) callback();
    else { navStack.push(node); showLevel(node); }
    return;
  }
  fireTransitionFlash(direction);
  tAnim.active   = true;
  tAnim.t        = 0;
  tAnim.executed = false;
  tAnim.dir      = direction;
  tAnim.cb       = callback || (() => { navStack.push(node); showLevel(node); });
}

function navigateUpWithTransition() {
  if (navStack.length <= 1) return;
  fireTransitionFlash(-1);
  tAnim.active   = true;
  tAnim.t        = 0;
  tAnim.executed = false;
  tAnim.dir      = -1;
  tAnim.cb       = () => { navStack.pop(); showLevel(navStack[navStack.length - 1]); };
}

// ── Level router ──────────────────────────────────────────────────────────────
// Clears the scene and delegates to the active visualisation renderer.
// Called after every navigation event (drill in, go up, breadcrumb click,
// mode switch, theme switch, or settings change).
function showLevel(node) {
  clearScene();
  updateBreadcrumb();
  updateLegend(node);
  galaxyUniforms = null;
  switch (currentMode) {
    case 'treemap':  renderTreemap(node);  break;
    case 'sunburst': renderSunburst(node); break;
    case 'bar':      renderBarChart(node); break;
    case 'stacked':  renderStacked(node);  break;
    case 'city':     renderCity(node);     break;
    case 'galaxy':   renderGalaxy(node);   break;
  }
  // Prime all meshes for scale-in animation
  if (tAnim.active && tAnim.executed) {
    sceneObjects.forEach(o => {
      if (o.isMesh || o.isPoints || o.isLine) {
        o.userData._tgtScale = 1;
        o.scale.setScalar(0.01);
      }
    });
  }
}

// ── Canvas text label ─────────────────────────────────────────────────────────
// Renders white text onto an offscreen Canvas, uploads it as a texture, and
// attaches it to a billboard PlaneGeometry.  Using Canvas rather than a 3D
// font keeps the bundle small and guarantees pixel-perfect sharpness.
function makeLabel(text, font) {
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  const fs     = 56;
  ctx.font = `bold ${fs}px "${font}", sans-serif`;
  const tw = Math.max(ctx.measureText(text).width + 24, 80);
  canvas.width  = Math.ceil(tw);
  canvas.height = fs + 16;
  ctx.font = `bold ${fs}px "${font}", sans-serif`;
  // subtle shadow for depth
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(text, 12, fs);
  const tex = new THREE.CanvasTexture(canvas);
  const aspect = canvas.width / canvas.height;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const geo = new THREE.PlaneGeometry(aspect * 3.5, 3.5);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  return { mesh, canvas };
}

// ── PBR material factory ──────────────────────────────────────────────────────
// Creates a MeshStandardMaterial with sane defaults.
// emissiveMult — how much of the base colour bleeds into self-emission (0–1)
// isFree       — when true the material is semi-transparent (free-space tiles)
function makeMat(color, emissiveMult = 0.18, rough = 0.35, metal = 0.6, isFree = false) {
  const c = new THREE.Color(color);
  const mat = new THREE.MeshStandardMaterial({
    color: c,
    emissive: c.clone().multiplyScalar(isFree ? 0.05 : emissiveMult),
    roughness: isFree ? 0.9 : rough,
    metalness: isFree ? 0.05 : metal,
    transparent: isFree,
    opacity: isFree ? 0.32 : 1.0,
  });
  return mat;
}

function makeFreeMat() {
  return makeMat(COLOR_FREE, 0.05, 0.9, 0.05, true);
}

// visibleKids — returns the direct children of a node that should be rendered.
// Filters out zero-size items and, when the "Show Free Space" setting is off,
// removes the synthetic "Free Space" placeholder child.
function visibleKids(node) {
  return (node.children || []).filter(c => c.size > 0 && (settings?.showFreeSpace !== false || c.name !== 'Free Space'));
}

// ══════════════════════════════════════════════════════════════════════════════
// MODE 1 — 3D TREEMAP (squarified)
//
// The squarified treemap algorithm lays out rectangles with near-1:1 aspect
// ratios to maximise readability.  Each rectangle's area is proportional to
// the file/folder size.  The resulting 2D rects are then extruded into 3D
// boxes whose height is a log-scaled function of size.
// ══════════════════════════════════════════════════════════════════════════════

// squarify — recursive squarified treemap layout.
// items  — array of { node, a: areaInWorldUnits }
// rect   — { x, y, w, h } available space in layout coordinates
// out    — accumulator array that receives placed { node, x, y, w, h } objects
function squarify(items, rect, out) {
  const { x, y, w, h } = rect;
  if (!items.length || w <= 0 || h <= 0) return;
  if (items.length === 1) { out.push({ ...items[0], x, y, w, h }); return; }
  const horiz = w >= h, free = horiz ? h : w;
  function worst(row) {
    const s = row.reduce((a, i) => a + i.a, 0);
    const mn = Math.min(...row.map(i => i.a)), mx = Math.max(...row.map(i => i.a));
    if (mn <= 0) return Infinity;
    return Math.max((free * free * mx) / (s * s), (s * s) / (free * free * mn));
  }
  let end = 1, prev = worst(items.slice(0, 1));
  for (let i = 2; i <= items.length; i++) {
    const nxt = worst(items.slice(0, i));
    if (nxt > prev) break; prev = nxt; end = i;
  }
  const row = items.slice(0, end), rowSum = row.reduce((a, i) => a + i.a, 0), thick = rowSum / free;
  let off = 0;
  for (const it of row) {
    const len = (it.a / rowSum) * free;
    out.push(horiz ? { ...it, x, y: y + off, w: thick, h: len } : { ...it, x: x + off, y, w: len, h: thick });
    off += len;
  }
  const rest = items.slice(end);
  if (rest.length) squarify(rest, horiz ? { x: x + thick, y, w: w - thick, h } : { x, y: y + thick, w, h: h - thick }, out);
}

function renderTreemap(node) {
  posCamera(0, 150, 180, 0, 0, 0);
  addGround();

  const kids = visibleKids(node);
  if (!kids.length) return;
  const total = kids.reduce((s, c) => s + c.size, 0);
  const sorted = [...kids].sort((a, b) => b.size - a.size);
  const rects = [];
  squarify(sorted.map(c => ({ node: c, a: (c.size / total) * TMAP * TMAP })), { x: 0, y: 0, w: TMAP, h: TMAP }, rects);
  const maxSz = sorted[0].size;

  for (const { node: n, x, y, w, h } of rects) {
    if (w < 0.05 || h < 0.05) continue;
    const isF = !!(n.children?.length);
    const cx = (x + w / 2) / TMAP * WORLD - WORLD / 2;
    const cz = (y + h / 2) / TMAP * WORLD - WORLD / 2;
    const bw = Math.max(w / TMAP * WORLD - GAP, 0.15);
    const bd = Math.max(h / TMAP * WORLD - GAP, 0.15);
    const bh = BOX_MIN_H + (Math.log(n.size + 2) / Math.log(maxSz + 2)) * (BOX_MAX_H - BOX_MIN_H);
    const showEdge = bw > 1.5 && bd > 1.5;

    if (n._isDriveStub) {
      // Split the block: used (left) + free (right) within the allocated rect
      const usedFrac = n.size > 0 ? n._driveUsed / n.size : 1;
      const freeFrac = 1 - usedFrac;
      const usedBW   = Math.max(bw * usedFrac - GAP / 2, 0.1);
      const freeBW   = Math.max(bw * freeFrac - GAP / 2, 0.1);
      const usedCX   = cx - bw / 2 + usedBW / 2;
      const freeCX   = cx + bw / 2 - freeBW / 2;
      // Used portion — clickable (triggers scan + drill)
      addStyledBox(usedCX, bh / 2, cz, usedBW, bh, bd, COLOR_USED, n, true, showEdge);
      // Free portion — informational
      if (freeFrac > 0.01 && settings.showFreeSpace !== false) {
        const freeH = Math.max(bh * 0.4, BOX_MIN_H);
        addStyledBox(freeCX, freeH / 2, cz, freeBW, freeH, bd,
          COLOR_FREE, n.children.find(c => c.name === 'Free Space') || n, false, false);
      }
    } else {
      const color = nodeColor(n.name, isF);
      addStyledBox(cx, bh / 2, cz, bw, bh, bd, color, n, isF, showEdge);
    }

    // Label if segment large enough
    const pct = (n.size / total) * 100;
    if (pct >= labelThreshold && bw > 4 && bd > 4) {
      const { mesh } = makeLabel(truncate(n.name, 18), currentFont);
      mesh.position.set(cx, bh + 2.2, cz);
      mesh.rotation.x = -Math.PI / 6;
      scene.add(mesh);
      sceneObjects.push(mesh);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MODE 2 — SUNBURST
// ══════════════════════════════════════════════════════════════════════════════
function makeSector(iR, oR, a0, a1, ht) {
  const sh = new THREE.Shape();
  sh.moveTo(Math.cos(a0) * iR, Math.sin(a0) * iR);
  sh.lineTo(Math.cos(a0) * oR, Math.sin(a0) * oR);
  sh.absarc(0, 0, oR, a0, a1, false);
  sh.lineTo(Math.cos(a1) * iR, Math.sin(a1) * iR);
  if (iR > 0) sh.absarc(0, 0, iR, a1, a0, true); else sh.lineTo(0, 0);
  const g = new THREE.ExtrudeGeometry(sh, { depth: ht, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

function addSector(iR, oR, a0, a1, ht, color, node, isF) {
  if (a1 - a0 < 0.003) return;
  const isFree = node?.name === 'Free Space';
  const mat = isFree ? makeFreeMat() : makeMat(color, 0.22, 0.3, 0.5);
  mat.side = THREE.DoubleSide;
  mat.needsUpdate = true;
  const sectorGeo = makeSector(iR, oR, a0, a1, ht);
  const mesh = new THREE.Mesh(sectorGeo, mat);
  // Thin black separator lines at sector edges
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x000000, opacity: 0.55, transparent: true });
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(sectorGeo, 15), edgeMat);
  scene.add(edges); sceneObjects.push(edges);
  mesh.castShadow = true;
  // Store midAngle for sunburst kick-out on hover; geometry rotateX(-π/2) maps → (cos a, 0, -sin a)
  const midA = (a0 + a1) / 2;
  mesh.userData = { node, isFolder: isF, baseColor: color, isSector: true,
    kickX: Math.cos(midA) * 3.5, kickZ: -Math.sin(midA) * 3.5 };
  scene.add(mesh); sceneObjects.push(mesh); clickable.push(mesh);

  // Label for large sectors
  const span = a1 - a0;
  const pct  = span / (Math.PI * 2) * 100;
  if (pct >= labelThreshold && span > 0.25) {
    const midA = (a0 + a1) / 2;
    const midR = (iR + oR) / 2;
    // geometry is rotateX(-π/2) so shape angle a → world (cos a, 0, -sin a)
    const lx = Math.cos(midA) * midR;
    const lz = -Math.sin(midA) * midR;
    const { mesh: lm } = makeLabel(truncate(node.name, 16), currentFont);
    lm.position.set(lx, ht + 1.5, lz);
    lm.rotation.x = -Math.PI / 2 + 0.3; // consistent tilt toward viewer for all labels
    scene.add(lm); sceneObjects.push(lm);
  }
}

function renderSunburst(node) {
  posCamera(0, 170, 60, 0, 0, 0);

  // ── Centre disk ──────────────────────────────────────────────────────────
  // Clicking the centre disk navigates UP to the parent directory.
  const cg = new THREE.CylinderGeometry(13, 13, 9, 64);
  const cm = makeMat(THEMES[currentTheme].accent.getHex(), 0.5, 0.2, 0.7);
  const cc = new THREE.Mesh(cg, cm);
  cc.position.y = 4.5; cc.castShadow = true;
  // isCenterNav = true tells onClick() to go UP instead of drilling in
  cc.userData = { node, isFolder: true, baseColor: THEMES[currentTheme].accent.getHex(), isCenterNav: true };
  scene.add(cc); sceneObjects.push(cc); clickable.push(cc);

  // Decorative glow ring around the centre
  const ringG = new THREE.TorusGeometry(13.5, 0.6, 16, 64);
  const ringM = new THREE.MeshStandardMaterial({
    color: THEMES[currentTheme].accent, emissive: THEMES[currentTheme].accent,
    emissiveIntensity: 1.5, roughness: 0.1, metalness: 0.8,
  });
  const ring = new THREE.Mesh(ringG, ringM);
  ring.position.y = 9; ring.rotation.x = Math.PI / 2;
  scene.add(ring); sceneObjects.push(ring);

  // ── Ring geometry layout ─────────────────────────────────────────────────
  // Each ring pair (iR, oR) is one recursion level.  We add more ring pairs
  // when the user increases the Recursion Count in Settings.
  // depth: how many levels to draw (0 = unlimited, otherwise cap at that depth)
  const maxDepth = (settings.recursionDepth > 0) ? settings.recursionDepth : Infinity;

  // Ring geometry: [innerR, outerR, height] for each depth level
  const RINGS = [
    [14, 36, 7],
    [37, 58, 5],
    [59, 76, 3],
    [77, 92, 2],
    [93, 106, 1.5],
  ];

  // Recursive sector builder — walks the tree up to maxDepth levels deep
  function buildRings(children, parentAngleStart, parentAngleSpan, depth) {
    if (depth > maxDepth || depth > RINGS.length) return;
    const [iR, oR, ht] = RINGS[depth - 1];
    const tot = children.reduce((s, c) => s + c.size, 0);
    if (!tot) return;
    let a = parentAngleStart;
    for (const ch of children) {
      const span = (ch.size / tot) * parentAngleSpan;
      const isF  = !!(ch.children?.length);
      addSector(iR, oR, a, a + span, ht, nodeColor(ch.name, isF), ch, isF);
      // Recurse into children for the next ring
      const subKids = (ch.children || []).filter(c => c.size > 0);
      if (subKids.length) buildRings(subKids, a, span, depth + 1);
      a += span;
    }
  }

  const kids = visibleKids(node);
  if (!kids.length) return;
  // Level 1: direct children, full circle
  buildRings(kids, 0, Math.PI * 2, 1);
}

// ══════════════════════════════════════════════════════════════════════════════
// MODE 3 — HORIZONTAL BAR CHART
// Items are sorted largest-first. The camera is positioned to look at the top
// of the list (index 0 = biggest item) so the most important data is
// immediately visible without scrolling.
// ══════════════════════════════════════════════════════════════════════════════
function renderBarChart(node) {
  // Sort descending so the biggest item is always at the top
  const kids = [...visibleKids(node)].sort((a, b) => b.size - a.size);
  if (!kids.length) return;
  const maxSz  = kids[0].size;
  const BAR_H  = 5, SPACING = 8.2, MAX_W = 155;
  // startY is the Y world-position of the first (largest) bar
  const startY = ((kids.length - 1) / 2) * SPACING;
  const total  = kids.reduce((s,c) => s + c.size, 0);
  // Aim the camera at the top of the list so the largest items are centred
  posCamera(0, startY + 10, 220, 0, startY, 0);

  const trackMat = new THREE.MeshStandardMaterial({ color: 0x0a0a1e, roughness: 0.9, metalness: 0.1 });

  kids.forEach((child, i) => {
    const barW  = Math.max((child.size / maxSz) * MAX_W, 0.5);
    const posY  = startY - i * SPACING;
    const isF   = !!(child.children?.length);
    const color = nodeColor(child.name, isF);

    // Track
    const track = new THREE.Mesh(new THREE.BoxGeometry(MAX_W, BAR_H, 3.5), trackMat);
    track.position.set(0, posY, -1.5);
    scene.add(track); sceneObjects.push(track);

    if (child._isDriveStub) {
      // Split bar: used (solid, left) + free (ghost, right)
      const usedFrac = child.size > 0 ? child._driveUsed / child.size : 1;
      const usedW    = Math.max(barW * usedFrac - 0.1, 0.2);
      const freeW    = Math.max(barW * (1 - usedFrac) - 0.1, 0);
      const leftEdge = -MAX_W / 2;

      // Used segment
      const usedMat  = makeMat(COLOR_USED, 0.28, 0.25, 0.65);
      const usedMesh = new THREE.Mesh(new THREE.BoxGeometry(usedW, BAR_H, 5.5), usedMat);
      usedMesh.position.set(leftEdge + usedW / 2, posY, 0);
      usedMesh.castShadow = true;
      usedMesh.userData = { node: child, isFolder: true, baseColor: COLOR_USED };
      scene.add(usedMesh); sceneObjects.push(usedMesh); clickable.push(usedMesh);

      // Free segment
      if (freeW > 0.2 && settings.showFreeSpace !== false) {
        const freeMat  = makeFreeMat();
        const freeMesh = new THREE.Mesh(new THREE.BoxGeometry(freeW, BAR_H * 0.55, 4), freeMat);
        freeMesh.position.set(leftEdge + usedW + freeW / 2, posY, 0);
        freeMesh.userData = { node: child.children?.find(c => c.name === 'Free Space') || child,
          isFolder: false, baseColor: COLOR_FREE };
        scene.add(freeMesh); sceneObjects.push(freeMesh);
      }

      // Used edge accent
      const edgeMat2 = new THREE.MeshStandardMaterial({ color: COLOR_USED,
        emissive: new THREE.Color(COLOR_USED).multiplyScalar(0.9), emissiveIntensity: 1.2, roughness: 0.1, metalness: 0.8 });
      const edge2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, BAR_H + 0.2, 6), edgeMat2);
      edge2.position.set(leftEdge + usedW, posY, 0);
      scene.add(edge2); sceneObjects.push(edge2);
    } else {
      // Normal bar
      const mat = makeMat(color, 0.28, 0.25, 0.65);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(barW, BAR_H, 5.5), mat);
      mesh.position.set(barW / 2 - MAX_W / 2, posY, 0);
      mesh.castShadow = true;
      mesh.userData = { node: child, isFolder: isF, baseColor: color };
      scene.add(mesh); sceneObjects.push(mesh); clickable.push(mesh);

      // Edge accent
      const edgeMat = new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(0.9), emissiveIntensity: 1.2, roughness: 0.1, metalness: 0.8 });
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.5, BAR_H + 0.2, 6), edgeMat);
      edge.position.set(barW - MAX_W / 2, posY, 0);
      scene.add(edge); sceneObjects.push(edge);
    }

    // Label
    const pct = (child.size / total) * 100;
    if (pct >= labelThreshold) {
      const { mesh: lm } = makeLabel(truncate(child.name, 20), currentFont);
      lm.position.set(-MAX_W / 2 + barW + 4, posY, 3.5);
      scene.add(lm); sceneObjects.push(lm);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// MODE 4 — STACKED BAR CHART
// ══════════════════════════════════════════════════════════════════════════════
function renderStacked(node) {
  posCamera(0, 50, 240, 0, 20, 0);
  const kids = [...visibleKids(node)]
    .sort((a, b) => b.size - a.size).slice(0, 40);
  if (!kids.length) return;

  const maxSz = kids[0].size;
  const BAR_W = 7, SPACING = 10.5, MAX_H = 95;
  const startX = -((kids.length - 1) / 2) * SPACING;
  const total  = kids.reduce((s,c) => s + c.size, 0);

  kids.forEach((child, i) => {
    const colH  = (child.size / maxSz) * MAX_H;
    let stackY  = 0;
    let added   = false;

    if (child._isDriveStub) {
      // Render as Used (bottom) + Free (top) two-segment stack
      const usedH = colH * (child.size > 0 ? child._driveUsed / child.size : 1);
      const freeH = colH - usedH;
      if (usedH > 0.05) {
        const mat  = makeMat(COLOR_USED, 0.25, 0.3, 0.55);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(BAR_W, usedH, BAR_W), mat);
        mesh.position.set(startX + i * SPACING, stackY + usedH / 2, 0);
        mesh.castShadow = true;
        mesh.userData = { node: child, isFolder: true, baseColor: COLOR_USED };
        scene.add(mesh); sceneObjects.push(mesh); clickable.push(mesh);
        stackY += usedH; added = true;
      }
      if (freeH > 0.05 && settings.showFreeSpace !== false) {
        const freeMesh = new THREE.Mesh(new THREE.BoxGeometry(BAR_W, freeH, BAR_W), makeFreeMat());
        freeMesh.position.set(startX + i * SPACING, stackY + freeH / 2, 0);
        freeMesh.userData = { node: child.children?.find(c => c.name === 'Free Space') || child,
          isFolder: false, baseColor: COLOR_FREE };
        scene.add(freeMesh); sceneObjects.push(freeMesh);
        stackY += freeH;
      }
    } else {
      const typeSz  = getTypeSizes(child);
      const totalSz = child.size || 1;

      for (const cat of ALL_CATS) {
        const sz   = typeSz[cat] || 0;
        if (!sz) continue;
        const segH = (sz / totalSz) * colH;
        if (segH < 0.05) continue;
        const color = CAT_COLORS[cat];
        const mat   = makeMat(color, 0.25, 0.3, 0.55);
        const mesh  = new THREE.Mesh(new THREE.BoxGeometry(BAR_W, segH, BAR_W), mat);
        mesh.position.set(startX + i * SPACING, stackY + segH / 2, 0);
        mesh.castShadow = true;
        mesh.userData = { node: child, isFolder: !!(child.children?.length), baseColor: color };
        scene.add(mesh); sceneObjects.push(mesh); clickable.push(mesh);
        stackY += segH;
        added = true;
      }
    }

    if (!added) {
      const ph = new THREE.Mesh(new THREE.BoxGeometry(BAR_W, 0.5, BAR_W),
        new THREE.MeshStandardMaterial({ color: 0x1a1a30, roughness: 0.9 }));
      ph.position.set(startX + i * SPACING, 0.25, 0);
      ph.userData = { node: child, isFolder: !!(child.children?.length), baseColor: 0x1a1a30 };
      scene.add(ph); sceneObjects.push(ph); clickable.push(ph);
      stackY = 0.5;
    }

    const pct = (child.size / total) * 100;
    if (pct >= labelThreshold && stackY > 4) {
      const { mesh: lm } = makeLabel(truncate(child.name, 12), currentFont);
      lm.position.set(startX + i * SPACING, stackY + 2.5, 0);
      lm.rotation.y = 0;
      scene.add(lm); sceneObjects.push(lm);
    }
  });

  // Ground
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 400),
    new THREE.MeshStandardMaterial({ color: 0x040408, roughness: 0.95, metalness: 0.0 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.3;
  scene.add(floor); sceneObjects.push(floor);
}

// ══════════════════════════════════════════════════════════════════════════════
// MODE 5 — CITY  (resources2city)
// ══════════════════════════════════════════════════════════════════════════════
const BUILDING_STYLES = {
  video:       { rough: 0.15, metal: 0.85, winColor: 0xff2200, aspect: 0.45 },
  images:      { rough: 0.25, metal: 0.5,  winColor: 0xffffff, aspect: 0.8  },
  audio:       { rough: 0.3,  metal: 0.5,  winColor: 0xffaa00, aspect: 0.6  },
  archives:    { rough: 0.8,  metal: 0.2,  winColor: 0xaa44ff, aspect: 1.1  },
  code:        { rough: 0.1,  metal: 0.95, winColor: 0x00ff88, aspect: 0.55 },
  documents:   { rough: 0.4,  metal: 0.4,  winColor: 0x4488ff, aspect: 0.75 },
  executables: { rough: 0.7,  metal: 0.6,  winColor: 0xffee00, aspect: 0.65 },
  other:       { rough: 0.55, metal: 0.35, winColor: 0x88aacc, aspect: 0.9  },
  folder:      { rough: 0.2,  metal: 0.7,  winColor: 0x4f8cff, aspect: 0.6  },
};

// addBuilding — constructs one city block with windows, rooftop spire, and a
// street-level sign so names are visible when walking down the street.
function addBuilding(cx, cz, bw, bd, bh, color, node, isF) {
  const cat   = isF ? 'folder' : getCategory(node.name);
  const style = BUILDING_STYLES[cat] || BUILDING_STYLES.other;

  // Main building body
  const mat  = new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(0.08),
    roughness: style.rough, metalness: style.metal,
  });
  const geo  = new THREE.BoxGeometry(bw, bh, bd);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, bh / 2, cz);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.userData = { node, isFolder: isF, baseColor: color };
  scene.add(mesh); sceneObjects.push(mesh); clickable.push(mesh);

  // ── Window lights ──────────────────────────────────────────────────────────
  if (bh > 3 && bw > 1 && bd > 1) {
    const winMat = new THREE.MeshStandardMaterial({
      color: style.winColor,
      emissive: new THREE.Color(style.winColor),
      emissiveIntensity: 1.8,
      roughness: 0.0, metalness: 0.0,
    });
    const rows   = Math.max(1, Math.floor(bh / 3));
    const cols   = Math.max(1, Math.floor(bw / 2));
    const ww     = bw / (cols * 2 + 1) * 0.7;
    const wh     = bh / (rows * 2 + 1) * 0.7;
    const winGeo = new THREE.PlaneGeometry(ww, wh);
    for (let r = 0; r < rows; r++) {
      const wy = -bh / 2 + (bh / (rows + 1)) * (r + 1);
      for (let c2 = 0; c2 < cols; c2++) {
        const wx = -bw / 2 + (bw / (cols + 1)) * (c2 + 1);
        // Front windows
        const wf = new THREE.Mesh(winGeo, winMat);
        wf.position.set(cx + wx, bh / 2 + wy, cz + bd / 2 + 0.02);
        scene.add(wf); sceneObjects.push(wf);
        // Back windows
        const wb = new THREE.Mesh(winGeo, winMat);
        wb.position.set(cx + wx, bh / 2 + wy, cz - bd / 2 - 0.02);
        wb.rotation.y = Math.PI;
        scene.add(wb); sceneObjects.push(wb);
      }
    }
  }

  // ── Rooftop spire for tall skyscrapers ────────────────────────────────────
  if (bh > 20) {
    const spireH   = bh * 0.14;
    const spireMat = new THREE.MeshStandardMaterial({
      color: THEMES[currentTheme].accent, emissive: THEMES[currentTheme].accent,
      emissiveIntensity: 2, roughness: 0.0, metalness: 1.0 });
    const spire = new THREE.Mesh(new THREE.ConeGeometry(bw * 0.1, spireH, 8), spireMat);
    spire.position.set(cx, bh + spireH / 2, cz);
    scene.add(spire); sceneObjects.push(spire);
  }

  // ── Street-level sign ─────────────────────────────────────────────────────
  // Name label mounted near the base of the building on the front face,
  // so it's visible at eye-level when walking down the street (WASD).
  const signH = Math.min(bh * 0.35, 5.5);  // sign sits low — approx first-storey height
  const { mesh: lm } = makeLabel(truncate(node.name, 16), currentFont);
  lm.position.set(cx, signH, cz + bd / 2 + 0.3);
  // Face toward the street (no rotation needed — label is already facing +Z)
  scene.add(lm); sceneObjects.push(lm);

  return mesh;
}

function addStreetLight(x, z) {
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.4, metalness: 0.8 });
  const pole    = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 8, 6), poleMat);
  pole.position.set(x, 4, z);
  scene.add(pole); sceneObjects.push(pole);
  const lightColor = THEMES[currentTheme].accent;
  const bulbMat = new THREE.MeshStandardMaterial({ color: lightColor, emissive: lightColor, emissiveIntensity: 3, roughness: 0, metalness: 0 });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), bulbMat);
  bulb.position.set(x, 8.5, z);
  scene.add(bulb); sceneObjects.push(bulb);
  const ptLight = new THREE.PointLight(lightColor, 1.5, 35);
  ptLight.position.set(x, 8, z);
  scene.add(ptLight); sceneObjects.push(ptLight);
}

// renderCity — turns the current folder into a 3D cityscape.
//
// Design intent:
//   • The default camera is at street level (eye height ~6 units) looking down
//     the main street so the scene is immediately "walkable".
//   • Building height AND width/depth scale with file size so tiny files become
//     suburban houses and huge files become downtown skyscrapers.
//   • The height formula uses a power-law (not log) for a more dramatic skyline.
//   • STREET gap between parcels is 14 units — wide enough to walk down.
//   • Building names appear as street-level signs on the front face (see addBuilding).
//   • Press WASD / arrow keys to walk around after loading.
function renderCity(node) {
  // Street-level default camera: standing in the main boulevard, looking north
  posCamera(0, 6, 130, 0, 6, 0);
  controls.maxPolarAngle = Math.PI;

  // ── Ground plane ──────────────────────────────────────────────────────────
  const groundColor = THEMES[currentTheme].ground || 0x0a0a14;
  const groundMat   = new THREE.MeshStandardMaterial({
    color: groundColor, roughness: 0.96, metalness: 0.04 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  scene.add(ground); sceneObjects.push(ground);

  // ── Road surface — wider, slightly lighter than ground ────────────────────
  const roadSurfaceMat = new THREE.MeshStandardMaterial({
    color: 0x111118, roughness: 0.98, metalness: 0.02 });
  // Main avenue down the centre (Z axis)
  const avenue = new THREE.Mesh(new THREE.PlaneGeometry(18, 500), roadSurfaceMat);
  avenue.rotation.x = -Math.PI / 2; avenue.position.y = 0.01;
  scene.add(avenue); sceneObjects.push(avenue);

  // ── Road grid lines (kerb markings) ──────────────────────────────────────
  const roadMat = new THREE.LineBasicMaterial({ color: 0x1e1e2e });
  const BLOCK = 28; // one city block width (building + street gap)
  for (let i = -8; i <= 8; i++) {
    const v = i * BLOCK;
    const g1 = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-250, 0.05, v), new THREE.Vector3(250, 0.05, v)]);
    const g2 = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(v, 0.05, -250), new THREE.Vector3(v, 0.05, 250)]);
    [g1, g2].forEach(g => { const l = new THREE.Line(g, roadMat); scene.add(l); sceneObjects.push(l); });
  }

  // ── Layout buildings using squarify ───────────────────────────────────────
  const kids   = (node.children || []).filter(c => c.size > 0);
  if (!kids.length) return;

  const total  = kids.reduce((s, c) => s + c.size, 0);
  const sorted = [...kids].sort((a, b) => b.size - a.size);
  const CITY   = 180;
  const rects  = [];
  squarify(sorted.map(c => ({ node: c, a: (c.size / total) * CITY * CITY })),
    { x: 0, y: 0, w: CITY, h: CITY }, rects);
  const maxSz  = sorted[0].size;

  // STREET = gap on each side of a parcel (total road width between buildings)
  const STREET = 14;

  for (const { node: n, x, y, w, h } of rects) {
    if (w < 0.5 || h < 0.5) continue;
    const cx  = (x + w / 2) / CITY * WORLD - WORLD / 2;
    const cz  = (y + h / 2) / CITY * WORLD - WORLD / 2;
    // usable building footprint after street gap
    const dw  = Math.max(w / CITY * WORLD - STREET, 1);
    const dd  = Math.max(h / CITY * WORLD - STREET, 1);
    const isF = !!(n.children?.length);

    // Height uses a power law: exponent < 1 compresses low values (houses)
    // while large values soar (skyscrapers up to ~90 units tall).
    const sizeFrac = n.size / maxSz;
    const blockH   = 1.5 + Math.pow(sizeFrac, 0.38) * 88;

    if (isF && n.children.length > 1) {
      // ── Folder district: sub-buildings laid out inside this parcel ─────
      const subKids  = n.children.filter(c => c.size > 0).sort((a, b) => b.size - a.size);
      const subTotal = subKids.reduce((s, c) => s + c.size, 0);
      const subRects = [];
      squarify(subKids.map(c => ({ node: c, a: (c.size / subTotal) * dw * dd })),
        { x: 0, y: 0, w: dw, h: dd }, subRects);
      const subMaxSz = subKids[0]?.size || 1;

      for (const { node: sn, x: sx, y: sy, w: sw, h: sh } of subRects) {
        if (sw < 0.3 || sh < 0.3) continue;
        const scx  = cx - dw / 2 + sx + sw / 2;
        const scz  = cz - dd / 2 + sy + sh / 2;
        const sbw  = Math.max(sw - 2, 0.5);
        const sbd  = Math.max(sh - 2, 0.5);
        const sbh  = 1.5 + Math.pow(sn.size / subMaxSz, 0.38) * 72;
        addBuilding(scx, scz, sbw, sbd, sbh,
          nodeColor(sn.name, !!(sn.children?.length)), sn, !!(sn.children?.length));
      }

      // District boundary marker (faint accent outline at street level)
      const borderMat = new THREE.LineBasicMaterial({
        color: THEMES[currentTheme].accent, transparent: true, opacity: 0.25 });
      const pts = [
        new THREE.Vector3(cx - dw/2, 0.1, cz - dd/2),
        new THREE.Vector3(cx + dw/2, 0.1, cz - dd/2),
        new THREE.Vector3(cx + dw/2, 0.1, cz + dd/2),
        new THREE.Vector3(cx - dw/2, 0.1, cz + dd/2),
        new THREE.Vector3(cx - dw/2, 0.1, cz - dd/2),
      ];
      const border = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), borderMat);
      scene.add(border); sceneObjects.push(border);

    } else {
      // ── Single file / leaf node ──────────────────────────────────────────
      addBuilding(cx, cz, Math.max(dw, 1), Math.max(dd, 1), blockH,
        nodeColor(n.name, isF), n, isF);
    }
  }

  // ── Street lights scattered along the main boulevard ─────────────────────
  for (let i = -4; i <= 4; i += 2) {
    for (let j = -4; j <= 4; j += 2) {
      if (Math.random() > 0.45) addStreetLight(i * BLOCK + 11, j * BLOCK + 11);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MODE 6 — GALAXY
// ══════════════════════════════════════════════════════════════════════════════
const GALAXY_VERT = `
  attribute float aSize;
  attribute vec3  aColor;
  attribute float aBright;
  varying vec3  vColor;
  varying float vBright;
  uniform float uTime;
  uniform float uPR;
  void main() {
    vColor  = aColor;
    vBright = aBright;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPR * (350.0 / -mv.z);
    gl_Position  = projectionMatrix * mv;
  }
`;
const GALAXY_FRAG = `
  varying vec3  vColor;
  varying float vBright;
  uniform float uTime;
  void main() {
    vec2  uv = gl_PointCoord - 0.5;
    float r  = length(uv);
    if (r > 0.5) discard;
    float core = exp(-r * 10.0);
    float halo = exp(-r *  3.5) * 0.5;
    float alpha = smoothstep(0.5, 0.0, r);
    vec3  glow  = vColor * (core * 3.0 + halo + 0.3);
    gl_FragColor = vec4(glow * vBright, alpha * (core + halo + 0.1));
  }
`;


function addParticleCloud(cx, cz, cloudR, files, parentMaxSz) {
  if (!files.length) return;
  const count = Math.min(files.length, 300);
  const pos    = new Float32Array(count * 3);
  const cols   = new Float32Array(count * 3);
  const szArr  = new Float32Array(count);
  const brArr  = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const f = files[i];
    const a = Math.random() * Math.PI * 2;
    const r = cloudR * (0.5 + Math.random() * 0.7);
    const y = (Math.random() - 0.5) * cloudR * 0.4;
    pos[i*3]   = cx + Math.cos(a) * r;
    pos[i*3+1] = y;
    pos[i*3+2] = cz + Math.sin(a) * r;
    const col = new THREE.Color(CAT_COLORS[getCategory(f.name)] || COLOR_DEFAULT);
    cols[i*3] = col.r; cols[i*3+1] = col.g; cols[i*3+2] = col.b;
    const logSz = Math.log(f.size + 2) / Math.log(parentMaxSz + 2);
    szArr[i] = 0.6 + logSz * 3;
    brArr[i] = 0.5 + logSz * 1.5;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor',   new THREE.BufferAttribute(cols, 3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(szArr, 1));
  geo.setAttribute('aBright',  new THREE.BufferAttribute(brArr, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPR: { value: Math.min(window.devicePixelRatio, 2) } },
    vertexShader: GALAXY_VERT, fragmentShader: GALAXY_FRAG,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, vertexColors: false,
  });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts); sceneObjects.push(pts);
}

// ── Helper: draw one star/sun sphere at (cx, 0, cz) ─────────────────────────
function addGalaxySun(cx, cz, sunR, color, emissiveIntensity, node, isCenter) {
  const c   = new THREE.Color(color);
  const mat = new THREE.MeshStandardMaterial({
    color: c, emissive: c, emissiveIntensity,
    roughness: 0.05, metalness: 0.8,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(sunR, 40, 40), mat);
  mesh.position.set(cx, 0, cz);
  // isCenterNav navigates up; only set for the single root centre sun
  mesh.userData = { node, isFolder: true, baseColor: color,
    isCenterNav: isCenter };
  scene.add(mesh); sceneObjects.push(mesh); clickable.push(mesh);

  // Outer corona
  const cm = new THREE.MeshBasicMaterial({
    color: c, transparent: true, opacity: 0.12, side: THREE.BackSide });
  const corona = new THREE.Mesh(new THREE.SphereGeometry(sunR * 1.6, 32, 32), cm);
  corona.position.set(cx, 0, cz);
  scene.add(corona); sceneObjects.push(corona);

  return mesh;
}

// ── Helper: draw one planet sphere at (px, 0, pz) with optional ring ─────────
function addGalaxyPlanet(px, pz, planetR, color, node) {
  const pColor = new THREE.Color(color);
  const pMat   = new THREE.MeshStandardMaterial({
    color: pColor, emissive: pColor.clone().multiplyScalar(0.35),
    roughness: 0.35, metalness: 0.65,
  });
  const planet = new THREE.Mesh(new THREE.SphereGeometry(planetR, 24, 24), pMat);
  planet.position.set(px, 0, pz);
  planet.userData = { node, isFolder: true, baseColor: color };
  scene.add(planet); sceneObjects.push(planet); clickable.push(planet);

  // Atmospheric ring on large planets
  if (planetR > 6) {
    const rGeo = new THREE.TorusGeometry(planetR * 1.35, planetR * 0.08, 8, 48);
    const rMat = new THREE.MeshBasicMaterial({ color: pColor, transparent: true, opacity: 0.25 });
    const ring = new THREE.Mesh(rGeo, rMat);
    ring.position.set(px, 0, pz);
    ring.rotation.x = Math.PI / 2.8;
    scene.add(ring); sceneObjects.push(ring);
  }

  // Label above planet
  const { mesh: lm } = makeLabel(truncate(node.name, 14), currentFont);
  lm.position.set(px, planetR + 3, pz);
  scene.add(lm); sceneObjects.push(lm);

  return planet;
}

// ── Helper: draw a circular orbit path at the given radius ───────────────────
function addOrbitRing(cx, cz, orbitR) {
  const pts = [];
  for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.05)
    pts.push(new THREE.Vector3(cx + Math.cos(a) * orbitR, 0, cz + Math.sin(a) * orbitR));
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x1a1a40, transparent: true, opacity: 0.4 }));
  scene.add(line); sceneObjects.push(line);
}

// ── Main galaxy renderer ──────────────────────────────────────────────────────
// Concept (when at root / All Drives level):
//   • The local machine is the invisible centre of the galaxy
//   • Each drive is a Star / Sun — size ∝ total capacity, colour ∝ free space
//   • First sub-folder level = Planets
//   • Second sub-folder level = Moons
//   (standard drill-in: Star → Planets → Moons → deeper files)
//
// At any other level the centre sphere represents the current folder and
// clicking it navigates back up to the parent.
function renderGalaxy(node) {
  posCamera(0, 110, 260, 0, 0, 0);
  controls.maxPolarAngle = Math.PI;

  // ── Background star field ─────────────────────────────────────────────────
  const bgCount = 5000;
  const bgPos   = new Float32Array(bgCount * 3);
  for (let i = 0; i < bgCount * 3; i++) bgPos[i] = (Math.random() - 0.5) * 1000;
  const bgGeo = new THREE.BufferGeometry();
  bgGeo.setAttribute('position', new THREE.BufferAttribute(bgPos, 3));
  const bgMat = new THREE.PointsMaterial({
    color: 0xffffff, size: 0.28, sizeAttenuation: true, transparent: true, opacity: 0.35 });
  const bgStars = new THREE.Points(bgGeo, bgMat);
  scene.add(bgStars); sceneObjects.push(bgStars);

  // Determine the recursion limit (0 = unlimited)
  const maxDepth = (settings.recursionDepth > 0) ? settings.recursionDepth : Infinity;

  // ── All-Drives special case: drives become Stars ──────────────────────────
  // When the user is at the very root of the "All Drives" view, each drive
  // node is a distinct Star scattered around the galactic centre.
  const isAllDrivesRoot = (node.name === 'All Drives');

  if (isAllDrivesRoot) {
    // Place drive-stars in a wide ring around the true centre
    const driveNodes = visibleKids(node);
    if (!driveNodes.length) return;
    const maxDriveSize = Math.max(...driveNodes.map(d => d.size));
    const STAR_ORBIT   = 120; // radius of the ring that stars sit on

    driveNodes.forEach((drive, idx) => {
      const angle  = (idx / driveNodes.length) * Math.PI * 2;
      const sx     = Math.cos(angle) * STAR_ORBIT;
      const sz     = Math.sin(angle) * STAR_ORBIT;

      // Star size proportional to total drive capacity (cube-root for visual balance)
      const sizeRatio = drive.size / maxDriveSize;
      const starR     = 6 + Math.cbrt(sizeRatio) * 14;

      // Colour from green (lots of free space) → red (nearly full)
      const usedFrac  = drive._driveUsed != null
        ? drive._driveUsed / Math.max(drive.size, 1)
        : 0.5;
      const starColor = new THREE.Color().setHSL(0.33 * (1 - usedFrac), 0.9, 0.55);

      addGalaxySun(sx, sz, starR, starColor.getHex(), 2.5, drive, false);

      // Label the star with the drive letter
      const { mesh: lm } = makeLabel(drive.name, currentFont);
      lm.position.set(sx, starR + 4, sz);
      scene.add(lm); sceneObjects.push(lm);

      // Planets: sub-folders of this drive (only if depth allows)
      if (maxDepth >= 2) {
        const driveFolders = visibleKids(drive)
          .filter(c => c.children?.length).sort((a, b) => b.size - a.size);
        const maxPlanetSz  = driveFolders[0]?.size || 1;
        driveFolders.forEach((folder, pidx) => {
          const pr    = 1.5 + Math.cbrt(folder.size / maxPlanetSz) * 5;
          const por   = starR + 14 + pidx * 12;
          const pa    = angle + (pidx / Math.max(driveFolders.length, 1)) * Math.PI * 2;
          const ppx   = sx + Math.cos(pa) * por;
          const ppz   = sz + Math.sin(pa) * por;
          addOrbitRing(sx, sz, por);
          addGalaxyPlanet(ppx, ppz, pr, nodeColor(folder.name, true), folder);

          // Moons (depth 3)
          if (maxDepth >= 3) {
            const subFolders = visibleKids(folder)
              .filter(c => c.children?.length).sort((a, b) => b.size - a.size).slice(0, 6);
            subFolders.forEach((moon, midx) => {
              const mr  = 0.8 + Math.cbrt(moon.size / Math.max(folder.size, 1)) * 2;
              const mor = pr + 5 + midx * 5;
              const ma  = pa + (midx / Math.max(subFolders.length, 1)) * Math.PI * 2;
              const mpx = ppx + Math.cos(ma) * mor;
              const mpz = ppz + Math.sin(ma) * mor;
              addOrbitRing(ppx, ppz, mor);
              addGalaxyPlanet(mpx, mpz, mr, nodeColor(moon.name, true), moon);
            });
          }

          // File particles around each planet
          const childFiles = visibleKids(folder).filter(c => !c.children?.length);
          if (childFiles.length)
            addParticleCloud(ppx, ppz, pr + 5, childFiles, childFiles[0].size);
        });
      }

      // Loose files in this drive as a small asteroid belt around the star
      const driveFiles = visibleKids(drive).filter(c => !c.children?.length);
      if (driveFiles.length)
        addParticleCloud(sx, sz, starR + 7, driveFiles, driveFiles[0].size);
    });

    // Boost bloom for the galaxy
    if (bloomPass) {
      bloomPass.strength  = Math.max(THEMES[currentTheme].bloom.strength, 1.2);
      bloomPass.threshold = 0.15;
    }
    return;
  }

  // ── Normal galaxy: single centre sun + orbiting planets/moons ────────────
  const folders  = visibleKids(node).filter(c => c.children?.length).sort((a, b) => b.size - a.size);
  const dirFiles = visibleKids(node).filter(c => !c.children?.length).sort((a, b) => b.size - a.size);
  const allChildren = [...folders, ...dirFiles];
  if (!allChildren.length) return;

  const maxChildSz = allChildren[0].size;

  // Central sun represents the current folder; clicking it goes UP
  const sunR   = 16;
  const accent = THEMES[currentTheme].accent;
  addGalaxySun(0, 0, sunR, accent.getHex(), 3.0, node, true);

  const { mesh: sunLabel } = makeLabel(truncate(node.name, 16), currentFont);
  sunLabel.position.set(0, sunR + 3, 0);
  scene.add(sunLabel); sceneObjects.push(sunLabel);

  // ── Planets (sub-folders) ─────────────────────────────────────────────────
  const ORBIT_START = sunR + 22;
  const ORBIT_STEP  = 20;

  folders.forEach((folder, idx) => {
    const sizeRatio = folder.size / maxChildSz;
    // Cube-root gives volume-based perceived size
    const planetR = 2.5 + Math.cbrt(sizeRatio) * 11;
    const orbitR  = ORBIT_START + idx * ORBIT_STEP;
    const angle   = (idx / Math.max(folders.length, 1)) * Math.PI * 2 + 0.3;
    const px = Math.cos(angle) * orbitR;
    const pz = Math.sin(angle) * orbitR;

    addOrbitRing(0, 0, orbitR);
    addGalaxyPlanet(px, pz, planetR, nodeColor(folder.name, true), folder);

    // ── Moons (sub-sub-folders, depth 2+) ──────────────────────────────────
    if (maxDepth >= 2) {
      const moonFolders = visibleKids(folder)
        .filter(c => c.children?.length).sort((a, b) => b.size - a.size).slice(0, 6);
      const maxMoonSz   = moonFolders[0]?.size || 1;
      moonFolders.forEach((moon, midx) => {
        const moonR  = 1 + Math.cbrt(moon.size / maxMoonSz) * 3.5;
        const moonOr = planetR + 6 + midx * 6;
        const moonA  = angle + (midx / Math.max(moonFolders.length, 1)) * Math.PI * 2;
        const mpx    = px + Math.cos(moonA) * moonOr;
        const mpz    = pz + Math.sin(moonA) * moonOr;
        addOrbitRing(px, pz, moonOr);
        addGalaxyPlanet(mpx, mpz, moonR, nodeColor(moon.name, true), moon);

        // Depth-3 moons of moons
        if (maxDepth >= 3) {
          const subMoons = visibleKids(moon)
            .filter(c => c.children?.length).sort((a, b) => b.size - a.size).slice(0, 4);
          subMoons.forEach((sm, smidx) => {
            const smR  = 0.6 + Math.cbrt(sm.size / Math.max(moon.size, 1)) * 2;
            const smOr = moonR + 4 + smidx * 4;
            const smA  = moonA + (smidx / Math.max(subMoons.length, 1)) * Math.PI * 2;
            addOrbitRing(mpx, mpz, smOr);
            addGalaxyPlanet(
              mpx + Math.cos(smA) * smOr, mpz + Math.sin(smA) * smOr,
              smR, nodeColor(sm.name, true), sm);
          });
        }
      });
    }

    // File particles as an asteroid belt around each planet
    const childFiles = visibleKids(folder).filter(c => !c.children?.length);
    if (childFiles.length)
      addParticleCloud(px, pz, planetR + 7, childFiles, childFiles[0].size);
  });

  // Loose files at this level form an asteroid belt around the central sun
  if (dirFiles.length)
    addParticleCloud(0, 0, sunR + 10, dirFiles, dirFiles[0].size);

  // Boost bloom for the galaxy scene
  if (bloomPass) {
    bloomPass.strength  = Math.max(THEMES[currentTheme].bloom.strength, 1.2);
    bloomPass.threshold = 0.15;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SHARED SCENE HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function posCamera(cx, cy, cz, tx, ty, tz) {
  camera.position.set(cx, cy, cz);
  controls.target.set(tx, ty, tz);
  controls.update();
}

function addGround() {
  const t = THEMES[currentTheme];
  const g = new THREE.Mesh(new THREE.PlaneGeometry(WORLD + 40, WORLD + 40),
    new THREE.MeshStandardMaterial({ color: t.ground || 0x070710, roughness: 0.95, metalness: 0.02 }));
  g.rotation.x = -Math.PI / 2; g.position.y = -0.1; g.receiveShadow = true;
  scene.add(g); sceneObjects.push(g);
  const grid = new THREE.GridHelper(WORLD + 40, 60, t.grid?.[0] ?? 0x141428, t.grid?.[1] ?? 0x0e0e22);
  scene.add(grid); sceneObjects.push(grid);
}

function addStyledBox(cx, cy, cz, bw, bh, bd, color, node, isF, edges) {
  const isFree = node?.name === 'Free Space';
  const mat  = isFree ? makeFreeMat()
             : makeMat(color, isF ? 0.22 : 0.14, 0.3, isF ? 0.65 : 0.45);
  const geo  = new THREE.BoxGeometry(bw, bh, bd);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, cy, cz);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.userData = { node, isFolder: isF, baseColor: color };
  scene.add(mesh); sceneObjects.push(mesh); clickable.push(mesh);

  if (edges) {
    const el = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x000000, opacity: 0.15, transparent: true })
    );
    el.position.copy(mesh.position);
    scene.add(el); sceneObjects.push(el);
  }
}

function clearScene() {
  sceneObjects.forEach(o => {
    scene.remove(o);
    o.geometry?.dispose();
    if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
    else o.material?.dispose();
  });
  sceneObjects = []; clickable = []; hovered = null;
  tooltip.style.display = 'none';
  // Restore normal bloom after galaxy
  if (bloomPass) {
    const t = THEMES[currentTheme];
    bloomPass.strength  = t.bloom.strength;
    bloomPass.threshold = t.bloom.threshold;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// INTERACTION
// ══════════════════════════════════════════════════════════════════════════════
function ndc(e) {
  const r = renderer3.domElement.getBoundingClientRect();
  return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * -2 + 1);
}

const PREVIEW_EXTS = new Set(['jpg','jpeg','png','gif','bmp','webp','tiff','tif','avif','heic','svg',
  'mp4','mkv','avi','mov','wmv','webm','m4v']);
const IMAGE_EXTS   = new Set(['jpg','jpeg','png','gif','bmp','webp','tiff','tif','avif','svg']);
const VIDEO_EXTS   = new Set(['mp4','mkv','avi','mov','wmv','webm','m4v']);

function showPreview(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  ttPreview.style.display = 'none';
  ttImg.style.display = 'none';
  ttVid.style.display = 'none';
  ttVid.src = '';
  ttImg.src = '';
  if (IMAGE_EXTS.has(ext)) {
    ttImg.src = 'file:///' + filePath.replace(/\\/g, '/');
    ttImg.style.display = 'block';
    ttPreview.style.display = 'block';
  } else if (VIDEO_EXTS.has(ext)) {
    ttVid.src = 'file:///' + filePath.replace(/\\/g, '/');
    ttVid.style.display = 'block';
    ttPreview.style.display = 'block';
  }
}

function hidePreview() {
  ttPreview.style.display = 'none';
  ttImg.style.display = 'none'; ttImg.src = '';
  ttVid.style.display = 'none'; ttVid.src = '';
  ttVid.pause?.();
}

function onMouseMove(e) {
  raycaster.setFromCamera(ndc(e), camera);
  const hit = raycaster.intersectObjects(clickable, false)[0]?.object ?? null;

  if (hovered && hovered !== hit) {
    hovered.material.color?.setHex(hovered.userData.baseColor);
    hovered.material.emissive?.setHex(0x000000);
    // Sunburst kick-out: restore original position
    if (hovered.userData.isSector) {
      hovered.position.set(0, 0, 0);
    }
    hovered = null;
    tooltip.style.display = 'none';
    hidePreview();
    renderer3.domElement.style.cursor = 'grab';
    // Update right panel to reflect nothing hovered
  }
  if (hit?.userData?.node) {
    if (hit !== hovered) {
      // Un-kick previous sector
      if (hovered?.userData?.isSector) hovered.position.set(0, 0, 0);
      hovered = hit;
      const bright = new THREE.Color(hovered.userData.baseColor).multiplyScalar(0.7);
      hit.material.emissive?.copy(bright);
      // Sunburst kick-out: push sector outward from center
      if (hit.userData.isSector) {
        hit.position.set(hit.userData.kickX, 0, hit.userData.kickZ);
      }
    }
    const n = hit.userData.node;
    const cat = hit.userData.isFolder ? 'Folder' : (getCategory(n.name).charAt(0).toUpperCase() + getCategory(n.name).slice(1));
    ttName.textContent = n.name;
    ttInfo.textContent = fmt(n.size);
    ttCat.textContent  = cat + (hit.userData.isFolder ? ' — click to drill in' : '');
    // Sub-items list (1 level deep, top 5 by size)
    if (hit.userData.isFolder && n.children?.length && ttChildren) {
      const top5 = [...n.children].filter(c => c.size > 0).sort((a, b) => b.size - a.size).slice(0, 5);
      ttChildren.innerHTML = top5.map(c => {
        const isF = !!(c.children?.length);
        const icon = isF ? '📁' : '📄';
        return `<div class="tt-child-row"><span>${icon} ${truncate(c.name, 22)}</span><span class="tt-child-sz">${fmt(c.size)}</span></div>`;
      }).join('');
      ttChildren.style.display = top5.length ? 'block' : 'none';
    } else if (ttChildren) {
      ttChildren.style.display = 'none';
    }
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 16) + 'px';
    tooltip.style.top  = (e.clientY - 10) + 'px';
    renderer3.domElement.style.cursor = hit.userData.isFolder ? 'pointer' : 'default';
    // File preview for images/video
    const ext = n.name.split('.').pop().toLowerCase();
    if (!hit.userData.isFolder && n.path && PREVIEW_EXTS.has(ext)) {
      showPreview(n.path);
    } else {
      hidePreview();
    }
    // Update right panel on hover too
    updateRightPanel(n, hit.userData.isFolder);
  }
}

function onClick(e) {
  raycaster.setFromCamera(ndc(e), camera);
  const hits = raycaster.intersectObjects(clickable, false);
  if (!hits.length) return;
  const { node: n, isFolder, isCenterNav } = hits[0].object.userData;

  // Clicking the centre core (sunburst disc or galaxy sun) goes up one level —
  // the same as pressing Escape or the Back button.
  if (isCenterNav) {
    if (navStack.length > 1) navigateUpWithTransition();
    return;
  }

  updateInfoPanel(n, isFolder);
  updateRightPanel(n, isFolder);
  if (isFolder && n.children?.length && n.name !== 'Free Space' && n.name !== 'Used') {
    if (n._isDriveStub && !n._scanned) {
      scanAndDrillDrive(n);
    } else {
      navigateWithTransition(n, 1);
    }
  }
}

function onKey(e) {
  if (e.key === 'Escape') {
    if (settingsOverlay?.classList.contains('open')) { settingsOverlay.classList.remove('open'); return; }
    if (aboutOverlay?.classList.contains('open'))   { aboutOverlay.classList.remove('open'); return; }
    if (helpOverlay?.classList.contains('open'))    { helpOverlay.classList.remove('open'); return; }
    if (smartOverlay.classList.contains('open')) { smartOverlay.classList.remove('open'); return; }
    if (ctxMenu.style.display !== 'none' || ctxDriveMenu.style.display !== 'none') { hideCtxMenu(); return; }
    navigateUp();
  }
  if (e.key === 'Home' && navStack.length > 1) {
    const root = navStack[0];
    navigateWithTransition(root, -1, () => { navStack.splice(1); showLevel(navStack[0]); });
  }
  // WASD city walk
  if (currentMode === 'city') {
    const spd = 6;
    if (e.key === 'w' || e.key === 'ArrowUp')    { camera.position.z -= spd; controls.target.z -= spd; }
    if (e.key === 's' || e.key === 'ArrowDown')   { camera.position.z += spd; controls.target.z += spd; }
    if (e.key === 'a' || e.key === 'ArrowLeft')   { camera.position.x -= spd; controls.target.x -= spd; }
    if (e.key === 'd' || e.key === 'ArrowRight')  { camera.position.x += spd; controls.target.x += spd; }
    controls.update();
  }
}

function navigateUp() {
  navigateUpWithTransition();
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTEXT MENU
// ══════════════════════════════════════════════════════════════════════════════
function onContextMenu(e) {
  e.preventDefault();
  raycaster.setFromCamera(ndc(e), camera);
  const hit = raycaster.intersectObjects(clickable, false)[0]?.object ?? null;
  if (!hit?.userData?.node || !hit.userData.node.path) { hideCtxMenu(); return; }
  const node = hit.userData.node;
  // Drive-level node: letter node whose children are Free Space + Used (All Drives view)
  const isDriveNode = navStack.length > 0 && navStack[0].name === 'All Drives' &&
    navStack[navStack.length - 1].name === 'All Drives' && hit.userData.isFolder &&
    node.children?.some(c => c.name === 'Free Space');
  hideCtxMenu();
  if (isDriveNode) {
    ctxDriveNode = node;
    const mw = 170, mh = 90;
    ctxDriveMenu.style.left = Math.min(e.clientX, window.innerWidth  - mw) + 'px';
    ctxDriveMenu.style.top  = Math.min(e.clientY, window.innerHeight - mh) + 'px';
    ctxDriveMenu.style.display = 'block';
  } else {
    ctxNode = node;
    const mw = 170, mh = 200;
    ctxMenu.style.left = Math.min(e.clientX, window.innerWidth  - mw) + 'px';
    ctxMenu.style.top  = Math.min(e.clientY, window.innerHeight - mh) + 'px';
    ctxMenu.style.display = 'block';
  }
}

function hideCtxMenu() {
  ctxMenu.style.display = 'none';
  ctxDriveMenu.style.display = 'none';
  ctxNode = null;
  ctxDriveNode = null;
}

// ── Tree mutation helpers ─────────────────────────────────────────────────────

// Subtract the deleted node's size from every ancestor in the navStack.
function propagateSizeChange(delta) {
  for (const ancestor of navStack) ancestor.size = Math.max(0, (ancestor.size || 0) + delta);
}

// After a rename, recursively rewrite paths of a node and all its descendants.
function rewritePaths(node, oldPrefix, newPrefix) {
  if (node.path?.startsWith(oldPrefix)) node.path = newPrefix + node.path.slice(oldPrefix.length);
  if (node.children) for (const c of node.children) rewritePaths(c, oldPrefix, newPrefix);
}

// Wire context menu items
document.getElementById('ctx-open').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!ctxNode) return;
  const result = await window.api.fsOpen(ctxNode.path);
  hideCtxMenu();
  if (result?.error) alert('Open failed: ' + result.error);
});

document.getElementById('ctx-rename').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!ctxNode) return;
  const newName = window.prompt('Rename to:', ctxNode.name);
  if (!newName || newName === ctxNode.name) { hideCtxMenu(); return; }
  const result = await window.api.fsRename(ctxNode.path, newName);
  hideCtxMenu();
  if (result.error) { alert('Rename failed: ' + result.error); return; }
  const oldPath = ctxNode.path;
  ctxNode.name = newName;
  ctxNode.path = result.newPath;
  // Fix all descendant paths so drill-in and open-in-explorer remain correct
  rewritePaths(ctxNode, oldPath, result.newPath);
  if (navStack.length) showLevel(navStack[navStack.length - 1]);
});

document.getElementById('ctx-copy').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!ctxNode) return;
  const result = await window.api.fsCopy(ctxNode.path);
  hideCtxMenu();
  if (result.error) alert('Copy failed: ' + result.error);
});

document.getElementById('ctx-cut').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!ctxNode) return;
  const result = await window.api.fsCut(ctxNode.path);
  hideCtxMenu();
  if (result.error) alert('Cut failed: ' + result.error);
});

document.getElementById('ctx-delete').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!ctxNode) return;
  const confirmed = window.confirm(`Move "${ctxNode.name}" to the Recycle Bin?`);
  if (!confirmed) { hideCtxMenu(); return; }
  const result = await window.api.fsDelete(ctxNode.path);
  hideCtxMenu();
  if (result.error) { alert('Delete failed: ' + result.error); return; }
  // Remove from the visible level's children list
  const parent = navStack[navStack.length - 1];
  if (parent?.children) {
    const idx = parent.children.indexOf(ctxNode);
    if (idx !== -1) parent.children.splice(idx, 1);
  }
  // Propagate size decrease up through all ancestors (disk bar, parent tooltips, etc.)
  propagateSizeChange(-(ctxNode.size || 0));
  showLevel(navStack[navStack.length - 1]);
});

document.getElementById('ctx-properties').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!ctxNode) return;
  await window.api.fsProperties(ctxNode.path);
  hideCtxMenu();
});

// ══════════════════════════════════════════════════════════════════════════════
// UI UPDATES
// ══════════════════════════════════════════════════════════════════════════════
function updateBreadcrumb() {
  // ── Top viewport HUD breadcrumb ───────────────────────────────────────────
  const topBC   = document.getElementById('top-breadcrumb');
  const topCopy = document.getElementById('top-copy-btn');
  const topExp  = document.getElementById('top-explorer-btn');

  if (topBC) {
    topBC.innerHTML = '';
    if (!navStack.length) {
      topBC.innerHTML = '<span style="color:#333">—</span>';
    } else {
      navStack.forEach((n, i) => {
        if (i > 0) {
          const s = document.createElement('span'); s.className = 'sep'; s.textContent = ' › ';
          topBC.appendChild(s);
        }
        const a = document.createElement('a'); a.href = '#';
        a.textContent = truncate(n.name, 28);
        a.addEventListener('click', ev => {
          ev.preventDefault();
          const target = navStack[i];
          navigateWithTransition(target, -1, () => {
            navStack.splice(i + 1);
            showLevel(navStack[navStack.length - 1]);
          });
        });
        topBC.appendChild(a);
      });
    }
    const cp = navStack[navStack.length - 1]?.path || '';
    if (topCopy) {
      topCopy.style.display = cp ? 'inline-flex' : 'none';
      topCopy.onclick = () => {
        navigator.clipboard.writeText(cp).then(() => {
          topCopy.style.color = '#2ecc71';
          setTimeout(() => (topCopy.style.color = ''), 1200);
        });
      };
    }
    if (topExp) {
      topExp.style.display = cp ? 'inline-flex' : 'none';
      topExp.onclick = () => window.api.openInExplorer(cp);
    }
  }

  // ── Sidebar breadcrumb (hidden by default, kept for legacy) ───────────────
  breadcrumbEl.innerHTML = '';
  if (!navStack.length) {
    breadcrumbEl.textContent = '—';
    openExplorerBtn.style.display = 'none';
    copyPathBtn.style.display = 'none';
    return;
  }
  navStack.forEach((n, i) => {
    if (i > 0) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = ' › '; breadcrumbEl.appendChild(s); }
    const a = document.createElement('a'); a.href = '#'; a.textContent = truncate(n.name, 20);
    a.addEventListener('click', ev => {
      ev.preventDefault();
      const target = navStack[i];
      navigateWithTransition(target, -1, () => { navStack.splice(i + 1); showLevel(navStack[navStack.length - 1]); });
    });
    breadcrumbEl.appendChild(a);
  });
  const currentPath = navStack[navStack.length - 1].path;
  if (currentPath) {
    openExplorerBtn.style.display = 'block';
    openExplorerBtn.onclick = () => window.api.openInExplorer(currentPath);
    copyPathBtn.style.display = 'inline-block';
    copyPathBtn.onclick = () => {
      navigator.clipboard.writeText(currentPath).then(() => {
        copyPathBtn.classList.add('copied');
        setTimeout(() => copyPathBtn.classList.remove('copied'), 1200);
      });
    };
  } else {
    openExplorerBtn.style.display = 'none';
    copyPathBtn.style.display = 'none';
  }
}

function updateInfoPanel(node, isFolder) {
  const parent = navStack[navStack.length - 1];
  const pct = parent?.size > 0 ? ((node.size / parent.size) * 100).toFixed(1) : '—';
  const drivePct = driveTotal > 0 ? ((node.size / driveTotal) * 100).toFixed(1) : null;
  const cat = isFolder ? 'Folder' : (getCategory(node.name).charAt(0).toUpperCase() + getCategory(node.name).slice(1));
  infoPanel.innerHTML =
    `<strong>${node.name}</strong>` +
    `Size: ${fmt(node.size)}<br>` +
    `${pct}% of parent<br>` +
    (drivePct !== null ? `${drivePct}% of drive<br>` : '') +
    `Type: ${cat}` +
    (isFolder ? `<br>Items: ${node.children?.length ?? 0}` : '');
}

const rpDates     = document.getElementById('rp-dates');
const rpDateCr    = document.getElementById('rp-date-created');
const rpDateMo    = document.getElementById('rp-date-modified');
const rpDateAc    = document.getElementById('rp-date-accessed');

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' })
      + ' ' + d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
  } catch (_) { return '—'; }
}

function updateRightPanel(node, isFolder) {
  rpPlaceholder.style.display = 'none';
  rpContent.style.display = 'block';
  rpName.textContent = node.name;
  rpSize.textContent = fmt(node.size);
  const parent = navStack[navStack.length - 1];
  const pct = parent?.size > 0 ? (node.size / parent.size) * 100 : 0;
  rpBarFill.style.width = Math.min(pct, 100).toFixed(1) + '%';
  const drivePct = driveTotal > 0 ? ((node.size / driveTotal) * 100).toFixed(1) : '—';
  const cat = isFolder ? 'Folder' : (getCategory(node.name).charAt(0).toUpperCase() + getCategory(node.name).slice(1));
  rpSub.innerHTML =
    `Type: ${cat}<br>` +
    `${pct.toFixed(1)}% of parent<br>` +
    `${drivePct}% of drive` +
    (isFolder ? `<br>Items: ${node.children?.length ?? 0}` : '');

  // File dates section — async fetch
  if (rpDates) {
    if (!isFolder && node.path) {
      rpDates.style.display = 'block';
      if (rpDateCr) rpDateCr.textContent = '…';
      if (rpDateMo) rpDateMo.textContent = '…';
      if (rpDateAc) rpDateAc.textContent = '…';
      window.api.fsStat(node.path).then(st => {
        if (st && !st.error) {
          if (rpDateCr) rpDateCr.textContent = fmtDate(st.created);
          if (rpDateMo) rpDateMo.textContent = fmtDate(st.modified);
          if (rpDateAc) rpDateAc.textContent = fmtDate(st.accessed);
        } else {
          if (rpDateCr) rpDateCr.textContent = '—';
          if (rpDateMo) rpDateMo.textContent = '—';
          if (rpDateAc) rpDateAc.textContent = '—';
        }
      }).catch(() => {});
    } else {
      rpDates.style.display = 'none';
    }
  }

  // Type breakdown
  rpTypeGrid.innerHTML = '';
  if (isFolder) {
    const typeSz = getTypeSizes(node);
    const entries = Object.entries(typeSz).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
    const COLORS = { video: '#e74c3c', images: '#2ecc71', audio: '#f39c12', archives: '#9b59b6',
      documents: '#3498db', code: '#1abc9c', executables: '#f1c40f', other: '#7f8c8d' };
    for (const [key, sz] of entries) {
      const row = document.createElement('div'); row.className = 'rp-type-row';
      row.innerHTML = `<div class="rp-dot" style="background:${COLORS[key]||'#888'}"></div>
        <span>${key}</span><span class="rp-type-sz">${fmt(sz)}</span>`;
      rpTypeGrid.appendChild(row);
    }
  }
}

function updateHUD(used, total, label) {
  if (label !== undefined) currentDriveLabel = label;
  if (!total) { hudText.innerHTML = '<span class="hud-used">—</span>'; return; }
  const pct = (used / total) * 100;
  hudBarFill.style.width = Math.min(pct, 100).toFixed(1) + '%';
  const driveTag = currentDriveLabel
    ? `<span style="color:#666;font-size:11px;margin-right:8px">${currentDriveLabel}</span>`
    : '';
  hudText.innerHTML =
    driveTag +
    `<span class="hud-used">${fmt(used)}</span>` +
    `<span class="hud-total"> used of ${fmt(total)}</span>` +
    `&nbsp;·&nbsp;<span class="hud-pct">${pct.toFixed(1)}%</span>`;
}

// ── Drive context menu (S.M.A.R.T.) ──────────────────────────────────────────
document.getElementById('ctx-drive-properties').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!ctxDriveNode) return;
  await window.api.fsProperties(ctxDriveNode.path);
  hideCtxMenu();
});

document.getElementById('ctx-drive-smart').addEventListener('click', async (e) => {
  e.stopPropagation();
  hideCtxMenu();
  smartLoading.style.display = 'block';
  smartBody.innerHTML = '';
  smartOverlay.classList.add('open');
  showVpOverlay('Reading S.M.A.R.T. data…');
  const res = await window.api.fsSmart();
  hideVpOverlay();
  smartLoading.style.display = 'none';
  if (res.error) { smartBody.innerHTML = `<div style="color:#e74c3c;font-size:11px">${res.error}</div>`; return; }
  for (const d of res.disks) {
    const health = (d.Health || '').toLowerCase();
    const healthClass = health === 'healthy' ? 'good' : health === 'warning' ? 'warn' : 'bad';
    const tempC = d.TemperatureC;
    const tempClass = !tempC ? '' : tempC < 45 ? 'good' : tempC < 60 ? 'warn' : 'bad';
    const rows = [
      ['Name',         d.Name || '—'],
      ['Media',        d.MediaType || '—'],
      ['Size',         d.SizeGB ? d.SizeGB + ' GB' : '—'],
      ['Health',       d.Health || '—', healthClass],
      ['Status',       d.Status || '—'],
      ['Temperature',  tempC != null ? tempC + ' °C' : 'N/A', tempClass],
      ['Power-On Hrs', d.PowerOnHours != null ? d.PowerOnHours + ' h' : 'N/A'],
      ['Read Errors',  d.ReadErrors  != null ? d.ReadErrors  : 'N/A'],
      ['Write Errors', d.WriteErrors != null ? d.WriteErrors : 'N/A'],
      ['Wear Level',   d.Wear        != null ? d.Wear + '%'  : 'N/A'],
      ['Read Lat.',    d.ReadLatencyMs  != null ? d.ReadLatencyMs  + ' ms' : 'N/A'],
      ['Write Lat.',   d.WriteLatencyMs != null ? d.WriteLatencyMs + ' ms' : 'N/A'],
    ];
    const rowsHtml = rows.map(([k, v, cls]) =>
      `<div class="smart-row"><span class="smart-key">${k}</span><span class="smart-val ${cls||''}">${v}</span></div>`
    ).join('');
    smartBody.innerHTML +=
      `<div class="smart-disk"><div class="smart-disk-name">${d.Name || 'Unknown'}</div>${rowsHtml}</div>`;
  }
  if (!res.disks.length) smartBody.innerHTML = '<div style="color:#666;font-size:11px">No physical disks found via WMI.<br>Run as Administrator for full S.M.A.R.T. access.</div>';
});

document.getElementById('smart-close').addEventListener('click', () => smartOverlay.classList.remove('open'));
smartOverlay.addEventListener('click', e => { if (e.target === smartOverlay) smartOverlay.classList.remove('open'); });

// Also dismiss drive menu on outside click
document.addEventListener('click', () => hideCtxMenu());

function updateLegend(node) {
  const totals = Object.fromEntries(ALL_CATS.map(c => [c, 0]));
  let folderSz = 0;
  for (const child of node.children || []) {
    if (child.children?.length) {
      folderSz += child.size;
      const ts = getTypeSizes(child);
      for (const c of ALL_CATS) totals[c] += ts[c];
    } else {
      totals[getCategory(child.name)] += child.size;
    }
  }
  const elF = document.getElementById('leg-folders');
  if (elF) elF.textContent = folderSz > 0 ? fmt(folderSz) : '';
  for (const cat of ALL_CATS) {
    const el = document.getElementById('leg-' + cat);
    if (el) el.textContent = totals[cat] > 0 ? fmt(totals[cat]) : '';
  }
}

// ── Render loop ───────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  controls.update();
  if (galaxyUniforms) galaxyUniforms.uTime.value += delta * (settings?.animSpeed ?? 1);

  // ── Transition animation ─────────────────────────────────────────────────
  if (tAnim.active) {
    tAnim.t += delta * (settings?.animSpeed ?? 1);
    const p = Math.min(tAnim.t / tAnim.dur, 1);

    // FOV punch: zoom in (dir>0) or zoom out (dir<0) then return
    const fovSwing = tAnim.dir > 0 ? 28 : -20;
    camera.fov = 50 + fovSwing * Math.sin(p * Math.PI);
    camera.updateProjectionMatrix();

    // Bloom boost during flash
    if (bloomPass) {
      const bt = THEMES[currentTheme];
      bloomPass.strength = bt.bloom.strength + bt.bloom.strength * 1.8 * Math.sin(p * Math.PI);
    }

    // At midpoint: execute the scene switch
    if (p >= 0.5 && !tAnim.executed) {
      tAnim.executed = true;
      tAnim.cb?.();
    }

    // Scale-in objects from midpoint onward
    if (tAnim.executed) {
      const sp = Math.min((p - 0.5) / 0.5, 1);
      const s  = Math.max(easeOutBack(sp), 0.01);
      sceneObjects.forEach(o => {
        if ((o.isMesh || o.isPoints || o.isLine) && o.userData._tgtScale) {
          o.scale.setScalar(s);
        }
      });
    }

    if (p >= 1) {
      tAnim.active = false;
      camera.fov = 50;
      camera.updateProjectionMatrix();
      if (bloomPass) {
        const bt = THEMES[currentTheme];
        bloomPass.strength = bt.bloom.strength;
      }
      sceneObjects.forEach(o => {
        if (o.userData._tgtScale) {
          o.scale.setScalar(1);
          delete o.userData._tgtScale;
        }
      });
    }
  }

  composer.render();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + u[i];
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ── Collapsible sidebar sections ──────────────────────────────────────────────
function initCollapsibleSidebar() {
  document.querySelectorAll('#sidebar > div').forEach(section => {
    const label = section.querySelector(':scope > .label');
    if (!label) return;
    // Collect all content siblings after the label
    const siblings = [];
    let el = label.nextElementSibling;
    while (el) { siblings.push(el); el = el.nextElementSibling; }
    if (!siblings.length) return;

    // Wrap content in a body div
    const body = document.createElement('div');
    body.className = 'sb-section-body';
    siblings.forEach(s => body.appendChild(s));
    section.appendChild(body);

    // Add caret to label — always start expanded
    const caret = document.createElement('span');
    caret.className = 'sb-caret open';
    caret.textContent = '▾';
    label.appendChild(caret);
    label.classList.add('collapsible');

    body.style.maxHeight = body.scrollHeight + 'px';

    label.addEventListener('click', () => {
      const collapsed = body.classList.contains('collapsed');
      if (collapsed) {
        body.classList.remove('collapsed');
        body.style.maxHeight = body.scrollHeight + 'px';
        caret.classList.add('open');
      } else {
        body.style.maxHeight = body.scrollHeight + 'px';
        requestAnimationFrame(() => {
          body.classList.add('collapsed');
          body.style.maxHeight = '0px';
        });
        caret.classList.remove('open');
      }
    });
  });
}
