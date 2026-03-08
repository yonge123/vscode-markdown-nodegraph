# Markdown Node Graph View — VSCode Extension

**An Extension for Visualizing Markdown Files Network Graph in Visual Studio Code**

It is a copy of [mkdocs-nodegraph - github](https://github.com/yonge123/mkdocs-nodegraph)

You can visualize the workspace markdown node graph with this extension on VSCode and publish it as a wiki page using the [mkdocs-nodegraph - pypi](https://pypi.org/project/mkdocs-nodegraph/) plugin in the mkdocs library


## Example

<p align="center">
<a>
<img alt="image001.png" src="https://github.com/yonge123/vscode-markdown-nodegraph/blob/master/src/image001.png?raw=true" data-hpc="true" class="Box-sc-g0xbh4-0 fzFXnm">
</a>

## [Youtubte Link](https://youtu.be/zyj5xpqXqIY)



## Features

- Visualizes links between `.md` files as an interactive force-directed graph
- Click a node to open the file in VSCode
- `Ctrl+Click` / `Cmd+Click` to open in a new tab
- `Alt+Click` to open `mdfile_site` URL (if set in frontmatter)
- Search nodes by filename with keyboard navigation
- Physics simulation with full slider controls (identical to original)
- Persistent node positions and preferences across sessions
- Auto-refresh when markdown files are created, deleted, or modified


## Setup Tags, Node Icon and Color on Markdown File

```md

---
tags:
  - CG
  - 3D software
mdfile_icon: "_sources/svgs/blender.svg"
mdfile_color: "#ea7600"
mdfile_site: "https://www.blender.org/"
---

```


## Installation

### From source

1. Copy this folder to `~/.vscode/extensions/vscode-markdown-nodegraph-1.0.0/`
2. Restart VSCode (or run **Developer: Reload Window**)


## Usage

- **Command Palette**: `Open Node Graph View`
- **Keyboard**: `Ctrl+Shift+G` / `Cmd+Shift+G`
- **Editor title bar**: click the hierarchy icon

## Panel Controls

| Control | Description |
|---|---|
| Search | Filter nodes by filename; ↑↓ buttons or Enter/Shift+Enter to cycle |
| Save | Persist current layout + settings |
| Home | Fit all nodes into view |
| Reset | Restore default settings and clear saved positions |
| Refresh | Re-scan workspace files and rebuild graph |
| Physics toggle | Enable/disable force simulation |
| Nodes toggle | Show/hide file nodes |
| Grid toggle | Show/hide background grid |
| Sliders | Tune physics, font, node/edge size |
| Color pickers | Change background and grid color |



[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/bluebird777)

