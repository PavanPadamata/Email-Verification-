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

// POST /upload
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const jobId = uuidv4();
  const jobDir = ensureJobDir(jobId);
  const inputPath = path.join(jobDir, 'input.csv');

  fs.renameSync(req.file.path, inputPath);

  const emails = fs.readFileSync(inputPath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && l.includes('@'));

  // Deduplicate
  const unique = [...new Set(emails)];
  fs.writeFileSync(inputPath, unique.join('\n'));

  const meta = {
    jobId,
    status: 'pending',
    total: unique.length,
    processed: 0,
    valid: 0,
    invalid: 0,
    risky: 0,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(jobDir, 'results.json'), JSON.stringify(meta, null, 2));

  res.json({ jobId, total: unique.length });
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

// GET /jobs — list recent jobs
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
