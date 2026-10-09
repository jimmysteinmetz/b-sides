# b-sides

Small mods for Claude Code, like new slash commands and side panes. Each one installs on its own, so you take only what you want.

## Plugins

| Plugin | What it does |
| --- | --- |
| [speedread](plugins/speedread) | Plays Claude's last reply, a markdown file, or pasted text one word at a time in a side pane. |

## Install

Run this at the Claude Code prompt in a terminal:

```
/plugin install speedread --marketplace jimmysteinmetz/b-sides
```

The first time, press `y` to add the marketplace, then pick a scope. After that, any other plugin here installs with `/plugin install <name>@b-sides`.

## Layout

Each plugin lives in `plugins/<name>/` with its own manifest, hooks, tests, and README. `.claude-plugin/marketplace.json` lists them all.

## Contributing

Issues and pull requests are welcome. Each plugin's README explains how to run, test, and type-check it.

## License

[MIT](LICENSE)
