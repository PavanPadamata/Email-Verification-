// proxy-pool.js
// Proxy list from env: PROXIES=socks5://u:p@host:port,socks5://u2:p2@host2:port2
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 min

class ProxyPool {
  constructor() {
    const raw = process.env.PROXIES || '';
    this.proxies = raw.split(',').map(p => p.trim()).filter(Boolean).map(url => ({
      url,
      failures: 0,
      disabledUntil: null,
    }));
    this.index = 0;
  }

  get() {
    if (this.proxies.length === 0) return null;
    const now = Date.now();
    // Re-enable cooled-down proxies
    this.proxies.forEach(p => {
      if (p.disabledUntil && now > p.disabledUntil) {
        p.failures = 0;
        p.disabledUntil = null;
      }
    });
    const available = this.proxies.filter(p => !p.disabledUntil);
    if (available.length === 0) return null;
    const proxy = available[this.index % available.length];
    this.index++;
    return proxy;
  }

  fail(proxyUrl) {
    const p = this.proxies.find(x => x.url === proxyUrl);
    if (!p) return;
    p.failures++;
    if (p.failures >= FAILURE_THRESHOLD) {
      p.disabledUntil = Date.now() + COOLDOWN_MS;
      console.warn(`[proxy] Disabled ${proxyUrl} for ${COOLDOWN_MS / 1000}s`);
    }
  }

  success(proxyUrl) {
    const p = this.proxies.find(x => x.url === proxyUrl);
    if (p) p.failures = 0;
  }
}

module.exports = new ProxyPool();
