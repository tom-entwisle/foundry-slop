# Foundry Slop

A module for Foundry Virtual Tabletop version 14.

## Installation

Use this manifest URL in Foundry's module installer:

```text
https://raw.githubusercontent.com/tom-entwisle/foundry-slop/main/module.json
```

## Development

The module entry point is `scripts/foundry-slop.js`. Styles live in `styles/foundry-slop.css`, and localization files live in `lang/`.

## Releasing

1. Update `version` and `download` in `module.json`.
2. Run `npm run package`.
3. Create a GitHub release using the same tag as the manifest version, for example `v0.1.0`.
4. Upload `dist/foundry-slop.zip` to the release.
