/*
 * Ald Amil Casino
 * Foundry VTT module: multiplayer blackjack in a resizable application window.
 */

(() => {
  const MODULE_ID = "ald-amil-casino";
  const SOCKET = `module.${MODULE_ID}`;
  const STARTING_GOLD = 100;
  const MIN_BET = 5;
  const MAX_SEATS = 9;
  const BETTING_SECONDS = 15;
  const DECKS = 4;

  const suits = ["S", "H", "D", "C"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const suitGlyph = { S: "♠", H: "♥", D: "♦", C: "♣" };

  let state = null;
  let casinoApp = null;
  let chatInterceptorInstalled = false;
  let casinoClockInstalled = false;

  const clone = value => foundry.utils?.deepClone ? foundry.utils.deepClone(value) : structuredClone(value);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  function userTokenImage(user) {
    return user?.character?.prototypeToken?.texture?.src || user?.character?.img || user?.avatar || "";
  }

  const actor = () => ({
    userId: game.user.id,
    name: game.user.name || "Unknown Player",
    isGM: game.user.isGM,
    image: userTokenImage(game.user)
  });

  function trustedActor(raw) {
    const user = game.users.get(raw?.userId);
    if (!user) {
      return {
        userId: raw?.userId || "unknown",
        name: raw?.name || "Unknown Player",
        isGM: false,
        image: raw?.image || ""
      };
    }
    return {
      userId: user.id,
      name: user.name || raw?.name || "Unknown Player",
      isGM: !!user.isGM,
      image: userTokenImage(user) || raw?.image || ""
    };
  }

  function freshState() {
    return {
      version: "2.0.0",
      tableId: foundry.utils?.randomID?.() || crypto.randomUUID?.() || String(Date.now()),
      phase: "lobby",
      handNo: 0,
      shoe: [],
      dealer: { hand: [], reveal: false },
      seats: [],
      accounts: {},
      turn: 0,
      bettingDeadline: 0,
      log: ["The Ald Amil Casino opens its brass doors. Join between rounds to buy into the next cycle."]
    };
  }

  function freshTableState(previous = {}) {
    return {
      ...freshState(),
      accounts: clone(previous.accounts || {}),
      log: ["The Odds Engine resets its table geometry. Gold ledgers remain synchronized."]
    };
  }

  function normalizeState(raw) {
    const s = foundry.utils?.mergeObject
      ? foundry.utils.mergeObject(freshState(), raw || {}, { inplace: false, recursive: true })
      : { ...freshState(), ...(raw || {}) };
    s.accounts ||= {};
    for (const p of s.seats || []) ensureAccount(s, p);
    return s;
  }

  function ensureAccount(s, who) {
    if (!who?.userId) return null;
    const existing = s.accounts[who.userId];
    if (!existing) {
      s.accounts[who.userId] = { userId: who.userId, name: who.name || "Unknown Player", image: who.image || "", gold: STARTING_GOLD };
    } else {
      existing.name = who.name || existing.name || "Unknown Player";
      existing.image = who.image || existing.image || "";
      existing.gold = Math.max(0, Number(existing.gold || 0));
    }
    return s.accounts[who.userId];
  }

  function goldOf(s, who) {
    return ensureAccount(s, who)?.gold || 0;
  }

  function addLog(s, text) {
    s.log = [text, ...(s.log || [])].slice(0, 9);
  }

  function seat(s, userId) {
    return s.seats.find(p => p.userId === userId);
  }

  function activeSeats(s) {
    return s.seats.filter(p => !p.out && goldOf(s, p) >= MIN_BET);
  }

  function playingSeats(s) {
    return s.seats.filter(p => !p.out && p.inHand);
  }

  function makeSeat(who) {
    return {
      userId: who.userId,
      name: who.name,
      image: who.image || "",
      bet: MIN_BET,
      hand: [],
      ready: false,
      standing: false,
      busted: false,
      surrendered: false,
      blackjack: false,
      inHand: false,
      result: "",
      lastDelta: 0,
      out: false
    };
  }

  function buildShoe() {
    const cards = [];
    for (let d = 0; d < DECKS; d++) {
      for (const suit of suits) for (const rank of ranks) cards.push(`${rank}${suit}`);
    }
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }

  function draw(s) {
    if (!s.shoe || s.shoe.length < 28) {
      s.shoe = buildShoe();
      addLog(s, "A fresh four-deck shoe locks into the brass probability rail.");
    }
    return s.shoe.pop();
  }

  function cardValue(card) {
    const rank = card.slice(0, -1);
    if (rank === "A") return 11;
    if (["K", "Q", "J"].includes(rank)) return 10;
    return Number(rank);
  }

  function handValue(hand) {
    let total = hand.reduce((sum, card) => sum + cardValue(card), 0);
    let aces = hand.filter(card => card.startsWith("A")).length;
    while (total > 21 && aces > 0) {
      total -= 10;
      aces -= 1;
    }
    return { total, soft: total <= 21 && aces > 0 };
  }

  function resetHand(s, p) {
    const gold = goldOf(s, p);
    p.hand = [];
    p.ready = false;
    p.standing = false;
    p.busted = false;
    p.surrendered = false;
    p.blackjack = false;
    p.inHand = false;
    p.result = "";
    p.lastDelta = 0;
    p.out = gold < MIN_BET;
    p.bet = gold >= MIN_BET ? clamp(p.bet || MIN_BET, MIN_BET, gold) : 0;
  }

  function beginBetting(s, who) {
    if (!["lobby", "settled"].includes(s.phase)) return;
    if (!seat(s, who.userId)) return;
    s.phase = "betting";
    s.dealer = { hand: [], reveal: false };
    s.turn = 0;
    s.bettingDeadline = Date.now() + BETTING_SECONDS * 1000;
    s.seats.forEach(p => resetHand(s, p));
    addLog(s, `${who.name} opens betting. The round starts in ${BETTING_SECONDS} seconds.`);
  }

  function dealHand(s, includeAllActive = false) {
    const players = activeSeats(s).filter(p => (includeAllActive || p.ready) && p.bet > 0 && goldOf(s, p) >= p.bet);
    if (!players.length) return;
    s.handNo += 1;
    s.phase = "playing";
    s.bettingDeadline = 0;
    s.dealer = { hand: [], reveal: false };
    players.forEach(p => {
      p.hand = [];
      p.inHand = true;
      p.standing = false;
      p.busted = false;
      p.surrendered = false;
      p.blackjack = false;
      p.result = "";
      p.lastDelta = 0;
    });
    for (let i = 0; i < 2; i++) {
      players.forEach(p => p.hand.push(draw(s)));
      s.dealer.hand.push(draw(s));
    }
    players.forEach(p => { p.blackjack = handValue(p.hand).total === 21 && p.hand.length === 2; });
    addLog(s, `Hand ${s.handNo} is dealt by the automaton.`);
    if (handValue(s.dealer.hand).total === 21 || players.every(p => p.blackjack)) {
      settleRound(s);
      return;
    }
    s.turn = nextPlayableIndex(s, -1);
    const current = playingSeats(s)[s.turn];
    if (current) addLog(s, `${current.name} has the action.`);
  }

  function nextPlayableIndex(s, fromIndex) {
    const players = playingSeats(s);
    for (let step = 1; step <= players.length; step++) {
      const idx = (fromIndex + step) % players.length;
      const p = players[idx];
      if (!p.standing && !p.busted && !p.surrendered && !p.blackjack) return idx;
    }
    return -1;
  }

  function advanceTurn(s) {
    const next = nextPlayableIndex(s, s.turn);
    if (next < 0) {
      dealerPlay(s);
      settleRound(s);
      return;
    }
    s.turn = next;
    addLog(s, `${playingSeats(s)[s.turn].name} has the action.`);
  }

  function dealerPlay(s) {
    s.dealer.reveal = true;
    const live = playingSeats(s).some(p => !p.busted && !p.surrendered && !p.blackjack);
    if (!live) return;
    let value = handValue(s.dealer.hand);
    while (value.total < 17 || (value.total === 17 && value.soft)) {
      s.dealer.hand.push(draw(s));
      value = handValue(s.dealer.hand);
    }
    addLog(s, `Dealer automaton stands on ${value.total}${value.soft ? " soft" : ""}.`);
  }

  function settleRound(s) {
    s.phase = "settled";
    s.dealer.reveal = true;
    const dealer = handValue(s.dealer.hand);
    const dealerBlackjack = dealer.total === 21 && s.dealer.hand.length === 2;
    const settled = playingSeats(s);

    for (const p of settled) {
      const value = handValue(p.hand);
      let delta = 0;
      let result = "Push";
      if (p.surrendered) {
        delta = -Math.ceil(p.bet / 2);
        result = "Surrender";
      } else if (p.busted || value.total > 21) {
        delta = -p.bet;
        result = "Bust";
      } else if (p.blackjack && !dealerBlackjack) {
        delta = Math.floor(p.bet * 1.5);
        result = "Blackjack";
      } else if (dealerBlackjack && !p.blackjack) {
        delta = -p.bet;
        result = "Dealer Blackjack";
      } else if (dealer.total > 21) {
        delta = p.bet;
        result = "Dealer Bust";
      } else if (value.total > dealer.total) {
        delta = p.bet;
        result = "Win";
      } else if (value.total < dealer.total) {
        delta = -p.bet;
        result = "Lose";
      }

      const account = ensureAccount(s, p);
      account.gold = Math.max(0, account.gold + delta);
      p.lastDelta = delta;
      p.result = result;
      p.ready = false;
      p.out = account.gold < MIN_BET;
      if (p.out) addLog(s, `${p.name} needs gold to continue.`);
    }

    const summary = settled.map(p => `${p.name}: ${p.result} ${p.lastDelta >= 0 ? "+" : ""}${p.lastDelta}g`).join(" · ");
    addLog(s, summary || "No wagers were settled.");
  }

  function allReady(s) {
    const players = activeSeats(s).filter(p => p.bet > 0 && goldOf(s, p) >= p.bet);
    return players.length > 0 && players.every(p => p.ready);
  }

  function bettingSecondsLeft(s = state) {
    if (s?.phase !== "betting" || !s.bettingDeadline) return 0;
    return clamp(Math.ceil((s.bettingDeadline - Date.now()) / 1000), 0, BETTING_SECONDS);
  }

  function settleExpiredBetting() {
    if (!state || state.phase !== "betting" || bettingSecondsLeft(state) > 0 || !isCoordinator()) return;
    const next = normalizeState(clone(state));
    dealHand(next, true);
    if (next.phase === "playing" || next.phase === "settled") setState(next);
  }

  function adjustGold(s, action, who) {
    if (!who.isGM) {
      ui.notifications?.warn("Only the DM can adjust casino gold.");
      return;
    }
    const [, userId, amountText] = action.split(":");
    const account = s.accounts[userId];
    const amount = Math.floor(Number(amountText));
    if (!account || !Number.isFinite(amount)) return;
    account.gold = Math.max(0, account.gold + amount);
    const playerSeat = seat(s, userId);
    if (playerSeat) {
      playerSeat.out = account.gold < MIN_BET;
      playerSeat.bet = account.gold >= MIN_BET ? clamp(playerSeat.bet || MIN_BET, MIN_BET, account.gold) : 0;
    }
    addLog(s, `DM adjusts ${account.name}'s gold by ${amount >= 0 ? "+" : ""}${amount}g.`);
  }

  function findAccountByName(s, name) {
    const wanted = String(name || "").trim().toLowerCase();
    if (!wanted) return null;
    const accounts = Object.values(s.accounts || {});
    return accounts.find(a => a.name.toLowerCase() === wanted)
      || accounts.find(a => a.name.toLowerCase().includes(wanted))
      || s.seats.find(p => p.name.toLowerCase() === wanted)
      || s.seats.find(p => p.name.toLowerCase().includes(wanted))
      || null;
  }

  function applyAction(current, action, who) {
    const s = normalizeState(clone(current));
    const meSeat = seat(s, who.userId);
    ensureAccount(s, who);

    if (action === "reset") {
      if (!who.isGM) {
        ui.notifications?.warn("Only the DM can reset the casino engine.");
        return s;
      }
      return freshTableState(s);
    }

    if (action.startsWith("gold:")) {
      adjustGold(s, action, who);
      return s;
    }

    if (action === "join") {
      if (!["lobby", "settled"].includes(s.phase)) {
        ui.notifications?.warn("New players can join after this round settles.");
        return s;
      }
      if (!meSeat && s.seats.length < MAX_SEATS) {
        s.seats.push(makeSeat(who));
        addLog(s, `${who.name} joins the brass table with ${goldOf(s, who)}g.`);
      }
      return s;
    }

    if (action === "leave") {
      if (!["lobby", "settled"].includes(s.phase)) {
        ui.notifications?.warn("You can leave after the current round settles.");
        return s;
      }
      s.seats = s.seats.filter(p => p.userId !== who.userId);
      addLog(s, `${who.name} leaves the table.`);
      if (!s.seats.length) s.phase = "lobby";
      return s;
    }

    if (action === "start") {
      beginBetting(s, who);
      return s;
    }

    if (!meSeat) {
      ui.notifications?.warn("Join the Ald Amil Casino table first.");
      return s;
    }

    if (s.phase === "betting") {
      if (action.startsWith("bet:") && !meSeat.ready) {
        const amount = action.split(":")[1];
        const gold = goldOf(s, meSeat);
        meSeat.bet = amount === "all" ? gold : clamp((meSeat.bet || MIN_BET) + Number(amount), MIN_BET, gold);
        addLog(s, `${meSeat.name} sets a ${meSeat.bet}g wager.`);
      }
      if (action === "ready" && !meSeat.out && goldOf(s, meSeat) >= MIN_BET) {
        meSeat.ready = !meSeat.ready;
        meSeat.bet = clamp(meSeat.bet || MIN_BET, MIN_BET, goldOf(s, meSeat));
        addLog(s, `${meSeat.name} is ${meSeat.ready ? "ready" : "adjusting their bet"}.`);
      }
      if (allReady(s)) dealHand(s);
      return s;
    }

    if (s.phase === "playing") {
      const players = playingSeats(s);
      const isTurn = players[s.turn]?.userId === who.userId;
      if (!isTurn) {
        ui.notifications?.warn("The automaton is waiting on another player.");
        return s;
      }
      if (action === "hit") {
        meSeat.hand.push(draw(s));
        const total = handValue(meSeat.hand).total;
        addLog(s, `${meSeat.name} hits to ${total}.`);
        if (total > 21) {
          meSeat.busted = true;
          addLog(s, `${meSeat.name} busts.`);
          advanceTurn(s);
        }
      }
      if (action === "stand") {
        meSeat.standing = true;
        addLog(s, `${meSeat.name} stands on ${handValue(meSeat.hand).total}.`);
        advanceTurn(s);
      }
      if (action === "double" && meSeat.hand.length === 2 && goldOf(s, meSeat) >= meSeat.bet * 2) {
        meSeat.bet *= 2;
        meSeat.hand.push(draw(s));
        const total = handValue(meSeat.hand).total;
        meSeat.standing = true;
        if (total > 21) meSeat.busted = true;
        addLog(s, `${meSeat.name} doubles to ${total}.`);
        advanceTurn(s);
      }
      if (action === "surrender" && meSeat.hand.length === 2) {
        meSeat.surrendered = true;
        addLog(s, `${meSeat.name} surrenders.`);
        advanceTurn(s);
      }
      return s;
    }

    return s;
  }

  function coordinatorId() {
    const active = game.users.filter(u => u.active);
    const gms = active.filter(u => u.isGM).sort((a, b) => a.id.localeCompare(b.id));
    if (gms.length) return gms[0].id;
    return active.sort((a, b) => a.id.localeCompare(b.id))[0]?.id || game.user.id;
  }

  function isCoordinator() {
    return game.user.id === coordinatorId();
  }

  async function persistIfPossible(next) {
    if (!game.user.isGM) return;
    await game.settings.set(MODULE_ID, "state", next);
  }

  async function setState(next, broadcast = true) {
    state = normalizeState(next);
    renderCasinoApp(false);
    if (broadcast) {
      await persistIfPossible(state);
      game.socket.emit(SOCKET, { type: "state", state });
    }
  }

  async function requestAction(action) {
    const who = trustedActor(actor());
    const gmOnly = action === "reset" || action.startsWith("gold:");
    if (gmOnly && !who.isGM) {
      ui.notifications?.warn("Only the DM can use that casino control.");
      return;
    }
    if (gmOnly && !isCoordinator()) {
      ui.notifications?.warn("DM treasury controls are only available from the coordinating GM client.");
      return;
    }
    if (isCoordinator()) {
      await setState(applyAction(state, action, who));
      return;
    }
    game.socket.emit(SOCKET, { type: "action", action, actor: who });
  }

  function ensureState() {
    if (state) return;
    try {
      state = normalizeState(game.settings.get(MODULE_ID, "state"));
    } catch (_err) {
      state = freshState();
    }
  }

  function renderCard(card, hidden = false) {
    if (hidden) return `<span class="aac-card aac-card-back" aria-label="Hidden card"><span>◆</span></span>`;
    const rank = card.slice(0, -1);
    const suit = card.slice(-1);
    const red = suit === "H" || suit === "D";
    return `<span class="aac-card ${red ? "is-red" : ""}">
      <span class="aac-card-corner">${esc(rank)}<small>${esc(suitGlyph[suit])}</small></span>
      <span class="aac-card-face">${esc(suitGlyph[suit])}</span>
      <span class="aac-card-corner is-bottom">${esc(rank)}<small>${esc(suitGlyph[suit])}</small></span>
    </span>`;
  }

  function renderHand(hand, hideHole = false) {
    if (!hand?.length) return `<span class="aac-muted">No cards yet.</span>`;
    return hand.map((card, index) => renderCard(card, hideHole && index === 1)).join("");
  }

  function renderValue(hand, hideHole = false) {
    if (!hand?.length) return "-";
    if (hideHole && hand.length > 1) return `${handValue([hand[0]]).total}+?`;
    const value = handValue(hand);
    return `${value.total}${value.soft ? " soft" : ""}`;
  }

  function htmlFromString(html) {
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
  }

  function activateCasinoListeners(root) {
    const element = root?.jquery ? root[0] : root;
    if (!element?.querySelectorAll) return;
    element.querySelectorAll("[data-aac-action]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        requestAction(event.currentTarget.dataset.aacAction);
      });
    });
  }

  function renderCasinoApp(force = false) {
    if (!casinoApp) return;
    casinoApp.render(force);
  }

  function installWindowDrag(windowElement, handle) {
    let drag = null;
    const move = event => {
      if (!drag) return;
      event.preventDefault?.();
      const left = drag.left + event.clientX - drag.x;
      const top = drag.top + event.clientY - drag.y;
      windowElement.style.left = `${clamp(left, 8, window.innerWidth - 120)}px`;
      windowElement.style.top = `${clamp(top, 8, window.innerHeight - 80)}px`;
      windowElement.style.transform = "none";
    };
    const end = () => {
      drag = null;
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", end, true);
    };
    handle.addEventListener("mousedown", event => {
      if (event.button !== 0) return;
      const rect = windowElement.getBoundingClientRect();
      drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      document.addEventListener("mousemove", move, true);
      document.addEventListener("mouseup", end, true);
    });
  }

  class AldAmilCasinoApp {
    constructor() {
      this.element = null;
      this.content = null;
    }

    render() {
      if (!this.element) this.createWindow();
      this.content.innerHTML = "";
      this.content.appendChild(htmlFromString(this.renderCasino()));
      activateCasinoListeners(this.content);
      this.content.querySelector(".aac-window-close")?.addEventListener("click", () => this.close());
      installWindowDrag(this.element, this.content.querySelector(".aac-hud"));
      this.element.hidden = false;
      this.element.style.display = "";
    }

    close() {
      this.element?.remove();
      this.element = null;
      this.content = null;
      if (casinoApp === this) casinoApp = null;
    }

    createWindow() {
      const wrapper = document.createElement("section");
      wrapper.id = "ald-amil-casino-app";
      wrapper.className = "ald-amil-casino-window aac-floating-window";
      wrapper.innerHTML = `<div class="window-content aac-window-content"></div>`;
      document.body.appendChild(wrapper);
      this.element = wrapper;
      this.content = wrapper.querySelector(".aac-window-content");
    }

    renderCasino() {
      const mySeat = seat(state, game.user.id);
      const players = playingSeats(state);
      const hideHole = state.phase === "playing" && !state.dealer.reveal;
      const currentId = players[state.turn]?.userId;
      const myGold = goldOf(state, actor());
      const countdown = bettingSecondsLeft(state);
      const currentName = state.phase === "betting" ? `Betting ${countdown}s` : currentId ? esc(seat(state, currentId)?.name || "Player") : "Open Table";
      return `<section class="aac-shell aac-casino-floor">
        <header class="aac-hud">
          <div class="aac-brand">
            <span class="aac-live-dot"></span>
            <div>
              <strong>Ald Amil Live Blackjack</strong>
              <small>VIP Table · Blackjack pays 3:2 · Dealer hits soft 17</small>
            </div>
          </div>
          <div class="aac-hud-stats">
            <span><small>Phase</small><strong>${esc(state.phase)}</strong></span>
            <span><small>Hand</small><strong>#${state.handNo}</strong></span>
            <span><small>Turn</small><strong>${currentName}</strong></span>
            <span><small>Balance</small><strong>${myGold}g</strong></span>
          </div>
          <button type="button" class="aac-window-close" aria-label="Close Ald Amil Casino">&times;</button>
        </header>
        <main class="aac-main aac-phase-${esc(state.phase)}">
          ${this.renderTable(hideHole, currentId, mySeat, myGold, countdown)}
        </main>
      </section>`;
    }

    renderTable(hideHole, currentId, mySeat, myGold, countdown) {
      const settled = state.phase === "settled";
      return `<section class="aac-table-stage">
        <div class="aac-felt-table">
          ${this.renderDealer(hideHole)}
          ${settled ? this.renderPayoutRibbon() : ""}
          <div class="aac-seat-ring ${state.seats.length ? "" : "is-empty"}">
            ${state.seats.length ? state.seats.map((p, index) => this.renderSeat(p, currentId, index)).join("") : `<div class="aac-table-empty">Use <strong>!casino</strong> to open this table, then join a seat.</div>`}
          </div>
          ${state.phase === "betting" ? `<div class="aac-countdown" style="--aac-tick:${BETTING_SECONDS - countdown};"><div class="aac-countdown-face"><span>Betting closes in</span><strong>${countdown}</strong></div></div>` : ""}
          <div class="aac-bottom-rail">
            <div class="aac-balance-strip">
              <span><small>Balance</small><strong>${myGold}g</strong></span>
              <span><small>Total Bet</small><strong>${mySeat?.bet || 0}g</strong></span>
            </div>
            <div class="aac-buttons">${this.renderControls(mySeat)}</div>
          </div>
        </div>
      </section>`;
    }

    renderDealer(hideHole) {
      return `<section class="aac-dealer">
        <div class="aac-hand">${renderHand(state.dealer.hand, hideHole)}</div>
        <span class="aac-dealer-total">${esc(renderValue(state.dealer.hand, hideHole))}</span>
      </section>`;
    }

    renderPayoutRibbon() {
      const settled = playingSeats(state);
      if (!settled.length) return "";
      return `<section class="aac-payout-ribbon">
        ${settled.map(p => {
          const delta = Number(p.lastDelta || 0);
          const tone = delta > 0 ? "win" : delta < 0 ? "loss" : "push";
          return `<span class="aac-payout is-${tone}"><strong>${esc(p.name)}</strong> ${esc(p.result || "Push")} <b>${delta >= 0 ? "+" : ""}${delta}g</b></span>`;
        }).join("")}
      </section>`;
    }

    renderSeat(p, currentId, index = 0) {
      const account = ensureAccount(state, p);
      const image = p.image || account.image || "";
      const status = p.out ? "Out" : p.result || (p.ready ? "Ready" : p.standing ? "Stand" : p.busted ? "Bust" : p.surrendered ? "Surrender" : p.blackjack ? "Blackjack" : currentId === p.userId ? "Action" : "Seated");
      const delta = Number(p.lastDelta || 0);
      const resultClass = delta > 0 ? "is-win" : delta < 0 ? "is-loss" : p.result ? "is-push" : "";
      return `<article class="aac-seat aac-seat-${index} ${currentId === p.userId ? "is-turn" : ""} ${p.userId === game.user.id ? "is-mine" : ""} ${p.out || p.busted ? "is-busted" : ""} ${resultClass}">
        <span class="aac-seat-status">${esc(status)}</span>
        <div class="aac-hand">${renderHand(p.hand)}</div>
        <div class="aac-player-id">
          ${image ? `<img src="${esc(image)}" alt="">` : `<span class="aac-token-fallback">${esc((p.name || "?").slice(0, 1))}</span>`}
          <h3>${esc(p.name)}</h3>
        </div>
        <div class="aac-meters">
          <span><small>Gold</small><strong>${account.gold}</strong></span>
          <span><small>Bet</small><strong>${p.bet || 0}</strong></span>
          <span><small>Total</small><strong>${esc(renderValue(p.hand))}</strong></span>
          ${p.result ? `<span class="aac-delta"><small>${esc(p.result)}</small><strong>${delta >= 0 ? "+" : ""}${delta}g</strong></span>` : ""}
        </div>
      </article>`;
    }

    renderControls(mySeat) {
      if (!mySeat) {
        return `<button class="aac-action aac-round-control primary" data-aac-action="join" ${!["lobby", "settled"].includes(state.phase) || state.seats.length >= MAX_SEATS ? "disabled" : ""}><strong>Join</strong><span>Table</span></button>`;
      }
      if (["lobby", "settled"].includes(state.phase)) {
        return [
          `<button class="aac-action aac-round-control primary" data-aac-action="start" ${activeSeats(state).length <= 0 ? "disabled" : ""}><strong>Deal</strong><span>Start</span></button>`,
          `<button class="aac-action aac-round-control" data-aac-action="leave"><strong>Exit</strong><span>Leave</span></button>`,
          game.user.isGM ? `<button class="aac-action aac-round-control danger" data-aac-action="reset"><strong>Reset</strong><span>Table</span></button>` : ""
        ].join("");
      }
      if (state.phase === "betting") {
        const gold = goldOf(state, mySeat);
        const maxed = mySeat.bet >= gold;
        return [
          `<button class="aac-chip-button is-minus" data-aac-action="bet:-5" ${mySeat.ready || mySeat.bet <= MIN_BET ? "disabled" : ""}>-</button>`,
          `<button class="aac-chip-button chip-5" data-aac-action="bet:5" ${mySeat.ready || maxed ? "disabled" : ""}>5</button>`,
          `<button class="aac-chip-button chip-10" data-aac-action="bet:10" ${mySeat.ready || maxed ? "disabled" : ""}>10</button>`,
          `<button class="aac-chip-button chip-25" data-aac-action="bet:25" ${mySeat.ready || maxed ? "disabled" : ""}>25</button>`,
          `<button class="aac-chip-button chip-50" data-aac-action="bet:50" ${mySeat.ready || maxed ? "disabled" : ""}>50</button>`,
          `<button class="aac-chip-button chip-100" data-aac-action="bet:100" ${mySeat.ready || maxed ? "disabled" : ""}>100</button>`,
          `<button class="aac-action aac-round-control all-in" data-aac-action="bet:all" ${mySeat.ready || maxed ? "disabled" : ""}><strong>All</strong><span>In</span></button>`,
          `<button class="aac-action aac-round-control primary" data-aac-action="ready"><strong>${mySeat.ready ? "Undo" : "Ready"}</strong><span>Bet</span></button>`
        ].join("");
      }
      if (state.phase === "playing") {
        const players = playingSeats(state);
        const isTurn = players[state.turn]?.userId === game.user.id;
        return [
          `<button class="aac-action aac-round-control double" data-aac-action="double" ${!isTurn || mySeat.hand.length !== 2 || goldOf(state, mySeat) < mySeat.bet * 2 ? "disabled" : ""}><strong>x2</strong><span>Double</span></button>`,
          `<button class="aac-action aac-round-control primary" data-aac-action="hit" ${!isTurn ? "disabled" : ""}><strong>+</strong><span>Hit</span></button>`,
          `<button class="aac-action aac-round-control danger" data-aac-action="stand" ${!isTurn ? "disabled" : ""}><strong>✋</strong><span>Stand</span></button>`,
          `<button class="aac-action aac-round-control split" data-aac-action="surrender" ${!isTurn || mySeat.hand.length !== 2 ? "disabled" : ""}><strong>↘</strong><span>Surrender</span></button>`
        ].join("");
      }
      return `<button class="aac-action aac-round-control primary" data-aac-action="start"><strong>Deal</strong><span>Next</span></button>`;
    }

  }

  function openCasino() {
    ensureState();
    if (!casinoApp) casinoApp = new AldAmilCasinoApp();
    renderCasinoApp(true);
    try {
      if (isCoordinator()) game.socket.emit(SOCKET, { type: "state", state });
    } catch (_err) {
      // Opening the casino should still work if socket sync is unavailable.
    }
  }

  function isLaunchCommand(value) {
    const raw = String(value || "").trim();
    const text = raw.includes("<")
      ? htmlFromString(`<div>${raw}</div>`)?.textContent?.trim() || raw
      : raw;
    return ["/casino", "/aldamil", "/ald-amil-casino", "!casino", "!aldamil"].includes(text.toLowerCase());
  }

  function parseCasinoCommand(value) {
    const raw = String(value || "").trim();
    const text = raw.includes("<")
      ? htmlFromString(`<div>${raw}</div>`)?.textContent?.trim() || raw
      : raw;
    const match = text.match(/^!(?:casino|aldamil)\s+(.+?)\s+([+-]\d+)g?$/i);
    if (!match) return null;
    return { playerName: match[1].trim(), amount: Number(match[2]) };
  }

  async function handleGoldChatCommand(command) {
    ensureState();
    if (!game.user.isGM) {
      ui.notifications?.warn("Only the DM can adjust casino gold.");
      return;
    }
    const target = findAccountByName(state, command.playerName);
    if (!target?.userId || !Number.isFinite(command.amount)) {
      ui.notifications?.warn(`No casino account found for "${command.playerName}".`);
      return;
    }
    await requestAction(`gold:${target.userId}:${command.amount}`);
  }

  function readInputValue(target) {
    if (!target) return "";
    if ("value" in target) return target.value;
    if (target.isContentEditable) return target.innerText || target.textContent || "";
    return "";
  }

  function clearInputValue(target) {
    if (!target) return;
    if ("value" in target) target.value = "";
    else if (target.isContentEditable) target.innerText = "";
  }

  function handleLaunchCommand(target, event) {
    const value = readInputValue(target);
    const goldCommand = parseCasinoCommand(value);
    if (goldCommand) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      clearInputValue(target);
      handleGoldChatCommand(goldCommand);
      return true;
    }
    if (!isLaunchCommand(value)) return false;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    clearInputValue(target);
    openCasino();
    return true;
  }

  function launcherDefaultPosition() {
    return { left: 8, top: Math.max(8, (window.innerHeight || 720) - 126) };
  }

  function clampLauncherPosition(position, element) {
    const margin = 8;
    const width = element?.offsetWidth || 170;
    const height = element?.offsetHeight || 36;
    const viewportWidth = window.innerWidth || 1280;
    const viewportHeight = window.innerHeight || 720;
    return {
      left: Math.min(Math.max(Number(position?.left) || margin, margin), Math.max(margin, viewportWidth - width - margin)),
      top: Math.min(Math.max(Number(position?.top) || margin, margin), Math.max(margin, viewportHeight - height - margin))
    };
  }

  function getLauncherPosition() {
    try {
      return game.settings.get(MODULE_ID, "launcherPosition") || launcherDefaultPosition();
    } catch (_err) {
      return launcherDefaultPosition();
    }
  }

  async function setLauncherPosition(position) {
    try {
      await game.settings.set(MODULE_ID, "launcherPosition", position);
    } catch (_err) {
      // Cosmetic client setting only; failing to save should not break the casino.
    }
  }

  function placeLauncher(launcher, position) {
    const next = clampLauncherPosition(position, launcher);
    launcher.style.left = `${next.left}px`;
    launcher.style.top = `${next.top}px`;
    launcher.style.bottom = "auto";
    launcher.style.right = "auto";
    return next;
  }

  function installLauncherDrag(launcher) {
    let drag = null;
    const move = event => {
      if (!drag) return;
      const point = event.touches?.[0] || event;
      const clientX = point.clientX ?? drag.startX;
      const clientY = point.clientY ?? drag.startY;
      const dx = clientX - drag.startX;
      const dy = clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      event.preventDefault?.();
      drag.moved = true;
      placeLauncher(launcher, {
        left: drag.originLeft + dx,
        top: drag.originTop + dy
      });
    };
    const end = async event => {
      if (!drag) return;
      const wasMoved = drag.moved;
      if (wasMoved) move(event);
      launcher.classList.remove("aac-launcher-dragging");
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", end, true);
      document.removeEventListener("touchmove", move, true);
      document.removeEventListener("touchend", end, true);
      const finalPosition = clampLauncherPosition({
        left: parseFloat(launcher.style.left),
        top: parseFloat(launcher.style.top)
      }, launcher);
      drag = null;
      if (wasMoved) await setLauncherPosition(finalPosition);
      else openCasino();
    };
    const start = event => {
      const touch = event.touches?.[0];
      const clientX = touch?.clientX ?? event.clientX;
      const clientY = touch?.clientY ?? event.clientY;
      if (clientX == null || clientY == null || event.button > 0) return;
      event.preventDefault?.();
      const current = clampLauncherPosition({
        left: parseFloat(launcher.style.left),
        top: parseFloat(launcher.style.top)
      }, launcher);
      drag = { startX: clientX, startY: clientY, originLeft: current.left, originTop: current.top, moved: false };
      launcher.classList.add("aac-launcher-dragging");
      document.addEventListener("mousemove", move, true);
      document.addEventListener("mouseup", end, true);
      document.addEventListener("touchmove", move, true);
      document.addEventListener("touchend", end, true);
    };
    launcher.addEventListener("mousedown", start);
    launcher.addEventListener("touchstart", start, { passive: false });
    window.addEventListener("resize", () => {
      const next = placeLauncher(launcher, {
        left: parseFloat(launcher.style.left),
        top: parseFloat(launcher.style.top)
      });
      setLauncherPosition(next);
    });
  }

  function installLauncherButton() {
    if (document.getElementById("ald-amil-casino-launcher")) return;
    const launcher = document.createElement("button");
    launcher.id = "ald-amil-casino-launcher";
    launcher.type = "button";
    launcher.innerHTML = `<i class="fas fa-coins"></i><span>Ald Amil Casino</span>`;
    launcher.title = "Open Ald Amil Casino";
    placeLauncher(launcher, getLauncherPosition());
    installLauncherDrag(launcher);
    document.body.appendChild(launcher);
  }

  function installChatCommandInterceptor() {
    if (chatInterceptorInstalled) return;
    chatInterceptorInstalled = true;
    Hooks.on("chatMessage", (_chatLog, messageText, chatData) => {
      messageText ||= chatData?.content;
      const goldCommand = parseCasinoCommand(messageText);
      if (goldCommand) {
        handleGoldChatCommand(goldCommand);
        return false;
      }
      if (!isLaunchCommand(messageText)) return true;
      openCasino();
      return false;
    });
    document.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const looksLikeChat = target?.id === "chat-message" || target?.name === "content" || target?.closest?.("#chat-form,.chat-form,#chat");
      if (!looksLikeChat) return;
      handleLaunchCommand(target, event);
    }, true);

    document.addEventListener("submit", event => {
      const form = event.target;
      if (!form?.matches?.("#chat-form,.chat-form")) return;
      const target = form.querySelector("#chat-message,[name='content'],textarea,input,[contenteditable='true']");
      handleLaunchCommand(target, event);
    }, true);
  }

  function removeLauncherButton() {
    document.getElementById("ald-amil-casino-launcher")?.remove();
  }

  function installCasinoClock() {
    if (casinoClockInstalled) return;
    casinoClockInstalled = true;
    setInterval(() => {
      if (state?.phase !== "betting") return;
      settleExpiredBetting();
      renderCasinoApp(false);
    }, 1000);
  }

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "state", {
      name: "Ald Amil Casino State",
      scope: "world",
      config: false,
      type: Object,
      default: freshState()
    });
    game.settings.register(MODULE_ID, "launcherPosition", {
      name: "Ald Amil Casino Launcher Position",
      scope: "client",
      config: false,
      type: Object,
      default: null
    });
  });

  Hooks.once("ready", () => {
    ensureState();
    game.aldAmilCasino = {
      open: openCasino,
      action: requestAction,
      get state() { return state; }
    };
    installChatCommandInterceptor();
    installCasinoClock();
    removeLauncherButton();

    try {
      game.socket.on(SOCKET, async payload => {
        if (payload.type === "state") {
          state = normalizeState(payload.state);
          renderCasinoApp(false);
          return;
        }
        if (payload.type === "action" && isCoordinator()) {
          if (payload.action === "reset" || payload.action?.startsWith("gold:")) return;
          await setState(applyAction(state, payload.action, trustedActor(payload.actor)));
        }
        if (payload.type === "sync" && isCoordinator()) {
          game.socket.emit(SOCKET, { type: "state", state });
        }
      });

      if (!isCoordinator()) game.socket.emit(SOCKET, { type: "sync" });
    } catch (err) {
      console.warn(`${MODULE_ID} | Socket sync unavailable; casino will run locally.`, err);
    }
  });
})();
