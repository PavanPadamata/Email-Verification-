import { useState, useEffect, useRef } from "react";
import "./App.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";

function formatNum(n) { return (n || 0).toLocaleString(); }

function ProgressBar({ pct, color }) {
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function StatPill({ label, value, color }) {
  return (
    <div className="stat-pill" style={{ borderColor: color }}>
      <span className="stat-value" style={{ color }}>{formatNum(value)}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function JobCard({ job, onDownload, onControl }) {
  const pct = job.total > 0 ? (job.processed / job.total) * 100 : 0;
  const isActive = job.status === 'running' || job.status === 'claimed';
  const isPaused = job.status === 'paused';
  const isDone = job.status === 'done' || job.status === 'stopped';
  const barColor = job.status === 'done' ? '#22c55e' : job.status === 'error' ? '#ef4444' : job.status === 'stopped' ? '#6b6b80' : job.status === 'paused' ? '#7c6aff' : '#f59e0b';

  return (
    <div className={`job-card ${job.status}`}>
      <div className="job-header">
        <div className="job-id-wrap">
          <span className="job-id">{job.jobId.slice(0, 8)}</span>
          <span className={`job-badge ${job.status}`}>{job.status}</span>
        </div>
        <span className="job-date">{new Date(job.createdAt).toLocaleString()}</span>
      </div>

      <ProgressBar pct={pct} color={barColor} />
      <div className="job-counts">
        <span>{formatNum(job.processed)} / {formatNum(job.total)}</span>
        {isActive && <span className="pulse-dot" />}
        {isPaused && <span className="paused-label">paused</span>}
      </div>

      <div className="stats-row">
        <StatPill label="Valid" value={job.valid} color="#22c55e" />
        <StatPill label="Invalid" value={job.invalid} color="#ef4444" />
        <StatPill label="Risky" value={job.risky} color="#f59e0b" />
      </div>

      {(isActive || isPaused) && (
        <div className="control-row">
          {isPaused ? (
            <button className="ctrl-btn resume" onClick={() => onControl(job.jobId, 'resume')}>▶ Resume</button>
          ) : (
            <button className="ctrl-btn pause" onClick={() => onControl(job.jobId, 'pause')}>⏸ Pause</button>
          )}
          <button className="ctrl-btn stop" onClick={() => onControl(job.jobId, 'stop')}>⏹ Stop</button>
        </div>
      )}

      {(isDone || isPaused) && (
        <div className="download-row">
          {['valid', 'invalid', 'risky'].map(t => (
            <button key={t} className={`dl-btn ${t}`} onClick={() => onDownload(job.jobId, t)}>
              ↓ {t}.csv
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef();

  async function loadJobs() {
    try {
      const r = await fetch(`${API}/jobs`);
      setJobs(await r.json());
    } catch {}
  }

  useEffect(() => {
    loadJobs();
    const t = setInterval(loadJobs, 3000);
    return () => clearInterval(t);
  }, []);

  async function uploadFile(file) {
    if (!file) return;
    if (!file.name.endsWith('.csv')) { setError('CSV files only'); return; }
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`${API}/upload`, { method: 'POST', body: fd });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      await loadJobs();
    } catch (e) { setError(e.message); }
    finally { setUploading(false); }
  }

  async function onControl(jobId, action) {
    try {
      await fetch(`${API}/control/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      await loadJobs();
    } catch (e) { setError(e.message); }
  }

  function onDrop(e) {
    e.preventDefault(); setDragging(false);
    uploadFile(e.dataTransfer.files[0]);
  }

  function onDownload(jobId, type) {
    window.open(`${API}/download/${jobId}/${type}`, '_blank');
  }

  const activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'claimed');

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <span className="logo-icon">✦</span>
          <span className="logo-text">MailCheck</span>
        </div>
        <div className="header-sub">Bulk Email Verification</div>
      </header>

      <main className="main">
        <div
          className={`dropzone ${dragging ? 'drag-over' : ''} ${uploading ? 'uploading' : ''}`}
          onClick={() => !uploading && fileRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }}
            onChange={e => uploadFile(e.target.files[0])} />
          {uploading ? (
            <div className="dz-content"><div className="spinner" /><p>Uploading…</p></div>
          ) : (
            <div className="dz-content">
              <div className="dz-icon">⬆</div>
              <p className="dz-title">Drop CSV here or click to browse</p>
              <p className="dz-sub">Listmonk format (email,name) or plain emails. Duplicates removed.</p>
            </div>
          )}
        </div>

        {error && <div className="error-banner">{error}</div>}

        {activeJobs.length > 0 && (
          <div className="active-notice">
            <span className="pulse-dot" /> {activeJobs.length} job{activeJobs.length > 1 ? 's' : ''} processing
          </div>
        )}

        {jobs.length > 0 && (
          <section className="jobs-section">
            <h2 className="section-title">Jobs</h2>
            <div className="jobs-grid">
              {jobs.map(job => (
                <JobCard key={job.jobId} job={job} onDownload={onDownload} onControl={onControl} />
              ))}
            </div>
          </section>
        )}

        {jobs.length === 0 && (
          <div className="empty-state"><p>No jobs yet. Upload a CSV to get started.</p></div>
        )}
      </main>
    </div>
  );
}
