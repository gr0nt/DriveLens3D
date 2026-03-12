/**
 * scanner.js — DriveLens 3D (Electron main-process helper)
 *
 * Recursively walks a directory tree, accumulating the size of every file.
 * Returns a tree of node objects:
 *   { name: string, size: number (bytes), path: string, children: node[] }
 *
 * Design decisions
 * ────────────────
 * • Symbolic links are skipped to avoid infinite loops and double-counting.
 * • Errors on individual entries are swallowed so a single inaccessible file
 *   (e.g. a locked system file) doesn't abort the whole scan.
 * • Progress is reported only for root-level entries so the UI can show a
 *   meaningful percentage bar without thousands of tiny updates.
 * • All directory reads run concurrently (Promise.all) for maximum throughput.
 *
 * @param {string}   root        - Absolute path to scan
 * @param {Function} onProgress  - Called with { pct, done, total } for each
 *                                  top-level entry that completes
 * @returns {Promise<object>}    - Root tree node
 */
const fs   = require('fs').promises;
const path = require('path');

async function scanPath(root, onProgress) {
  // ── Recursive inner scanner (no progress events below root level) ─────────
  async function helper(p) {
    let stat;
    try { stat = await fs.stat(p); } catch (e) { return null; }
    if (!stat.isDirectory()) {
      return { name: path.basename(p), size: stat.size || 0, path: p, children: [] };
    }
    let entries;
    try {
      entries = await fs.readdir(p, { withFileTypes: true });
    } catch (e) {
      return { name: path.basename(p) || p, size: 0, path: p, children: [] };
    }
    const results = await Promise.all(
      entries.map(async (e) => {
        if (e.isSymbolicLink()) return null;
        const full = path.join(p, e.name);
        try {
          if (e.isDirectory()) return await helper(full);
          if (e.isFile()) {
            let s = 0;
            try { const st = await fs.stat(full); s = st.size || 0; } catch (_) {}
            return { name: e.name, size: s, path: full, children: [] };
          }
        } catch (_) {}
        return null;
      })
    );
    const children = results.filter(Boolean);
    return { name: path.basename(p) || p, size: children.reduce((s, c) => s + (c.size || 0), 0), path: p, children };
  }

  // Root level — handled separately so we can track and report progress
  let stat;
  try { stat = await fs.stat(root); } catch (e) { return null; }
  if (!stat.isDirectory()) {
    return { name: path.basename(root), size: stat.size || 0, path: root, children: [] };
  }
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    return { name: path.basename(root) || root, size: 0, path: root, children: [] };
  }

  const valid = entries.filter(e => !e.isSymbolicLink());
  const total = valid.length || 1;
  let done = 0;

  const results = await Promise.all(
    valid.map(async (e) => {
      const full = path.join(root, e.name);
      let result = null;
      try {
        if (e.isDirectory()) result = await helper(full);
        else if (e.isFile()) {
          let s = 0;
          try { const st = await fs.stat(full); s = st.size || 0; } catch (_) {}
          result = { name: e.name, size: s, path: full, children: [] };
        }
      } catch (_) {}
      done++;
      if (onProgress) onProgress({ pct: Math.round((done / total) * 100), done, total });
      return result;
    })
  );

  const children = results.filter(Boolean);
  return {
    name: path.basename(root) || root,
    size: children.reduce((s, c) => s + (c.size || 0), 0),
    path: root,
    children,
  };
}

module.exports = { scanPath };
