// "HP daily collection" block. Adds itself to the bottom of the main dashboard (/) and the Hire Purchase page (/hp.html).
// It uses the same cluster / showroom / period selectors as the page it sits in.
(function () {
  if (typeof getRange !== 'function' || typeof Chart === 'undefined') return;
  const main = document.querySelector('main');
  if (!main) return;

  const sec = document.createElement('section');
  sec.className = 'card';
  sec.style.marginTop = '14px';
  sec.innerHTML =
    '<h2 style="font-size:15px;margin:0 0 2px">HP daily collection</h2>' +
    '<div class="hint" id="hcHint" style="font-size:12px;color:var(--muted);margin-bottom:10px">Loading...</div>' +
    '<div class="kpis" id="hcKpis" style="margin-bottom:14px"></div>' +
    '<div class="kpis" id="hcPay" style="margin-bottom:14px"></div>' +
    '<div id="hcBody"><div class="chartbox" style="position:relative;height:300px"><canvas id="cHpCol"></canvas></div>' +
    '<div class="scroll" id="hcBranch" style="overflow:auto;max-height:420px;margin-top:14px"></div></div>';
  main.appendChild(sec);

  const $$ = id => document.getElementById(id);
  const e = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cssv = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  let chart = null, busy = false, again = false;

  function change(v) {
    if (v === null || v === undefined || !isFinite(v)) return '<span>no previous data</span>';
    const up = v >= 0;
    return '<span class="' + (up ? 'up' : 'down') + '">' + (up ? '&#9650;' : '&#9660;') + ' ' + Math.abs(v).toFixed(1) + '%</span> vs previous period';
  }
  const cell = v => v === null || v === undefined || !isFinite(v) ? '-' : '<span class="' + (v >= 0 ? 'up' : 'down') + '">' + (v >= 0 ? '&#9650;' : '&#9660;') + ' ' + Math.abs(v).toFixed(1) + '%</span>';

  function render(D) {
    if (!D.found) {
      $$('hcHint').textContent = '';
      $$('hcKpis').innerHTML = ''; $$('hcPay').innerHTML = '';
      $$('hcBody').innerHTML = '<div class="empty" style="color:var(--muted);padding:20px 0;text-align:center">The HP collection table was not found automatically. ' +
        'Open <a href="/api/hp-collection/schema" target="_blank">/api/hp-collection/schema</a> to see what was found. ' + e((D.notes || []).join(' ')) + '</div>';
      return;
    }
    if (!$$('cHpCol')) {
      $$('hcBody').innerHTML = '<div class="chartbox" style="position:relative;height:300px"><canvas id="cHpCol"></canvas></div><div class="scroll" id="hcBranch" style="overflow:auto;max-height:420px;margin-top:14px"></div>';
      chart = null;
    }
    const k = D.kpi;
    $$('hcHint').textContent = D.scopeLabel + ' | ' + D.range.from + ' to ' + D.range.to + ' | amounts from ' + D.table + '.' + D.amountColumn +
      ' | bars = ' + (D.group === 'day' ? 'per day' : D.group === 'week' ? 'per week' : 'per month');
    const cards = [
      ['HP collected', money(k.collected), change(k.change)],
      ['Receipts', full(k.receipts), 'number of collections'],
      ['Average per day', money(k.avgPerDay), 'over the chosen period'],
      ['Latest collection day', k.latest ? e(k.latest.date.slice(5)) : '-', k.latest ? money(k.latest.amount) : 'no collections'],
      ['Best day', k.best ? e(k.best.date.slice(5)) : '-', k.best ? money(k.best.amount) : ''],
      ['Collected / HP sales', k.ratio === null ? '-' : k.ratio.toFixed(1) + '%', 'HP sales ' + money(k.hpSales)],
    ];
    $$('hcKpis').innerHTML = cards.map(c => '<div class="kpi"><div class="label">' + c[0] + '</div><div class="value">' + c[1] + '</div><div class="note">' + c[2] + '</div></div>').join('');

    const colors = { pay_cash: '#4f6bed', pay_cheque: '#e9a23b', pay_ccard: '#2fb67c', pay_deposit: '#9b6bd6', pay_cnote: '#d0453b', pay_other: '#8a97a6' };
    const pt = D.payTypes || [];
    const paid = pt.reduce((a, x) => a + x.amount, 0);
    $$('hcPay').innerHTML = pt.map(x => '<div class="kpi"><div class="label">' + e(x.label) + '</div><div class="value">' + money(x.amount) + '</div><div class="note">' + x.share.toFixed(1) + '% of collected</div></div>').join('') +
      (pt.length && Math.abs(paid - D.kpi.collected) > Math.max(1, D.kpi.collected * 0.005)
        ? '<div class="kpi"><div class="label">Not split</div><div class="value">' + money(D.kpi.collected - paid) + '</div><div class="note">collected minus the payment types above</div></div>' : '');

    if (chart) chart.destroy();
    const datasets = pt.length
      ? pt.map(x => ({ label: x.label, data: D.daily.map(d => d.pay[x.key] || 0), backgroundColor: colors[x.key] || '#8a97a6' }))
      : [{ label: 'HP collected', data: D.daily.map(d => d.amount), backgroundColor: cssv('--hp') || '#4f6bed' }];
    chart = new Chart($$('cHpCol'), {
      type: 'bar',
      data: { labels: D.daily.map(d => d.label), datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { callback: v => money(v) } } },
        plugins: { legend: { display: pt.length > 1 }, tooltip: { callbacks: { label: c => c.dataset.label + ': Rs. ' + full(c.parsed.y), footer: items => { const d = D.daily[items[0].dataIndex]; return 'Total Rs. ' + full(d.amount) + '  (' + full(d.receipts) + ' receipts)'; } } } },
      },
    });

    $$('hcBranch').innerHTML = D.branches.length
      ? '<table><thead><tr><th>Branch</th><th>Collected</th><th>Share</th><th>Cash %</th><th>Receipts</th><th>vs previous</th></tr></thead><tbody>' +
        D.branches.map(b => '<tr><td>' + e(b.name) + '</td><td>' + full(b.amount) + '</td><td>' + b.share.toFixed(1) + '%</td><td>' + (b.cashPct === null || b.cashPct === undefined ? '-' : b.cashPct.toFixed(0) + '%') + '</td><td>' + full(b.receipts) + '</td><td>' + cell(b.change) + '</td></tr>').join('') + '</tbody></table>'
      : '<div class="empty" style="color:var(--muted);padding:20px 0;text-align:center">No HP collections in this period.</div>';
  }

  async function load() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const [f, t] = getRange($$('period').value);
      const scope = $$('branch').value ? 'br:' + $$('branch').value : $$('scope').value;
      const res = await fetch('/api/hp-collection?' + new URLSearchParams({ scope, from: ymd(f), to: ymd(t) }));
      const D = await res.json();
      if (!res.ok || D.error) throw new Error(D.error || 'Request failed');
      render(D);
    } catch (err) {
      $$('hcHint').textContent = 'Could not load HP collection: ' + err.message;
    } finally {
      busy = false;
      if (again) { again = false; load(); }
    }
  }

  ['scope', 'branch', 'period', 'dFrom', 'dTo'].forEach(id => { const el = $$(id); if (el) el.addEventListener('change', () => setTimeout(load, 50)); });
  const rf = $$('refresh'); if (rf) rf.addEventListener('click', () => setTimeout(load, 50));
  setTimeout(load, 1500);          // wait until the page has filled its own selectors
  setInterval(load, 60000);
})();
