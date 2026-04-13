# Implementation Plan for Auto-Start Toggle & Copy Confirmation Dialog

## Goal Description
We will add two new features to Super Clip:
1. **Auto-Start Toggle** – a setting in the Settings modal that lets the user enable or disable launching the app on system startup (Windows). This will use the `tauri-plugin-autostart-api` we installed.
2. **Copy Confirmation Dialog** – when a user copies a clip, show a configurable confirmation dialog (Yes/No). If the user selects "Yes" once, we store the preference and skip future prompts.

## User Review Required
> [!IMPORTANT]
> Please confirm the UI design for the auto‑start toggle (a switch) and the copy‑confirmation modal (a simple dialog with "Copy" and "Cancel" buttons). Also confirm whether the preference for "always copy without asking" should be persisted in the app settings (we will store it via `save_setting`).

## Proposed Changes
---
### Settings Component
- Add a new toggle UI for auto‑start using a switch control.
- Hook into Tauri's `autostart` API: `invoke('set_autostart', { enabled })` and `invoke('is_autostart_enabled')`.
- Persist the choice via `save_setting('auto_start', enabled)`.

### Backend (Rust)
- In `src-tauri/src/main.rs` add handlers:
  - `set_autostart(enabled: bool)` – uses `tauri_plugin_autostart_api::Autostart` to enable/disable.
  - `is_autostart_enabled()` – returns current status.
- Register the plugin in `tauri::Builder`.

---
### Copy Confirmation Dialog
- Create a new component `CopyConfirmDialog.tsx` that receives `isOpen`, `onConfirm`, `onCancel`.
- When `handleCopy` is called, check a new setting `copy_confirm_enabled` (default true).
- If enabled, show the dialog; on confirm, perform the copy and optionally set `copy_confirm_enabled` to false if the user checks "Don't ask again".
- Store the preference via `save_setting('copy_confirm_enabled', true/false)`.

### Settings Component (Update)
- Add a new section for the copy‑confirmation toggle with a checkbox "Ask before copying".
- Add a sub‑option "Remember my choice" inside the dialog implementation.

---
### UI/UX Enhancements
- Use the existing glass styling and subtle animations for the new modal.
- Ensure the toggle switch matches the design language (rounded, color‑transition on state change).
- Add appropriate tooltips.

## Open Questions
> [!WARNING]
> 1. Should the auto‑start toggle be visible on all platforms or hidden on non‑Windows? (We can conditionally render based on `process.platform`).
> 2. For the copy confirmation, do you want a global "Never ask again" checkbox, or per‑clip prompting? (We plan a global setting.)

## Verification Plan
### Automated Tests
- Run `npm run dev` and manually verify the Settings modal shows the new toggle and that toggling it updates the backend (check via console logs).
- Verify the copy confirmation appears on first copy and respects the saved preference.

### Manual Verification
- Build the Tauri app (`npm run tauri build`) and test on Windows that the app launches on startup when enabled.
- Test copy behavior across text and image clips.
