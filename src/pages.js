// Einfache Hinweis-Seiten vom Server (Login-Fehler, 404, Setup).
// Hier landen nur feste Texte. Werte aus der Anfrage (URL, Formulare) werden nie eingebaut.
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(title, body) {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body class="notice-page">
  <main class="card notice">
${body}
  </main>
</body>
</html>
`;
}

/** Kurze Hinweis-Seite mit Überschrift, Text und einem Link. */
export function messagePage({ title, text, linkHref = '/', linkText = 'Zurück zur Startseite' }) {
  return layout(
    title,
    `    <h1>${escapeHtml(title)}</h1>
    <p class="lead">${escapeHtml(text)}</p>
    <p><a class="btn" href="${escapeHtml(linkHref)}">${escapeHtml(linkText)}</a></p>`,
  );
}

/** Setup-Seite: nennt nur die Namen der fehlenden oder ungültigen Einstellungen, nie ihre Werte. */
export function setupPage(problems) {
  const items = problems
    .map((p) => `      <li><code>${escapeHtml(p.name)}</code> <span class="tag">${escapeHtml(p.kind)}</span></li>`)
    .join('\n');
  return layout(
    'Fast geschafft: Einrichtung fehlt noch',
    `    <div class="badge badge-warn">Einrichtung</div>
    <h1>Fast geschafft!</h1>
    <p class="lead">Deine Seite läuft, aber es fehlen noch Einstellungen. Sobald sie gesetzt sind und die App neu gestartet wurde, erscheint hier dein Hub.</p>
    <ul class="setup-list">
${items}
    </ul>
    <p class="hint">Lokal hilft dir <code>npm run setup</code>. Online trägst du die Werte bei deinem Hoster als Umgebungsvariablen ein. Die Schritt-für-Schritt-Anleitung steht in <code>CHECKLISTE.md</code>.</p>`,
  );
}
