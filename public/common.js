// Gemeinsame Helfer für Startseite und Admin-Seite.
// Regel: Elemente werden mit createElement gebaut, Texte immer per textContent gesetzt.

/** Baut ein Element. options: class, text, on: { ereignis: funktion }, alles andere wird als Attribut gesetzt. */
export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'on') for (const [name, fn] of Object.entries(value)) node.addEventListener(name, fn);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child !== undefined && child !== null && child !== false) node.append(child);
  }
  return node;
}

/** Leert ein Element und setzt neue Kinder ein. */
export function fill(node, children = []) {
  node.replaceChildren(...[].concat(children).filter((c) => c !== undefined && c !== null && c !== false));
  return node;
}

const numberFormat = new Intl.NumberFormat('de-DE');
export const formatNumber = (n) => numberFormat.format(Number(n) || 0);

/** Anfrage an die eigene API. Gibt immer { status, data, retryAfter } zurück, auch bei Netzwerkfehlern. */
export async function request(method, path, body) {
  const options = { method, headers: { accept: 'application/json' }, credentials: 'same-origin' };
  if (method !== 'GET') {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body === undefined ? {} : body);
  }
  try {
    const res = await fetch(path, options);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data, retryAfter: Number(res.headers.get('retry-after')) || 0 };
  } catch {
    return { status: 0, data: null, retryAfter: 0 };
  }
}

/** Das Zeichen der Währung: das eingestellte Bild oder, ohne Bild, das Emoji. */
export function currencyNode(currency) {
  if (currency.currencyImage) {
    return el('img', {
      class: 'currency-img',
      src: `/waehrung/${encodeURIComponent(currency.currencyImage)}`,
      alt: currency.currencyName,
    });
  }
  return el('span', { class: 'currency-emoji', text: currency.currencyEmoji });
}

/** Eine Menge mit Währungszeichen dahinter, z. B. „120 ⭐“. */
export function amountNode(currency, value, prefix = '') {
  return el('span', { class: 'amount' }, [el('span', { text: `${prefix}${formatNumber(value)}` }), currencyNode(currency)]);
}

/** Sekunden als kurzer Text: „30 Sek.“, „2 Min.“, „1 Std.“ */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} Sek.`;
  if (s < 3600) return `${Math.ceil(s / 60)} Min.`;
  return `${Math.ceil(s / 3600)} Std.`;
}

let toastTimer = null;
/** Kurze Meldung unten auf der Seite. kind: 'ok', 'error' oder leer. */
export function showToast(text, kind = '') {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = text;
  node.className = `toast${kind ? ` toast-${kind}` : ''}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 5000);
}

/** Text in die Zwischenablage kopieren. Gibt true zurück, wenn es geklappt hat. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
