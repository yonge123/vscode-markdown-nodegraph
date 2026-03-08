'use strict';

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');

const PANEL_ID    = 'nodegraphView';
const PANEL_TITLE = 'Node Graph';

/** @type {vscode.WebviewPanel | undefined} */
let panel;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const cmd = vscode.commands.registerCommand('nodegraph.open', () => {
    if (panel) {
      panel.reveal();
      return;
    }
    panel = vscode.window.createWebviewPanel(
      PANEL_ID,
      PANEL_TITLE,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          ...(vscode.workspace.workspaceFolders || []).map(f => f.uri),
        ],
      }
    );

    panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);

    // ── Message bus: Webview → Extension ──────────────────────────────────
    panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {

        // Webview is ready — collect graph data and send it over
        case 'ready': {
          const savedState = context.globalState.get('nodegraph.state', {});
          await sendGraphData(panel.webview, savedState);
          break;
        }

        // Open a file by workspace-relative path
        case 'openFile': {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (!workspaceFolders) break;
          for (const folder of workspaceFolders) {
            const fullPath = path.join(folder.uri.fsPath, msg.filePath);
            if (fs.existsSync(fullPath)) {
              const doc = await vscode.workspace.openTextDocument(fullPath);
              await vscode.window.showTextDocument(doc, {
                preview: !msg.newTab,
                viewColumn: msg.newTab ? vscode.ViewColumn.Active : vscode.ViewColumn.One,
                preserveFocus: true,
              });
              break;
            }
          }
          break;
        }

        // Open external URL
        case 'openUrl': {
          vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;
        }

        // Save state (prefs + node positions)
        case 'saveState': {
          await context.globalState.update('nodegraph.state', msg.state);
          if (msg.notify) vscode.window.showInformationMessage('Node Graph: saved ✓');
          break;
        }

        // Reset state
        case 'resetState': {
          await context.globalState.update('nodegraph.state', {});
          vscode.window.showInformationMessage('Node Graph: reset to defaults');
          break;
        }

        // Refresh graph data (e.g. after files changed)
        case 'refresh': {
          const savedState = context.globalState.get('nodegraph.state', {});
          await sendGraphData(panel.webview, savedState);
          break;
        }
      }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);

    // Auto-refresh when markdown files change
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');
    const refresh = () => {
      if (!panel) return;
      const savedState = context.globalState.get('nodegraph.state', {});
      sendGraphData(panel.webview, savedState);
    };
    watcher.onDidCreate(refresh, undefined, context.subscriptions);
    watcher.onDidDelete(refresh, undefined, context.subscriptions);
    // onDidChange intentionally omitted — fires on file open/save, causing graph
    // to rebuild and nodes to vanish every time a node is clicked.
    context.subscriptions.push(watcher);
  });

  context.subscriptions.push(cmd);
}

// ── Graph data collection ─────────────────────────────────────────────────────

/**
 * Find all .md files, parse [[wikilinks]], build nodes + edges.
async function collectGraphData(webview = null) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return { nodes: [], edges: [] };

  // Find all markdown files
  const uris = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');

  // Map: basename (no ext) → workspace-relative path
  const basenameToPath = {};
  for (const uri of uris) {
    const rel  = vscode.workspace.asRelativePath(uri, false);
    const base = path.basename(rel, '.md');
    basenameToPath[base] = rel;
  }
  const pathSet = new Set(Object.values(basenameToPath));

  // Parse wikilinks [[note]] and markdown links [text](note.md) from file content
  const wikilinkRe = /\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
  const mdlinkRe   = /\[[^\]]*\]\(([^)#?]+\.md)[^)]*\)/g;

  const dataDic = {}; // relPath → Set<relPath>
  const fileMeta = {}; // relPath → { basename, frontmatter, links }

  for (const uri of uris) {
    const rel  = vscode.workspace.asRelativePath(uri, false);
    const base = path.basename(rel, '.md');
    if (!dataDic[rel]) dataDic[rel] = new Set();

    let content = '';
    try { content = fs.readFileSync(uri.fsPath, 'utf8'); } catch { continue; }

    // Parse frontmatter
    const fm = {};
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      for (const line of fmMatch[1].split('\n')) {
        const m = line.match(/^(\w+):\s*(.+)/);
        if (m) fm[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }

    // Collect links (wikilinks + markdown links)
    const links = [];
    let m;
    wikilinkRe.lastIndex = 0;
    while ((m = wikilinkRe.exec(content)) !== null) links.push(m[1].trim());
    mdlinkRe.lastIndex = 0;
    while ((m = mdlinkRe.exec(content)) !== null) links.push(m[1].trim());

    fileMeta[rel] = { basename: base, frontmatter: fm, links, path: rel };
  }

  // Build bidirectional dataDic)
  for (const [relPath, meta] of Object.entries(fileMeta)) {
    for (const link of meta.links) {
      // Try exact relative path match first, then basename match
      const linkNorm = link.replace(/\\/g, '/').replace(/\.md$/, '');
      const linkBase = path.basename(linkNorm);
      // Direct path hit (e.g. from markdown links)
      const directHit = pathSet.has(linkNorm + '.md') ? linkNorm + '.md' : null;
      const targetPath = directHit || basenameToPath[linkBase];
      if (!targetPath || !pathSet.has(targetPath)) continue;
      if (!dataDic[targetPath]) dataDic[targetPath] = new Set();
      dataDic[relPath].add(targetPath);
      dataDic[targetPath].add(relPath);
    }
  }

  // Build nodes
  const BEAUTIFUL_COLORS = [
    "#E9967A","#00CED1","#90EE90","#CD5C5C","#FF1493","#32CD32","#FF00FF",
    "#4682B4","#DA70D6","#FFD700","#C71585","#FFDAB9","#20B2AA","#FF69B4",
    "#DAA520","#48D1CC","#F0E68C","#9400D3","#FF7F50","#8B008B","#98FB98",
    "#DDA0DD","#6495ED","#4169E1","#87CEEB","#800080","#FFA500","#8E44AD",
    "#9370DB","#3CB371","#8A2BE2","#66CDAA","#9932CC","#BA55D3","#4ECDC4",
    "#8FBC8F","#5F9EA0","#45B7D1","#FA8072","#00FA9A","#F4A460","#6A5ACD",
    "#D2691E","#7B68EE","#40E0D0","#F08080","#B0C4DE","#FF6B6B","#1E90FF",
    "#FF4500","#FFB6C1","#FFA07A","#87CEFA",
  ];
  const ORPHAN_COLOR = "#9CA3AF";

  let colorArr = [...BEAUTIFUL_COLORS];
  const nodes   = [];
  const nodeMap = {};

  // ── Icon resolution: scan workspace for image files ────────────────────────
  // findFiles with {a,b,c} glob brace expansion is unreliable across platforms —
  // run one query per extension to guarantee all files are found.
  const IMAGE_EXTS = ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
  const imageByBasename = {};
  const imageByRel      = {};

  await Promise.all(IMAGE_EXTS.map(async ext => {
    try {
      const uris = await vscode.workspace.findFiles(
        `**/*.${ext}`, '**/node_modules/**'
      );
      for (const u of uris) {
        const rel  = vscode.workspace.asRelativePath(u, false);
        const base = path.basename(rel);
        // rel-path map (exact match for paths like "_sources/icons/blender.svg")
        imageByRel[rel.replace(/\\/g, '/')] = u.fsPath;
        // also store without leading "./" if present
        imageByRel[rel.replace(/^\.\//,'').replace(/\\/g,'/')] = u.fsPath;
        // basename map (fallback for bare "blender.svg")
        if (!imageByBasename[base]) imageByBasename[base] = u.fsPath;
      }
    } catch (e) {
      console.warn('[NodeGraph] findFiles failed for ext:', ext, e.message);
    }
  }));

  console.log('[NodeGraph] icon scan: found', Object.keys(imageByRel).length, 'images in workspace');

  function fixSvgColors(svgText) {
    // SVGs as base64 data URIs inside <img>→<canvas> have no document context.
    // Fixes applied in order:

    // 1. Inline url(#gradient) references → first stop-color of that gradient.
    //    Without this, gradient fills render as solid black (broken ID lookup).
    const gradientColors = {};
    const gradRe = /<(?:linearGradient|radialGradient)\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/(?:linear|radial)Gradient>/gi;
    let gm;
    while ((gm = gradRe.exec(svgText)) !== null) {
      const stopMatch = gm[0].match(/stop-color[=:]\s*["'\s]*([#\w][^"';\s)]+)/i);
      if (stopMatch) gradientColors[gm[1]] = stopMatch[1];
    }
    // Replace fill="url(#id)" and stroke="url(#id)" with the resolved colour
    svgText = svgText.replace(/(?:fill|stroke)="url\(#([^)]+)\)"/gi, (m, id) => {
      const attr = m.startsWith("fill") ? "fill" : "stroke";
      return gradientColors[id] ? `${attr}="${gradientColors[id]}"` : `${attr}="white"`;
    });

    // 2. Strip <style> blocks — class-based colours can't apply on canvas
    svgText = svgText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // 3. Collapse CSS variable references → currentColor
    svgText = svgText.replace(/var\([^)]+\)/gi, 'currentColor');

    // 4. Check if ANY element already has an explicit colour (hex / rgb)
    //    If so, the SVG is self-coloured — only replace currentColor, nothing else.
    const hasExplicit = /fill\s*=\s*["']\s*#|fill\s*=\s*["']\s*rgb|stroke\s*=\s*["']\s*#|stroke\s*=\s*["']\s*rgb/.test(svgText);
    if (hasExplicit) {
      svgText = svgText.replace(/currentColor/gi, 'white');
      return svgText;
    }

    // 5. No explicit colours — detect stroke-based SVG (Lucide/Feather/Tabler)
    const svgTag = svgText.match(/<svg\b[^>]*>/i)?.[0] || '';
    const rootFillNone = /fill\s*=\s*["']none["']/.test(svgTag);

    // 6. Replace remaining currentColor → white
    svgText = svgText.replace(/currentColor/gi, 'white');

    if (rootFillNone) {
      // Stroke-based: keep fill=none, ensure root has stroke=white
      svgText = svgText.replace(/<svg\b([^>]*?)(\s*>)/i, (m, attrs, close) => {
        if (/stroke\s*=\s*["'][^"']+["']/.test(attrs)) return m;
        return '<svg' + attrs + ' stroke="white"' + close;
      });
      return svgText;
    }

    // 7. Fill-based, no explicit colours: add fill=white to root
    svgText = svgText.replace(/<svg\b([^>]*?)(\s*>)/i, (m, attrs, close) => {
      if (/\bfill\s*=/.test(attrs)) return m;
      return '<svg' + attrs + ' fill="white"' + close;
    });

    // 8. Class-only elements with stripped style get fill=white
    svgText = svgText.replace(
      /<(path|circle|rect|ellipse|polygon|polyline|line|text)\b([^>]*?)(\s*\/?>)/gi,
      (m, tag, attrs, close) => {
        if (/\bclass\s*=/.test(attrs) &&
            !/\bfill\s*=/.test(attrs) &&
            !/\bstroke\s*=/.test(attrs)) {
          return '<' + tag + attrs + ' fill="white"' + close;
        }
        return m;
      }
    );
    return svgText;
  }
  function resolveIconDataUri(iconValue) {
    if (!iconValue) return '';
    const norm = iconValue.replace(/\\/g, '/').replace(/^\.\//, '');
    let fsPath = imageByRel[norm] || imageByBasename[path.basename(norm)];
    if (!fsPath) {
      for (const folder of (vscode.workspace.workspaceFolders || [])) {
        const candidate = path.join(folder.uri.fsPath, norm);
        if (fs.existsSync(candidate)) { fsPath = candidate; break; }
      }
    }
    if (!fsPath && path.isAbsolute(iconValue) && fs.existsSync(iconValue)) fsPath = iconValue;
    if (!fsPath) { console.warn('[NodeGraph] icon not found:', iconValue); return ''; }

    // Use asWebviewUri — same as VS Code built-in Markdown preview.
    // Serves the file via vscode-resource: protocol with full CSS/gradient support.
    // No base64 encoding, no color mangling, SVGs render exactly as intended.
    if (webview) {
      try { return webview.asWebviewUri(vscode.Uri.file(fsPath)).toString(); }
      catch (e) { console.warn('[NodeGraph] asWebviewUri failed:', fsPath, e.message); }
    }
    // Fallback to base64 if webview ref unavailable
    try {
      const ext  = path.extname(fsPath).slice(1).toLowerCase();
      const mime = { svg:'image/svg+xml', png:'image/png', jpg:'image/jpeg',
                     jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp' }[ext] || 'image/png';
      if (ext === 'svg') {
        let svgText = fs.readFileSync(fsPath, 'utf8');
        svgText = fixSvgColors(svgText);
        return `data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}`;
      }
      return `data:${mime};base64,${fs.readFileSync(fsPath).toString('base64')}`;
    } catch (e) { console.warn('[NodeGraph] icon read failed:', fsPath, e.message); return ''; }
  }

  for (const [relPath, meta] of Object.entries(fileMeta)) {
    if (!colorArr.length) colorArr = [...BEAUTIFUL_COLORS];
    const fm         = meta.frontmatter;
    const countLinks = (dataDic[relPath] || new Set()).size;

    let color = colorArr.shift();
    if (countLinks <= 1) color = ORPHAN_COLOR;
    if (fm.mdfile_color) color = fm.mdfile_color;

    const size   = Math.min(50 + countLinks * 4, 120);
    const altUrl = fm.mdfile_site || '';

    // Resolve icon: base64 data URI works inside VSCode webview CSP
    const iconDataUri = resolveIconDataUri(fm.mdfile_icon || '');
    const shape = iconDataUri ? 'image' : 'dot';

    const node = {
      id:       relPath,
      label:    meta.basename,
      nodetype: 'filenode',
      color: color,
      size,
      shape,
      ...(iconDataUri ? {
        image: iconDataUri,
        borderWidth: 0,
        shapeProperties: { useImageSize: false, useBorderWithImage: false, interpolation: false },
      } : {}),
      opacity:     1,
      borderWidth: iconDataUri ? 0 : 2,
      font: {
        color, size: 70, align: 'middle',
        vadjust: shape === 'image' ? size * 0.4 : 0,
      },
      _url:      relPath,
      _url2:     altUrl,
      _basename: meta.basename,
    };
    nodes.push(node);
    nodeMap[relPath] = node;
  }

  // Build edges
  const edges  = [];
  const edgeSet = new Set();

  for (const [relPath, meta] of Object.entries(fileMeta)) {
    meta.links.forEach((link, idx) => {
      const linkNorm   = link.replace(/\\/g, '/').replace(/\.md$/, '');
      const linkBase   = path.basename(linkNorm);
      const directHit  = pathSet.has(linkNorm + '.md') ? linkNorm + '.md' : null;
      const targetPath = directHit || basenameToPath[linkBase];
      if (!targetPath || !pathSet.has(targetPath)) return;

      const key = [relPath, targetPath].sort().join('\0');
      if (edgeSet.has(key)) return;
      edgeSet.add(key);

      const fDeg   = (dataDic[relPath]    || new Set()).size;
      const tDeg   = (dataDic[targetPath] || new Set()).size;
      const maxLnk = Math.max(fDeg, tDeg);
      const len    = maxLnk * 45 + idx * 35;

      const dominant  = fDeg >= tDeg ? nodeMap[relPath] : nodeMap[targetPath];
      const edgeColor = dominant?.color ?? ORPHAN_COLOR;

      edges.push({ from: relPath, to: targetPath, color: edgeColor, length: len, width: 12, smooth: false });
    });
  }

  return { nodes, edges };
}

async function sendGraphData(webview, savedState) {
  try {
    const { nodes, edges } = await collectGraphData(webview);
    webview.postMessage({
      type: 'graphData',
      nodes,
      edges,
      savedState,
    });
  } catch (e) {
    console.error('[NodeGraph]', e);
    vscode.window.showErrorMessage('Node Graph: error building graph — check Output panel');
  }
}

// ── Webview HTML ──────────────────────────────────────────────────────────────

function getWebviewContent(webview, extensionUri) {
  const nonce = getNonce();

  // Inline the CSS rather than loading from disk for portability
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com;
           style-src  'unsafe-inline' https://cdnjs.cloudflare.com;
           img-src    data: blob: https: ${webview.cspSource};
           connect-src 'none';">
<title>Node Graph</title>
<link rel="stylesheet"
  href="https://cdnjs.cloudflare.com/ajax/libs/vis-network/10.0.2/dist/dist/vis-network.min.css">
<style>
/* ── Reset + Base ──────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #0d0f14; }

.ng-root {
  display: flex; width: 100%; height: 100vh;
  overflow: hidden; position: relative; background: #0d0f14;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

/* ── Left Panel ──────────────────────────────────────────────────────────── */
.ng-panel {
  background: #4454704f;
  /* Frosted glass — panel floats OVER the canvas so nodes are visible behind it */
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  width: 270px; min-width: 270px;
  position: absolute; z-index: 10;
  border-radius: 10px;
  box-sizing: border-box; top: 8px; left: 8px; bottom: 8px;
  transition: width 0.2s, background 0.2s;
  /* NO background block — transparent so graph shows through */
}
.ng-panel.collapsed { width: 30px; min-width: 30px; background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; }
.ng-panel.collapsed .ng-panel-content { opacity: 0; visibility: hidden; pointer-events: none; }

.ng-collapse-btn {
  position: absolute; width: 30px; height: 30px; right: 0;
  padding: 2px; color: whitesmoke; background: #222222a6;
  border: none; border-radius: 4px; cursor: pointer;
  transition: background 0.3s; user-select: none; z-index: 3;
}
.ng-collapse-btn:hover { background: #747988; }

.ng-panel-content {
  padding: 5px; margin-top: 32px; margin-bottom: 3px;
  display: flex; flex-direction: column; gap: 0;
  overflow-y: auto; max-height: calc(100% - 35px);
}

/* ── Search ──────────────────────────────────────────────────────────────── */
.ng-search-row { display: flex; align-items: center; gap: 5px; margin-bottom: 8px; }
.ng-search {
  flex: 1; min-width: 0; padding: 7px 10px; background: #151820 !important;
  color: #c8d0e0; border: 1px solid #252a35; border-radius: 6px;
  font-size: 13px; outline: none; transition: border-color 0.2s, box-shadow 0.2s;
}
.ng-search::placeholder { color: #555f75; }
.ng-search:focus { border-color: #00e5ff; box-shadow: 0 0 0 2px rgba(0,229,255,0.15); }

.ng-nav-btn {
  width: 30px; height: 30px; padding: 2px; color: whitesmoke;
  background: #151820 !important; border: none; border-radius: 4px;
  cursor: pointer; transition: 0.3s; user-select: none; flex-shrink: 0;
}
.ng-nav-btn:hover { border-color: #00e5ff; background: rgba(0,229,255,0.08) !important; box-shadow: 0 0 6px rgba(0,229,255,0.2); }

/* ── Buttons ──────────────────────────────────────────────────────────────── */
.ng-btn {
  display: flex; align-items: center; justify-content: center;
  width: 100%; padding: 8px 10px; margin-bottom: 5px;
  font-size: 12px; font-weight: 600; letter-spacing: 0.05em;
  text-transform: uppercase; border: 1px solid transparent;
  border-radius: 6px; cursor: pointer; font-family: inherit;
  transition: background 0.2s, border-color 0.2s, box-shadow 0.2s, transform 0.1s;
}
.ng-btn:active { transform: scale(0.97); }
.ng-btn-save  { background: rgba(0,229,255,0.12) !important; color: #00e5ff; border-color: rgba(0,229,255,0.35); }
.ng-btn-save:hover  { background: rgba(0,229,255,0.22) !important; border-color: #00e5ff; box-shadow: 0 0 10px rgba(0,229,255,0.25); }
.ng-btn-home  { background: #151820 !important; color: #c8d0e0; border-color: #252a35; }
.ng-btn-home:hover  { border-color: #00e5ff; background: rgba(0,229,255,0.06) !important; }
.ng-btn-reset { background: rgba(255,77,109,0.08) !important; color: #ff7a94; border-color: rgba(255,77,109,0.3); }
.ng-btn-reset:hover { background: rgba(255,77,109,0.18) !important; border-color: #ff4d6d; box-shadow: 0 0 10px rgba(255,77,109,0.2); }

/* ── Toggles ──────────────────────────────────────────────────────────────── */
.ng-toggle-group { display: flex; flex-direction: column; gap: 8px; margin-bottom: 6px; }
.ng-toggle-item {
  display: flex; align-items: center; gap: 12px; padding: 10px 12px;
  border: 1px solid #252a35; border-radius: 4px; cursor: pointer;
  transition: border-color 0.15s, background 0.15s; user-select: none;
}
.ng-toggle-item:hover { border-color: #00e5ff; background: rgba(0,229,255,0.04); }
.ng-toggle-dot {
  width: 32px; height: 18px; border-radius: 9px; background: #252a35;
  position: relative; flex-shrink: 0; transition: background 0.2s;
}
.ng-toggle-dot::after {
  content: ''; position: absolute; width: 12px; height: 12px;
  border-radius: 50%; background: #555f75;
  top: 3px; left: 3px; transition: transform 0.2s, background 0.2s;
}
input[type="checkbox"]:checked ~ .ng-toggle-dot { background: rgba(0,229,255,0.2); }
input[type="checkbox"]:checked ~ .ng-toggle-dot::after { transform: translateX(14px); background: #00e5ff; }
.ng-toggle-label { font-size: 12px; font-weight: 600; color: #c8d0e0; letter-spacing: 0.03em; }

/* ── Sliders ──────────────────────────────────────────────────────────────── */
.ng-slider-wrap { margin-top: 2px; display: flex; flex-direction: column; width: 100%; }
.ng-control-label {
  display: block; font-size: 12px; font-weight: 600; letter-spacing: 0.06em;
  color: #c8d0e0; margin-bottom: 2px; margin-top: 14px;
}
.ng-slider {
  -webkit-appearance: none; appearance: none;
  width: 100% !important; height: 14px;
  background: transparent; outline: none; cursor: pointer;
  opacity: 0.85; padding: 0; margin-bottom: 5px;
}
.ng-slider:hover { opacity: 1; }
.ng-slider::-webkit-slider-runnable-track {
  background: linear-gradient(to right, rgba(0,229,255,0.4), #252a35);
  border-radius: 4px; height: 4px;
}
.ng-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  height: 14px; width: 14px; border-radius: 50%; background: #00e5ff;
  border: none; box-shadow: 0 0 6px rgba(0,229,255,0.5); cursor: pointer; margin-top: -5px;
}

/* ── Canvas area — full width, panel floats above it ─────────────────────── */
.ng-area {
  position: absolute; inset: 0;
  overflow: hidden; background: #191b20;
  z-index: 0;
}
.ng-grid-canvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; }
.ng-vis { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 1; }
.ng-vis canvas { background: transparent !important; }

/* ── Loading ──────────────────────────────────────────────────────────────── */
.ng-loading {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 16px;
  background: rgba(13,15,20,0.85); z-index: 50; backdrop-filter: blur(4px);
}
.ng-loading-text { color: #c8d0e0; font-size: 14px; letter-spacing: 0.04em; }
.ng-spinner {
  width: 36px; height: 36px; border: 3px solid rgba(0,229,255,0.15);
  border-top-color: #00e5ff; border-radius: 50%;
  animation: ng-spin 0.8s linear infinite;
}
@keyframes ng-spin { to { transform: rotate(360deg); } }

/* ── Tooltip ──────────────────────────────────────────────────────────────── */
.ng-tooltip {
  position: absolute; display: none; z-index: 8; background: #151820;
  border: 1px solid #252a35; border-radius: 8px; padding: 10px 14px;
  min-width: 160px; max-width: 280px; pointer-events: none;
  box-shadow: 0 4px 20px rgba(0,0,0,0.5);
}
.ng-tt-title { font-size: 13px; font-weight: 600; color: #c8d0e0; margin-bottom: 4px; word-break: break-word; }
.ng-tt-path  { font-size: 11px; color: #555f75; margin-bottom: 4px; word-break: break-all; }
.ng-tt-url   { font-size: 11px; color: #00e5ff; word-break: break-all; }

/* ── Status ──────────────────────────────────────────────────────────────── */
.ng-status {
  position: absolute; bottom: 8px; right: 12px; font-size: 11px;
  color: #555f75; z-index: 5; pointer-events: none; letter-spacing: 0.03em;
}

/* ── Color pickers ──────────────────────────────────────────────────────── */
.ng-color-row { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.ng-color-picker {
  -webkit-appearance: none; appearance: none; width: 36px; height: 28px;
  padding: 2px; border: 1px solid #252a35; border-radius: 6px;
  background: #151820; cursor: pointer; flex-shrink: 0;
}
.ng-color-picker::-webkit-color-swatch-wrapper { padding: 0; border-radius: 4px; }
.ng-color-picker::-webkit-color-swatch { border: none; border-radius: 4px; }
.ng-color-picker:hover { border-color: #00e5ff; box-shadow: 0 0 6px rgba(0,229,255,0.2); }
.ng-color-hex { font-size: 11px; font-family: monospace; color: #555f75; letter-spacing: 0.05em; }

/* ── Scrollbar ──────────────────────────────────────────────────────────── */
.ng-panel-content::-webkit-scrollbar { width: 4px; }
.ng-panel-content::-webkit-scrollbar-track { background: transparent; }
.ng-panel-content::-webkit-scrollbar-thumb { background: #252a35; border-radius: 2px; }
.ng-panel-content::-webkit-scrollbar-thumb:hover { background: #555f75; }
</style>
</head>
<body>
<div class="ng-root" id="ngRoot">

  <!-- LEFT PANEL -->
  <div class="ng-panel" id="ngPanel">
    <button class="ng-collapse-btn" id="ngCollapseBtn" title="Toggle panel">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M11 3.9V20.3M6 7.4H8M6 10.9H8M6 14.5H8M6.2 20.3H17.8C18.9 20.3 19.5 20.3 19.9 20.1 20.3 19.8 20.6 19.5 20.8 19 21 18.6 21 17.9 21 16.6V7.7C21 6.4 21 5.7 20.8 5.2 20.6 4.7 20.3 4.4 19.9 4.1 19.5 3.9 18.9 3.9 17.8 3.9H6.2C5.1 3.9 4.5 3.9 4.1 4.1 3.7 4.4 3.4 4.7 3.2 5.2 3 5.7 3 6.4 3 7.7V16.6C3 17.9 3 18.6 3.2 19 3.4 19.5 3.7 19.8 4.1 20.1 4.5 20.3 5.1 20.3 6.2 20.3Z"
          stroke="whitesmoke" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <div class="ng-panel-content" id="ngPanelContent">
      <!-- Search -->
      <div class="ng-search-row">
        <input type="text" class="ng-search" id="ngSearch" placeholder="Search...">
        <button class="ng-nav-btn" id="ngUp" title="Previous match">
          <svg viewBox="0 0 24 24" width="26" height="26" stroke="white" stroke-width="3" fill="none">
            <path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/>
          </svg>
        </button>
        <button class="ng-nav-btn" id="ngDn" title="Next match">
          <svg viewBox="0 0 24 24" width="26" height="26" stroke="white" stroke-width="3" fill="none">
            <path d="M12 5v14"/><polyline points="19 12 12 19 5 12"/>
          </svg>
        </button>
      </div>

      <!-- Action buttons -->
      <button class="ng-btn ng-btn-save"    id="ngSave">Save</button>
      <button class="ng-btn ng-btn-home"    id="ngHome">Home</button>
      <button class="ng-btn ng-btn-reset"   id="ngReset">Reset</button>

      <!-- Toggles -->
      <div class="ng-toggle-group" id="ngToggles"></div>

      <!-- Sliders -->
      <div id="ngSliders"></div>

      <!-- Color pickers -->
      <div id="ngColors"></div>
    </div>
  </div>

  <!-- CANVAS AREA -->
  <div class="ng-area" id="ngArea">
    <canvas class="ng-grid-canvas" id="ngGridCanvas"></canvas>
    <div class="ng-vis" id="ngVis"></div>
    <div class="ng-loading" id="ngLoading">
      <div class="ng-spinner"></div>
      <div class="ng-loading-text">Building graph…</div>
    </div>
    <div class="ng-tooltip" id="ngTooltip"></div>
    <div class="ng-status" id="ngStatus"></div>
  </div>

</div>

<!-- vis-network from CDN -->
<script nonce="${nonce}"
  src="https://cdnjs.cloudflare.com/ajax/libs/vis-network/10.0.2/dist/vis-network.min.js">
</script>

<script nonce="${nonce}">
// ─── VSCode API bridge ────────────────────────────────────────────────────────
const vscodeApi = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
function postMsg(msg) { if (vscodeApi) vscodeApi.postMessage(msg); }

// ─── Constants ────────────────────────────────────────────────────────────────
const BEAUTIFUL_COLORS = [
  "#E9967A","#00CED1","#90EE90","#CD5C5C","#FF1493","#32CD32","#FF00FF",
  "#4682B4","#DA70D6","#FFD700","#C71585","#FFDAB9","#20B2AA","#FF69B4",
  "#DAA520","#48D1CC","#F0E68C","#9400D3","#FF7F50","#8B008B","#98FB98",
  "#DDA0DD","#6495ED","#4169E1","#87CEEB","#800080","#FFA500","#8E44AD",
  "#9370DB","#3CB371","#8A2BE2","#66CDAA","#9932CC","#BA55D3","#4ECDC4",
  "#8FBC8F","#5F9EA0","#45B7D1","#FA8072","#00FA9A","#F4A460","#6A5ACD",
  "#D2691E","#7B68EE","#40E0D0","#F08080","#B0C4DE","#FF6B6B","#1E90FF",
  "#FF4500","#FFB6C1","#FFA07A","#87CEFA",
];

const DEFAULT_PREFS = {
  physics: true, showNodes: true, showGrid: true,
  gridScale: 120, gravitationalConstant: -800, centralGravity: 3,
  springConstant: 7, damping: 25, fontSize: 43, nodeSize: 11,
  edgeLength: 4, edgeWidth: 6,
  bgColor: '#191b20', gridColor: 'rgba(255,255,255,0.055)',
};

const SLIDER_DEFS = [
  { key: 'gridScale',             label: 'Grid Scale',             min: 10,    max: 300 },
  { key: 'gravitationalConstant', label: 'Gravitational Constant', min: -5000, max: 1100 },
  { key: 'centralGravity',        label: 'Central Gravity',        min: 0,     max: 100 },
  { key: 'springConstant',        label: 'Spring Constant',        min: 0,     max: 100 },
  { key: 'damping',               label: 'Damping',                min: 0,     max: 50 },
  { key: 'fontSize',              label: 'Font Size',              min: 30,    max: 200 },
  { key: 'nodeSize',              label: 'Node Size',              min: 1,     max: 100 },
  { key: 'edgeLength',            label: 'Edge Length',            min: 1,     max: 100 },
  { key: 'edgeWidth',             label: 'Edge Width',             min: 1,     max: 100 },
];

const COLOR_DEFS = [
  { key: 'bgColor',   label: 'Background Color' },
  { key: 'gridColor', label: 'Grid Color' },
];

const TOGGLE_DEFS = [
  { key: 'physics',   label: 'Physics' },
  { key: 'showNodes', label: 'Nodes' },
  { key: 'showGrid',  label: 'Grid' },
];

// ─── State ────────────────────────────────────────────────────────────────────
let network      = null;
let visNodes     = null;
let visEdges     = null;
let nodesBackup  = [];
let edgesBackup  = [];
let nodeColors     = {};
let nodeFontColors = {};
let matchList    = [];
let matchIdx     = -1;
let highlightId  = null;
let prefs        = { ...DEFAULT_PREFS };

// DOM refs
const panel       = document.getElementById('ngPanel');
const area        = document.getElementById('ngArea');
const visEl       = document.getElementById('ngVis');
const gridCanvas  = document.getElementById('ngGridCanvas');
const loadingEl   = document.getElementById('ngLoading');
const tooltipEl   = document.getElementById('ngTooltip');
const statusEl    = document.getElementById('ngStatus');
const searchEl    = document.getElementById('ngSearch');

const sliderEls   = {};
const checkboxEls = {};
const colorEls    = {};

// ─── Build UI controls ────────────────────────────────────────────────────────
function buildControls() {
  // Collapse
  document.getElementById('ngCollapseBtn').onclick = () => {
    panel.classList.toggle('collapsed');
  };
  panel.classList.toggle('collapsed'); // start collapsed like original

  // Search
  let searchTimer;
  searchEl.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(onSearch, 200); });
  searchEl.addEventListener('keydown', e => { if (e.key === 'Enter') navMatch(e.shiftKey ? -1 : 1); });
  document.getElementById('ngUp').onclick = () => navMatch(-1);
  document.getElementById('ngDn').onclick = () => navMatch(1);

  // Buttons
  document.getElementById('ngSave').onclick    = savePrefs;
  document.getElementById('ngHome').onclick    = () => network?.fit({ animation: true });
  document.getElementById('ngReset').onclick   = resetPrefs;

  // Toggles
  const tg = document.getElementById('ngToggles');
  for (const { key, label } of TOGGLE_DEFS) {
    const item = document.createElement('label');
    item.className = 'ng-toggle-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.style.display = 'none'; cb.checked = prefs[key];
    const dot = document.createElement('div');
    dot.className = 'ng-toggle-dot';
    const lbl = document.createElement('span');
    lbl.className = 'ng-toggle-label'; lbl.textContent = label;
    item.append(cb, dot, lbl);
    item.onclick = e => {
      e.preventDefault();
      cb.checked = !cb.checked;
      prefs[key] = cb.checked;
      applyToggle(key, cb.checked);
    };
    checkboxEls[key] = cb;
    tg.appendChild(item);
  }

  // Sliders
  const slidersWrap = document.getElementById('ngSliders');
  for (const d of SLIDER_DEFS) {
    const w = document.createElement('div');
    w.className = 'ng-slider-wrap';
    const lbl = document.createElement('span');
    lbl.className = 'ng-control-label'; lbl.textContent = d.label;
    const sl = document.createElement('input');
    sl.type = 'range'; sl.className = 'ng-slider';
    sl.min = d.min; sl.max = d.max; sl.value = prefs[d.key];
    sliderEls[d.key] = sl;
    sl.oninput = () => { prefs[d.key] = +sl.value; applySlider(d.key); };
    w.append(lbl, sl);
    slidersWrap.appendChild(w);
  }

  // Color pickers
  const colorsWrap = document.getElementById('ngColors');
  for (const d of COLOR_DEFS) {
    const w = document.createElement('div');
    w.className = 'ng-slider-wrap';
    const lbl = document.createElement('span');
    lbl.className = 'ng-control-label'; lbl.textContent = d.label;
    const row = document.createElement('div');
    row.className = 'ng-color-row';
    const cp = document.createElement('input');
    cp.type = 'color'; cp.className = 'ng-color-picker';
    cp.value = prefs[d.key];
    const hex = document.createElement('span');
    hex.className = 'ng-color-hex'; hex.textContent = prefs[d.key];
    colorEls[d.key] = cp;
    cp.oninput = () => { prefs[d.key] = cp.value; hex.textContent = cp.value; applyColor(d.key); };
    row.append(cp, hex);
    w.append(lbl, row);
    colorsWrap.appendChild(w);
  }
}

// ─── Safe node update helper ──────────────────────────────────────────────────
// Always reads the LIVE node from the DataSet before updating, so shape/image/
// color/opacity are never lost — vis-network renders nodes invisible otherwise.
function safeNodeUpdate(updates) {
  if (!visNodes) return;
  const patched = updates.map(upd => {
    const live = visNodes.get(upd.id);
    if (!live) return upd;
    const result = { ...upd };
    // Preserve all visual identity props from live node unless explicitly overridden
    if (live.shape            !== undefined && result.shape            === undefined) result.shape            = live.shape;
    if (live.image            !== undefined && result.image            === undefined) result.image            = live.image;
    if (live.color            !== undefined && result.color            === undefined) result.color            = live.color;
    if (live.opacity          !== undefined && result.opacity          === undefined) result.opacity          = live.opacity;
    if (live.shapeProperties  !== undefined && result.shapeProperties  === undefined) result.shapeProperties  = live.shapeProperties;
    // Never allow a blank image on an image-shape node
    if (result.shape === 'image' && !result.image) result.image = live.image;
    return result;
  });
  visNodes.update(patched);
}

// ─── Toggle logic ─────────────────────────────────────────────────────────────
function applyToggle(key, val) {
  if (key === 'physics' && network) network.setOptions({ physics: { enabled: val } });
  if (key === 'showNodes') setNodeTypeVisible('filenode', val);
  if (key === 'showGrid')  drawGrid();
}

// ─── Slider formulas (exact from original) ───────────────────────────────────
function applySlider(key) {
  if (!network) return;
  const v = prefs[key];
  if (key === 'gridScale') { drawGrid(); return; }
  if (key === 'gravitationalConstant') {
    network.setOptions({ physics: { forceAtlas2Based: { gravitationalConstant: -(Math.abs(v) * 2.517) } } }); return;
  }
  if (key === 'centralGravity') {
    network.setOptions({ physics: { forceAtlas2Based: { centralGravity: v * 0.01 } } }); return;
  }
  if (key === 'springConstant') {
    network.setOptions({ physics: { forceAtlas2Based: { springConstant: v * 0.01 } } }); return;
  }
  if (key === 'damping') {
    network.setOptions({ physics: { forceAtlas2Based: { damping: v * 0.01 } } }); return;
  }
  if (key === 'fontSize') {
    const sz = parseFloat(v);
    network.setOptions({ nodes: { font: { size: sz } } });
    if (visNodes) safeNodeUpdate(visNodes.get().map(n => ({
      id: n.id, font: { ...n.font, size: sz },
    })));
    return;
  }
  if (key === 'nodeSize') {
    if (!nodesBackup.length) return;
    const mult = v * 0.1;
    // Clamp to a minimum visible size (matches scaling.min in opts)
    safeNodeUpdate(nodesBackup.map(n => ({ id: n.id, size: Math.max(n.size * mult, 10) })));
    return;
  }
  if (key === 'edgeLength' || key === 'edgeWidth') { applyEdgeSliders(); return; }
}

function applyEdgeSliders() {
  if (!visEdges || !edgesBackup.length) return;
  const elM = prefs.edgeLength * 0.1;
  const ewM = prefs.edgeWidth  * 0.1;
  visEdges.update(edgesBackup.map(e => ({ id: e.id, length: e.length * elM, width: e.width * ewM })));
}

function applyColor(key) {
  if (key === 'bgColor' && area) {
    area.style.background = prefs.bgColor;
    // Keep image-node backgrounds in sync so no white halo shows.
    // safeNodeUpdate preserves shape/image/shapeProperties so nodes stay visible.
    if (visNodes) {
      safeNodeUpdate(
        visNodes.get({ filter: n => n.shape === 'image' }).map(n => ({
          id: n.id,
          color: { background: prefs.bgColor, border: prefs.bgColor,
                   highlight: { background: prefs.bgColor, border: '#00e5ff' } },
        }))
      );
    }
  }
  if (key === 'gridColor') drawGrid();
}

// ─── Build & init network ─────────────────────────────────────────────────────
function buildGraph(nodes, edges, savedState) {
  setLoading(true);

  visNodes    = new vis.DataSet(nodes);
  visEdges    = new vis.DataSet(edges);
  nodesBackup = nodes.map(n => ({ ...n }));
  edgesBackup = edges.map(e => ({ ...e }));
  nodeColors  = {};
  nodeFontColors = {};
  nodes.forEach(n => {
    nodeColors[n.id]     = n.color;
    nodeFontColors[n.id] = n.font?.color ?? (n.color?.background ?? '#c8d0e0');
  });

  // Restore saved positions
  const savedPos = savedState.nodePositions || {};
  if (Object.keys(savedPos).length > 0) {
    const updated = nodes.map(n => {
      const p = savedPos[n.id];
      return p ? { ...n, x: p.x, y: p.y, fixed: false } : n;
    });
    visNodes = new vis.DataSet(updated);
  }

  // Restore saved prefs
  if (savedState.prefs) Object.assign(prefs, savedState.prefs);

  initNetwork();

  const hasSavedPos = Object.keys(savedPos).length > 0;
  if (hasSavedPos) {
    network.setOptions({ physics: { enabled: false, stabilization: { enabled: false } } });
    network.fit({ animation: false });
  }

  drawGrid();
  loadPreferences(hasSavedPos);

  if (savedState.viewPosition && savedState.scale) {
    try { network.moveTo({ position: savedState.viewPosition, scale: savedState.scale }); } catch {}
  }

  statusEl.textContent = nodes.length + ' nodes · ' + edges.length + ' edges';
  setLoading(false);
}

function initNetwork() {
  if (network) { network.destroy(); network = null; }

  const opts = {
    nodes: {
      shape: 'dot',
      font: { size: 70, align: 'middle' },
      scaling: { min: 70, max: 120 },
      borderWidth: 0, size: 100,
      brokenImage: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MCIgaGVpZ2h0PSI2MCIvPg==',
      shapeProperties: { useBorderWithImage: false, interpolation: false },
    },
    edges: { color: { inherit: true }, smooth: false },
    physics: {
      stabilization: { enabled: false },
      forceAtlas2Based: {
        theta: 0.5, gravitationalConstant: -1100, centralGravity: 0.009,
        springConstant: 0.08, springLength: 600, damping: 0.2, avoidOverlap: 0,
      },
      solver: 'forceAtlas2Based', minVelocity: 5, maxVelocity: 50, timestep: 0.5,
    },
    interaction: { hover: true, tooltipDelay: 9999, navigationButtons: false, keyboard: false },
  };

  network = new vis.Network(visEl, { nodes: visNodes, edges: visEdges }, opts);

  network.on('click', params => {
    savePositions();
    if (!params.nodes.length) return;
    const n  = visNodes.get(params.nodes[0]);
    if (!n || n.nodetype !== 'filenode') return;
    const ev = params.event?.srcEvent || {};
    if (ev.altKey && n._url2) {
      postMsg({ type: 'openUrl', url: n._url2 });
    } else {
      postMsg({ type: 'openFile', filePath: n._url, newTab: ev.ctrlKey || ev.metaKey });
    }
  });

  network.on('hoverNode', p => {
    const n = visNodes.get(p.node);
    if (n) showTooltip(p.event, n);
  });
  network.on('blurNode',          () => { tooltipEl.style.display = 'none'; });
  network.on('zoom',              () => drawGrid());
  // Restore original node colors on every selection/drag event.
  // vis-network dims non-connected nodes to rgba(200,200,200,0.5) — on a dark
  // background they become invisible. We undo this immediately after each event.
  network.on('selectNode',   () => _restoreAllNodeColors());
  network.on('deselectNode', () => { _restoreAllNodeColors(); dehighlightNode(); });
  network.on('dragStart',    () => _restoreAllNodeColors());
  network.on('dragEnd',      () => { _restoreAllNodeColors(); drawGrid(); savePositions(); });
  network.on('animationFinished', () => drawGrid());
}

function _restoreAllNodeColors() {
  if (!visNodes) return;
  const updates = [];
  visNodes.forEach(n => {
    const saved = nodeColors[n.id];
    if (!saved) return;
    const curBg  = typeof n.color === 'object' ? n.color?.background : n.color;
    const origBg = typeof saved  === 'object' ? saved?.background   : saved;
    if (curBg !== origBg) updates.push({ id: n.id, color: saved });
  });
  if (updates.length > 0) visNodes.update(updates);
}

// ─── Preferences ─────────────────────────────────────────────────────────────
function loadPreferences(hasSavedPos = false) {
  for (const [k, sl] of Object.entries(sliderEls))   sl.value   = prefs[k];
  for (const [k, cb] of Object.entries(checkboxEls)) cb.checked = prefs[k];
  for (const [k, cp] of Object.entries(colorEls)) {
    cp.value = prefs[k];
    if (cp.nextSibling) cp.nextSibling.textContent = prefs[k];
  }
  applyColor('bgColor');
  applyColor('gridColor');
  applySlider('gravitationalConstant');
  applySlider('centralGravity');
  applySlider('springConstant');
  applySlider('damping');
  applySlider('fontSize');
  applySlider('nodeSize');
  applyEdgeSliders();
  if (!hasSavedPos) network?.setOptions({ physics: { enabled: prefs.physics } });
  setNodeTypeVisible('filenode', prefs.showNodes);
  drawGrid();
}

function savePrefs() {
  const state = {
    prefs: { ...prefs },
    nodePositions: network ? network.getPositions() : {},
    viewPosition:  network ? network.getViewPosition() : null,
    scale:         network ? network.getScale() : null,
  };
  postMsg({ type: 'saveState', state, notify: true });
}

async function resetPrefs() {
  Object.assign(prefs, DEFAULT_PREFS);
  for (const [k, sl] of Object.entries(sliderEls))   sl.value   = DEFAULT_PREFS[k];
  for (const [k, cb] of Object.entries(checkboxEls)) cb.checked = DEFAULT_PREFS[k];
  if (visNodes)
    safeNodeUpdate(visNodes.get().map(n => ({
      id: n.id, color: nodeColors[n.id] ?? n.color,
    })));
  initNetwork();
  network?.fit({ animation: true });
  loadPreferences();
  postMsg({ type: 'resetState' });
}

function savePositions() {
  if (!network) return;
  const state = {
    prefs: { ...prefs },
    nodePositions: network.getPositions(),
    viewPosition:  network.getViewPosition(),
    scale:         network.getScale(),
  };
  postMsg({ type: 'saveState', state, notify: false });
}



// ─── Node visibility ──────────────────────────────────────────────────────────
function setNodeTypeVisible(nodetype, visible) {
  if (!visNodes) return;
  safeNodeUpdate(
    visNodes.get({ filter: n => n.nodetype === nodetype })
            .map(n => ({ id: n.id, hidden: !visible }))
  );
}

// ─── Search ───────────────────────────────────────────────────────────────────
function onSearch() {
  const q = searchEl.value.trim().toLowerCase();
  // Store only IDs — never snapshot full node objects which go stale after updates
  matchList = []; matchIdx = -1;
  dehighlightNode();
  if (!q || !visNodes) return;
  // Search across basename, label, and full path
  matchList = visNodes
    .get({ filter: n => n.nodetype === 'filenode' })
    .filter(n => {
      const hay = ((n._basename || '') + ' ' + (n.label || '') + ' ' + (n._url || '')).toLowerCase();
      return hay.includes(q);
    })
    .map(n => n.id);  // store IDs only
  if (matchList.length) navMatch(1);
}

function navMatch(dir) {
  if (!matchList.length || !network) return;
  dehighlightNode();
  matchIdx = (matchIdx + dir + matchList.length) % matchList.length;
  const nodeId = matchList[matchIdx];
  // Always fetch fresh from DataSet — never use a stale snapshot
  const n = visNodes.get(nodeId);
  if (!n) return;
  network.selectNodes([nodeId]);
  try {
    const pos = network.getPosition(nodeId);
    network.moveTo({ position: pos, animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
  } catch(e) {}
  highlightId = nodeId;
  safeNodeUpdate([{ id: nodeId, font: { ...(n.font || {}), color: '#FFD700' } }]);
}

function dehighlightNode() {
  if (!highlightId || !visNodes) return;
  const id = highlightId;
  highlightId = null;  // clear first to prevent re-entrancy
  const n = visNodes.get(id);
  if (n) {
    safeNodeUpdate([{ id, font: { ...(n.font || {}), color: nodeFontColors[id] ?? '#c8d0e0' } }]);
  }
}

// ─── Grid ─────────────────────────────────────────────────────────────────────
function drawGrid() {
  const c = gridCanvas;
  const w = area.offsetWidth  || 800;
  const h = area.offsetHeight || 600;
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!prefs.showGrid) return;
  const sp = prefs.gridScale;
  ctx.strokeStyle = prefs.gridColor;
  ctx.lineWidth   = 1;
  let ox = 0, oy = 0;
  if (network) {
    try {
      const o = network.canvasToDOM({ x: 0, y: 0 });
      ox = ((o.x % sp) + sp) % sp;
      oy = ((o.y % sp) + sp) % sp;
    } catch {}
  }
  ctx.beginPath();
  for (let x = ox; x <= w; x += sp) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = oy; y <= h; y += sp) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────
function showTooltip(event, node) {
  const rect = area.getBoundingClientRect();
  let x = (event.clientX || 0) - rect.left + 16;
  let y = (event.clientY || 0) - rect.top  + 16;
  if (x + 240 > rect.width)  x -= 256;
  if (y + 100 > rect.height) y -= 80;
  tooltipEl.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'ng-tt-title'; title.textContent = node._basename || node.label || '';
  const pth = document.createElement('div');
  pth.className = 'ng-tt-path'; pth.textContent = node._url || '';
  tooltipEl.append(title, pth);
  if (node._url2) {
    const url = document.createElement('div');
    url.className = 'ng-tt-url'; url.textContent = '🔗 ' + node._url2;
    tooltipEl.appendChild(url);
  }
  Object.assign(tooltipEl.style, { left: x + 'px', top: y + 'px', display: 'block' });
}

// ─── Loading ──────────────────────────────────────────────────────────────────
function setLoading(v) { loadingEl.style.display = v ? 'flex' : 'none'; }

// ─── Message handler (Extension → Webview) ───────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'graphData') {
    // Skip full rebuild if nodes/edges haven't changed — prevents the graph
    // from wiping and re-drawing when VS Code fires workspace events after
    // a node is clicked to open its file.
    if (network && visNodes && visEdges) {
      const cur = visNodes.get();
      const incoming = msg.nodes;
      if (cur.length === incoming.length && visEdges.get().length === msg.edges.length) {
        const ids = new Set(cur.map(n => n.id));
        if (incoming.every(n => ids.has(n.id))) return; // topology unchanged
      }
    }
    buildGraph(msg.nodes, msg.edges, msg.savedState || {});
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
buildControls();

// Signal ready to extension host
postMsg({ type: 'ready' });

// Redraw grid on resize
window.addEventListener('resize', () => { drawGrid(); });
</script>
</body>
</html>`;
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function deactivate() {}

module.exports = { activate, deactivate };
