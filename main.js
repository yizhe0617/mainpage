const cardsEl = document.getElementById("cards");
const filtersEl = document.getElementById("filters");
const sorted = [...PROJECTS].sort((a, b) => b.date.localeCompare(a.date));

// 作品卡片
function renderCards(tag) {
  const list = tag === "全部" ? sorted : sorted.filter(p => p.tags.includes(tag));
  cardsEl.innerHTML = list.map((p, i) => `
    <article class="card" style="animation-delay:${i * 60}ms">
      ${p.featured ? '<span class="badge">★ pick</span>' : ""}
      <div class="card-icon">${p.icon}</div>
      <h3>${p.title}</h3>
      <span class="date">${p.date.replace("-", ".")}</span>
      <p class="desc">${p.desc}</p>
      <div class="tech">${p.tech.map(t => `<span>${t}</span>`).join("")}</div>
      <div class="links">
        ${p.demo ? `<a class="primary" href="${p.demo}" target="_blank" rel="noopener">${p.demoLabel || "▶ 玩玩看"}</a>` : ""}
        ${p.repo ? `<a href="${p.repo}" target="_blank" rel="noopener">&lt;/&gt; 原始碼</a>` : ""}
      </div>
    </article>`).join("");
}

// 篩選按鈕：從所有作品的 tags 自動產生
const tags = ["全部", ...new Set(PROJECTS.flatMap(p => p.tags))];
filtersEl.innerHTML = tags.map(t => `<button data-tag="${t}">${t}</button>`).join("");
filtersEl.addEventListener("click", e => {
  const btn = e.target.closest("button");
  if (!btn) return;
  filtersEl.querySelectorAll("button").forEach(b => b.classList.toggle("active", b === btn));
  renderCards(btn.dataset.tag);
});
filtersEl.firstElementChild.classList.add("active");
renderCards("全部");

// 終端機：作品數字跳動 + 打字效果
const countEl = document.getElementById("count");
let n = 0;
const counter = setInterval(() => {
  countEl.textContent = ++n;
  if (n >= PROJECTS.length) clearInterval(counter);
}, 120);

const lines = ["echo \"歡迎參觀，隨便點 🚀\"", "git commit -m \"又做了一個新東西\"", "sudo make coffee ☕"];
const typedEl = document.getElementById("typed");
let li = 0, ci = 0, deleting = false;
(function type() {
  const line = lines[li];
  typedEl.textContent = line.slice(0, ci);
  if (!deleting && ci < line.length) ci++;
  else if (!deleting) { deleting = true; return setTimeout(type, 1800); }
  else if (ci > 0) ci--;
  else { deleting = false; li = (li + 1) % lines.length; }
  setTimeout(type, deleting ? 30 : 70);
})();

// 深淺色切換（記在 localStorage）
const toggle = document.getElementById("theme-toggle");
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  toggle.textContent = t === "light" ? "🌙" : "☀️";
  try { localStorage.setItem("theme", t); } catch {}
}
let saved = null;
try { saved = localStorage.getItem("theme"); } catch {}
setTheme(saved || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
toggle.addEventListener("click", () =>
  setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
