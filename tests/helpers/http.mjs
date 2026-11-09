/**
 * Raw HTTP helpers (node:http) for security tests that need control over
 * headers, partial bodies and aborted sockets — things fetch() normalizes.
 */
import http from 'node:http';
import net from 'node:net';

export function rawRequest({
  port,
  method = 'GET',
  path = '/',
  headers = {},
  body,
  timeoutMs = 10000,
  host = '127.0.0.1',
}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        method,
        path,
        // Explicit Host header: http.request(setHost:false) otherwise sends none,
        // which the bridge rejects as a non-loopback host before auth runs.
        headers: { host: `127.0.0.1:${port}`, ...headers },
        agent: false,
        setHost: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`raw request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Open a request, write `firstChunk`, wait `delayMs`, then write `secondChunk`
 * and end. Used to prove the server survives a slow/trickling client.
 */
export function slowRequest({
  port,
  method = 'POST',
  path = '/',
  headers = {},
  firstChunk,
  secondChunk,
  delayMs = 400,
  timeoutMs = 10000,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let responded = false;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        responded = true;
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          settled = true;
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('slow request timeout')), timeoutMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      if (!settled && !responded) {
        settled = true;
        reject(error);
      }
    });
    try {
      req.write(firstChunk);
    } catch (error) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
    setTimeout(() => {
      try {
        if (secondChunk !== undefined) req.write(secondChunk);
        req.end();
      } catch {
        /* the server already answered and closed the socket */
      }
    }, delayMs);
    void responded;
  });
}

/** Try to connect and immediately GET; resolves true when a TCP connection opens. */
export function tcpReachable(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}
