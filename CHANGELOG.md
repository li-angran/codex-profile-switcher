# Changelog

## 0.2.1

- First version prepared for the Marketplace: icon, license metadata, changelog, privacy and trademark notes.
- API key sign-in now works when the terminal runs zsh or fish.
- Only the ID token in `auth.json` is decoded; the access token is no longer used as a fallback.
- Open Settings no longer depends on a hard-coded publisher.

## 0.2.0

- New Accounts panel with colored avatars, keyboard control and native context menus.
- Usage meters with a time marker, read from Codex's local conversation files.
- Hand a conversation to another account when one reaches its limit, and get notified when a limit resets.
- Found on this computer: add existing Codex homes, or bring back removed accounts.
- Removing an account keeps its folder and can be undone.
- Account colors, shell launchers, and a shared history overview.
- Times follow the VS Code window's time zone on remote machines.

## 0.1.0

- One Codex account per window through `CODEX_HOME`, with shared or separate conversation history.
