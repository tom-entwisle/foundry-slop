# Ald Amil Casino

A multiplayer blackjack table module for Foundry Virtual Tabletop v14.

## Installation

Use this manifest URL in Foundry's module installer:

```text
https://raw.githubusercontent.com/tom-entwisle/foundry-slop/main/module.json
```

The module package is expected at:

```text
https://raw.githubusercontent.com/tom-entwisle/foundry-slop/main/ald-amil-casino.zip
```

## Usage

Enable **Ald Amil Casino** in Foundry, then use the moveable **Ald Amil Casino** launcher button near the lower-left of the Foundry UI to open a resizable blackjack window. Drag the launcher to reposition it; its location is saved for your browser.

You can also type `/casino` or `!casino` in chat. The module intercepts those commands locally and opens the casino window without posting a chat message.

## Multiplayer Flow

1. Open the Ald Amil Casino window from the launcher button or by typing `/casino` in chat.
2. Players click **Join Table** between rounds.
3. Any seated player clicks **Start Round** to open betting.
4. Each seated player adjusts their wager and clicks **Ready**.
5. The hand deals automatically when all active players are ready.
6. On your turn, use **Hit**, **Stand**, **Double**, or **Surrender**.
7. The automaton dealer reveals, draws, and pays out automatically after all players finish.

## Blackjack Rules

- Four-deck shoe.
- Dealer hits soft 17.
- Blackjack pays 3:2.
- Surrender loses half the wager.
- Up to 7 players can sit at the table.
- Players start with 100 persistent gold.
- Minimum wager is 5 gold.

## Releasing

1. Update `version` in `module.json` and `package.json`.
2. Run `npm run package`.
3. Commit and push `ald-amil-casino.zip` with the manifest changes.
