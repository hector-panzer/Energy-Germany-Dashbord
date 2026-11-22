/* Reiter „Netze“: Karte des Stromnetzes mit Engpässen, Redispatch und Grenzflüssen.
   Daten: netze/*.json (täglich per GitHub Action), SMARD live (Grenzflüsse, Preise). */
(function () {
"use strict";
const TZ = "Europe/Berlin", H = 3600000;
const nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fDayL = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const fChip = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" });
const fYmd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const css = v => getComputedStyle(document.querySelector(".ed")).getPropertyValue(v).trim();
const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const dayDate = ds => new Date(ds + "T12:00:00Z");
const GWh = mwh => nf1.format(mwh / 1000);

/* ---------------- Erklärungen hinter dem kleinen i ---------------- */
const INFO = {
  karte: `<b>Die Karte</b><p>Graue Linien sind Stromleitungen aus OpenStreetMap, einer frei bearbeitbaren Weltkarte. Dunkel: 380 kV und 400 kV, heller: 220 kV, ganz hell (zuschaltbar): 110 kV. Gestrichelt grün: Gleichstromleitungen (HGÜ).</p><p>220 und 380 kV bilden das <b>Übertragungsnetz</b>, betrieben von den vier Übertragungsnetzbetreibern 50Hertz, Amprion, TenneT und TransnetBW. Die 110-kV-Ebene gehört meist schon zum <b>Verteilnetz</b>.</p><p>Darüber liegen die Daten des gewählten Tages: Engpässe, Redispatch und Stromflüsse über die Grenzen. Tippe auf etwas, um Details zu sehen.</p>`,
  v380: `<b>380 kV (Höchstspannung)</b><p>Die „Autobahnen“ des Stromnetzes. Ein 380-kV-Stromkreis überträgt typischerweise 1,5 bis 2,5 GW. Im Ausland ist 400 kV üblich, das ist dieselbe Netzebene.</p>`,
  v220: `<b>220 kV</b><p>Ältere Ebene des Übertragungsnetzes. Viele 220-kV-Leitungen werden nach und nach auf 380 kV umgebaut.</p>`,
  v110: `<b>110 kV (Hochspannung)</b><p>Verteilt den Strom regional, z. B. zu Städten, Industrie und großen Wind- und Solarparks. Gehört meist den Verteilnetzbetreibern. Wird nur für Deutschland gezeigt, weil die Karte sonst sehr voll wird.</p>`,
  hgue: `<b>HGÜ (Hochspannungs-Gleichstrom-Übertragung)</b><p>Gleichstrom statt Wechselstrom. Lohnt sich bei langen Strecken und Seekabeln, weil weniger Verluste entstehen. Beispiele: NordLink nach Norwegen, die Offshore-Anbindungen in der Nordsee, künftig SuedLink und SuedOstLink. Anders als bei Wechselstrom kann man den Fluss auf einer HGÜ-Leitung direkt steuern.</p>`,
  cnec: `<b>Engpass (CNEC)</b><p>CNEC steht für <i>Critical Network Element and Contingency</i>: eine kritische Leitung oder ein Transformator (CNE), betrachtet für den Fall, dass ein anderes Element ausfällt (Contingency). Das Netz muss auch diesen Ausfall verkraften („n-1-Prinzip“).</p><p>Bei der europäischen Strombörse wird für jedes CNEC vorab berechnet, wie viel Handel zwischen den Ländern es noch verträgt. Auf der Karte siehst du nur die, die den Handel am gewählten Tag tatsächlich <b>begrenzt</b> haben.</p>`,
  bindend: `<b>Bindend</b><p>Ein Engpass ist bindend, wenn er in einer Viertelstunde den Handel begrenzt hat: Ohne ihn hätten die Länder mehr Strom ausgetauscht. Dann ist sein Schattenpreis größer als null.</p><p>Gezählt wird in Viertelstunden, weil der Day-Ahead-Markt seit 2025 in 15-Minuten-Schritten rechnet. 96 Viertelstunden sind ein ganzer Tag.</p>`,
  schatten: `<b>Schattenpreis</b><p>Der Wert, den 1 MW mehr Kapazität auf diesem Netzelement für den europäischen Markt in dieser Viertelstunde gehabt hätte, in €/MW. Mathematisch ist es der Lagrange-Multiplikator der Nebenbedingung „Fluss ≤ RAM“.</p><p>0 heißt: kein Problem. Ein hoher Wert heißt: Genau hier hat das Netz den Markt am stärksten ausgebremst. Die <b>Summe</b> über alle Viertelstunden zeigt, wie teuer der Engpass am ganzen Tag war.</p>`,
  fmax: `<b>Fmax</b><p>Wie viel Strom maximal über das Element fließen darf, bevor es thermisch überlastet ist, in MW. Berechnet aus dem zulässigen Strom (Imax) und der Spannung.</p>`,
  fref: `<b>Fref</b><p>Der Fluss, der im Referenzfall schon über das Element läuft, in MW, also bevor die Börse den grenzüberschreitenden Handel verteilt. Er kommt aus Erzeugung und Verbrauch in den Ländern selbst und aus Ringflüssen.</p>`,
  frm: `<b>FRM (Flow Reliability Margin)</b><p>Ein Sicherheitspuffer in MW. Er deckt ab, dass Prognosen zu Wind, Sonne und Verbrauch nie ganz stimmen.</p>`,
  ram: `<b>RAM (Remaining Available Margin)</b><p>Was nach Abzug von Grundlast und Puffer für den Handel übrig bleibt, in MW. Vereinfacht: RAM = Fmax − Fref − FRM (dazu kommen noch kleine Korrekturen der Netzbetreiber).</p><p>Ist das RAM eines Elements ausgeschöpft, ist es bindend.</p>`,
  mrf: `<b>Mindest-RAM</b><p>Anteil von Fmax, der mindestens für grenzüberschreitenden Handel freigehalten werden muss, in Prozent. Die EU verlangt grundsätzlich 70 %. Übergangsregeln und Ausnahmen der Länder erlauben teils niedrigere Werte.</p>`,
  cont: `<b>Angenommener Ausfall</b><p>Für welchen Ausfall dieses Element geprüft wurde. „Basecase“ heißt: ohne Ausfall, im Normalzustand.</p>`,
  zuordnung: `<b>Position auf der Karte</b><p>Die Börse nennt nur Namen wie „Diele – Meeden“. Das Dashboard sucht die beiden Umspannwerke in OpenStreetMap und verbindet sie mit einer <b>geraden</b> Linie. Der echte Leitungsverlauf ist die graue Linie darunter. Ein Kreis steht für einen Transformator in einem Umspannwerk. Engpässe, deren Namen nicht zugeordnet werden konnten, stehen nur in der Liste.</p>`,
  extern: `<b>External Constraint</b><p>Kein einzelnes Kabel, sondern eine Obergrenze, die ein Netzbetreiber für den gesamten Import oder Export einer Zone setzt, oft wegen der Systemstabilität oder einer Gleichstromleitung.</p>`,
  core: `<b>Region Core</b><p>13 Länder in Mitteleuropa (u. a. Deutschland/Luxemburg, Frankreich, Benelux, Österreich, Polen, Tschechien), die ihre Grenzkapazitäten gemeinsam mit dem <b>Flow-Based Market Coupling</b> berechnen. Daten: Joint Allocation Office (JAO).</p><p>Dänemark, Norwegen und Schweden sind über ihre Gleichstrom- und Grenzverbindungen angebunden, die Schweiz gehört nicht dazu.</p>`,
  redispatch: `<b>Redispatch</b><p>Die Börse tut innerhalb Deutschlands so, als gäbe es keine Leitungen, weil ganz Deutschland eine Preiszone ist. Passt das Ergebnis physikalisch nicht ins Netz, greifen die Netzbetreiber danach ein: Vor dem Engpass wird Erzeugung <b>abgeregelt</b> (rot), dahinter wird sie <b>hochgefahren</b> (blau). Die Energiemenge bleibt gleich, nur der Ort ändert sich.</p><p>Typisch: viel Wind im Norden, Abregelung dort, und Kraftwerke im Süden oder Westen fahren hoch. Die Kosten zahlen alle über die Netzentgelte.</p>`,
  rdort: `<b>Standorte</b><p>Die Netzbetreiber nennen nur den Anlagennamen. Das Dashboard sucht ihn in OpenStreetMap. Gestrichelte Kreise stehen für Sammelmeldungen ganzer Verteilnetzgebiete (oft viele abgeregelte Windparks) und sind nur ungefähr platziert. Meldungen ohne Ort (z. B. „Börse“) stehen in der Liste darunter.</p>`,
  countertrade: `<b>Countertrade</b><p>Statt ein bestimmtes Kraftwerk anzuweisen, handelt der Netzbetreiber über die Grenze gegen den Engpass, z. B. kauft er Strom in Dänemark und verkauft ihn in Deutschland. Deshalb steht dort oft „Börse“ als Anlage.</p>`,
  probe: `<b>Probefahrten</b><p>Testläufe von Reservekraftwerken. Sie sind kein Zeichen für einen Engpass und werden deshalb nicht mitgezählt.</p>`,
  physisch: `<b>Physikalischer Fluss</b><p>Wie viel Strom tatsächlich durch die Grenzleitungen geflossen ist (gemessen), als Tagesmenge und als Durchschnitt in GW. Quelle: SMARD.</p>`,
  handel: `<b>Geplanter Austausch</b><p>Was die Börse in der Marktkopplung zwischen den beiden Zonen vereinbart hat (kommerziell). Weicht vom physikalischen Fluss ab, weil Strom über Umwege und durch Nachbarländer fließt (Ringflüsse). Quelle: JAO.</p>`,
  maxbex: `<b>Maximal möglicher Austausch (MaxBex)</b><p>Wie viel zwischen den beiden Zonen höchstens hätte gehandelt werden können, wenn an allen anderen Grenzen nichts gehandelt worden wäre, in MW (Tagesdurchschnitt). Ein theoretischer Höchstwert aus dem Flow-Based-Verfahren.</p><p>Liegt der geplante Austausch nahe am Maximum und unterscheiden sich die Preise stark, war die Grenze ein Engpass.</p>`,
  preis: `<b>Preisunterschied</b><p>Tagesdurchschnitt des Day-Ahead-Preises im Nachbarland minus Deutschland. Sind die Preise gleich, reichte die Leitungskapazität. Ein großer Unterschied heißt: Die Händler hätten gern mehr Strom über die Grenze geschickt, das Netz ließ es nicht zu.</p>`
};
let pop;
function openInfo(btn) {
  closeInfo();
  const key = btn.dataset.info; if (!INFO[key]) return;
  pop = el("div", "ed-pop"); pop.setAttribute("role", "dialog"); pop.innerHTML = INFO[key];
  const x = el("button", "ed-pop-x", "×"); x.setAttribute("aria-label", "Schließen"); x.addEventListener("click", closeInfo); pop.prepend(x);
  document.querySelector(".ed").appendChild(pop);
  const r = btn.getBoundingClientRect(), W = Math.min(340, window.innerWidth - 20);
  pop.style.width = W + "px";
  let left = r.left + r.width / 2 - W / 2; left = Math.max(10, Math.min(window.innerWidth - W - 10, left));
  pop.style.left = left + "px";
  const below = r.bottom + 8, ph = pop.offsetHeight;
  pop.style.top = (below + ph > window.innerHeight - 10 && r.top - ph - 8 > 10 ? r.top - ph - 8 : below) + "px";
  btn.setAttribute("aria-expanded", "true"); pop._btn = btn;
}
function closeInfo() { if (pop) { if (pop._btn) pop._btn.setAttribute("aria-expanded", "false"); pop.remove(); pop = null; } }
document.addEventListener("click", ev => {
  const b = ev.target.closest(".ed-i");
  if (b) { ev.preventDefault(); ev.stopPropagation(); if (pop && pop._btn === b) closeInfo(); else openInfo(b); return; }
  if (pop && !pop.contains(ev.target)) closeInfo();
}, true);
document.addEventListener("keydown", ev => { if (ev.key === "Escape") closeInfo(); });
window.addEventListener("scroll", closeInfo, { passive: true });
function iBtn(key, label) { const b = el("button", "ed-i", "i"); b.type = "button"; b.dataset.info = key; b.setAttribute("aria-label", "Erklärung" + (label ? ": " + label : "")); b.setAttribute("aria-expanded", "false"); return b; }
window.EDInfo = { iBtn };

/* ---------------- Länder ---------------- */
const COUNTRIES = [
  { n: "Dänemark", k: "DK", spread: "DE_DK1", smard: [4736, 4880], price: [252, 253], pl: ["DK1", "DK2"], at: [55.45, 9.35], de: [54.55, 9.45],
    jao: { maxOut: ["DE_DE_DK1_VH", "DE_DE_DK2_BigHub"], maxIn: ["DE_DK1_VH_DE", "DE_DK2_BigHub_DE"], schOut: ["DE_DK1_VH", "DE_DK2_BIGHUB_VH"], schIn: ["DK1_VH_DE", "DK2_BIGHUB_VH_DE"] } },
  { n: "Niederlande", k: "NL", spread: "DE_NL", smard: [4739, 4883], price: [256], at: [52.35, 5.75], de: [52.4, 7.15],
    jao: { maxOut: ["DE_NL"], maxIn: ["NL_DE"], schOut: ["DE_NL"], schIn: ["NL_DE"] } },
  { n: "Belgien", k: "BE", spread: "DE_BE", smard: [4992, 4994], price: [4996], at: [50.62, 5.0], de: [50.72, 6.25],
    jao: { maxOut: ["DE_BE"], maxIn: ["BE_DE"], schOut: ["DE_BE"], schIn: ["BE_DE"] } },
  { n: "Luxemburg", k: "LU", smard: [4738, 4882], price: [4169], at: [49.72, 6.0], de: [49.8, 6.75], sameZone: true },
  { n: "Frankreich", k: "FR", spread: "DE_FR", smard: [4737, 4881], price: [254], at: [48.55, 6.25], de: [48.75, 7.95],
    jao: { maxOut: ["DE_FR"], maxIn: ["FR_DE"], schOut: ["DE_FR"], schIn: ["FR_DE"] } },
  { n: "Schweiz", k: "CH", smard: [4743, 4887], price: [259], at: [46.95, 8.15], de: [47.75, 8.55] },
  { n: "Österreich", k: "AT", spread: "DE_AT", smard: [4740, 4884], price: [4170], at: [47.4, 13.6], de: [48.05, 12.35],
    jao: { maxOut: ["DE_AT"], maxIn: ["AT_DE"], schOut: ["DE_AT"], schIn: ["AT_DE"] } },
  { n: "Tschechien", k: "CZ", spread: "DE_CZ", smard: [4744, 4888], price: [261], at: [49.95, 14.35], de: [50.3, 12.95],
    jao: { maxOut: ["DE_CZ"], maxIn: ["CZ_DE"], schOut: ["DE_CZ"], schIn: ["CZ_DE"] } },
  { n: "Polen", k: "PL", spread: "DE_PL", smard: [4741, 4885], price: [257], at: [52.35, 16.0], de: [52.4, 14.35],
    jao: { maxOut: ["DE_PL"], maxIn: ["PL_DE"], schOut: ["DE_PL"], schIn: ["PL_DE"] } },
  { n: "Schweden", k: "SE", smard: [4742, 4886], price: [258], pl: ["SE4"], at: [55.85, 13.6], de: [54.35, 12.4],
    jao: { maxOut: ["DE_DE_SE4_Baltic"], maxIn: ["DE_SE4_Baltic_DE"], schOut: ["DE_SE4_BALTIC_VH"], schIn: ["SE4_BALTIC_VH_DE"] } },
  { n: "Norwegen", k: "NO", smard: [4988, 4990], price: [4997], pl: ["NO2"], at: [57.75, 7.4], de: [54.35, 8.55],
    jao: { maxOut: ["DE_DE_NO2_BigHub"], maxIn: ["DE_NO2_BigHub_DE"], schOut: ["DE_NO2_BIGHUB_VH"], schIn: ["NO2_BIGHUB_VH_DE"] } }
];

/* ---------------- Zustand ---------------- */
let D = null, GHS = null, G110 = null, SM = null, day = null, map = null, L = null;
const lay = { hs: true, l110: false, cnec: true, rd: true, flow: true };
const layerObj = {};
let selLayer = null, inited = false, lineIndex = [];

function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Laden fehlgeschlagen: " + src)); document.head.appendChild(s); }); }
function loadCss(href) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.appendChild(l); }
async function getJSON(u) { const r = await fetch(u, { cache: "no-cache" }); if (!r.ok) throw new Error(r.status + " " + u); return r.json(); }

/* ---------------- SMARD: Grenzflüsse und Preise je Tag ---------------- */
const SMARD = "https://www.smard.de/app/chart_data/";
async function smardSeries(id, region, res) {
  const idx = (await getJSON(`${SMARD}${id}/${region}/index_${res}.json`)).timestamps.slice(-3);
  const parts = await Promise.all(idx.map(t => getJSON(`${SMARD}${id}/${region}/${id}_${region}_${res}_${t}.json`).then(d => d.series).catch(() => [])));
  const m = new Map(); parts.forEach(p => p.forEach(([t, v]) => { if (v != null) m.set(t, v); })); return m;
}
function perDay(m, fn) {
  const o = {}; m.forEach((v, t) => { const d = fYmd.format(t); (o[d] = o[d] || []).push(v); });
  const r = {}; for (const d in o) r[d] = fn(o[d]); return r;
}
async function loadSmard() {
  const sum = a => a.reduce((s, v) => s + Math.abs(v), 0);
  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
  const flows = await Promise.all(COUNTRIES.map(c => Promise.all([smardSeries(c.smard[0], "DE", "hour"), smardSeries(c.smard[1], "DE", "hour")])
    .then(([e, i]) => ({ e: perDay(e, sum), i: perDay(i, sum), en: perDay(e, a => a.length) })).catch(() => null)));
  const pids = [...new Set([4169].concat(...COUNTRIES.map(c => c.price)))];
  const prices = {};
  await Promise.all(pids.map(id => smardSeries(id, "DE-LU", "quarterhour").then(m => { prices[id] = perDay(m, a => a.length >= 20 ? avg(a) : null); })
    .catch(() => smardSeries(id, "DE-LU", "hour").then(m => { prices[id] = perDay(m, a => a.length >= 12 ? avg(a) : null); }).catch(() => {}))));
  return { flows, prices };
}

/* ---------------- Start ---------------- */
async function init() {
  inited = true;
  $("nzSub").textContent = "Lade Karte und Netzdaten …";
  loadCss("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css");
  const leaflet = loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js");
  const v = "?v=" + Math.floor(Date.now() / 600000);
  const pD = getJSON("netze/netze.json" + v).catch(e => { console.warn(e); return null; });
  const pG = getJSON("netze/grid_hs.json" + v).catch(e => { console.warn(e); return null; });
  const pS = loadSmard().catch(e => { console.warn(e); return null; });
  try { await leaflet; } catch (e) { $("nzSub").textContent = "Die Kartenbibliothek konnte nicht geladen werden. Bitte später neu laden."; return; }
  L = window.L;
  [D, GHS] = await Promise.all([pD, pG]);
  buildMap();
  if (!D) { $("nzSub").textContent = "Die Netzdaten werden gerade zum ersten Mal erzeugt. Schau in ein paar Minuten wieder vorbei."; }
  const days = D ? D.tage.filter(d => (D.jao[d] && D.jao[d].cnecs) || (D.redispatch[d] && D.redispatch[d].plants)) : [];
  day = days[days.length - 1] || null;
  buildDays(days);
  drawGrid();
  renderDay();
  pS.then(s => { SM = s; renderFlows(); renderBorders(); });
}

function buildDays(days) {
  const box = $("nzDays"); box.textContent = "";
  days.slice(-7).forEach(d => {
    const b = el("button", null, fChip.format(dayDate(d)).replace(".,", ","));
    b.setAttribute("aria-pressed", d === day); b.addEventListener("click", () => { day = d; box.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderDay(); });
    box.appendChild(b);
  });
  box.scrollLeft = box.scrollWidth;
}

/* ---------------- Karte ---------------- */
function dark() { return css("--page").toLowerCase() === "#0d0d0d"; }
let base, labels;
function setTiles() {
  const th = dark() ? "dark" : "light";
  const opt = { subdomains: "abcd", maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende · © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>' };
  if (base) map.removeLayer(base); if (labels) map.removeLayer(labels);
  base = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${th}_nolabels/{z}/{x}/{y}{r}.png`, opt).addTo(map);
  labels = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${th}_only_labels/{z}/{x}/{y}{r}.png`, { subdomains: "abcd", maxZoom: 18, pane: "labels" }).addTo(map);
}
function buildMap() {
  map = L.map("nzMap", { zoomSnap: 0.25, preferCanvas: true, attributionControl: true, scrollWheelZoom: false, worldCopyJump: false, minZoom: 4, maxZoom: 13 });
  map.attributionControl.setPrefix(false);
  map.createPane("labels"); map.getPane("labels").style.zIndex = 450; map.getPane("labels").style.pointerEvents = "none";
  map.createPane("grid"); map.getPane("grid").style.zIndex = 350;
  map.createPane("over"); map.getPane("over").style.zIndex = 500;
  map.createPane("arrows"); map.getPane("arrows").style.zIndex = 520;
  map.createPane("sel"); map.getPane("sel").style.zIndex = 540; map.getPane("sel").style.pointerEvents = "none";
  const home = () => map.fitBounds([[47.2, 5.8], [55.1, 15.1]], { padding: [4, 4] });
  home(); let touched = false; map.on("dragstart zoomstart", e => { if (e.hard !== false && map._loaded) touched = true; });
  layerObj.home = home; setTimeout(() => { map.invalidateSize(); if (!touched) home(); touched = false; }, 60);
  setTiles();
  map.on("click", ev => pickLine(ev));
  map.on("focus", () => map.scrollWheelZoom.enable());
  map.getContainer().addEventListener("mouseleave", () => map.scrollWheelZoom.disable());
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setTimeout(() => { setTiles(); drawGrid(); renderDay(); renderFlows(); }, 50));
  const R = L.canvas({ padding: 0.3, pane: "grid", tolerance: 0 });
  layerObj.renderer = R;
  const ro = new ResizeObserver(() => map.invalidateSize()); ro.observe($("nzMap"));
  buildLayerToggles();
}
function decode(enc) { const pts = []; let x = 0, y = 0; for (let i = 0; i < enc.length; i += 2) { x += enc[i]; y += enc[i + 1]; pts.push([y / 1000, x / 1000]); } return pts; }
function lineClass(l) { const [v, flags] = l; if (flags & 2) return "dc"; if (v >= 300) return "380"; if (v >= 200) return "220"; return "110"; }
function gridStyle(cls, cable) {
  const d = dark();
  const s = {
    "380": { color: d ? "#c3c2b7" : "#52514e", weight: 1.6, opacity: d ? 0.75 : 0.8 },
    "220": { color: d ? "#898781" : "#898781", weight: 1.2, opacity: 0.75 },
    "110": { color: d ? "#5a5955" : "#b5b3ab", weight: 0.8, opacity: 0.8 },
    "dc": { color: css("--c-wasser"), weight: 2, opacity: 0.9, dashArray: "5 4" }
  }[cls];
  return Object.assign({ renderer: layerObj.renderer, pane: "grid", interactive: false, lineCap: "round" }, s, cable && cls !== "dc" ? { dashArray: "2 3" } : {});
}
function drawGrid() {
  if (!map) return;
  ["g380", "g220", "gdc", "g110", "g380c", "g220c", "g110c"].forEach(k => { if (layerObj[k]) { map.removeLayer(layerObj[k]); delete layerObj[k]; } });
  lineIndex = [];
  const add = (src, only110) => {
    const groups = {};
    (src ? src.lines : []).forEach(l => {
      const cls = lineClass(l); if (only110 !== (cls === "110")) return;
      const cable = (l[1] & 1) && cls !== "dc";
      const pts = decode(l[5]); const key = "g" + cls + (cable ? "c" : "");
      (groups[key] = groups[key] || []).push(pts);
      let s = 90, w = 180, n = -90, e = -180; pts.forEach(([a, b]) => { if (a < s) s = a; if (a > n) n = a; if (b < w) w = b; if (b > e) e = b; });
      lineIndex.push({ l, pts, bb: [s, w, n, e], cls });
    });
    for (const k in groups) { const cable = k !== "gdc" && k.endsWith("c"); layerObj[k] = L.polyline(groups[k], gridStyle(cable ? k.slice(1, -1) : k.slice(1), cable)); }
  };
  if (lay.hs) add(GHS, false);
  if (lay.l110 && G110) add(G110, true);
  ["g110", "g110c", "g220", "g220c", "g380", "g380c", "gdc"].forEach(k => layerObj[k] && layerObj[k].addTo(map));
  renderLegend();
}
function pickLine(ev) {
  if (!lineIndex.length) return;
  const p = map.latLngToContainerPoint(ev.latlng), tol = 7;
  const d = map.containerPointToLatLng([p.x + tol, p.y + tol]), dLat = Math.abs(d.lat - ev.latlng.lat), dLng = Math.abs(d.lng - ev.latlng.lng);
  const la = ev.latlng.lat, lo = ev.latlng.lng; let best = null, bd = tol * tol;
  for (const it of lineIndex) {
    const [s, w, n, e] = it.bb; if (la < s - dLat || la > n + dLat || lo < w - dLng || lo > e + dLng) continue;
    let prev = null;
    for (const q of it.pts) { const c = map.latLngToContainerPoint(q); if (prev) { const dd = segDist(p, prev, c); if (dd < bd) { bd = dd; best = it; } } prev = c; }
  }
  if (best) { select(L.polyline(best.pts, { pane: "sel", color: css("--c-pv"), weight: 5, opacity: 0.55, interactive: false })); showLine(best); }
}
function segDist(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy; let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); const x = a.x + t * dx - p.x, y = a.y + t * dy - p.y; return x * x + y * y; }
function select(layer) { if (selLayer) map.removeLayer(selLayer); selLayer = layer; if (layer) layer.addTo(map); }

/* ---------------- Ebenen ---------------- */
function buildLayerToggles() {
  const box = $("nzLayers"); box.textContent = "";
  const items = [["hs", "Übertragungsnetz", "karte"], ["l110", "110 kV", "v110"], ["cnec", "Engpässe", "cnec"], ["rd", "Redispatch", "redispatch"], ["flow", "Grenzflüsse", "physisch"]];
  items.forEach(([k, name, info]) => {
    const w = el("span", "nz-chip");
    const lab = el("label"); const cb = el("input"); cb.type = "checkbox"; cb.checked = lay[k];
    cb.addEventListener("change", async () => {
      lay[k] = cb.checked;
      if (k === "l110" && cb.checked && !G110) { lab.classList.add("busy"); try { G110 = await getJSON("netze/grid_110.json?v=" + Math.floor(Date.now() / 600000)); } catch (e) { cb.checked = lay[k] = false; alert("Die 110-kV-Daten sind noch nicht verfügbar."); } lab.classList.remove("busy"); }
      if (k === "hs" || k === "l110") drawGrid(); else if (k === "flow") renderFlows(); else renderDay();
    });
    lab.append(cb, document.createTextNode(" " + name)); w.append(lab, iBtn(info, name)); box.appendChild(w);
  });
}
function renderLegend() {
  const lg = $("nzLegend"); lg.textContent = "";
  const add = (sw, txt, info) => { const s = el("span"); s.appendChild(sw); s.appendChild(document.createTextNode(txt)); if (info) s.appendChild(iBtn(info, txt)); lg.appendChild(s); };
  const ln = (c, w, dash, op) => { const i = el("i", "ln"); i.style.borderTop = `${w}px ${dash ? "dashed" : "solid"} ${c}`; if (op) i.style.opacity = op; return i; };
  const d = dark();
  if (lay.hs) { add(ln(d ? "#c3c2b7" : "#52514e", 2), "380/400 kV", "v380"); add(ln("#898781", 2), "220 kV", "v220"); add(ln(css("--c-wasser"), 2, true), "Gleichstrom (HGÜ)", "hgue"); }
  if (lay.l110) add(ln(d ? "#5a5955" : "#b5b3ab", 2), "110 kV", "v110");
  if (lay.cnec) add(ln(css("--c-pv"), 4), "bindender Engpass", "cnec");
  if (lay.flow) { add(ln(css("--pos"), 4), "Export", "physisch"); add(ln(css("--neg"), 4), "Import über die Grenze", null); }
  if (lay.rd) { const a = el("i", "dot"); a.style.background = css("--neg"); add(a, "abgeregelt", "redispatch"); const b = el("i", "dot"); b.style.background = css("--pos"); add(b, "hochgefahren", null); }
}

/* ---------------- Tagesdaten auf der Karte ---------------- */
function cnecsOf(d) { return (D && D.jao[d] && D.jao[d].cnecs) || []; }
function rdOf(d) { return (D && D.redispatch[d]) || null; }
function renderDay() {
  if (!map) return;
  ["cnec", "rd"].forEach(k => { if (layerObj[k]) { map.removeLayer(layerObj[k]); delete layerObj[k]; } });
  select(null);
  if (day) $("nzSub").textContent = "Daten für " + fDayL.format(dayDate(day)) + " · Netzkarte aus OpenStreetMap";
  else if (D) $("nzSub").textContent = "Für die letzten Tage liegen noch keine Daten vor.";
  // Redispatch
  const rd = rdOf(day);
  if (lay.rd && rd) {
    const g = L.layerGroup();
    const maxE = Math.max(1, ...rd.plants.map(p => p.up + p.down));
    rd.plants.filter(p => p.geo).sort((a, b) => (b.up + b.down) - (a.up + a.down)).forEach(p => {
      const e = p.up + p.down, net = p.up - p.down, approx = p.geo[3] === 1;
      const r = 3 + 19 * Math.sqrt(e / maxE);
      const c = net >= 0 ? css("--pos") : css("--neg");
      const m = L.circleMarker([p.geo[0], p.geo[1]], { pane: "over", radius: r, color: c, weight: approx ? 1.5 : 1, opacity: 0.95, dashArray: approx ? "3 3" : null, fillColor: c, fillOpacity: approx ? 0.12 : 0.38, bubblingMouseEvents: false });
      m.bindTooltip(p.name + " · " + GWh(e) + " GWh", { direction: "top", sticky: true, opacity: 0.95 });
      m.on("click", ev => { L.DomEvent.stop(ev); select(L.circleMarker(m.getLatLng(), { pane: "sel", radius: r + 4, color: css("--ink"), weight: 2, fill: false })); showPlant(p); });
      g.addLayer(m);
    });
    layerObj.rd = g.addTo(map);
  }
  // Engpässe
  const cs = cnecsOf(day);
  if (lay.cnec && cs.length) {
    const g = L.layerGroup();
    const maxS = Math.max(1, ...cs.map(c => c.sum));
    cs.filter(c => c.geo && c.geo.length).slice().reverse().forEach(c => {
      const w = 2.5 + 6 * Math.sqrt(c.sum / maxS), col = css("--c-pv");
      let m;
      if (c.geo.length === 2) m = L.polyline([[c.geo[0][0], c.geo[0][1]], [c.geo[1][0], c.geo[1][1]]], { pane: "over", color: col, weight: w, opacity: 0.9, lineCap: "round", bubblingMouseEvents: false });
      else m = L.circleMarker([c.geo[0][0], c.geo[0][1]], { pane: "over", radius: 4 + w, color: col, weight: 3, fillColor: col, fillOpacity: 0.25, bubblingMouseEvents: false });
      m.bindTooltip(c.name.trim() + " · Σ " + nf0.format(c.sum) + " €/MW", { sticky: true, opacity: 0.95 });
      m.on("click", ev => { L.DomEvent.stop(ev); highlightCnec(c); showCnec(c); });
      g.addLayer(m);
    });
    layerObj.cnec = g.addTo(map);
  }
  renderLegend();
  renderTiles(); renderCnecList(); renderRd(); renderFlows(); renderBorders();
  showDefault();
}
function highlightCnec(c) {
  if (!c.geo || !c.geo.length) { select(null); return; }
  if (c.geo.length === 2) select(L.polyline([[c.geo[0][0], c.geo[0][1]], [c.geo[1][0], c.geo[1][1]]], { pane: "sel", color: css("--ink"), weight: 3, dashArray: "6 5", opacity: 0.9 }));
  else select(L.circleMarker([c.geo[0][0], c.geo[0][1]], { pane: "sel", radius: 16, color: css("--ink"), weight: 2, fill: false }));
}

/* ---------------- Grenzflüsse ---------------- */
function borderData(c) {
  const o = { c };
  if (SM && SM.flows) { const i = COUNTRIES.indexOf(c), f = SM.flows[i]; if (f && f.e[day] != null) { o.exp = f.e[day]; o.imp = f.i[day] || 0; o.hours = f.en[day]; } }
  if (SM && SM.prices) {
    const de = SM.prices[4169] && SM.prices[4169][day];
    const ps = c.price.map(id => SM.prices[id] && SM.prices[id][day]).filter(v => v != null);
    if (de != null) o.pDE = de; if (ps.length) o.p = c.price.map(id => SM.prices[id] && SM.prices[id][day]);
  }
  const b = D && D.jao[day] && D.jao[day].borders;
  if (b && c.jao) {
    const s = (keys, f) => { const v = keys.map(k => b[k] && b[k][f]).filter(x => x != null); return v.length ? v.reduce((a, x) => a + x, 0) : null; };
    o.maxOut = s(c.jao.maxOut, "max_avg"); o.maxIn = s(c.jao.maxIn, "max_avg");
    o.schOut = s(c.jao.schOut, "sched_avg"); o.schIn = s(c.jao.schIn, "sched_avg");
  }
  if (b && c.spread && b[c.spread] && b[c.spread].spread_avg != null) o.spread = b[c.spread].spread_avg;
  o.diff = (o.p && o.p[0] != null && o.pDE != null) ? o.p[0] - o.pDE : (o.spread != null ? o.spread : null);
  return o;
}
function renderFlows() {
  if (!map) return;
  if (layerObj.flow) { map.removeLayer(layerObj.flow); delete layerObj.flow; }
  if (!lay.flow || !day) return;
  const g = L.layerGroup();
  const bds = COUNTRIES.map(borderData);
  const maxF = Math.max(1, ...bds.map(b => b.exp != null ? Math.abs(b.exp - b.imp) : 0));
  bds.forEach(b => {
    const c = b.c;
    const has = b.exp != null, net = has ? b.exp - b.imp : 0, gw = has ? net / (b.hours || 24) / 1000 : 0;
    if (has && Math.abs(gw) >= 0.02) {
      const from = net >= 0 ? c.de : c.at, to = net >= 0 ? c.at : c.de, col = net >= 0 ? css("--pos") : css("--neg");
      const w = 2 + 7 * Math.sqrt(Math.abs(net) / maxF);
      const cut = shorten(from, to, 0.62);
      g.addLayer(L.polyline([from, cut], { pane: "arrows", color: col, weight: w, opacity: 0.85, lineCap: "butt", interactive: false }));
      g.addLayer(L.polygon(arrowHead(from, cut, w), { pane: "arrows", color: col, weight: 0, fillColor: col, fillOpacity: 0.9, interactive: false }));
    }
    const lab = has ? (Math.abs(gw) < 0.05 ? "±0" : nf1.format(Math.abs(gw)) + " GW") : "–";
    const col = !has || Math.abs(gw) < 0.05 ? "" : ` style="color:var(${net >= 0 ? "--pos" : "--neg"})"`;
    const icon = L.divIcon({ className: "nz-cty", html: `<b>${c.k}</b><span${col}>${lab}</span>`, iconSize: null });
    const m = L.marker(c.at, { icon, pane: "arrows", keyboard: true, title: c.n, bubblingMouseEvents: false });
    m.on("click", ev => { L.DomEvent.stop(ev); select(null); showBorder(b); });
    g.addLayer(m);
  });
  layerObj.flow = g.addTo(map);
}
function shorten(a, b, f) { return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; }
function arrowHead(a, b, w) {
  const k = Math.cos(b[0] * Math.PI / 180), z = map.getZoom();
  const s = (w * 1.1 + 5) * 360 / (256 * Math.pow(2, z));
  const dx = (b[1] - a[1]) * k, dy = b[0] - a[0], len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  const tip = [b[0] + uy * s * 1.3, b[1] + ux * s * 1.3 / k];
  const l = [b[0] + ux * s * 0.8, b[1] - uy * s * 0.8 / k], r = [b[0] - ux * s * 0.8, b[1] + uy * s * 0.8 / k];
  return [tip, l, r];
}

/* ---------------- Detailbereich ---------------- */
function detail() { const d = $("nzDetail"); d.textContent = ""; return d; }
function kv(box, label, value, info) {
  const r = el("div", "nz-kv"); const a = el("span", "k", label); if (info) a.appendChild(iBtn(info, label)); r.append(a, el("b", null, value)); box.appendChild(r);
}
function showDefault() {
  const d = detail();
  d.appendChild(el("div", "nz-hint", "Tippe auf eine orange Linie (Engpass), einen Kreis (Redispatch), ein Länderkürzel oder eine graue Leitung, um hier Details zu sehen."));
}
function showLine(it) {
  const d = detail(), l = it.l;
  d.appendChild(el("div", "nz-cat", { "380": "Höchstspannungsleitung", "220": "Höchstspannungsleitung", "110": "Hochspannungsleitung", "dc": "Gleichstromleitung (HGÜ)" }[it.cls]));
  d.appendChild(el("h3", null, l[2] || "Leitung ohne Namen"));
  kv(d, "Spannung", nf0.format(l[0]) + " kV", { "380": "v380", "220": "v220", "110": "v110", "dc": "hgue" }[it.cls]);
  if (l[3]) kv(d, "Betreiber", l[3]);
  if (l[4]) kv(d, "Stromkreise", l[4]);
  kv(d, "Bauart", (l[1] & 1) ? "Kabel (unterirdisch oder Seekabel)" : "Freileitung");
  d.appendChild(el("p", "muted", "Aus OpenStreetMap. Wie stark eine einzelne Leitung ausgelastet ist, veröffentlichen die Netzbetreiber nicht."));
}
function strip96(q) {
  const s = el("div", "nz-strip"); const mx = Math.max(1, ...q);
  q.forEach((v, i) => { const c = el("i"); if (v > 0) { c.style.background = css("--c-pv"); c.style.opacity = 0.35 + 0.65 * Math.sqrt(v / mx); } c.title = String(Math.floor(i / 4)).padStart(2, "0") + ":" + String(i % 4 * 15).padStart(2, "0") + (v > 0 ? " · " + nf1.format(v) + " €/MW" : ""); s.appendChild(c); });
  const ax = el("div", "nz-strip-ax"); ["0", "6", "12", "18", "24 Uhr"].forEach(t => ax.appendChild(el("span", null, t)));
  const w = el("div"); w.append(s, ax); return w;
}
function showCnec(c) {
  const d = detail();
  const cat = el("div", "nz-cat", c.kind === "extern" ? "Externe Grenze" : (c.kind === "trafo" ? "Transformator · bindender Engpass" : "Leitung · bindender Engpass"));
  cat.appendChild(iBtn(c.kind === "extern" ? "extern" : "cnec")); d.appendChild(cat);
  d.appendChild(el("h3", null, c.name.trim()));
  kv(d, "Netzbetreiber", c.tso + (c.de ? " (Deutschland)" : ""));
  if (c.cont) kv(d, "Angenommener Ausfall", c.cont.replace(/^N-1\s*/i, ""), "cont");
  kv(d, "Bindend", c.qh + " von 96 Viertelstunden", "bindend");
  const sp = el("div", "nz-sub2"); sp.appendChild(document.createTextNode("Schattenpreis")); sp.appendChild(iBtn("schatten", "Schattenpreis")); d.appendChild(sp);
  kv(d, "Summe über den Tag", nf0.format(c.sum) + " €/MW"); kv(d, "Höchster Wert", nf1.format(c.max) + " €/MW");
  d.appendChild(strip96(c.q || []));
  if (c.fmax != null) {
    const sp2 = el("div", "nz-sub2", "Kapazität im Schnitt der bindenden Viertelstunden"); d.appendChild(sp2);
    d.appendChild(capBar(c));
    kv(d, "Fmax", nf0.format(c.fmax) + " MW", "fmax");
    if (c.fref != null) kv(d, "Fref", nf0.format(c.fref) + " MW", "fref");
    if (c.frm != null) kv(d, "FRM", nf0.format(c.frm) + " MW", "frm");
    if (c.ram != null) kv(d, "RAM", nf0.format(c.ram) + " MW", "ram");
    if (c.mrf != null) kv(d, "Mindest-RAM", nf0.format(c.mrf) + " %", "mrf");
  }
  const z = el("p", "muted"); z.textContent = c.geo && c.geo.length ? "Auf der Karte: " + c.geo.map(g => g[2]).join(" – ") + " " : "Keine Kartenposition gefunden. "; z.appendChild(iBtn("zuordnung")); d.appendChild(z);
}
function capBar(c) {
  const box = el("div", "nz-cap");
  const fm = c.fmax || 1, segs = [["Fref", Math.max(0, Math.min(c.fref || 0, fm)), "--axis"], ["FRM", Math.max(0, c.frm || 0), "--muted"], ["RAM", Math.max(0, c.ram || 0), "--c-pv"]];
  const tot = Math.max(fm, segs.reduce((s, x) => s + x[1], 0));
  const bar = el("div", "bar"); segs.forEach(([n, v, col]) => { if (v <= 0) return; const s = el("div"); s.style.width = (v / tot * 100) + "%"; s.style.background = css(col); s.title = n + ": " + nf0.format(v) + " MW"; bar.appendChild(s); });
  const leg = el("div", "ed-legend"); segs.forEach(([n, , col]) => { const s = el("span"); const i = el("i"); i.style.background = css(col); s.append(i, document.createTextNode(n)); leg.appendChild(s); });
  box.append(bar, leg); return box;
}
function showPlant(p) {
  const d = detail();
  const cat = el("div", "nz-cat", "Redispatch · " + (p.pe || "")); cat.appendChild(iBtn("redispatch")); d.appendChild(cat);
  d.appendChild(el("h3", null, p.name));
  if (p.up) kv(d, "Hochgefahren", GWh(p.up) + " GWh");
  if (p.down) kv(d, "Abgeregelt", GWh(p.down) + " GWh");
  kv(d, "Größte Leistung", nf0.format(p.maxmw) + " MW");
  kv(d, "Maßnahmen", String(p.n));
  kv(d, "Angewiesen von", p.uenb);
  kv(d, "Grund", p.grund.join(", "), p.grund.some(g => /countertrade/i.test(g)) ? "countertrade" : null);
  const z = el("p", "muted"); z.textContent = p.geo ? "Ort: " + p.geo[2] + (p.geo[3] === 1 ? " (ungefähr) " : " ") : "Kein Ort zugeordnet. "; z.appendChild(iBtn("rdort")); d.appendChild(z);
}
function showBorder(b) {
  const d = detail(), c = b.c;
  const cat = el("div", "nz-cat", "Grenze zu"); d.appendChild(cat);
  d.appendChild(el("h3", null, c.n));
  if (b.exp != null) {
    kv(d, "Export dorthin", GWh(b.exp) + " GWh", "physisch"); kv(d, "Import von dort", GWh(b.imp) + " GWh");
    const net = b.exp - b.imp; kv(d, net >= 0 ? "Nettoexport" : "Nettoimport", GWh(Math.abs(net)) + " GWh · Ø " + nf1.format(Math.abs(net) / (b.hours || 24) / 1000) + " GW");
  } else kv(d, "Physikalischer Fluss", "noch nicht veröffentlicht", "physisch");
  if (c.sameZone) d.appendChild(el("p", "muted", "Luxemburg bildet mit Deutschland eine gemeinsame Preiszone. Deshalb gibt es keinen Preisunterschied und keine Handelsgrenze."));
  else if (b.p && b.pDE != null) {
    b.p.forEach((v, i) => { if (v == null) return; kv(d, "Preis " + (c.pl ? c.pl[i] : c.n), nf0.format(v) + " €/MWh (" + (v - b.pDE >= 0 ? "+" : "−") + nf0.format(Math.abs(v - b.pDE)) + " zu DE)", i === 0 ? "preis" : null); });
    kv(d, "Preis Deutschland", nf0.format(b.pDE) + " €/MWh");
  } else if (b.spread != null) kv(d, "Preisunterschied zu DE", (b.spread >= 0 ? "+" : "−") + nf1.format(Math.abs(b.spread)) + " €/MWh", "preis");
  else if (!c.sameZone) kv(d, "Preise", "noch nicht veröffentlicht", "preis");
  if (b.maxOut != null || b.schOut != null) {
    const s = el("div", "nz-sub2", "Handel und Kapazität (Tagesdurchschnitt)"); s.appendChild(iBtn("maxbex", "Kapazität")); d.appendChild(s);
    d.appendChild(useBar("Export DE → " + c.k, b.schOut, b.maxOut, "--pos"));
    d.appendChild(useBar("Import " + c.k + " → DE", b.schIn, b.maxIn, "--neg"));
  } else if (!c.sameZone) d.appendChild(el("p", "muted", c.k === "CH" ? "Die Schweiz gehört nicht zur Flow-Based-Region Core; ihre Grenzkapazitäten stehen nicht bei JAO." : "Für diese Grenze liegen keine JAO-Daten vor."));
}
function useBar(label, used, max, col) {
  const w = el("div", "nz-use");
  const t = el("div", "t"); t.append(el("span", null, label), el("b", null, used == null ? "–" : nf1.format(used / 1000) + " GW" + (max != null ? " von " + nf1.format(max / 1000) + " GW" : ""))); w.appendChild(t);
  const bar = el("div", "bar"); const f = el("div"); f.style.background = css(col); f.style.width = (max ? Math.min(100, (used || 0) / max * 100) : 0) + "%"; bar.appendChild(f); w.appendChild(bar);
  return w;
}

/* ---------------- Kacheln, Listen ---------------- */
function tile(box, lab, val, unit, note, info) {
  const t = el("div", "ed-tile"); const l = el("div", "lab", lab); if (info) l.appendChild(iBtn(info, lab)); const v = el("div", "val", val + " ");
  if (unit) v.appendChild(el("small", null, unit)); t.append(l, v, el("div", "note", note || "")); box.appendChild(t);
}
function renderTiles() {
  const box = $("nzTiles"); box.textContent = "";
  const cs = cnecsOf(day), rd = rdOf(day);
  const inner = cs.filter(c => c.kind !== "extern");
  tile(box, "Bindende Engpässe", String(inner.length), "", inner.filter(c => c.de).length + " davon bei deutschen Netzbetreibern", "cnec");
  const top = cs[0];
  tile(box, "Teuerster Engpass", top ? nf0.format(top.sum) : "–", "€/MW", top ? top.name.trim() : "", "schatten");
  const upE = rd ? rd.tot.up : null, dn = rd ? rd.tot.down : null;
  tile(box, "Redispatch hochgefahren", upE != null ? GWh(upE) : "–", "GWh", "Erzeugung hinter Engpässen", "redispatch");
  const ee = rd ? (rd.pe["Erneuerbar-"] || 0) : 0;
  tile(box, "Redispatch abgeregelt", dn != null ? GWh(dn) : "–", "GWh", rd ? "davon Erneuerbare " + GWh(ee) + " GWh" : "", "redispatch");
}
function renderCnecList() {
  const box = $("nzCnecs"); box.textContent = "";
  const cs = cnecsOf(day);
  if (!cs.length) { box.appendChild(el("p", "muted", D ? "Für diesen Tag liegen keine Engpassdaten vor." : "Noch keine Daten.")); return; }
  const mx = Math.max(1, ...cs.map(c => c.sum));
  const tb = el("div", "nz-list");
  cs.slice(0, 25).forEach(c => {
    const r = el("button", "nz-row"); r.type = "button";
    const nm = el("div", "nm"); nm.appendChild(el("span", null, c.name.trim())); const meta = el("small", null, c.tso + " · " + c.qh + "/96 Viertelstunden" + (c.geo && c.geo.length ? "" : " · nicht auf der Karte")); nm.appendChild(meta);
    const bar = el("div", "bar"); const f = el("div"); f.style.width = (c.sum / mx * 100) + "%"; f.style.background = css("--c-pv"); bar.appendChild(f);
    const v = el("b", null, nf0.format(c.sum));
    r.append(nm, bar, v);
    r.addEventListener("click", () => { highlightCnec(c); showCnec(c); if (c.geo && c.geo.length) { const b = L.latLngBounds(c.geo.map(g => [g[0], g[1]])); map.flyToBounds(b.pad(1.2), { maxZoom: 8, duration: 0.6 }); } $("nzMapCard").scrollIntoView({ behavior: "smooth", block: "start" }); });
    tb.appendChild(r);
  });
  box.appendChild(tb);
  box.appendChild(el("p", "muted", "Summe der Schattenpreise über alle bindenden Viertelstunden des Tages, in €/MW. Enthalten sind alle Länder der Region Core, deutsche Elemente sind in der Kachel oben gezählt."));
}
function renderRd() {
  const box = $("nzRd"); box.textContent = "";
  const rd = rdOf(day);
  if (!rd) { box.appendChild(el("p", "muted", D ? "Für diesen Tag hat netztransparenz.de noch keine Redispatch-Daten veröffentlicht." : "Noch keine Daten.")); return; }
  // Aufteilung nach Energieträger
  const parts = [["Konventionell+", "Konventionell hochgefahren", "--pos", 1], ["Sonstiges+", "Sonstiges hochgefahren", "--pos", 0.55], ["Erneuerbar+", "Erneuerbar hochgefahren", "--pos", 0.3],
    ["Konventionell-", "Konventionell abgeregelt", "--neg", 1], ["Erneuerbar-", "Erneuerbar abgeregelt", "--neg", 0.55], ["Sonstiges-", "Sonstiges abgeregelt", "--neg", 0.3]];
  const tot = parts.reduce((s, p) => s + (rd.pe[p[0]] || 0), 0) || 1;
  const bar = el("div", "ed-segbar");
  parts.forEach(([k, n, c, o]) => { const v = rd.pe[k] || 0; if (!v) return; const d = el("div"); d.style.flex = v + " 1 0"; d.style.background = css(c); d.style.opacity = o; d.title = n + ": " + GWh(v) + " GWh"; bar.appendChild(d); });
  box.appendChild(bar);
  const lg = el("div", "ed-legend"); parts.forEach(([k, n, c, o]) => { const v = rd.pe[k] || 0; if (!v) return; const s = el("span"); const i = el("i"); i.style.background = css(c); i.style.opacity = o; s.append(i, document.createTextNode(n + " " + GWh(v) + " GWh")); lg.appendChild(s); });
  box.appendChild(lg);
  const extra = el("p", "muted");
  if (rd.tot.ct) { extra.appendChild(document.createTextNode("Davon Countertrade " + GWh(rd.tot.ct) + " GWh ")); extra.appendChild(iBtn("countertrade")); extra.appendChild(document.createTextNode(" · ")); }
  if (rd.tot.probe) { extra.appendChild(document.createTextNode("Probefahrten " + GWh(rd.tot.probe) + " GWh nicht mitgezählt ")); extra.appendChild(iBtn("probe")); }
  if (extra.childNodes.length) box.appendChild(extra);
  // größte Anlagen
  const top = rd.plants.slice(0, 12); const mx = Math.max(1, ...top.map(p => Math.max(p.up, p.down)));
  const list = el("div", "nz-list");
  top.forEach(p => {
    const r = el("button", "nz-row"); r.type = "button";
    const nm = el("div", "nm"); nm.appendChild(el("span", null, p.name)); nm.appendChild(el("small", null, p.pe + " · " + p.uenb + (p.geo ? (p.geo[3] === 1 ? " · Ort ungefähr" : "") : " · ohne Ort")));
    const bar2 = el("div", "bar two"); const u = el("div", "u"); u.style.width = (p.up / mx * 50) + "%"; const dn = el("div", "d"); dn.style.width = (p.down / mx * 50) + "%"; bar2.append(dn, u);
    const v = el("b", null, (p.up >= p.down ? "+" : "−") + GWh(Math.max(p.up, p.down)));
    r.append(nm, bar2, v);
    r.addEventListener("click", () => { showPlant(p); if (p.geo) { select(L.circleMarker([p.geo[0], p.geo[1]], { pane: "sel", radius: 20, color: css("--ink"), weight: 2, fill: false })); map.flyTo([p.geo[0], p.geo[1]], Math.max(map.getZoom(), 7), { duration: 0.6 }); } $("nzMapCard").scrollIntoView({ behavior: "smooth", block: "start" }); });
    list.appendChild(r);
  });
  box.appendChild(list);
  box.appendChild(el("p", "muted", "Rot = abgeregelt, Blau = hochgefahren, in GWh am gewählten Tag."));
  const nol = rd.plants.filter(p => !p.geo);
  if (nol.length) {
    const det = el("details"); det.appendChild(el("summary", null, nol.length + " Meldungen ohne Ort"));
    const t = el("table"); t.innerHTML = "<tr><th>Anlage</th><th>hoch GWh</th><th>ab GWh</th></tr>";
    nol.forEach(p => { const r = t.insertRow(); r.insertCell().textContent = p.name; r.insertCell().textContent = GWh(p.up); r.insertCell().textContent = GWh(p.down); });
    det.appendChild(t); box.appendChild(det);
  }
}
function renderBorders() {
  const box = $("nzBorders"); if (!box) return; box.textContent = "";
  if (!day) return;
  if (!SM) { box.appendChild(el("p", "muted", "Lade Grenzflüsse und Preise von SMARD …")); }
  const rows = COUNTRIES.map(borderData).sort((a, b) => ((b.exp || 0) - (b.imp || 0)) - ((a.exp || 0) - (a.imp || 0)));
  const head = el("div", "nz-bhead"); ["Land", "Netto (Ø GW)", "Preis €/MWh", "Handel / möglich"].forEach((t, i) => { const s = el("span", null, t); if (i === 1) s.appendChild(iBtn("physisch")); if (i === 2) s.appendChild(iBtn("preis")); if (i === 3) s.appendChild(iBtn("maxbex")); head.appendChild(s); });
  box.appendChild(head);
  const mxN = Math.max(0.1, ...rows.map(b => b.exp != null ? Math.abs(b.exp - b.imp) / (b.hours || 24) / 1000 : 0));
  rows.forEach(b => {
    const r = el("button", "nz-brow"); r.type = "button";
    r.appendChild(el("span", "n", b.c.n));
    const nb = el("span", "net"); const track = el("span", "track"); const f = el("i");
    if (b.exp != null) { const g = (b.exp - b.imp) / (b.hours || 24) / 1000; f.style.width = (Math.abs(g) / mxN * 50) + "%"; f.style.background = css(g >= 0 ? "--pos" : "--neg"); f.style[g >= 0 ? "left" : "right"] = "50%"; nb.title = (g >= 0 ? "Nettoexport " : "Nettoimport ") + nf1.format(Math.abs(g)) + " GW"; track.appendChild(f); nb.append(track, el("b", null, (g >= 0 ? "+" : "−") + nf1.format(Math.abs(g)))); }
    else nb.append(track, el("b", null, "–"));
    r.appendChild(nb);
    const p = el("span", "p");
    if (b.c.sameZone) p.textContent = "= DE"; else if (b.p && b.p[0] != null && b.pDE != null) { const dd = b.p[0] - b.pDE; p.append(el("b", null, nf0.format(b.p[0])), el("small", null, " " + (dd >= 0 ? "+" : "−") + nf0.format(Math.abs(dd)))); }
    else if (b.diff != null) p.append(el("small", null, "Δ " + (b.diff >= 0 ? "+" : "−") + nf0.format(Math.abs(b.diff)))); else p.textContent = "–";
    r.appendChild(p);
    const u = el("span", "u");
    if (b.maxOut != null && b.schOut != null) {
      const ex = (b.schOut || 0) >= (b.schIn || 0), used = ex ? b.schOut : b.schIn, mx = ex ? b.maxOut : b.maxIn;
      const tr = el("span", "track"); const fi = el("i"); fi.style.width = Math.min(100, used / (mx || 1) * 100) + "%"; fi.style.background = css(ex ? "--pos" : "--neg"); tr.appendChild(fi);
      u.append(tr, el("small", null, nf1.format(used / 1000) + "/" + nf1.format((mx || 0) / 1000)));
    } else u.appendChild(el("small", "muted", b.c.sameZone ? "gleiche Zone" : "keine Daten"));
    r.appendChild(u);
    r.addEventListener("click", () => { select(null); showBorder(b); $("nzMapCard").scrollIntoView({ behavior: "smooth", block: "start" }); });
    box.appendChild(r);
  });
  box.appendChild(el("p", "muted", "Netto: physikalischer Fluss, + heißt Export aus Deutschland. Preis: Durchschnitt im Nachbarland, daneben der Unterschied zu Deutschland. Handel / möglich: geplanter Austausch in der Hauptrichtung im Verhältnis zum maximal möglichen Austausch, in GW. Tippe auf ein Land für Details."));
}

window.NetzeTab = {
  show() { if (!inited) init(); else if (map) setTimeout(() => map.invalidateSize(), 30); }
};
})();
// Falls der Reiter schon beim Laden der Seite offen ist (gespeicherter Reiter), jetzt starten
(function () { const p = document.getElementById("p-netze"); if (p && !p.hidden && window.NetzeTab) window.NetzeTab.show(); })();
