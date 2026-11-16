// Overlay-Events: verteilt Ereignisse per Server-Sent Events an alle verbundenen OBS-Overlays.
const MAX_CLIENTS = 20;
const PING_MS = 25000;

export function createEvents() {
  const clients = new Set();

  const timer = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, PING_MS);
  timer.unref();

  return {
    /** Verbindet ein Overlay. Gibt false zurück, wenn schon zu viele verbunden sind. */
    subscribe(req, res) {
      if (clients.size >= MAX_CLIENTS) return false;
      res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      });
      res.flushHeaders();
      res.write(': verbunden\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return true;
    },

    /** Schickt ein Event an alle Overlays. Enthält nie Tokens oder IDs, nur Anzeigewerte. */
    publish(event) {
      const line = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of clients) res.write(line);
    },
  };
}
