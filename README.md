# Facebook Group Share

Local Chrome extension (Manifest V3) that **semi-automatically** shares an existing Facebook post into a fixed group list, one at a time, with human-like delays and a hard **100/day** cap.

Two presets (each max 100 groups):

| Set | Source file |
|---|---|
| **California** | [`data/groups-california.json`](data/groups-california.json) |
| **Whole US** | [`data/groups-us.json`](data/groups-us.json) |

Pick the set in the popup. The same list runs every time. You can edit in the UI or in those JSON files; **Reset to file** reloads from disk.

It lowers ban risk; it cannot eliminate it.

## Location

```
C:\Users\leeor\Desktop\Projects\facebook-group-share
```

## Easy run

Double-click **`run.bat`**. It:

1. Copies the extension path to your clipboard
2. Opens `chrome://extensions`
3. Opens this folder in Explorer

Then: **Developer mode** → **Load unpacked** → paste/select this folder.

After code or group-file changes, click **Reload** on the extension card (or run `run.bat` again and reload).

## Daily use

1. Fill `data/groups-california.json` and/or `data/groups-us.json` (see [`data/README.md`](data/README.md)), then **Reset to file** in the popup — or import/edit in the UI.
2. Open the Facebook **post** to share (keep that tab open).
3. In the popup, choose **California** or **Whole US**.
4. Click **Share to my groups** on the page, or **Start** in the popup.
5. Leave the tab open. Default pacing: 40–75s between shares, 3–6 min break every 12, stop at 100/day.
6. If Facebook shows a checkpoint/CAPTCHA, finish it manually → **Resume**.

## Group JSON format

```json
{
  "id": "california",
  "name": "California",
  "description": "…",
  "groups": [
    {
      "name": "Exact group name as shown on Facebook",
      "url": "https://www.facebook.com/groups/123456789"
    }
  ]
}
```

## Safe defaults

| Setting | Default |
|---|---|
| Inter-group delay | 40–75 seconds |
| Batch size | 12 |
| Batch break | 3–6 minutes |
| Daily cap | 100 |
| Groups per set | ≤ 100 |

## Repo layout

- `manifest.json` — MV3 config  
- `shared.js` — storage + set loading  
- `background.js` — queue / delays / daily cap  
- `content.js` — Share UI automation  
- `popup.*` — set picker + controls  
- `data/` — fixed California & US lists  
- `run.bat` — one-click load helper  

## Privacy

All data stays in `chrome.storage.local` on your machine. No analytics or cloud sync.
