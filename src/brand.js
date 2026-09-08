// Brand tokens, lifted verbatim from the crew Worker's src/brand.js so the two
// sites cannot drift apart. If a colour changes there, change it here too.
//
// PRIMARY (brand book p.14) — Pantone-matched, do not adjust:
//   SeaLink Navy      Pantone 287 C   #1f3d7c
//   SeaLink Mid Blue  Pantone 285 C   #0070b9
//   SeaLink Cyan      Pantone Cyan C  #00aeef
//   SeaLink Gold      Pantone 137 C   #faa21b
//
// TYPOGRAPHY (p.15): Fira Sans Condensed for headings, Roboto for body.
//
// Status colours come from the supporting digital palette on the same page.
// None of them is legible as text on white, so each is a tint for the pill
// background with the same hue darkened for the ink. Every pair clears WCAG AA
// for small text. If you change a base colour, re-check the pair.

export const BRAND_TOKENS = `
  --navy:#1f3d7c;
  --navy-deep:#172e5d;
  --mid-blue:#0070b9;
  --cyan:#00aeef;
  --gold:#faa21b;
  --gold-ink:#8d5703;
  --ink:#172e5d;
  --ink-quiet:#5b6b86;
  --rule:#dde2ea;

  --expired-bg:#fadddd; --expired-ink:#bb1a1e;
  --due-bg:#feeed6;     --due-ink:#8d5703;
  --soon-bg:#fff7cd;    --soon-ink:#776400;
  --plan-bg:#d6e8f4;    --plan-ink:#0063a3;
  --ok-bg:#dcf3ec;      --ok-ink:#246e58;
  --fault-bg:#f0eef6;   --fault-ink:#6950a1;
  --backlog-bg:#fdedf2; --backlog-ink:#bd113e;
  --none-bg:#dbd9d6;    --none-ink:#414d61;

  --tab-h:64px;
  --tab-w:calc(var(--tab-h) * 2.5724);
  --tab-clear:calc(var(--tab-w) * .10);

  --font-display:"Fira Sans Condensed","Helvetica Neue",Arial,sans-serif;
  --font-body:Roboto,"Helvetica Neue",Arial,sans-serif;
`;

// The masthead is WHITE with the navy angled tab on the left. The tab's
// surround is transparent and the tab itself is brand navy, so on a navy
// masthead the curve vanishes and only the wordmark shows. Anything styled
// from an assumption of a navy bar comes out white on white: present,
// correctly unhidden, and invisible.
//
// Clearspace is the width of the "S", approximated at 10% of tab width and
// calculated from --tab-w so it holds at every size.
export const LOGO_CSS = `
.masthead{
  background:#fff;color:var(--ink);
  height:auto;min-height:var(--tab-h);
  padding:0 20px 0 0;
  display:flex;flex-wrap:wrap;align-items:center;
  gap:0 var(--tab-clear);
  border-bottom:1px solid var(--rule);
  position:sticky;top:0;z-index:40;
}
.masthead .tab{display:block;height:var(--tab-h);width:auto;align-self:flex-start}
.masthead .opname{
  font-family:var(--font-display);font-weight:500;font-size:17px;
  color:var(--navy);letter-spacing:.01em;white-space:nowrap;
}
.masthead h1{
  margin:0;font-family:var(--font-display);letter-spacing:.01em;
  font-size:16px;font-weight:500;color:var(--navy);
  padding-left:var(--tab-clear);
  border-left:1px solid var(--rule);
}
.masthead .home{
  margin-left:auto;font-weight:500;color:var(--navy);text-decoration:none;
  border:1px solid var(--rule);border-radius:4px;padding:6px 12px;white-space:nowrap;
}
.masthead .home:hover{border-color:var(--navy);background:var(--none-bg)}
.masthead .stamp{color:var(--mid-blue);padding-left:14px;font-size:13px}
.masthead .who{font-size:13px;color:var(--ink-quiet);white-space:nowrap}
.masthead .who a{color:var(--navy)}
@media (max-width:640px){
  :root{--tab-h:48px}
  .masthead{padding-right:14px}
  .masthead .opname{font-size:15px}
  .masthead h1{font-size:15px;padding-left:10px}
  .masthead .stamp{
    padding:0 0 8px calc(var(--tab-w) + var(--tab-clear));
    flex-basis:100%;
  }
  .masthead .home{padding:5px 10px}
}
@media print{.masthead{border-bottom:0}}
`;

export const PAGE_CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#fff;color:var(--ink);font-family:var(--font-body);
  font-size:15px;line-height:1.45;font-variant-numeric:tabular-nums}
main{padding:0 20px 56px}
a{color:var(--navy)}

h2{margin:26px 0 2px;font-family:var(--font-display);font-size:20px;font-weight:500}
.subhead{margin:28px 0 10px;font-family:var(--font-display);letter-spacing:.02em;
  font-size:14px;font-weight:500;color:var(--ink-quiet)}
p.sub{margin:0 0 14px;color:var(--ink-quiet);font-size:13px}
.more{color:var(--ink-quiet);font-size:12px;display:block;margin-top:2px}

.notice{margin:18px 0 0;padding:11px 14px;border-radius:6px;font-size:14px;
  background:var(--due-bg);color:var(--gold-ink);border-left:3px solid var(--gold)}
.notice.plain{background:var(--fault-bg);color:var(--fault-ink);border-left-color:var(--fault-ink)}
.notice.calm{background:var(--plan-bg);color:var(--plan-ink);border-left-color:var(--mid-blue)}
.notice ul{margin:6px 0 0;padding-left:18px}
.notice a{color:inherit;font-weight:500}

.metrics{display:grid;gap:10px;margin:18px 0 0;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.metric{border:1px solid var(--rule);border-radius:8px;padding:12px 14px}
.metric.alert{border-color:var(--expired-ink);background:var(--expired-bg)}
.metric.warn{border-color:var(--gold);background:var(--due-bg)}
.metric.info{border-color:var(--fault-ink);background:var(--fault-bg)}
.metric .label{font-size:13px;color:var(--ink-quiet);line-height:1.3}
.metric.alert .label,.metric.warn .label,.metric.info .label{color:inherit;opacity:.85}
.metric .value{font-family:var(--font-display);font-size:27px;font-weight:500;
  margin-top:3px;line-height:1.1}
.metric .foot{font-size:12px;color:var(--ink-quiet);margin-top:2px}

.scroll{overflow:auto;-webkit-overflow-scrolling:touch;scrollbar-color:var(--navy) var(--rule)}
.scroll::-webkit-scrollbar{height:14px;width:14px}
.scroll::-webkit-scrollbar-track{background:var(--rule)}
.scroll::-webkit-scrollbar-thumb{background:var(--navy);border:3px solid var(--rule);border-radius:7px}
table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px}
th,td{padding:9px 10px;border-bottom:1px solid var(--rule);text-align:left;
  white-space:nowrap;vertical-align:top}
thead th{font-family:var(--font-display);font-weight:500;color:var(--ink-quiet);
  background:#fff;box-shadow:inset 0 -1px 0 var(--rule)}
td.num,th.num{text-align:right}
.wrapcol{white-space:normal;min-width:220px;max-width:430px}
caption{caption-side:bottom;text-align:left;padding:8px 0 0;color:var(--ink-quiet);
  font-size:12px;white-space:normal;max-width:78ch}
tr.total td{font-weight:500;border-top:2px solid var(--navy);background:#f7f9fc}
.absent{color:var(--none-ink);font-size:12px}
.absent::after{content:'not recorded'}

.pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;
  font-weight:500;white-space:nowrap}
.p-scheduled{background:var(--ok-bg);color:var(--ok-ink)}
.p-internal{background:var(--none-bg);color:var(--none-ink)}
.p-return{background:var(--plan-bg);color:var(--plan-ink)}
.p-extra{background:var(--due-bg);color:var(--due-ink)}
.p-other{background:var(--fault-bg);color:var(--fault-ink)}
.p-ship{background:var(--soon-bg);color:var(--soon-ink)}

nav.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 0;
  padding-bottom:12px;border-bottom:1px solid var(--rule)}
nav.tabs a{font-weight:500;color:var(--navy);text-decoration:none;
  border:1px solid var(--rule);border-radius:4px;padding:6px 12px;font-size:14px}
nav.tabs a:hover{border-color:var(--navy);background:var(--none-bg)}
nav.tabs a[aria-current="page"]{border-color:var(--navy);background:var(--plan-bg)}

form.card{max-width:360px;margin:0}
.panel{border:1px solid var(--rule);border-radius:8px;padding:14px 16px;
  max-width:520px;margin:12px 0 0}
label{display:block;font-size:14px;font-weight:500;margin:12px 0 6px}
input,select{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--rule);
  border-radius:6px;background:#fff;color:inherit}
button,.btn{font:inherit;font-weight:500;padding:9px 14px;border-radius:6px;
  cursor:pointer;border:1px solid var(--rule);background:#fff;color:inherit;
  text-decoration:none;display:inline-block;margin-top:14px}
button:hover,.btn:hover{border-color:var(--navy)}
button.primary{background:var(--navy);color:#fff;border-color:var(--navy);width:100%}
button.primary:hover{background:var(--navy-deep)}
button.small{margin:0;padding:4px 10px;font-size:12px}
:focus-visible{outline:2px solid var(--navy);outline-offset:2px}
.error{margin:0 0 14px;padding:10px 12px;background:var(--expired-bg);
  color:var(--expired-ink);border-radius:6px;font-size:14px}
.done{margin:0 0 14px;padding:10px 12px;background:var(--ok-bg);
  color:var(--ok-ink);border-radius:6px;font-size:14px}
p.note{margin-top:18px;font-size:13px;color:var(--ink-quiet)}
footer{margin:40px 20px 0;padding:14px 0;border-top:1px solid var(--rule);
  color:var(--ink-quiet);font-size:12px}
@media (max-width:640px){main{padding:0 14px 44px}footer{margin:32px 14px 0}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

export const FAVICON_TAGS =
  '<link rel="icon" href="/favicon.png" type="image/png">'
  + '<link rel="apple-touch-icon" href="/favicon.png">';

export const LOGO_BAR =
  '<img class="tab" src="/logo.png" alt="SeaLink Marine &amp; Tourism">'
  + '<span class="opname">Gladstone</span>';

/**
 * Every page goes through here, so every page gets the masthead, the Home
 * button and the tab row. A page that builds its own shell will drift.
 *
 * @param title    shown as the masthead h1
 * @param session  drives the tab row and the sign-out link
 * @param home     false on the landing page and sign-in page: one is home,
 *                 the other has nowhere to go until you have signed in
 * @param stamp    data-currency line, mid blue, next to the title
 */
export function page({ title, body, session, current, home = true, stamp, tabs }) {
  const row = tabs ?? defaultTabs(session);
  return new Response(`<!doctype html><html lang="en-AU">
<head>
<meta charset="utf-8">
${FAVICON_TAGS}
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Sans+Condensed:wght@400;500&family=Roboto:wght@300;400;500&display=swap" rel="stylesheet">
<title>${esc(title)} — SeaLink Gladstone</title>
<style>
:root{${BRAND_TOKENS}}
${PAGE_CSS}
${LOGO_CSS}
</style>
</head>
<body>
<header class="masthead">${LOGO_BAR}
  <h1>${esc(title)}</h1>
  ${stamp ? `<span class="stamp">${esc(stamp)}</span>` : ''}
  ${session ? `<span class="who">${esc(session.username)}${
    session.role === 'admin' ? ' · Operations' : ''} · <a href="/logout">Sign out</a></span>` : ''}
  ${home ? '<a class="home" href="/">Home</a>' : ''}
</header>
<main>
${row.length ? `<nav class="tabs" aria-label="Sections">${
  row.map((t) => `<a href="${esc(t.href)}"${
    t.href === current ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`).join('')
}</nav>` : ''}
${body}
</main>
<footer>SeaLink Gladstone · Curtis Island Assets Pty Ltd</footer>
</body>
</html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        + "font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self'; "
        + "frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

function defaultTabs(session) {
  if (!session) return [];
  if (session.role === 'admin') {
    return [
      { href: '/', label: 'Home' },
      { href: '/admin/accounts', label: 'Accounts' },
      { href: '/admin/unattributed', label: 'Attribution' },
    ];
  }
  return [{ href: '/', label: 'Home' }, { href: '/daily', label: 'Daily trip log' }];
}

/** Trip type to pill class. Unrecognised values still display, never switch. */
export function tripPill(runType) {
  const map = {
    'Scheduled Run': 'p-scheduled', 'Internal Run': 'p-internal',
    'Return Run': 'p-return', 'Extra Run': 'p-extra',
  };
  return map[runType] || 'p-other';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** A number, or a visibly distinct "not recorded" when it is absent. */
export function nn(v, dp = 2) {
  if (v === null || v === undefined) return '<span class="absent"></span>';
  return Number(v).toLocaleString('en-AU', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
