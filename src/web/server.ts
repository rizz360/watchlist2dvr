import express from "express"
import type { DvrAdapter } from "../dvr/index.js"
import type { HistoryStore } from "../state/history.js"

export interface WebDeps {
  dvr: DvrAdapter
  history: HistoryStore
}

export function startWebServer(deps: WebDeps, port: number): void {
  const app = express()

  app.get("/api/status", (_req, res) => {
    deps.history
      .getLastRun()
      .then((last) => {
        res.json({
          service: "watchlist2dvr",
          lastRun: last
            ? { at: last.completedAt, scheduled: last.scheduled, matched: last.matchesFound }
            : null,
        })
      })
      .catch((err: Error) => res.status(500).json({ error: err.message }))
  })

  app.get("/api/history", (_req, res) => {
    deps.history
      .getRuns(50)
      .then((runs) => res.json(runs))
      .catch((err: Error) => res.status(500).json({ error: err.message }))
  })

  app.get("/api/upcoming", (_req, res) => {
    deps.dvr
      .getScheduledEntries()
      .then((entries) => {
        const upcoming = entries
          .filter((e) => e.status === "scheduled" || e.status === "recording")
          .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
        res.json(upcoming)
      })
      .catch((err: Error) => res.status(503).json({ error: err.message }))
  })

  app.get("/api/watchlist", (_req, res) => {
    deps.history
      .getLastRun()
      .then((last) => {
        if (!last) {
          res.json({ matches: [], ambiguous: [], unmatched: [] })
          return
        }
        res.json({
          matches: last.matches,
          ambiguous: last.ambiguousItems,
          unmatched: last.unmatchedItems,
        })
      })
      .catch((err: Error) => res.status(500).json({ error: err.message }))
  })

  app.get("*", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.send(dashboardHtml())
  })

  app.listen(port, () => {
    console.log(`[web] Dashboard available at http://localhost:${port}`)
  })
}

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>watchlist2dvr</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f1a;color:#e0e0f0;min-height:100vh}
header{padding:1.2rem 2rem;border-bottom:1px solid #2a2a4a;display:flex;align-items:center;justify-content:space-between;background:#13132a}
header h1{font-size:1.3rem;font-weight:600;color:#a78bfa;letter-spacing:-.5px}
.last-run{font-size:.82rem;color:#6b6b8a}
nav{padding:0 2rem;border-bottom:1px solid #2a2a4a;background:#13132a;display:flex;gap:0}
nav button{background:none;border:none;color:#8888aa;padding:.85rem 1.4rem;cursor:pointer;font-size:.88rem;border-bottom:2px solid transparent;transition:color .15s,border-color .15s}
nav button:hover{color:#c0c0e0}
nav button.active{color:#a78bfa;border-bottom-color:#a78bfa}
main{padding:2rem;max-width:1280px}
.tab{display:none}
.tab.active{display:block}
.stat-row{display:flex;gap:1rem;margin-bottom:1.75rem;flex-wrap:wrap}
.stat-card{background:#1a1a30;border:1px solid #2a2a4a;border-radius:8px;padding:.9rem 1.4rem;min-width:130px}
.stat-card .lbl{font-size:.72rem;color:#6b6b8a;text-transform:uppercase;letter-spacing:.05em}
.stat-card .val{font-size:1.9rem;font-weight:700;color:#a78bfa;margin-top:.2rem}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th{text-align:left;padding:.65rem 1rem;color:#6b6b8a;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #2a2a4a}
td{padding:.75rem 1rem;border-bottom:1px solid #1e1e38;color:#c0c0e0;vertical-align:middle}
tr:hover td{background:#1a1a30}
.badge{display:inline-block;padding:.18rem .55rem;border-radius:999px;font-size:.72rem;font-weight:500}
.badge-exact,.badge-scheduled{background:#1e3a5f;color:#60a5fa}
.badge-recording{background:#14532d;color:#4ade80}
.badge-fuzzy{background:#713f12;color:#fbbf24}
.badge-failed{background:#3b1414;color:#f87171}
.badge-ambiguous{background:#2a2a1a;color:#fbbf24}
.sec{font-size:.8rem;font-weight:600;color:#8888aa;text-transform:uppercase;letter-spacing:.08em;margin:1.5rem 0 .6rem}
.empty{color:#4a4a6a;font-size:.88rem;padding:2.5rem 0;text-align:center}
.run-card{background:#1a1a30;border:1px solid #2a2a4a;border-radius:6px;padding:.9rem 1.4rem;margin-bottom:.6rem}
.run-time{font-size:.78rem;color:#6b6b8a;margin-bottom:.45rem}
.run-stats{display:flex;gap:1.4rem;flex-wrap:wrap}
.run-stat{font-size:.82rem}.run-stat span{color:#a78bfa;font-weight:600}
.run-errors{margin-top:.5rem;color:#f87171;font-size:.78rem}
a{color:#818cf8;text-decoration:none}
a:hover{text-decoration:underline}
.err-box{color:#f87171;font-size:.85rem;padding:1rem;background:#2a1a1a;border-radius:6px;margin:.5rem 0}
</style>
</head>
<body>
<header>
  <h1>&#128250; watchlist2dvr</h1>
  <div class="last-run" id="last-run-info">Loading&hellip;</div>
</header>
<nav>
  <button class="active" onclick="showTab('watchlist',this)">Watchlist</button>
  <button onclick="showTab('upcoming',this)">Upcoming</button>
  <button onclick="showTab('history',this)">History</button>
</nav>
<main>
  <div id="tab-watchlist" class="tab active">
    <div class="stat-row" id="stat-row"></div>
    <div id="wl-content"><p class="empty">Loading&hellip;</p></div>
  </div>
  <div id="tab-upcoming" class="tab">
    <div id="up-content"><p class="empty">Loading&hellip;</p></div>
  </div>
  <div id="tab-history" class="tab">
    <div id="hi-content"><p class="empty">Loading&hellip;</p></div>
  </div>
</main>
<script>
function showTab(name, btn) {
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});
  document.querySelectorAll('nav button').forEach(function(b){b.classList.remove('active')});
  document.getElementById('tab-'+name).classList.add('active');
  btn.classList.add('active');
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtDate(iso) {
  if (!iso) return '&mdash;';
  return new Date(iso).toLocaleString();
}

function loadStatus() {
  fetch('/api/status').then(function(r){return r.json()}).then(function(d) {
    var el = document.getElementById('last-run-info');
    if (d.lastRun) {
      el.textContent = 'Last run: ' + new Date(d.lastRun.at).toLocaleString() + ' \u2014 ' + d.lastRun.scheduled + ' scheduled';
    } else {
      el.textContent = 'No runs recorded yet';
    }
  }).catch(function(){});
}

function loadWatchlist() {
  Promise.all([fetch('/api/watchlist').then(function(r){return r.json()}), fetch('/api/status').then(function(r){return r.json()})]).then(function(results) {
    var data = results[0];
    var status = results[1];
    var last = status.lastRun;
    var stats = [
      ['Matched', data.matches ? data.matches.length : 0],
      ['Scheduled', last ? last.scheduled : '&mdash;'],
      ['Ambiguous', data.ambiguous ? data.ambiguous.length : 0],
      ['Unmatched', data.unmatched ? data.unmatched.length : 0]
    ];
    document.getElementById('stat-row').innerHTML = stats.map(function(s) {
      return '<div class="stat-card"><div class="lbl">'+s[0]+'</div><div class="val">'+s[1]+'</div></div>';
    }).join('');

    var html = '';
    if (data.matches && data.matches.length) {
      html += '<p class="sec">Matched ('+data.matches.length+')</p>';
      html += '<table><thead><tr><th>Title</th><th>EPG title</th><th>Channel</th><th>Airtime</th><th>Match</th></tr></thead><tbody>';
      data.matches.forEach(function(m) {
        html += '<tr><td>'+esc(m.originalTitle)+' <a href="https://www.imdb.com/title/'+esc(m.imdbId)+'/" target="_blank" rel="noopener">&#x2197;</a></td>';
        html += '<td>'+esc(m.epgTitle)+'</td><td>'+esc(m.channelName)+'</td>';
        html += '<td>'+fmtDate(m.startTime)+'</td>';
        html += '<td><span class="badge badge-'+esc(m.confidence)+'">'+esc(m.confidence)+'</span> <small style="color:#6b6b8a">'+esc(m.matchedLanguage)+'</small></td></tr>';
      });
      html += '</tbody></table>';
    }
    if (data.ambiguous && data.ambiguous.length) {
      html += '<p class="sec">Ambiguous ('+data.ambiguous.length+')</p>';
      html += '<table><thead><tr><th>Title</th><th>Reason</th></tr></thead><tbody>';
      data.ambiguous.forEach(function(a) {
        html += '<tr><td>'+esc(a.originalTitle)+'</td><td><span class="badge badge-ambiguous">ambiguous</span> '+esc(a.reason)+'</td></tr>';
      });
      html += '</tbody></table>';
    }
    if (data.unmatched && data.unmatched.length) {
      html += '<p class="sec">No EPG match ('+data.unmatched.length+')</p>';
      html += '<table><thead><tr><th>Title</th><th>Year</th><th>IMDb</th></tr></thead><tbody>';
      data.unmatched.forEach(function(u) {
        html += '<tr><td>'+esc(u.originalTitle)+'</td><td>'+(u.year || '&mdash;')+'</td>';
        html += '<td><a href="https://www.imdb.com/title/'+esc(u.imdbId)+'/" target="_blank" rel="noopener">'+esc(u.imdbId)+'</a></td></tr>';
      });
      html += '</tbody></table>';
    }
    if (!html) html = '<p class="empty">No data yet &mdash; run the scheduler to populate.</p>';
    document.getElementById('wl-content').innerHTML = html;
  }).catch(function(e) {
    document.getElementById('wl-content').innerHTML = '<p class="err-box">'+esc(String(e))+'</p>';
  });
}

function loadUpcoming() {
  fetch('/api/upcoming').then(function(r){return r.json()}).then(function(entries) {
    var el = document.getElementById('up-content');
    if (!entries.length) { el.innerHTML = '<p class="empty">No upcoming recordings scheduled.</p>'; return; }
    var html = '<table><thead><tr><th>Title</th><th>Channel</th><th>Start</th><th>End</th><th>Status</th></tr></thead><tbody>';
    entries.forEach(function(e) {
      html += '<tr><td>'+esc(e.title)+'</td>';
      html += '<td>'+(e.channelName ? esc(e.channelName) : esc(e.channelId))+'</td>';
      html += '<td>'+fmtDate(e.startTime)+'</td>';
      html += '<td>'+fmtDate(e.endTime)+'</td>';
      html += '<td><span class="badge badge-'+esc(e.status)+'">'+esc(e.status)+'</span></td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
  }).catch(function(e) {
    document.getElementById('up-content').innerHTML = '<p class="err-box">'+esc(String(e))+'</p>';
  });
}

function loadHistory() {
  fetch('/api/history').then(function(r){return r.json()}).then(function(runs) {
    var el = document.getElementById('hi-content');
    if (!runs.length) { el.innerHTML = '<p class="empty">No run history yet.</p>'; return; }
    var html = '';
    runs.forEach(function(run) {
      html += '<div class="run-card">';
      html += '<div class="run-time">'+fmtDate(run.startedAt)+'</div>';
      html += '<div class="run-stats">';
      [['Total',run.itemsTotal],['Matched',run.matchesFound],['Scheduled',run.scheduled],
       ['Ambiguous',run.ambiguous],['Unmatched',run.unmatched],['In library',run.itemsInLibrary]
      ].forEach(function(s){ html += '<div class="run-stat">'+s[0]+': <span>'+s[1]+'</span></div>'; });
      html += '</div>';
      if (run.errors && run.errors.length) {
        html += '<div class="run-errors">'+run.errors.map(esc).join('<br>')+'</div>';
      }
      html += '</div>';
    });
    el.innerHTML = html;
  }).catch(function(e) {
    document.getElementById('hi-content').innerHTML = '<p class="err-box">'+esc(String(e))+'</p>';
  });
}

loadStatus(); loadWatchlist(); loadUpcoming(); loadHistory();
setInterval(function(){ loadStatus(); loadWatchlist(); loadUpcoming(); loadHistory(); }, 5*60*1000);
</script>
</body>
</html>`
}
