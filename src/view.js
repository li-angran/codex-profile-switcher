'use strict';

// The "Accounts" webview view. The extension sends the whole panel state; the page renders it and
// posts back what the user clicked. Right-click and the ⋯ buttons open VS Code's own context menu
// (contributed under "webview/context"), driven by the data-vscode-context of each element.

const vscode = require('vscode');
const crypto = require('crypto');

const VIEW_ID = 'codexProfileSwitcher.profiles';

class ProfilesViewProvider {
  constructor(context, { getState, onMessage, onTimeZone }) {
    this.context = context;
    this.getState = getState;
    this.onMessage = onMessage;
    this.onTimeZone = onTimeZone;
    this.view = null;
    this.lastJson = '';
  }

  resolveWebviewView(view) {
    this.view = view;
    this.lastJson = '';
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg && msg.type === 'ready') {
        this.lastJson = '';
        if (msg.timeZone && this.onTimeZone) this.onTimeZone(msg.timeZone);
        this.post();
        return;
      }
      await this.onMessage(msg);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.post();
    });
    view.onDidDispose(() => {
      this.view = null;
    });
  }

  // Sends the state if it changed (or always, with force).
  post(force = false) {
    if (!this.view || !this.view.visible) return;
    const state = this.getState();
    const json = JSON.stringify(state);
    if (!force && json === this.lastJson) return;
    this.lastJson = json;
    this.view.webview.postMessage({ type: 'state', state });
  }

  send(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>Codex Profiles</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div id="app" aria-live="polite"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

module.exports = { ProfilesViewProvider, VIEW_ID };
