const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const JOBS_DIR = process.env.JOBS_DIR || '/jobs';

app.use(cors());
app.use(express.json());

const upload = multer({ dest: '/tmp/uploads/' });

function ensureJobDir(jobId) {
  const dir = path.join(JOBS_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Parse CSV — supports:
//   plain:        email@example.com
//   listmonk:     email,name  (or name,email)
//   with header:  skips header row
function parseEmails(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const emailMap = new Map(); // email -> name

  for (const line of lines) {
    if (line.includes(',')) {
      const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, ''));
      // detect which column is email
      const emailIdx = parts[0].includes('@') ? 0 : parts[1] && parts[1].includes('@') ? 1 : -1;
      if (emailIdx === -1) continue; // skip header or non-email rows
      const email = parts[emailIdx].toLowerCase();
      const name = emailIdx === 0 ? (parts[1] || '') : (parts[0] || '');
      if (!emailMap.has(email)) emailMap.set(email, name);
    } else if (line.includes('@')) {
      const email = line.toLowerCase();
      if (!emailMap.has(email)) emailMap.set(email, '');
    }
  }
  return emailMap;
}

// POST /upload
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const jobId = uuidv4();
  const jobDir = ensureJobDir(jobId);
  const inputPath = path.join(jobDir, 'input.csv');

  const content = fs.readFileSync(req.file.path, 'utf8');
  fs.unlinkSync(req.file.path);

  const emailMap = parseEmails(content);

  if (emailMap.size === 0) return res.status(400).json({ error: 'No valid emails found in file' });

  // Store as listmonk format: email,name
  const csvLines = ['email,name', ...Array.from(emailMap.entries()).map(([e, n]) => `${e},${n}`)];
  fs.writeFileSync(inputPath, csvLines.join('\n'));

  const meta = {
    jobId,
    status: 'pending',
    total: emailMap.size,
    processed: 0,
    valid: 0,
    invalid: 0,
    risky: 0,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(jobDir, 'results.json'), JSON.stringify(meta, null, 2));

  res.json({ jobId, total: emailMap.size });
});

// GET /status/:jobId
app.get('/status/:jobId', (req, res) => {
  const metaPath = path.join(JOBS_DIR, req.params.jobId, 'results.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'Job not found' });
  res.json(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
});

// GET /download/:jobId/:type
app.get('/download/:jobId/:type', (req, res) => {
  const { jobId, type } = req.params;
  if (!['valid', 'invalid', 'risky'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const filePath = path.join(JOBS_DIR, jobId, `${type}.csv`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not ready' });
  res.download(filePath, `${type}.csv`);
});

// GET /jobs
app.get('/jobs', (req, res) => {
  if (!fs.existsSync(JOBS_DIR)) return res.json([]);
  const jobs = fs.readdirSync(JOBS_DIR)
    .map(id => {
      try {
        return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, id, 'results.json'), 'utf8'));
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20);
  res.json(jobs);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend on :${PORT}`));
