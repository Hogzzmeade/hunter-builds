# Hunter Builds

A Windows app for Destiny 2 Hunters. It reads your inventory and vault through [DIM](https://app.destinyitemmanager.com/) and ranks the best Hunter builds you can make from what you already own.

## What it does
- **Builds**: meta Hunter builds scored against your gear, with the best armor combination, weapons, subclass setup and champion coverage.
- **Equip now**: puts a whole build on your character through DIM (be in orbit or a social space).
- **Custom build**: pick an exotic and stat priorities; the optimizer finds the best armor from your vault. Save builds by name.
- **Compare**, **Vault cleanup** (keep / dismantle, lock build items, tag junk), **infusion** suggestions.
- **Meta & farming**: what you are missing for the strongest builds and where it drops.
- **This week**: raid and dungeon rotation, and what Xûr sells for Hunters.
- **History** of your Power and new items, wish-list (Voltron) roll grades, search across items and perks.
- Runs in the tray, refreshes every 6 hours, sends notifications, can start with Windows, and updates itself from this repository's releases.

## Install
Download `HunterBuilds-Setup-x.y.z.exe` from [Releases](../../releases/latest) and run it. Windows may warn because the app is not code-signed: choose **More info → Run anyway**.

The first time, press **Sign in to DIM** and sign in with Bungie.net. Your sign-in, inventory and history stay on your computer.

## Privacy
The app has no server. It only talks to DIM and Bungie.net (through DIM) and to GitHub to check for updates.

## Build from source
```
npm install
npm start        # run
npm run dist     # Windows installer in dist/
```

Not affiliated with Bungie or DIM. Destiny 2 content and materials are trademarks of Bungie, Inc.
