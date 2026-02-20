import express from "express"
import type { Redis } from "ioredis"
import type { DvrAdapter } from "../dvr/index.js"
import type { HistoryStore } from "../state/history.js"

export interface WebDeps {
  dvr: DvrAdapter
  history: HistoryStore
  redis: Redis
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
          res.json({ items: [] })
          return
        }
        const items = [
          ...(last.inLibraryItems ?? []).map((x) => ({ ...x, status: "in_library" as const })),
          ...(last.alreadyScheduledItems ?? []).map((x) => ({ ...x, status: "already_scheduled" as const })),
          ...last.matches.map((m) => ({
            imdbId: m.imdbId,
            originalTitle: m.originalTitle,
            localizedTitle: m.localizedTitle,
            source: m.source,
            userRating: m.userRating,
            status: "matched" as const,
            match: m,
          })),
          ...last.ambiguousItems.map((a) => ({
            imdbId: a.imdbId,
            originalTitle: a.originalTitle,
            localizedTitle: a.localizedTitle,
            source: a.source,
            userRating: a.userRating,
            status: "ambiguous" as const,
            reason: a.reason,
          })),
          ...last.unmatchedItems.map((u) => ({
            imdbId: u.imdbId,
            originalTitle: u.originalTitle,
            localizedTitle: u.localizedTitle,
            source: u.source,
            userRating: u.userRating,
            status: "unmatched" as const,
            year: u.year,
          })),
        ]
        res.json({ items })
      })
      .catch((err: Error) => res.status(500).json({ error: err.message }))
  })

  app.get("/api/debug/cache", (_req, res) => {
    const prefixes = ["tmdb:id:", "tmdb:titles:", "plex:library:", "jellyfin:library:"]
    Promise.all(prefixes.map((p) => deps.redis.keys(`${p}*`)))
      .then((results) => {
        const counts: Record<string, number> = {}
        prefixes.forEach((p, i) => (counts[p] = results[i].length))
        res.json({ counts })
      })
      .catch((err: Error) => res.status(500).json({ error: err.message }))
  })

  app.get("/api/debug/cache/:imdbId", (req, res) => {
    const { imdbId } = req.params
    if (!/^tt\d+$/.test(imdbId)) {
      res.status(400).json({ error: "Invalid IMDb ID" })
      return
    }
    Promise.all([
      deps.redis.get(`tmdb:id:${imdbId}`),
      deps.redis.get(`tmdb:titles:${imdbId}`),
    ])
      .then(([tmdbId, titlesRaw]) => {
        res.json({
          imdbId,
          tmdbId: tmdbId ? parseInt(tmdbId, 10) : null,
          titles: titlesRaw ? (JSON.parse(titlesRaw) as Record<string, string>) : null,
        })
      })
      .catch((err: Error) => res.status(500).json({ error: err.message }))
  })

  app.get("/{*splat}", (_req, res) => {
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
.badge-dryrun{background:#1a1a3a;color:#818cf8;border:1px solid #4a4a8a}
.badge-ambiguous{background:#2a2a1a;color:#fbbf24}
.badge-library{background:#162a1e;color:#4ade80}
.badge-noepg{background:#1e1e2a;color:#6b6b8a}
.badge-rating{background:#2e1e0a;color:#fbbf24}
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
  <button onclick="showTab('debug',this)">Debug</button>
</nav>
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
  <div id="tab-debug" class="tab">
    <div id="debug-content"><p class="empty">Loading&hellip;</p></div>
    <div style="margin-top:1.5rem">
      <p class="sec">Look up IMDb ID</p>
      <div style="display:flex;gap:.6rem;margin-top:.5rem">
        <input id="debug-id-input" type="text" placeholder="tt0088763" style="background:#1a1a30;border:1px solid #2a2a4a;color:#e0e0f0;padding:.5rem .8rem;border-radius:6px;font-size:.88rem;width:220px">
        <button onclick="lookupCache()" style="background:#2a2a4a;border:none;color:#a78bfa;padding:.5rem 1rem;border-radius:6px;cursor:pointer;font-size:.88rem">Look up</button>
      </div>
      <div id="debug-lookup-result" style="margin-top:.8rem"></div>
    </div>
  </div>
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
  fetch('/api/watchlist').then(function(r){return r.json()}).then(function(data) {
    var items = data.items || [];
    var counts = {matched:0,in_library:0,already_scheduled:0,ambiguous:0,unmatched:0};
    items.forEach(function(i){ if(counts[i.status]!==undefined) counts[i.status]++; });
    var stats = [
      ['Total', items.length],
      ['Matched', counts.matched],
      ['In Library', counts.in_library],
      ['Scheduled', counts.already_scheduled],
      ['Ambiguous', counts.ambiguous],
      ['No EPG', counts.unmatched]
    ];
    document.getElementById('stat-row').innerHTML = stats.map(function(s) {
      return '<div class="stat-card"><div class="lbl">'+s[0]+'</div><div class="val">'+s[1]+'</div></div>';
    }).join('');
    if (!items.length) {
      document.getElementById('wl-content').innerHTML = '<p class="empty">No data yet &mdash; run the scheduler to populate.</p>';
      return;
    }
    var order = {matched:0,ambiguous:1,unmatched:2,in_library:3,already_scheduled:4};
    items.sort(function(a,b){
      return (order[a.status]||99)-(order[b.status]||99) || a.originalTitle.localeCompare(b.originalTitle);
    });
    var html = '<table><thead><tr><th>Title</th><th>Rating</th><th>Status</th><th>EPG / Channel</th><th>Airtime</th></tr></thead><tbody>';
    items.forEach(function(item) {
      var displayTitle = (item.localizedTitle && item.localizedTitle !== item.originalTitle)
        ? esc(item.localizedTitle) + '<br><small style="color:#6b6b8a">' + esc(item.originalTitle) + '</small>'
        : esc(item.originalTitle);
      var imdbLink = ' <a href="https://www.imdb.com/title/'+esc(item.imdbId)+'/" target="_blank" rel="noopener">&#x2197;</a>';
      var ratingHtml = item.userRating ? '<span class="badge badge-rating">&#9733; '+item.userRating+'</span>' : '&mdash;';
      var badge='', epg='&mdash;', airtime='&mdash;';
      if (item.status==='matched') {
        badge = '<span class="badge badge-'+esc(item.match.confidence)+'">'+esc(item.match.confidence)+'</span>'
              + (item.match.matchedLanguage ? ' <small style="color:#6b6b8a">'+esc(item.match.matchedLanguage)+'</small>' : '');
        epg = esc(item.match.epgTitle)+'<br><small style="color:#6b6b8a">'+esc(item.match.channelName)+'</small>';
        airtime = fmtDate(item.match.startTime);
      } else if (item.status==='in_library') {
        badge = '<span class="badge badge-library">in library</span>';
      } else if (item.status==='already_scheduled') {
        badge = '<span class="badge badge-scheduled">scheduled</span>';
      } else if (item.status==='ambiguous') {
        badge = '<span class="badge badge-ambiguous">ambiguous</span>';
        epg = '<small style="color:#8888aa">'+esc(item.reason)+'</small>';
      } else {
        badge = '<span class="badge badge-noepg">no EPG</span>';
        if (item.year) epg = String(item.year);
      }
      html += '<tr><td>'+displayTitle+imdbLink+'</td><td>'+ratingHtml+'</td><td>'+badge+'</td><td>'+epg+'</td><td>'+airtime+'</td></tr>';
    });
    html += '</tbody></table>';
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
      html += '<div class="run-time">'+fmtDate(run.startedAt)+(run.dryRun ? ' <span class="badge badge-dryrun">dry run</span>' : '')+'</div>';
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

function loadDebug() {
  fetch('/api/debug/cache').then(function(r){return r.json()}).then(function(data) {
    var html = '<p class="sec">Redis cache</p>';
    html += '<table><thead><tr><th>Key prefix</th><th>Entries</th></tr></thead><tbody>';
    Object.keys(data.counts).forEach(function(k) {
      html += '<tr><td><code>'+esc(k)+'*</code></td><td>'+data.counts[k]+'</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('debug-content').innerHTML = html;
  }).catch(function(e) {
    document.getElementById('debug-content').innerHTML = '<p class="err-box">'+esc(String(e))+'</p>';
  });
}

function lookupCache() {
  var id = document.getElementById('debug-id-input').value.trim();
  if (!id) return;
  var el = document.getElementById('debug-lookup-result');
  el.innerHTML = '<p style="color:#6b6b8a;font-size:.85rem">Loading\u2026</p>';
  fetch('/api/debug/cache/'+encodeURIComponent(id)).then(function(r){return r.json()}).then(function(d) {
    if (d.error) { el.innerHTML = '<p class="err-box">'+esc(d.error)+'</p>'; return; }
    var html = '<table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>';
    html += '<tr><td>IMDb ID</td><td>'+esc(d.imdbId)+'</td></tr>';
    html += '<tr><td>TMDB ID</td><td>'+(d.tmdbId || '<span style="color:#6b6b8a">not cached</span>')+'</td></tr>';
    if (d.titles) {
      Object.keys(d.titles).sort().forEach(function(lang) {
        html += '<tr><td><code>'+esc(lang)+'</code></td><td>'+esc(d.titles[lang])+'</td></tr>';
      });
    } else {
      html += '<tr><td>Titles</td><td><span style="color:#6b6b8a">not cached</span></td></tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  }).catch(function(e) {
    el.innerHTML = '<p class="err-box">'+esc(String(e))+'</p>';
  });
}

loadStatus(); loadWatchlist(); loadUpcoming(); loadHistory(); loadDebug();
setInterval(function(){ loadStatus(); loadWatchlist(); loadUpcoming(); loadHistory(); loadDebug(); }, 5*60*1000);
</script>
</body>
</html>`
}
