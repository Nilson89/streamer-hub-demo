// OBS-Overlay: empfängt Ereignisse vom Server und zeigt sie an.
// Namen und Texte werden ausschließlich per textContent eingesetzt.
const key = new URLSearchParams(window.location.search).get('key') || '';
const query = `?key=${encodeURIComponent(key)}`;

const $ = (id) => document.getElementById(id);
const alerts = $('alerts');
const rainLayer = $('rain-layer');
const votePanel = $('vote-panel');

let currency = { currencyName: '', currencyEmoji: '⭐', currencyImage: null, followBonus: 0 };
let voteTimer = null;
let audio = null;

let currencyLoadedAt = 0;

/** Holt die Währung vom Server, höchstens alle 20 Sekunden (außer mit force). */
async function loadCurrency(force = false) {
  if (force !== true && Date.now() - currencyLoadedAt < 20000) return;
  currencyLoadedAt = Date.now();
  try {
    const res = await fetch(`/overlay/config${query}`, { credentials: 'same-origin' });
    if (res.ok) currency = { ...currency, ...(await res.json()) };
  } catch {
    /* beim nächsten Versuch klappt es wieder */
  }
}

/** Das Zeichen der Währung: Bild, falls gesetzt, sonst das Emoji. */
function mark(className) {
  if (currency.currencyImage) {
    const img = document.createElement('img');
    img.className = className;
    img.src = `/waehrung/${encodeURIComponent(currency.currencyImage)}`;
    img.alt = '';
    return img;
  }
  const span = document.createElement('span');
  span.className = className;
  span.textContent = currency.currencyEmoji;
  return span;
}

function textSpan(text, className) {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.textContent = text;
  return span;
}

/** Einblendung unten mittig. parts: Texte oder fertige Elemente. */
function showAlert(parts, { icon = true, ms = 5000 } = {}) {
  const box = document.createElement('div');
  box.className = 'alert';
  if (icon) box.append(mark('mark'));
  const text = document.createElement('span');
  text.className = 'alert-text';
  for (const part of parts) text.append(typeof part === 'string' ? document.createTextNode(part) : part);
  box.append(text);
  alerts.append(box);
  while (alerts.children.length > 3) alerts.firstElementChild.remove();
  setTimeout(() => {
    box.classList.add('leaving');
    setTimeout(() => box.remove(), 450);
  }, ms);
}

/** Regen mit der Währung über das ganze Bild. */
function rain(count, seconds) {
  for (let i = 0; i < count; i++) {
    const drop = mark('drop');
    const duration = seconds * (0.55 + Math.random() * 0.45);
    drop.style.left = `${Math.random() * 100}%`;
    drop.style.animationDuration = `${duration}s`;
    drop.style.animationDelay = `${Math.random() * (seconds - duration)}s`;
    if (!currency.currencyImage) drop.style.fontSize = `${48 + Math.random() * 56}px`;
    rainLayer.append(drop);
    setTimeout(() => drop.remove(), seconds * 1000 + 400);
  }
}

/** Kurzer „Plopp“, erzeugt mit der Web Audio API (keine Audiodatei nötig). */
function plop() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const now = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(680, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.16);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.6, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain).connect(audio.destination);
    osc.start(now);
    osc.stop(now + 0.25);
  } catch {
    /* ohne Ton weitermachen */
  }
}

function showVote(event) {
  const options = Array.isArray(event.options) ? event.options : [];
  const total = options.reduce((sum, o) => sum + (Number(o.votes) || 0), 0);
  const list = $('vote-list');
  list.replaceChildren(
    ...options.map((o) => {
      const votes = Number(o.votes) || 0;
      const line = document.createElement('div');
      line.className = 'vote-item-line';
      line.append(textSpan(String(o.option)), textSpan(String(votes)));
      const fillBar = document.createElement('div');
      fillBar.className = 'vote-fill';
      fillBar.style.width = `${total > 0 ? Math.round((votes / total) * 100) : 0}%`;
      const track = document.createElement('div');
      track.className = 'vote-track';
      track.append(fillBar);
      const item = document.createElement('div');
      item.append(line, track);
      return item;
    }),
  );
  votePanel.hidden = false;
  // Verschwindet nach 15 Sekunden ohne neue Stimme.
  clearTimeout(voteTimer);
  voteTimer = setTimeout(() => {
    votePanel.hidden = true;
  }, 15000);
}

function handle(event) {
  if (!event || typeof event !== 'object') return;
  const name = textSpan(String(event.displayName || 'Jemand'), 'alert-name');
  switch (event.type) {
    case 'redeem':
      if (event.actionType === 'sound') {
        plop();
        showAlert([name, ' hat einen Sound ausgelöst'], { icon: false });
      } else if (event.actionType === 'rain') {
        rain(70, 4);
        showAlert([name, ` lässt ${currency.currencyName} regnen`]);
      } else if (event.actionType === 'vote') {
        $('vote-heading').textContent = String(event.actionName || 'Abstimmung');
        showAlert([name, ' stimmt für ', textSpan(String(event.option || ''))], { icon: false, ms: 3500 });
      }
      break;
    case 'vote':
      showVote(event);
      break;
    case 'follow': {
      const amount = textSpan(`+${Number(event.amount) || 0} `);
      const sign = mark(currency.currencyImage ? 'amount-img' : '');
      showAlert([name, ' folgt jetzt, ', amount, sign], { icon: false });
      break;
    }
    case 'test':
      rain(30, 3);
      showAlert(['✅ Overlay funktioniert!']);
      break;
    default:
      break;
  }
}

async function start() {
  await loadCurrency(true);
  const source = new EventSource(`/overlay/events${query}`);
  // Nach jeder (Neu-)Verbindung die Währung frisch laden, falls sie geändert wurde.
  source.addEventListener('open', () => loadCurrency(true));
  source.addEventListener('message', async (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    await loadCurrency();
    handle(event);
  });
}

start();
