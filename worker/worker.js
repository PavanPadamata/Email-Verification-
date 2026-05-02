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
const CLI_BIN = process.env.CLI_BIN || 'check-if-email-exists';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readMeta(jobDir) {
  return JSON.parse(fs.readFileSync(path.join(jobDir, 'results.json'), 'utf8'));
}

function writeMeta(jobDir, meta) {
  fs.writeFileSync(path.join(jobDir, 'results.json'), JSON.stringify(meta, null, 2));
}

function classify(result) {
  if (!result || result.error) return 'risky';
  const misc = result.misc || {};
  const smtp = result.smtp || {};
  const mx = result.mx || {};

  if (misc.is_disposable) return 'invalid';
  if (!mx.accepts_mail) return 'invalid';
  if (smtp.is_deliverable === true) return 'valid';
  if (smtp.is_deliverable === false) return 'invalid';
  if (smtp.can_connect_smtp === false) return 'risky';
  if (misc.is_catch_all) return 'risky';
  return 'risky';
}

function runCLI(email, proxyUrl, attempt = 0) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (proxyUrl) env.ALL_PROXY = proxyUrl;

    const cmd = `${CLI_BIN} --output-format json ${email}`;
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

  const result = await runCLI(email, proxyUrl, attempt);

  if (result.error) {
    if (proxyUrl) proxyPool.fail(proxyUrl);
    if (attempt < MAX_RETRIES) {
      await sleep(1000 * (attempt + 1));
      return verifyEmail(email, attempt + 1);
    }
    return { email, classification: 'risky', error: result.error };
  }

  if (proxyUrl) proxyPool.success(proxyUrl);

  const classification = classify(result);
  return { email, classification, result };
}

async function processJob(jobId) {
  const jobDir = path.join(JOBS_DIR, jobId);
  const meta = readMeta(jobDir);

  meta.status = 'running';
  meta.startedAt = new Date().toISOString();
  writeMeta(jobDir, meta);

  const emails = fs.readFileSync(path.join(jobDir, 'input.csv'), 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean);

  const validOut = fs.createWriteStream(path.join(jobDir, 'valid.csv'));
  const invalidOut = fs.createWriteStream(path.join(jobDir, 'invalid.csv'));
  const riskyOut = fs.createWriteStream(path.join(jobDir, 'risky.csv'));

  // Write headers
  [validOut, invalidOut, riskyOut].forEach(s => s.write('email\n'));

  const limit = pLimit(CONCURRENCY);
  let processed = 0, valid = 0, invalid = 0, risky = 0;

  const tasks = emails.map(email => limit(async () => {
    await sleep(DELAY_MS);
    const res = await verifyEmail(email);

    if (res.classification === 'valid') { validOut.write(`${email}\n`); valid++; }
    else if (res.classification === 'invalid') { invalidOut.write(`${email}\n`); invalid++; }
    else { riskyOut.write(`${email}\n`); risky++; }

    processed++;
    // Debounce writes: every 10 or last
    if (processed % 10 === 0 || processed === emails.length) {
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
          // Atomically claim
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
