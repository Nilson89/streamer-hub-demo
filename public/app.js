// Startseite: zeigt nur an, was der Server liefert. Kontostand, Kosten und Cooldowns entscheidet immer der Server.
import { amountNode, currencyNode, el, fill, formatDuration, formatNumber, request, showToast } from './common.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  me: null,
  board: [],
  vote: null,
  cooldownUntil: new Map(), // Aktion -> Zeitpunkt, ab dem sie wieder geht (nur Anzeige)
  chosenOption: new Map(), // Abstimmungs-Aktion -> gewählte Option
  actionButtons: new Map(), // Aktion -> { button, label }
  busy: false,
  lastAmount: null,
  actionsKey: '',
  rainKey: '',
};

// ---------- Daten laden ----------

async function loadAll() {
  const [config, me, board, vote] = await Promise.all([
    request('GET', '/api/config'),
    request('GET', '/api/me'),
    request('GET', '/api/leaderboard'),
    request('GET', '/api/vote'),
  ]);
  if (config.status === 200 && config.data) state.config = config.data;
  if (me.status === 200 && me.data) state.me = me.data;
  else if (me.status === 401) state.me = null;
  if (board.status === 200 && board.data) state.board = board.data.entries || [];
  if (vote.status === 200 && vote.data) state.vote = vote.data;
  render();
}

// ---------- Anzeige ----------

function render() {
  const c = state.config;
  if (!c) {
    $('loading-text').textContent = 'Die Seite ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.';
    return;
  }
  $('loading-card').hidden = true;

  document.title = c.hubName;
  $('hub-name').textContent = c.hubName;
  $('tagline').textContent = `Sammle ${c.currencyName} und löse Aktionen im Stream aus.`;
  fill($('value-note'), [`${c.currencyName} sind virtuell und haben keinen Geldwert. Man kann sie nicht kaufen, verkaufen oder auszahlen.`]);
  $('value-note').hidden = false;

  const live = state.me ? state.me.isLive : c.isLive;
  $('live-badge').className = live ? 'badge' : 'badge badge-off';
  $('live-text').textContent = live ? 'Stream ist live' : 'Stream ist offline';

  renderRain(c);
  renderBoard(c);
  renderVote();

  const me = state.me;
  $('guest-card').hidden = Boolean(me);
  for (const id of ['account-card', 'actions-card', 'tools-card']) $(id).hidden = !me;
  $('admin-link').hidden = !(me && me.isAdmin);

  if (!me) {
    $('guest-text').textContent = `Melde dich mit Twitch an, sammle ${c.currencyName} beim Zuschauen und löse damit Aktionen im Stream aus: Sounds, Effekte und Abstimmungen.`;
    state.lastAmount = null;
    return;
  }
  renderAccount(c, me, live);
  renderActions(c);
  updateActionButtons();
}

function renderRain(c) {
  const key = `${c.currencyImage}|${c.currencyEmoji}`;
  if (key === state.rainKey) return;
  state.rainKey = key;
  fill($('rain'), Array.from({ length: 12 }, () => currencyNode(c)));
}

function renderAccount(c, me, live) {
  $('greeting').textContent = `Hallo, ${me.displayName}!`;
  $('live-line').textContent = live ? 'Der Stream läuft gerade.' : 'Der Stream ist gerade offline.';

  fill($('counter-number'), [el('span', { text: formatNumber(me.bananas) }), currencyNode(c)]);
  $('counter-label').textContent = c.currencyName;
  if (state.lastAmount !== null && state.lastAmount !== me.bananas) {
    const counter = $('counter');
    counter.classList.remove('bump');
    void counter.offsetWidth; // Animation neu starten
    counter.classList.add('bump');
  }
  state.lastAmount = me.bananas;

  // Fortschritt bis zur nächsten Zuschau-Belohnung
  const watchBox = $('watch-box');
  watchBox.hidden = c.watchBananas <= 0;
  if (c.watchBananas > 0) {
    const interval = c.watchIntervalMinutes;
    const done = Math.min(me.watchMinutes, interval);
    const left = Math.max(interval - done, 0);
    $('watch-bar').style.width = `${Math.round((done / interval) * 100)}%`;
    if (me.isAdmin) {
      fill($('watch-text'), [`Als Streamer bekommst du in deinem eigenen Kanal keine Zuschau-${c.currencyName}.`]);
    } else {
      const lead = left <= 0 ? 'Gleich gibt es ' : `Noch ${left} ${left === 1 ? 'Minute' : 'Minuten'} Zuschauen bis `;
      fill($('watch-text'), [lead, amountNode(c, c.watchBananas, '+')]);
    }
    $('watch-hint').textContent = `Zuschau-${c.currencyName} gibt es, wenn du während des Streams im Twitch-Chat bist.`;
  }

  // Check-in
  const button = $('checkin-button');
  const hint = $('checkin-hint');
  if (me.checkedInToday) {
    button.disabled = true;
    fill(hint, ['Heute schon erledigt. Morgen gibt es wieder ', amountNode(c, c.checkinBananas, '+'), '.']);
  } else if (!live) {
    button.disabled = true;
    hint.textContent = 'Der Check-in geht nur, während der Stream live ist.';
  } else {
    button.disabled = state.busy;
    fill(hint, ['Einmal am Tag während des Streams: ', amountNode(c, c.checkinBananas, '+'), '.']);
  }
}

function renderActions(c) {
  const key = JSON.stringify([c.actions, c.currencyImage, c.currencyEmoji, c.currencyName]);
  if (key === state.actionsKey) return;
  state.actionsKey = key;
  state.actionButtons.clear();

  const cards = c.actions.map((action) => {
    const isVote = action.type === 'vote';
    const label = isVote ? 'Abstimmen' : 'Einlösen';
    const button = el('button', { class: 'btn btn-primary', type: 'button', text: label, on: { click: () => redeem(action) } });
    state.actionButtons.set(action.id, { button, label });

    const foot = [];
    if (isVote) {
      if (!action.options.includes(state.chosenOption.get(action.id))) state.chosenOption.set(action.id, action.options[0]);
      const select = el(
        'select',
        { 'aria-label': `Auswahl für ${action.name}`, on: { change: (e) => state.chosenOption.set(action.id, e.target.value) } },
        action.options.map((option) => el('option', { value: option, text: option })),
      );
      select.value = state.chosenOption.get(action.id);
      foot.push(select);
    }
    foot.push(button);

    return el('article', { class: 'action-card' }, [
      el('h3', { text: action.name }),
      action.description ? el('p', { text: action.description }) : null,
      el('div', { class: 'action-meta' }, [
        amountNode(c, action.cost),
        el('span', { text: action.cooldownSeconds > 0 ? `Cooldown: ${formatDuration(action.cooldownSeconds)}` : 'Kein Cooldown' }),
      ]),
      el('div', { class: 'action-foot' }, foot),
    ]);
  });
  fill($('action-grid'), cards);
}

/** Buttons sperren, solange ein Cooldown läuft oder gerade eine Anfrage unterwegs ist. */
function updateActionButtons() {
  const now = Date.now();
  for (const [id, { button, label }] of state.actionButtons) {
    const left = Math.ceil(((state.cooldownUntil.get(id) || 0) - now) / 1000);
    if (left > 0) {
      button.disabled = true;
      button.textContent = `Noch ${formatDuration(left)}`;
    } else {
      button.disabled = state.busy;
      button.textContent = label;
    }
  }
}

function renderVote() {
  const vote = state.vote;
  const action = vote && vote.actionId && state.config ? state.config.actions.find((a) => a.id === vote.actionId) : null;
  $('vote-card').hidden = !action;
  if (!action) return;
  const total = vote.options.reduce((sum, o) => sum + o.votes, 0);
  $('vote-title').textContent = action.name;
  $('vote-total').textContent = total === 1 ? '1 Stimme' : `${formatNumber(total)} Stimmen`;
  fill(
    $('vote-rows'),
    vote.options.map((o) => {
      const bar = el('div', { class: 'progress-bar' });
      bar.style.width = `${total > 0 ? Math.round((o.votes / total) * 100) : 0}%`;
      return el('div', { class: 'vote-row' }, [
        el('div', { class: 'vote-line' }, [el('span', { text: o.option }), el('span', { text: formatNumber(o.votes) })]),
        el('div', { class: 'progress' }, [bar]),
      ]);
    }),
  );
}

function renderBoard(c) {
  $('board-empty').hidden = state.board.length > 0;
  fill(
    $('board'),
    state.board.map((entry, i) =>
      el('li', {}, [el('span', { class: 'rank', text: String(i + 1) }), el('span', { class: 'name', text: entry.displayName }), amountNode(c, entry.bananas)]),
    ),
  );
}

// ---------- Aktionen ----------

/** Macht aus einem Fehlercode eine freundliche Meldung in der eingestellten Währung. */
function errorText(result, action) {
  const c = state.config;
  switch (result.data && result.data.error) {
    case 'not_enough_bananas': {
      const missing = action && state.me ? Math.max(action.cost - state.me.bananas, 1) : null;
      return missing ? `Dafür fehlen dir ${formatNumber(missing)} ${c.currencyName}.` : `Dafür hast du nicht genug ${c.currencyName}.`;
    }
    case 'cooldown':
      return `Noch ${result.retryAfter || 1} Sekunden Cooldown.`;
    case 'rate_limited':
      return 'Das war etwas zu schnell. Bitte warte kurz.';
    case 'not_live':
      return 'Das geht nur, während der Stream live ist.';
    case 'already_checked_in':
      return 'Du hast heute schon eingecheckt.';
    case 'unknown_action':
      return 'Diese Aktion gibt es nicht mehr.';
    case 'invalid_option':
      return 'Diese Auswahl gibt es nicht mehr.';
    case 'unauthorized':
      return 'Du bist nicht mehr angemeldet. Bitte melde dich neu an.';
    default:
      return result.status === 0 ? 'Keine Verbindung. Bitte versuche es gleich noch einmal.' : 'Das hat leider nicht geklappt. Bitte versuche es noch einmal.';
  }
}

async function withBusy(job) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await job();
  } finally {
    state.busy = false;
    await loadAll();
  }
}

function redeem(action) {
  return withBusy(async () => {
    const body = { actionId: action.id };
    if (action.type === 'vote') body.option = state.chosenOption.get(action.id);
    const result = await request('POST', '/api/redeem', body);
    if (result.status === 200) {
      if (action.cooldownSeconds > 0) state.cooldownUntil.set(action.id, Date.now() + action.cooldownSeconds * 1000);
      showToast(action.type === 'vote' ? `Deine Stimme für „${body.option}“ ist gezählt.` : `„${action.name}“ wurde ausgelöst.`, 'ok');
    } else {
      if (result.data && result.data.error === 'cooldown' && result.retryAfter > 0) {
        state.cooldownUntil.set(action.id, Date.now() + result.retryAfter * 1000);
      }
      showToast(errorText(result, action), 'error');
    }
  });
}

function checkin() {
  return withBusy(async () => {
    const result = await request('POST', '/api/checkin');
    if (result.status === 200) showToast('Check-in erledigt!', 'ok');
    else showToast(errorText(result), 'error');
  });
}

async function logout() {
  await request('POST', '/auth/logout');
  window.location.assign('/');
}

async function deleteAccount() {
  const result = await request('POST', '/api/me/delete');
  if (result.status === 200) {
    window.location.assign('/');
    return;
  }
  showToast(errorText(result), 'error');
}

// ---------- Start ----------

$('checkin-button').addEventListener('click', checkin);
$('logout-button').addEventListener('click', logout);
$('delete-button').addEventListener('click', () => {
  $('delete-confirm').hidden = false;
});
$('delete-no').addEventListener('click', () => {
  $('delete-confirm').hidden = true;
});
$('delete-yes').addEventListener('click', deleteAccount);

// Alle 15 Sekunden neu laden (nicht im versteckten Tab) und sofort, wenn der Tab wieder sichtbar wird.
setInterval(() => {
  if (!document.hidden && !state.busy) loadAll();
}, 15000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !state.busy) loadAll();
});
setInterval(updateActionButtons, 1000);

loadAll();
