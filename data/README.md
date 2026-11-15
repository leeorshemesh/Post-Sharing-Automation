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
