// ====== SETTING: Supabase ki Project URL aur ANON key yahan paste karein ======
// (Kabhi "service_role" key yahan na daalein.) Khali chhorein to app sirf phone mein chalegi.
const SB_URL = '', SB_KEY = '';

const $ = i => document.getElementById(i);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = n => 'Rs. ' + (+(+n).toFixed(2)).toLocaleString('en-US');
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d } catch { return d } };
let txs = load('md_txs', []), sent = new Set(load('md_sent', [])), cur = null, busy = false, sb = null;
const store = () => { localStorage.setItem('md_txs', JSON.stringify(txs)); localStorage.setItem('md_sent', JSON.stringify([...sent])) };

/* ---------- WORD LISTS ---------- */
const UN = { packet: 'packet', packets: 'packet', pkt: 'packet', bottle: 'bottle', bottles: 'bottle', kg: 'kg', kilo: 'kg', litre: 'litre', liter: 'litre', ltr: 'litre', box: 'box', boxes: 'box', carton: 'carton', cartons: 'carton', piece: 'piece', pieces: 'piece', pcs: 'piece', dana: 'piece' };
const W = {
  sale: 'becha beche bechi sale sold farokht'.split(' '),
  buy: 'khareeda khareede khareedi kharida kharide kharidi liya purchase bought'.split(' '),
  exp: 'kharcha bill rent bijli transport tankhwah salary'.split(' '),
  cr: 'udhaar udhar baqi credit'.split(' '),
  rep: 'wapas waapis wapis'.split(' '),
  per: 'personal ghar nikale nikaale withdraw'.split(' '),
  dep: 'rakhe rakhi daale dala jama'.split(' ')
};
const ALLW = Object.values(W).flat();
const STOP = new Set('aaj ke ka ki ko ne se mein me per each har pe rupay rupee rupees rupaye rupe rs hua hui hai kiye kiya liye saman cash drawer use diya diye de dukan'.split(' '));
const CUR = ['rupay', 'rupee', 'rupees', 'rupaye', 'rupe', 'rs'];
const has = (t, l) => t.some(x => l.includes(x));
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
const findP = (n, P) => { if (!n) return ''; if (P[n]) return n; return Object.keys(P).find(k => k.includes(n) || n.includes(k)) || n };

/* ---------- PARSER ---------- */
function parse(raw, P) {
  const s = raw.toLowerCase().replace(/(\d),(?=\d{3})/g, '$1').replace(/(\d)([a-z])/g, '$1 $2').replace(/[,!?]|\.(?!\d)/g, ' ');
  const t = s.split(/\s+/).filter(Boolean);
  const nums = [];
  t.forEach((x, i) => { if (/^\d+(\.\d+)?$/.test(x)) nums.push({ n: +x, i, cur: CUR.includes(t[i + 1]) || CUR.includes(t[i - 1]) }) });
  const am = nums.find(x => x.cur), oth = nums.filter(x => x !== am);
  const unitTok = t.find(x => UN[x]);
  const j = t.findIndex(x => x == 'ko' || x == 'ne');
  const party = j > 0 ? cap(t[j - 1]) : '';
  const all = has(t, W.cr);
  let type = null, credit = false;
  if (all && has(t, W.rep)) type = 'cust_pay';
  else if (t.includes('supplier') && !has(t, W.buy) && !has(t, W.sale)) type = 'supp_pay';
  else if (has(t, W.per)) type = 'owner_out';
  else if (has(t, W.dep)) type = 'cash_in';
  else if (has(t, W.exp) && !has(t, W.buy) && !has(t, W.sale)) type = 'expense';
  else if (has(t, W.buy)) type = 'purchase';
  else if (has(t, W.sale) || all) type = 'sale';
  if (all && (type == 'sale' || type == 'purchase')) credit = true;
  const words = t.filter((x, i) => i !== j - 1 && !/^\d/.test(x) && !STOP.has(x) && !UN[x] && !ALLW.includes(x));
  const p = { raw, type, unit: unitTok ? UN[unitTok] : '', credit, party, product: findP(words.join(' '), P), qty: oth.length ? oth[0].n : null, amt: am ? am.n : (oth.length > 1 ? oth[1].n : null), mode: null };
  if (!['sale', 'purchase', null].includes(type)) {
    p.amt = am ? am.n : (nums[0] ? nums[0].n : null);
    p.product = ''; p.qty = null;
    if (type == 'expense') p.name = t.filter(x => W.exp.includes(x)).join(' ');
    if (type == 'supp_pay' && !p.party) p.party = 'Supplier';
  } else {
    if (type == 'purchase' && credit) { const i = t.indexOf('se'); p.party = cap(t[i + 1] || '') || party }
    if (credit && !p.party) p.party = type == 'sale' ? 'Customer' : 'Supplier';
    p.mode = (p.qty || 1) == 1 || has(t, ['per', 'each', 'har', 'pe']) || p.amt == null ? 'each' : 'ask';
  }
  return p;
}
const tot = p => p.mode == 'total' ? p.amt : (p.qty || 1) * p.amt;

/* ---------- ACCOUNTING ENGINE (replays all saved entries; weighted average cost) ---------- */
function addStock(p, q, c) {
  if (q > 0 && c != null) { const b = Math.max(p.qty, 0); p.cost = (b + q) > 0 ? (b * p.cost + q * c) / (b + q) : c }
  p.qty += q;
}
function compute(all) {
  const v = new Set(all.filter(t => t.type == 'void').map(t => t.ref));
  const S = { cash: 0, P: {}, C: {}, V: {}, list: all.filter(t => t.type != 'void' && !v.has(t.id)), voided: v };
  const gp = (n, u) => S.P[n] ||= { unit: u || 'piece', qty: 0, cost: 0, price: 0, min: 5 };
  for (const t of S.list) {
    if (t.type == 'product') {
      const p = gp(t.product, t.unit);
      if (t.unit) p.unit = t.unit; if (t.price) p.price = t.price; if (t.min != null) p.min = t.min;
      if (t.cost != null && !(t.qty > 0)) p.cost = t.cost;
      if (t.qty) addStock(p, t.qty, t.cost);
    } else if (t.type == 'purchase') {
      addStock(gp(t.product, t.unit), t.qty, t.price);
      if (t.credit) S.V[t.party] = (S.V[t.party] || 0) + t.total; else S.cash -= t.total;
    } else if (t.type == 'sale') {
      if (t.product) { const p = gp(t.product, t.unit); p.qty -= t.qty; if (!p.price) p.price = t.price }
      if (t.credit) S.C[t.party] = (S.C[t.party] || 0) + t.total; else S.cash += t.total;
    } else if (t.type == 'expense' || t.type == 'owner_out') S.cash -= t.total;
    else if (t.type == 'cash_in') S.cash += t.total;
    else if (t.type == 'cust_pay') { S.C[t.party] = (S.C[t.party] || 0) - t.total; S.cash += t.total }
    else if (t.type == 'supp_pay') { S.V[t.party] = (S.V[t.party] || 0) - t.total; S.cash -= t.total }
  }
  return S;
}
function startOf(k) { const d = new Date(); d.setHours(0, 0, 0, 0); if (k == 'week') d.setDate(d.getDate() - 6); if (k == 'month') d.setDate(1); return d.getTime() }
function stats(S, from) {
  const r = { sales: 0, cogs: 0, buy: 0, exp: 0, cin: 0, cout: 0, nocogs: 0, best: {} };
  for (const t of S.list) {
    if (t.ts < from) continue;
    if (t.type == 'sale') { r.sales += t.total; r.cogs += t.cogs || 0; if (t.nocogs) r.nocogs++; if (!t.credit) r.cin += t.total; if (t.product) r.best[t.product] = (r.best[t.product] || 0) + t.qty }
    if (t.type == 'purchase') { r.buy += t.total; if (!t.credit) r.cout += t.total }
    if (t.type == 'expense') { r.exp += t.total; r.cout += t.total }
    if (t.type == 'owner_out' || t.type == 'supp_pay') r.cout += t.total;
    if (t.type == 'cash_in' || t.type == 'cust_pay') r.cin += t.total;
  }
  r.gross = r.sales - r.cogs; r.net = r.gross - r.exp; return r;
}

/* ---------- ENTRY FLOW ---------- */
const desc = t => ({
  sale: `${t.qty || ''} ${t.product || ''} ${t.unit || ''} becha${t.credit ? ' (udhaar ' + t.party + ')' : ''}`,
  purchase: `${t.qty} ${t.product} ${t.unit || ''} khareede${t.credit ? ' (udhaar)' : ''}`,
  expense: `Kharcha: ${t.name || ''}`, cash_in: 'Cash rakha', owner_out: 'Ghar/personal nikale',
  cust_pay: `${t.party} ne udhaar wapas kiya`, supp_pay: `${t.party} ko payment`, product: `Product: ${t.product}`
}[t.type] || t.type);

function card() {
  const p = cur, S = compute(txs), c = $('card'), e = [], w = [];
  c.hidden = false;
  if (!p.type) {
    if (p.amt == null) { c.innerHTML = '<p class="err">Samajh nahi aaya. Edit karein, jaise: "5 doodh 100 rupay per packet beche".</p><div class="row"><button data-a="ed">Edit</button><button class="ghost" data-a="no">Cancel</button></div>'; return }
    c.innerHTML = '<h3>Ye kya hai?</h3><div class="row"><button data-a="t:sale">Becha (Sale)</button><button data-a="t:purchase">Khareeda</button></div><button class="ghost big" data-a="no">Cancel</button>';
    return;
  }
  const sp = p.type == 'sale' || p.type == 'purchase', pr = S.P[p.product];
  if (sp) {
    p.qty = p.qty || 1;
    if (pr && p.amt == null) { p.amt = p.type == 'sale' ? pr.price : pr.cost; p.saved = 1; p.mode = 'each' }
    if (!p.unit && pr) p.unit = pr.unit;
    if (!p.product && !p.credit) e.push('Product ka naam samajh nahi aaya.');
    p.newProd = !!p.product && !pr;
    if (p.newProd) w.push(p.type == 'sale' ? 'Naya product hai. Neeche kharid qeemat likhein. Is ka stock zero hai.' : 'Naya product add ho jayega.');
    if (p.type == 'sale' && pr && pr.qty < p.qty) w.push(`Stock sirf ${pr.qty} ${pr.unit} hai. Save karne se stock minus ho jayega.`);
    if (p.type == 'sale' && !p.product) w.push('Product nahi likha: stock aur munafa update nahi hoga, sirf udhaar.');
  }
  if (!(p.amt > 0)) e.push('Rupay samajh nahi aaye.');
  if (p.type == 'cust_pay' && !p.party) e.push('Customer ka naam likhein (jaise: Ahmed ne 500 udhaar wapas kiye).');
  const T = p.amt > 0 && p.mode != 'ask' ? tot(p) : 0;
  const sum = {
    sale: p.product ? `${p.qty} ${p.unit} ${p.product} becha${p.credit ? ' (udhaar ' + p.party + ')' : ''}?` : `${p.party} ko saman udhaar diya?`,
    purchase: `${p.qty} ${p.unit} ${p.product} khareede${p.credit ? ' (udhaar ' + p.party + ')' : ''}?`,
    expense: `Kharcha: ${p.name || 'general'}?`, cash_in: 'Dukan ke cash mein rakhe?', owner_out: 'Ghar/personal ke liye nikale?',
    cust_pay: `${p.party} ne udhaar wapas kiya?`, supp_pay: `${p.party} ko payment di?`
  }[p.type];
  let h = `<h3>${esc(sum)}</h3>`;
  if (p.mode == 'ask') h += `<p>Rs. ${p.amt} har ${esc(p.unit || 'ek')} ka hai ya total?</p><div class="row"><button data-a="m:each">Har ek ka</button><button data-a="m:total">Total</button></div>`;
  else h += `<div class="tot">Total: ${fmt(T)}</div>${p.saved ? '<small>Save kiya hua rate use hua.</small>' : ''}`;
  if (p.newProd && p.type == 'sale') h += '<input id="cost" type="number" inputmode="decimal" placeholder="Is ki kharid qeemat (Rs. per ek)">';
  e.forEach(x => h += `<p class="err">${esc(x)}</p>`); w.forEach(x => h += `<p class="warn">${esc(x)}</p>`);
  const low = p.type == 'sale' && p.product && (!pr || pr.qty < p.qty);
  h += `<div class="row"><button data-a="ok" ${e.length || p.mode == 'ask' ? 'disabled' : ''}>${low ? 'Phir bhi Save' : 'Confirm'}</button><button class="ghost" data-a="ed">Edit</button><button class="ghost" data-a="no">Cancel</button></div>`;
  c.innerHTML = h;
}
function closeCard() { cur = null; $('card').hidden = true; busy = false }
function commit() {
  if (busy) return; busy = true;
  const p = cur, S = compute(txs), now = Date.now(), T = [], total = tot(p), pr = S.P[p.product];
  const mk = o => ({ id: crypto.randomUUID(), ts: now, raw: p.raw, ...o });
  if (p.type == 'sale' || p.type == 'purchase') {
    const unitPrice = total / p.qty; let cost = pr ? pr.cost : 0;
    if (p.newProd && p.type == 'sale') {
      cost = parseFloat(($('cost') || {}).value);
      if (isNaN(cost) || cost < 0) { alert('Pehle kharid qeemat likhein.'); busy = false; return }
      T.push(mk({ type: 'product', product: p.product, unit: p.unit || 'piece', cost, price: unitPrice, qty: 0, total: 0 }));
    }
    if (p.type == 'sale') T.push(mk({ type: 'sale', product: p.product, unit: p.unit, qty: p.product ? p.qty : null, price: unitPrice, total, credit: p.credit, party: p.party, cogs: p.product ? p.qty * cost : 0, nocogs: !p.product }));
    else T.push(mk({ type: 'purchase', product: p.product, unit: p.unit || 'piece', qty: p.qty, price: unitPrice, total, credit: p.credit, party: p.party }));
  } else T.push(mk({ type: p.type, total: p.amt, party: p.party, name: p.name }));
  txs.push(...T); store(); $('box').value = ''; closeCard(); render(); sync();
}
$('save').onclick = () => {
  const raw = $('box').value.trim(); if (!raw) { $('box').focus(); return }
  cur = parse(raw, compute(txs).P); card();
};
$('card').onclick = e => {
  const a = e.target.dataset.a; if (!a || !cur) return;
  if (a == 'ok') commit();
  else if (a == 'no') closeCard();
  else if (a == 'ed') { $('box').value = cur.raw; closeCard(); $('box').focus() }
  else if (a.startsWith('t:')) { cur.type = a.slice(2); cur.mode = (cur.qty || 1) == 1 ? 'each' : 'ask'; card() }
  else if (a.startsWith('m:')) { cur.mode = a.slice(2); card() }
};

/* ---------- DASHBOARD ---------- */
function render() {
  const S = compute(txs), r = stats(S, startOf('day'));
  $('date').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('k').innerHTML = [['Aaj ki Sale', r.sales], ['Aaj ki Kharidari', r.buy], ['Aaj ka Kharcha', r.exp], ['Aaj ka Munafa (andaza)', r.gross], ['Net Munafa (andaza)', r.net], ['Total Cash', S.cash]].map(([a, b]) => `<div class="k"><small>${a}</small><b>${fmt(b)}</b></div>`).join('');
  const lows = Object.entries(S.P).filter(([, p]) => p.qty <= p.min);
  $('low').innerHTML = lows.length ? `<div class="alert"><b>Kam Stock:</b> ${lows.map(([n, p]) => `${esc(n)} (${p.qty} ${p.unit})`).join(', ')}</div>` : '';
  $('recent').innerHTML = txs.filter(t => t.type != 'void').slice(-8).reverse().map(t => {
    const vd = S.voided.has(t.id);
    return `<li class="${vd ? 'v' : ''}"><span>${esc(desc(t))}<br><small>${fmt(t.total || 0)}</small></span>${vd ? '<small>Wapas</small>' : `<button data-u="${t.id}">Wapas</button>`}</li>`;
  }).join('') || '<li>Abhi koi hisab nahi.</li>';
}
$('recent').onclick = e => {
  const id = e.target.dataset.u; if (!id || !confirm('Ye entry wapas (cancel) karein?')) return;
  txs.push({ id: crypto.randomUUID(), ts: Date.now(), type: 'void', ref: id, total: 0 }); store(); render(); sync();
};

/* ---------- SHEETS ---------- */
let rangeKey = 'day';
function sheet(k) {
  const S = compute(txs); let h = '';
  if (k == 'stock') {
    h = '<h2>Baqi Stock</h2><table>' + (Object.entries(S.P).map(([n, p]) => `<tr><td>${esc(n)}<br><small>Kharid ${fmt(p.cost)} | Bechna ${fmt(p.price)}</small></td><td>${p.qty} ${p.unit}</td></tr>`).join('') || '<tr><td>Koi product nahi.</td></tr>') + `</table>
    <h2>Product Add / Stock Theek Karein</h2>
    <input id="pn" placeholder="Product ka naam (jaise: sugar)"><select id="pu">${[...new Set(Object.values(UN))].map(u => `<option>${u}</option>`).join('')}</select>
    <input id="pc" type="number" inputmode="decimal" placeholder="Kharid qeemat (per ek)"><input id="pp" type="number" inputmode="decimal" placeholder="Bechne ki qeemat (per ek)">
    <input id="pq" type="number" inputmode="decimal" placeholder="Stock kitna barhana (ghatane ke liye minus likhein)"><input id="pm" type="number" placeholder="Kam stock alert (jaise 5)">
    <button class="big" data-a="addp">Save Karein</button>`;
  } else if (k == 'udhaar') {
    const L = o => Object.entries(o).filter(([, v]) => Math.abs(v) > 0.001).map(([n, v]) => `<tr><td>${esc(n)}</td><td>${fmt(v)}</td></tr>`).join('') || '<tr><td>Koi udhaar nahi.</td></tr>';
    h = `<h2>Customer ka Udhaar (humein milna hai)</h2><table>${L(S.C)}</table><h2>Supplier ko Dena Hai</h2><table>${L(S.V)}</table>`;
  } else if (k == 'report') {
    const r = stats(S, startOf(rangeKey)), top = Object.entries(r.best).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const slow = Object.entries(S.P).filter(([n, p]) => p.qty > 0 && !r.best[n]).map(([n]) => esc(n)).join(', ');
    const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
    const row = (a, b) => `<tr><td>${a}</td><td>${fmt(b)}</td></tr>`;
    const stockVal = Object.values(S.P).reduce((a, p) => a + Math.max(p.qty, 0) * p.cost, 0);
    h = `<div class="row noprint">${[['day', 'Aaj'], ['week', 'Hafta'], ['month', 'Mahina']].map(([a, b]) => `<button class="${rangeKey == a ? '' : 'ghost'}" data-a="r:${a}">${b}</button>`).join('')}</div>
    <h2>${{ day: 'Aaj', week: 'Is Hafte', month: 'Mahine' }[rangeKey]} ka Hisab</h2>
    <div class="est">Ye ANDAZA hai (aap ki entries se). Final verified hisab nahi.${r.nocogs ? ` ${r.nocogs} sale mein product nahi likha tha, is liye munafa zyada dikh sakta hai.` : ''}</div>
    <table>${row('Total Sale', r.sales)}${row('Kharidari', r.buy)}${row('Maal ki Laagat', r.cogs)}${row('Gross Munafa', r.gross)}${row('Kharcha', r.exp)}${row('Net Munafa', r.net)}${row('Cash Mila', r.cin)}${row('Cash Diya', r.cout)}${row('Total Cash (abhi)', S.cash)}${row('Stock ki Laagat (abhi)', stockVal)}${row('Customer Udhaar', sum(S.C))}${row('Supplier ko Dena', sum(S.V))}</table>
    <h2>Sab se zyada Bikne wale</h2><p>${top.map(([n, q]) => `${esc(n)} (${q})`).join(', ') || 'Abhi koi sale nahi.'}</p>
    ${rangeKey == 'month' ? `<h2>Slow Maal</h2><p>${slow || 'Koi nahi.'}</p>` : ''}
    <button class="big noprint" onclick="window.print()">Print / PDF Banayein</button>`;
  } else if (k == 'settings') {
    h = `<h2>Online Backup</h2><p id="ss">${sb ? 'Supabase connected.' : 'Supabase abhi set nahi (sirf phone mein save ho raha hai).'}</p>`;
    if (sb) h += `<input id="em" type="email" placeholder="Email"><input id="pw" type="password" placeholder="Password (kam az kam 6)"><div class="row"><button data-a="in">Login</button><button class="ghost" data-a="up">Naya Account</button></div><button class="ghost big" data-a="out">Logout</button>`;
    h += `<p>Kul entries: ${txs.length}. Bhejni baqi: ${txs.filter(t => !sent.has(t.id)).length}</p><button class="big" data-a="exp">Backup File Download</button>`;
  }
  $('sbody').innerHTML = h; $('sheet').hidden = false; $('sheet').dataset.k = k;
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => sheet(b.dataset.s));
$('close').onclick = () => { $('sheet').hidden = true };
$('sbody').onclick = async e => {
  const a = e.target.dataset.a; if (!a) return;
  if (a.startsWith('r:')) { rangeKey = a.slice(2); sheet('report') }
  else if (a == 'addp') {
    const n = $('pn').value.trim().toLowerCase(), num = i => $(i).value === '' ? null : +$(i).value;
    if (!n) { alert('Product ka naam likhein.'); return }
    txs.push({ id: crypto.randomUUID(), ts: Date.now(), type: 'product', product: n, unit: $('pu').value, cost: num('pc'), price: num('pp'), qty: num('pq') || 0, min: num('pm'), total: 0 });
    store(); render(); sync(); sheet('stock');
  } else if (a == 'exp') {
    const u = URL.createObjectURL(new Blob([JSON.stringify(txs, null, 1)], { type: 'application/json' }));
    const l = document.createElement('a'); l.href = u; l.download = 'meri-dukan-backup-' + new Date().toISOString().slice(0, 10) + '.json'; l.click();
  } else if (sb && ['in', 'up', 'out'].includes(a)) {
    let r;
    if (a == 'out') r = await sb.auth.signOut();
    else { const c = { email: $('em').value.trim(), password: $('pw').value }; r = a == 'in' ? await sb.auth.signInWithPassword(c) : await sb.auth.signUp(c) }
    $('ss').textContent = r.error ? 'Masla: ' + r.error.message : (a == 'up' ? 'Account ban gaya. Agar email confirm mangay to confirm karke Login karein.' : a == 'in' ? 'Login ho gaya.' : 'Logout ho gaya.');
    if (a == 'in') sync();
  }
};

/* ---------- SYNC (safe: each entry has a unique id, so nothing is saved twice) ---------- */
async function sync() {
  if (!sb || !navigator.onLine) return;
  try {
    const { data: { session } } = await sb.auth.getSession(); if (!session) return;
    const todo = txs.filter(t => !sent.has(t.id));
    if (todo.length) {
      const { error } = await sb.from('entries').upsert(todo.map(t => ({ id: t.id, data: t })), { onConflict: 'id', ignoreDuplicates: true });
      if (error) throw error; todo.forEach(t => sent.add(t.id));
    }
    const have = new Set(txs.map(t => t.id));
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('entries').select('data').order('created_at').range(from, from + 999);
      if (error) throw error;
      data.forEach(r => { if (!have.has(r.data.id)) { txs.push(r.data); sent.add(r.data.id) } });
      if (data.length < 1000) break;
    }
    txs.sort((a, b) => a.ts - b.ts); store(); render();
  } catch (e) { console.warn('Sync baad mein hoga:', e.message || e) }
}

/* ---------- START ---------- */
if (SB_URL && SB_KEY && window.supabase) { sb = supabase.createClien
