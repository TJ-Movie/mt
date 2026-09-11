import { spawnSync } from 'node:child_process';
const credential = spawnSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true,
});
const token = credential.stdout?.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9);
if (!token) throw new Error('GitHub Git authentication unavailable');
const base = 'https://api.github.com/repos/TJ-Movie/mt';
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const mode = process.argv[2];
const requestedRun = process.argv.find((arg) => arg.startsWith('--run-id='))?.slice(9);
const path = mode === 'dispatch' ? '/actions/workflows/magnet-to-r2.yml/dispatches' : (requestedRun ? `/actions/runs/${requestedRun}` : '/actions/workflows/magnet-to-r2.yml/runs?per_page=3');
const requestedQuality = process.argv.find((arg) => arg.startsWith('--quality='))?.slice(10);
const response = await fetch(base + path, { headers, ...(mode === 'dispatch' ? { method: 'POST', body: JSON.stringify({ ref: 'main', ...(requestedQuality ? { inputs: { quality: requestedQuality } } : {}) }) } : {}) });
if (!response.ok) { console.error(`GitHub API HTTP ${response.status}`); process.exit(1); }
if (mode === 'dispatch') console.log('Workflow dispatch accepted');
else {
  const data = await response.json();
  for (const run of (requestedRun ? [data] : data.workflow_runs.slice(0, 1))) {
    console.log(JSON.stringify({ id: run.id, status: run.status, conclusion: run.conclusion, url: run.html_url }));
    const jobs = await fetch(`${base}/actions/runs/${run.id}/jobs`, { headers });
    const details = await jobs.json();
    console.log(JSON.stringify(details.jobs?.map(job => ({ id: job.id, status: job.status, conclusion: job.conclusion, steps: job.steps?.map(s => ({ name: s.name, status: s.status, conclusion: s.conclusion })) }))));
    if (run.conclusion === 'failure') {
      for (const job of details.jobs || []) {
        const log = await fetch(`${base}/actions/jobs/${job.id}/logs`, { headers });
        if (log.ok) {
          const lines = (await log.text()).split('\n');
          const start = lines.findIndex(line => line.includes('D1 access failed:'));
          if (start >= 0) console.log(lines.slice(start, start + 28).join('\n').replaceAll(token, '[redacted]'));
        }
      }
    }
  }
}
