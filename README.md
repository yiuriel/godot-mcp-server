# godot-mcp-server

### how to add

```
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "godot-creator": {
      "type": "local",
      "command": [
        "node",
        "/absolute/path/to/src/index.ts"
      ]
    }
  },
  "permission": {
    "godot-creator_create_godot_file": "allow"
  }
}
```