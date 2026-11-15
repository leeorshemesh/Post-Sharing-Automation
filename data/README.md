# Group sets

Two fixed lists (never more than 100 each):

| File | Set |
|---|---|
| `groups-california.json` | California |
| `groups-us.json` | Whole US |

## Format

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

The extension loads these as defaults. You can also edit the active list in the popup; use **Reset to file** to reload from this folder.

Keep each `groups` array at **100 items or fewer**.

## Hebrew / non-English group names

Facebook UI can stay in English while group names are Hebrew. That works:

1. Put the **exact group name** as Facebook shows it (copy/paste Hebrew is fine).
2. Keep buttons/labels in English on the account (`Share`, `Group`, `Post`) — the extension looks for those.
3. Save JSON / popup text as UTF-8 (normal for this project).

Example:

```json
{
  "name": "קבוצת דוגמה תל אביב",
  "url": "https://www.facebook.com/groups/123456789"
}
```
