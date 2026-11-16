// Kleiner Logger. Regel: Hier landen nie Tokens, Secrets, Cookies oder URLs mit Query-Teil.
// Als zweite Sicherung werden bekannte geheime Werte vor der Ausgabe unkenntlich gemacht.
let secrets = [];

export function setLogSecrets(values) {
  secrets = values.filter(Boolean);
}

function scrub(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('[geheim]');
  return out;
}

function write(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${scrub(message)}`;
  if (level === 'FEHLER') console.error(line);
  else console.log(line);
}

/** Beschreibt einen Fehler knapp, ohne Stacktrace und ohne lange Details. */
export function describeError(err) {
  if (!err) return 'unbekannter Fehler';
  const name = err.name || 'Error';
  const code = err.code ? ` ${err.code}` : '';
  const message = typeof err.message === 'string' ? `: ${err.message.replace(/\s+/g, ' ').slice(0, 200)}` : '';
  return `${name}${code}${message}`;
}

export const log = {
  info: (message) => write('INFO', message),
  warn: (message) => write('WARNUNG', message),
  error: (message, err) => write('FEHLER', err ? `${message} (${describeError(err)})` : message),
};
