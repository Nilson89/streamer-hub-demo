// Admin-Seite: Einstellungen bearbeiten. Geprüft und gespeichert wird immer auf dem Server.
import { amountNode, copyText, el, fill, request, showToast } from './common.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: null, // Arbeitskopie der Einstellungen
  images: [],
  overlay: null,
  overlayShown: false,
};

const HIDDEN_URL = '••••••••••••••••••••••••';
const TYPE_LABELS = { sound: 'Sound abspielen', rain: 'Regen mit deiner Währung', vote: 'Abstimmung' };

// ---------- Felder ----------

/** Ganze Zahl aus einem Eingabefeld. Ungültiges bleibt Text, der Server meldet es dann am Feld. */
const toNumber = (value) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : value);

/**
 * Baut ein Formularfeld: Label, Eingabe, optional Hinweis, darunter Platz für den Fehlertext.
 * path ist der Ort in den Einstellungen (z. B. „actions.2.cost“), damit Server-Fehler am richtigen Feld landen.
 */
function field({ path, label, value, type = 'text', hint, wide = false, choices, attrs = {}, onChange }) {
  const id = `feld-${path.replace(/\./g, '-')}`;
  let input;
  if (choices) {
    input = el(
      'select',
      { id },
      choices.map((c) => el('option', { value: c.value, text: c.label })),
    );
  } else {
    input = el('input', { id, type, autocomplete: 'off', ...attrs });
  }
  input.value = value === null || value === undefined ? '' : String(value);
  input.addEventListener(choices ? 'change' : 'input', () => {
    onChange(input.value);
    markDirty();
  });
  return el('div', { class: `field${wide ? ' field-wide' : ''}`, 'data-path': path }, [
    el('label', { for: id, text: label, title: label }),
    input,
    hint ? el('p', { class: 'hint', text: hint }) : null,
    el('p', { class: 'error', hidden: true }),
  ]);
}

function clearErrors() {
  for (const node of document.querySelectorAll('[data-path]')) {
    node.classList.remove('has-error');
    const error = node.querySelector('.error');
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
  }
  $('actions-error').hidden = true;
}

/** Zeigt die Fehler vom Server direkt am jeweiligen Feld an. Gibt zurück, wie viele kein Feld gefunden haben. */
function showIssues(issues) {
  const byPath = new Map();
  for (const node of document.querySelectorAll('[data-path]')) byPath.set(node.dataset.path, node);
  const rest = [];
  for (const issue of issues) {
    let path = String(issue.path || '');
    let node = byPath.get(path);
    // Fehler ohne eigenes Feld (z. B. an einer einzelnen Option) wandern eine Ebene nach oben.
    while (!node && path.includes('.')) {
      path = path.slice(0, path.lastIndexOf('.'));
      node = byPath.get(path);
    }
    const error = node ? node.querySelector('.error') : null;
    if (!error) {
      rest.push(issue.message);
      continue;
    }
    node.classList.add('has-error');
    error.textContent = String(issue.message);
    error.hidden = false;
  }
  if (rest.length) {
    $('actions-error').textContent = rest.join(' ');
    $('actions-error').hidden = false;
  }
}

function markDirty() {
  $('save-button').disabled = false;
  $('save-status').textContent = 'Noch nicht gespeichert.';
  $('save-status').className = 'small muted';
}

// ---------- Währung ----------

function renderPreview() {
  const s = state.settings;
  fill($('preview'), [amountNode(s, 120), el('span', { class: 'preview-name', text: s.currencyName })]);
  $('values-title').textContent = `${s.currencyName || 'Währung'}: Werte`;
  const watch = Number(s.watchBananas) || 0;
  const example = $('values-example');
  if (watch > 0) {
    const minutes = Number(s.watchIntervalMinutes) || 0;
    fill(example, ['Zuschauer bekommen ', amountNode(s, watch), ` alle ${minutes} ${minutes === 1 ? 'Minute' : 'Minuten'}.`]);
  } else {
    fill(example, ['Die Zuschau-Belohnung ist ausgeschaltet (Wert 0).']);
  }
}

function renderCurrency() {
  const s = state.settings;
  const imageChoices = [{ value: '', label: 'Kein Bild, Emoji verwenden' }];
  const names = new Set(state.images);
  if (s.currencyImage) names.add(s.currencyImage);
  for (const name of [...names].sort()) imageChoices.push({ value: name, label: name });

  fill($('currency-fields'), [
    field({
      path: 'currencyName',
      label: 'Name der Währung',
      value: s.currencyName,
      attrs: { maxlength: 20 },
      hint: 'In der Mehrzahl, z. B. „Kekse“.',
      onChange: (v) => {
        s.currencyName = v;
        renderPreview();
      },
    }),
    field({
      path: 'currencyEmoji',
      label: 'Emoji',
      value: s.currencyEmoji,
      attrs: { maxlength: 8 },
      hint: 'Wird gezeigt, wenn kein Bild gewählt ist.',
      onChange: (v) => {
        s.currencyEmoji = v;
        renderPreview();
      },
    }),
    field({
      path: 'currencyImage',
      label: 'Bild',
      value: s.currencyImage || '',
      choices: imageChoices,
      onChange: (v) => {
        s.currencyImage = v || null;
        renderPreview();
      },
    }),
    field({
      path: 'hubName',
      label: 'Name des Hubs',
      value: s.hubName,
      attrs: { maxlength: 40 },
      onChange: (v) => {
        s.hubName = v;
      },
    }),
  ]);
}

// ---------- Werte ----------

function renderValues() {
  const s = state.settings;
  const number = (path, label, min, max, hint) =>
    field({
      path,
      label,
      value: s[path],
      type: 'number',
      hint,
      attrs: { min, max, step: 1, inputmode: 'numeric' },
      onChange: (v) => {
        s[path] = toNumber(v);
        renderPreview();
      },
    });
  fill($('value-fields'), [
    number('watchBananas', 'Zuschau-Belohnung', 0, 10000, '0 schaltet sie aus.'),
    number('watchIntervalMinutes', 'Intervall in Minuten', 1, 120, 'So lange muss man im Chat sein.'),
    number('checkinBananas', 'Check-in', 0, 10000, 'Einmal pro Tag, nur wenn du live bist.'),
    number('followBonus', 'Follow-Bonus', 0, 100000, 'Einmalig pro Twitch-Account.'),
    number('leaderboardSize', 'Größe der Rangliste', 3, 50, 'So viele Plätze werden angezeigt.'),
  ]);
}

// ---------- Aktionen ----------

function renderActions() {
  const s = state.settings;
  const editors = s.actions.map((action, i) => {
    const base = `actions.${i}`;
    const heading = el('h3', { text: action.name || 'Neue Aktion' });
    const parts = [
      el('div', { class: 'card-head' }, [
        heading,
        el('button', {
          class: 'btn btn-small btn-danger',
          type: 'button',
          text: 'Entfernen',
          on: {
            click: () => {
              s.actions.splice(i, 1);
              markDirty();
              renderActions();
            },
          },
        }),
      ]),
      el('div', { class: 'field-grid' }, [
        field({
          path: `${base}.name`,
          label: 'Name',
          value: action.name,
          attrs: { maxlength: 40 },
          onChange: (v) => {
            action.name = v;
            heading.textContent = v || 'Neue Aktion';
          },
        }),
        field({
          path: `${base}.type`,
          label: 'Typ',
          value: action.type,
          choices: Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label })),
          onChange: (v) => {
            action.type = v;
            if (v === 'vote') action.options = action.options && action.options.length >= 2 ? action.options : ['', ''];
            else delete action.options;
            renderActions();
          },
        }),
        field({
          path: `${base}.description`,
          label: 'Beschreibung',
          value: action.description,
          wide: true,
          attrs: { maxlength: 120 },
          onChange: (v) => {
            action.description = v;
          },
        }),
        field({
          path: `${base}.cost`,
          label: 'Kosten',
          value: action.cost,
          type: 'number',
          attrs: { min: 1, max: 100000, step: 1, inputmode: 'numeric' },
          onChange: (v) => {
            action.cost = toNumber(v);
          },
        }),
        field({
          path: `${base}.cooldownSeconds`,
          label: 'Cooldown in Sekunden',
          value: action.cooldownSeconds,
          type: 'number',
          hint: '0 = ohne Wartezeit.',
          attrs: { min: 0, max: 86400, step: 1, inputmode: 'numeric' },
          onChange: (v) => {
            action.cooldownSeconds = toNumber(v);
          },
        }),
      ]),
    ];

    if (action.type === 'vote') {
      const rows = action.options.map((option, j) => {
        const input = el('input', { type: 'text', maxlength: 40, autocomplete: 'off', 'aria-label': `Option ${j + 1}` });
        input.value = option;
        input.addEventListener('input', () => {
          action.options[j] = input.value;
          markDirty();
        });
        const remove = el('button', {
          class: 'btn btn-small',
          type: 'button',
          text: 'Entfernen',
          on: {
            click: () => {
              action.options.splice(j, 1);
              markDirty();
              renderActions();
            },
          },
        });
        remove.disabled = action.options.length <= 2;
        return el('div', { class: 'option-row' }, [input, remove]);
      });
      const add = el('button', {
        class: 'btn btn-small',
        type: 'button',
        text: 'Option hinzufügen',
        on: {
          click: () => {
            action.options.push('');
            markDirty();
            renderActions();
          },
        },
      });
      add.disabled = action.options.length >= 6;
      parts.push(
        el('div', { class: 'field', 'data-path': `${base}.options` }, [
          el('label', { text: 'Optionen der Abstimmung (2 bis 6)' }),
          el('div', { class: 'option-list' }, rows),
          el('div', { class: 'btn-row' }, [add]),
          el('p', { class: 'error', hidden: true }),
        ]),
      );
    }
    return el('div', { class: 'action-editor' }, parts);
  });
  fill($('action-editors'), editors);
  $('action-add').disabled = s.actions.length >= 20;
}

/** Macht aus einem Namen eine Kennung: Kleinbuchstaben, Ziffern und Bindestriche. */
function slugify(name) {
  const umlauts = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
  let slug = String(name)
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => umlauts[c])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  if (slug.length < 2) slug = 'aktion';
  return slug;
}

/** Baut das Objekt, das an den Server geht. Neue Aktionen bekommen hier einmalig ihre Kennung. */
function buildPayload() {
  const s = state.settings;
  const used = new Set(s.actions.map((a) => a.id).filter(Boolean));
  const actions = s.actions.map((a) => {
    let id = a.id;
    if (!id) {
      const baseId = slugify(a.name);
      id = baseId;
      for (let n = 2; used.has(id); n++) id = `${baseId}-${n}`;
      used.add(id);
    }
    const out = { id, type: a.type, name: a.name, description: a.description, cost: a.cost, cooldownSeconds: a.cooldownSeconds };
    if (a.type === 'vote') out.options = a.options;
    return out;
  });
  return {
    hubName: s.hubName,
    currencyName: s.currencyName,
    currencyEmoji: s.currencyEmoji,
    currencyImage: s.currencyImage,
    checkinBananas: s.checkinBananas,
    followBonus: s.followBonus,
    watchBananas: s.watchBananas,
    watchIntervalMinutes: s.watchIntervalMinutes,
    leaderboardSize: s.leaderboardSize,
    actions,
  };
}

function renderAll() {
  renderCurrency();
  renderValues();
  renderActions();
  renderPreview();
}

async function save() {
  const button = $('save-button');
  const status = $('save-status');
  button.disabled = true;
  clearErrors();
  const result = await request('PUT', '/api/admin/settings', buildPayload());
  if (result.status === 200 && result.data && result.data.settings) {
    state.settings = result.data.settings;
    renderAll();
    status.textContent = '✅ Gespeichert. Die Änderungen gelten ab sofort.';
    status.className = 'small accent';
    return;
  }
  button.disabled = false;
  status.className = 'small error-line';
  if (result.status === 400 && result.data && Array.isArray(result.data.issues)) {
    showIssues(result.data.issues);
    status.textContent = 'Bitte prüfe die markierten Felder.';
  } else if (result.status === 413) {
    status.textContent = 'Die Einstellungen sind zu umfangreich. Bitte kürze Beschreibungen oder entferne eine Aktion.';
  } else if (result.status === 401 || result.status === 403) {
    status.textContent = 'Du bist nicht mehr als Streamer angemeldet. Bitte lade die Seite neu.';
  } else {
    status.textContent = 'Speichern hat nicht geklappt. Bitte versuche es noch einmal.';
  }
}

// ---------- Twitch-Verbindung ----------

function renderTwitch(info) {
  const connected = Boolean(info.streamerAuthorized);
  const reconnect = Boolean(info.streamerNeedsReconnect) && !connected;
  $('twitch-status').className = connected ? 'badge' : reconnect ? 'badge badge-warn' : 'badge badge-off';
  $('twitch-status-text').textContent = connected ? 'Verbunden' : reconnect ? 'Bitte neu verbinden' : 'Nicht verbunden';
  $('twitch-reconnect').hidden = !reconnect;
  $('twitch-connect').textContent = connected || reconnect ? 'Neu verbinden' : 'Kanal verbinden';
  $('twitch-connect').className = connected ? 'btn' : 'btn btn-primary';
  $('twitch-remove').hidden = !connected;
  $('twitch-confirm').hidden = true;
}

async function removeConnection() {
  const result = await request('POST', '/api/admin/streamer/revoke');
  if (result.status === 200) {
    showToast('Die Verbindung wurde entfernt.', 'ok');
    renderTwitch({ streamerAuthorized: false, streamerNeedsReconnect: false });
  } else {
    showToast('Das Entfernen hat nicht geklappt. Bitte versuche es noch einmal.', 'error');
  }
}

// ---------- OBS ----------

function renderOverlay() {
  const o = state.overlay;
  const code = $('overlay-url');
  code.textContent = o && state.overlayShown ? o.url : HIDDEN_URL;
  code.className = state.overlayShown ? 'revealed' : '';
  $('overlay-toggle').textContent = state.overlayShown ? 'Verbergen' : 'Anzeigen';
  if (!o) return;
  for (const id of ['overlay-width', 'step-width']) $(id).textContent = String(o.width);
  for (const id of ['overlay-height', 'step-height']) $(id).textContent = String(o.height);
}

async function copyWithToast(text, what) {
  if (await copyText(text)) showToast(`${what} kopiert.`, 'ok');
  else showToast('Kopieren hat nicht geklappt. Bitte markiere den Text von Hand.', 'error');
}

// ---------- Start ----------

async function load() {
  const [settings, images, overlay] = await Promise.all([
    request('GET', '/api/admin/settings'),
    request('GET', '/api/admin/currency-images'),
    request('GET', '/api/admin/overlay-url'),
  ]);
  if (settings.status !== 200 || !settings.data) {
    $('load-error').hidden = false;
    return;
  }
  state.settings = settings.data.settings;
  state.images = images.status === 200 && images.data ? images.data.images : [];
  state.overlay = overlay.status === 200 ? overlay.data : null;
  document.title = `Admin · ${state.settings.hubName}`;
  renderAll();
  renderTwitch(settings.data);
  renderOverlay();
  $('save-status').textContent = '';
}

$('save-button').addEventListener('click', save);
$('action-add').addEventListener('click', () => {
  state.settings.actions.push({ id: '', type: 'sound', name: '', description: '', cost: 10, cooldownSeconds: 30 });
  markDirty();
  renderActions();
});
$('twitch-remove').addEventListener('click', () => {
  $('twitch-confirm').hidden = false;
});
$('twitch-remove-no').addEventListener('click', () => {
  $('twitch-confirm').hidden = true;
});
$('twitch-remove-yes').addEventListener('click', removeConnection);
$('overlay-toggle').addEventListener('click', () => {
  state.overlayShown = !state.overlayShown;
  renderOverlay();
});
$('overlay-copy').addEventListener('click', () => {
  if (state.overlay) copyWithToast(state.overlay.url, 'Overlay-URL');
});
$('overlay-width-copy').addEventListener('click', () => {
  if (state.overlay) copyWithToast(String(state.overlay.width), 'Breite');
});
$('overlay-height-copy').addEventListener('click', () => {
  if (state.overlay) copyWithToast(String(state.overlay.height), 'Höhe');
});
$('overlay-test').addEventListener('click', async () => {
  const result = await request('POST', '/api/admin/overlay/test');
  $('overlay-test-hint').hidden = result.status !== 200;
  if (result.status !== 200) showToast('Der Test konnte nicht gesendet werden.', 'error');
});

load();
