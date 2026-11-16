// Ein Fehler mit festem Statuscode und kurzem Fehlercode für den Browser.
// Der Browser bekommt nur den Code, nie Details aus dem Server.
export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
