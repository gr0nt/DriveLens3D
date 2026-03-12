const fs   = require('fs').promises;
const path = require('path');

async function scanPath(root, onProgress) {
  // Recursive helper — no progress reporting at sub-levels
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
