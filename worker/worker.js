const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const pLimit = require('p-limit');
const proxyPool = require('./proxy-pool');

const JOBS_DIR = process.env.JOBS_DIR || '/jobs';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5');
const DELAY_MS = parseInt(process.env.DELAY_MS || '500');
const MAX_RETRIES = 2;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '30000');
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5000');
const CLI_BIN = process.env.CLI_BIN || 'check_if_email_exists';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readMeta(jobDir) {
  return JSON.parse(fs.readFileSync(path.join(jobDir, 'results.json'), 'utf8'));
}

function writeMeta(jobDir, meta) {
  fs.writeFileSync(path.join(jobDir, 'results.json'), JSON.stringify(meta, null, 2));
}

// Known catch-all providers: SMTP verification blocked, assume valid if MX exists
const CATCH_ALL_DOMAINS = new Set([
  'gmail.com','googlemail.com',
  'yahoo.com','yahoo.co.uk','yahoo.co.in','yahoo.fr','yahoo.de','yahoo.es',
  'hotmail.com','hotmail.co.uk','hotmail.fr','hotmail.de',
  'outlook.com','outlook.co.uk','outlook.fr','outlook.de',
  'live.com','live.co.uk','live.fr',
  'icloud.com','me.com','mac.com',
  'protonmail.com','proton.me',
  'aol.com','msn.com','yandex.com','yandex.ru','mail.ru',
]);

function classify(result, email) {
  if (!result || result.error) return 'risky';
  const misc = result.misc || {};
  const smtp = result.smtp || {};
  const mx = result.mx || {};
  const domain = (email || '').split('@')[1]?.toLowerCase();

  if (misc.is_disposable) return 'invalid';
  if (!mx.accepts_mail) return 'invalid';

  // Known catch-all providers: SMTP unreliable, trust MX existence
  if (CATCH_ALL_DOMAINS.has(domain)) return 'valid';

  // New CLI uses top-level is_reachable: safe | invalid | risky
  if (result.is_reachable === 'safe') return 'valid';
  if (result.is_reachable === 'invalid') return 'invalid';

  // Fallback to smtp fields
  if (smtp.is_deliverable === true) return 'valid';
  if (smtp.is_deliverable === false) return 'invalid';
  if (smtp.can_connect_smtp === false) return 'risky';
  if (smtp.is_catch_all) return 'valid';
  return 'risky';
}

function runCLI(email, proxyUrl) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (proxyUrl) env.ALL_PROXY = proxyUrl;
    const cmd = `${CLI_BIN} ${email}`;
    const child = exec(cmd, { env, timeout: TIMEOUT_MS }, (err, stdout) => {
      if (err) { resolve({ error: err.message }); return; }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({ error: 'parse_error', raw: stdout.trim() });
      }
    });
    child.on('error', (e) => resolve({ error: e.message }));
  });
}

async function verifyEmail(email, attempt = 0) {
  const proxy = proxyPool.get();
  const proxyUrl = proxy ? proxy.url : null;

  const result = await runCLI(email, proxyUrl);

  if (result.error) {
    if (proxyUrl) proxyPool.fail(proxyUrl);
    if (attempt < MAX_RETRIES) {
      await sleep(1000 * (attempt + 1));
      return verifyEmail(email, attempt + 1);
    }
    return { email, classification: 'risky', error: result.error };
  }

  if (proxyUrl) proxyPool.success(proxyUrl);
  const classification = classify(result, email);
  return { email, classification, result };
}

async function processJob(jobId) {
  const jobDir = path.join(JOBS_DIR, jobId);
  const meta = readMeta(jobDir);

  meta.status = 'running';
  meta.startedAt = new Date().toISOString();
  writeMeta(jobDir, meta);

  // Parse listmonk format: email,name (skip header row)
  const lines = fs.readFileSync(path.join(jobDir, 'input.csv'), 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean);

  const emailRows = lines
    .filter(l => l.includes('@'))
    .map(l => {
      const parts = l.split(',').map(p => p.trim());
      return { email: parts[0].toLowerCase(), name: parts[1] || '' };
    });

  const validOut = fs.createWriteStream(path.join(jobDir, 'valid.csv'));
  const invalidOut = fs.createWriteStream(path.join(jobDir, 'invalid.csv'));
  const riskyOut = fs.createWriteStream(path.join(jobDir, 'risky.csv'));

  // Write listmonk format headers
  [validOut, invalidOut, riskyOut].forEach(s => s.write('email,name\n'));

  const limit = pLimit(CONCURRENCY);
  let processed = 0, valid = 0, invalid = 0, risky = 0;

  const tasks = emailRows.map(({ email, name }) => limit(async () => {
    await sleep(DELAY_MS);
    const res = await verifyEmail(email);
    const row = `${email},${name}\n`;

    if (res.classification === 'valid') { validOut.write(row); valid++; }
    else if (res.classification === 'invalid') { invalidOut.write(row); invalid++; }
    else { riskyOut.write(row); risky++; }

    processed++;
    if (processed % 10 === 0 || processed === emailRows.length) {
      const m = readMeta(jobDir);
      m.processed = processed; m.valid = valid; m.invalid = invalid; m.risky = risky;
      writeMeta(jobDir, m);
    }
  }));

  await Promise.all(tasks);
  [validOut, invalidOut, riskyOut].forEach(s => s.end());

  const finalMeta = readMeta(jobDir);
  finalMeta.status = 'done';
  finalMeta.processed = processed;
  finalMeta.valid = valid;
  finalMeta.invalid = invalid;
  finalMeta.risky = risky;
  finalMeta.finishedAt = new Date().toISOString();
  writeMeta(jobDir, finalMeta);

  console.log(`[worker] Job ${jobId} done: ${valid}v ${invalid}i ${risky}r`);
}

async function pollForJobs() {
  if (!fs.existsSync(JOBS_DIR)) { fs.mkdirSync(JOBS_DIR, { recursive: true }); }

  while (true) {
    const dirs = fs.readdirSync(JOBS_DIR);
    for (const jobId of dirs) {
      const metaPath = path.join(JOBS_DIR, jobId, 'results.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.status === 'pending') {
          meta.status = 'claimed';
          writeMeta(path.join(JOBS_DIR, jobId), meta);
          console.log(`[worker] Claiming job ${jobId}`);
          processJob(jobId).catch(err => {
            console.error(`[worker] Job ${jobId} failed:`, err);
            const m = readMeta(path.join(JOBS_DIR, jobId));
            m.status = 'error'; m.error = err.message;
            writeMeta(path.join(JOBS_DIR, jobId), m);
          });
        }
      } catch (e) { /* skip */ }
    }
    await sleep(POLL_INTERVAL);
  }
}

pollForJobs();
