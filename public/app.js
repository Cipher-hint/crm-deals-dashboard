const numberFmt = new Intl.NumberFormat("ru-RU");
const dateFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const moneyCache = new Map();

const fromInput = document.getElementById("from");
const toInput = document.getElementById("to");
const statusEl = document.getElementById("status");
const kpisEl = document.getElementById("kpis");
const funnelEl = document.getElementById("funnel");
const recentEl = document.getElementById("recent");
const subtitleEl = document.getElementById("subtitle");

document.getElementById("filters").addEventListener("submit", (event) => {
  event.preventDefault();
  setActivePreset(null);
  loadDashboard();
});

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    applyPreset(button.dataset.preset);
    loadDashboard();
  });
});

applyPreset("30");
loadDashboard();
initChrome();

function initChrome() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });
  document.getElementById("copy-support")?.addEventListener("click", copySupportDump);
  loadMeta();
  if (location.hash.startsWith("#h-")) showView("help");
}

function showView(view) {
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== view;
  });
}

async function loadMeta() {
  try {
    const response = await fetch("/api/meta");
    const payload = await response.json();
    if (!payload.success) return;
    const footer = document.getElementById("app-footer");
    if (footer && payload.data.footer) footer.innerHTML = formatFooter(payload.data);
  } catch {
    /* keep static footer */
  }
}

function formatFooter(meta) {
  return `${escapeHtml(meta.name)} v${escapeHtml(meta.version)}&nbsp;&nbsp;|&nbsp;&nbsp;Разработчик: <a href="${escapeHtml(meta.site)}" target="_top" rel="noopener">${escapeHtml(meta.vendor)}</a>&nbsp;&nbsp;|&nbsp;&nbsp;Поддержка: <a href="mailto:${escapeHtml(meta.support)}">${escapeHtml(meta.support)}</a>`;
}

async function copySupportDump() {
  const hint = document.getElementById("copy-hint");
  let meta = {};
  try {
    const payload = await (await fetch("/api/meta")).json();
    meta = payload.data || {};
  } catch {
    meta = { version: "unknown" };
  }
  const dump = [
    "Приложение: Дашборд сделок CRM",
    `Версия: ${meta.version || "1.2.0"}`,
    `Разработчик: ${meta.vendor || "safekit.tech"}`,
    `Адрес: ${location.href}`,
    `User-Agent: ${navigator.userAgent}`,
    `Время: ${new Date().toISOString()}`,
    `Экран: ${window.innerWidth}x${window.innerHeight}`,
    "В дамп не входят сделки и персональные данные клиентов.",
  ].join("\n");
  try {
    await navigator.clipboard.writeText(dump);
    if (hint) {
      hint.hidden = false;
      setTimeout(() => { hint.hidden = true; }, 2500);
    }
  } catch {
    window.prompt("Скопируйте текст для поддержки:", dump);
  }
}

function applyPreset(preset) {
  const today = new Date();
  const to = isoDate(today);
  if (preset === "all") {
    fromInput.value = "";
    toInput.value = "";
  } else {
    const days = Number(preset);
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1));
    fromInput.value = isoDate(from);
    toInput.value = to;
  }
  setActivePreset(preset);
}

function setActivePreset(preset) {
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.preset === preset);
  });
}

async function loadDashboard() {
  const from = fromInput.value;
  const to = toInput.value;
  if ((from && !to) || (!from && to)) {
    showError("Укажите обе границы периода или очистите обе — тогда покажем все сделки.");
    return;
  }
  if (from && to && from > to) {
    showError("Дата начала позже даты окончания. Исправьте диапазон.");
    return;
  }

  showError("");
  kpisEl.innerHTML = skeletonKpis();
  funnelEl.innerHTML = `<p class="empty">Загружаем воронку…</p>`;
  recentEl.innerHTML = `<tr><td colspan="5" class="empty">Загружаем сделки…</td></tr>`;

  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  try {
    const response = await fetch(`/api/dashboard?${params.toString()}`);
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || !payload?.success) {
      throw new Error(messageFromFailure(response.status, payload));
    }
    render(payload.data);
  } catch (error) {
    showError(error.message || "Ошибка загрузки дашборда.");
    const truncatedEl = document.getElementById("truncated");
    if (truncatedEl) truncatedEl.hidden = true;
    funnelEl.innerHTML = "";
    recentEl.innerHTML = "";
    kpisEl.innerHTML = "";
  }
}

function render(data) {
  const viewer = data.viewer?.name ? `Данные от лица: ${data.viewer.name}` : "";
  const periodLabel = data.period.from
    ? `Период создания: ${formatIso(data.period.from)} — ${formatIso(data.period.to)}`
    : "Период: все время";
  subtitleEl.textContent = [periodLabel, viewer].filter(Boolean).join(" · ");

  const truncatedEl = document.getElementById("truncated");
  if (truncatedEl) truncatedEl.hidden = !data.funnel?.truncated;

  const kpis = data.kpis;
  const currency = kpis.currency || "RUB";
  const extra = (kpis.currencies || []).filter((code) => code !== currency);
  const extraHint = extra.length ? ` · также ${extra.join(", ")}` : "";
  kpisEl.innerHTML = [
    kpiCard("Сумма открытых сделок", formatMoney(kpis.openAmount, currency), `${numberFmt.format(kpis.openCount)} в работе${extraHint}`),
    kpiCard("Выиграно за период", numberFmt.format(kpis.wonCount), formatMoney(kpis.wonAmount, currency)),
    kpiCard("Средний чек", formatMoney(kpis.averageCheck, currency), `${numberFmt.format(kpis.periodCount)} сделок в выборке`),
  ].join("");

  if (!data.funnel.stages.length) {
    funnelEl.innerHTML = `<p class="empty">За выбранный период сделок нет. Сдвиньте даты или выберите «Все время».</p>`;
  } else {
    funnelEl.innerHTML = data.funnel.stages
      .map((stage) => {
        const width = Math.max(6, Math.round(stage.amountShare * 100));
        const cut = stage.truncated ? " · усечено" : "";
        return `<div class="stage">
          <div>
            <div class="stage-name">${escapeHtml(stage.name)}</div>
            <div class="stage-cat">${escapeHtml(stage.categoryName)} · ${escapeHtml(stage.stageId)}${cut}</div>
          </div>
          <div class="num">${numberFmt.format(stage.count)}</div>
          <div class="num">${formatMoney(stage.amount, stage.currency || currency)}</div>
          <div class="bar"><span style="width:${width}%;background:${escapeHtml(stage.color)}"></span></div>
        </div>`;
      })
      .join("");
  }

  if (!data.recentDeals.length) {
    recentEl.innerHTML = `<tr><td colspan="5" class="empty">Нет сделок за выбранный период.</td></tr>`;
    return;
  }

  recentEl.innerHTML = data.recentDeals
    .map(
      (deal) => `<tr>
        <td>${escapeHtml(deal.title)}</td>
        <td class="num">${formatMoney(deal.amount, deal.currency || currency)}</td>
        <td><span class="badge"><span class="dot"></span>${escapeHtml(deal.stageName)}</span></td>
        <td>${escapeHtml(deal.assignedByName)}</td>
        <td>${formatIso(deal.createdAt)}</td>
      </tr>`
    )
    .join("");
}

function kpiCard(label, value, hint) {
  return `<article class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></article>`;
}

function skeletonKpis() {
  return ["", "", ""].map(() => `<article class="kpi"><div class="label">…</div><div class="value">—</div></article>`).join("");
}

function showError(message) {
  statusEl.hidden = !message;
  statusEl.textContent = message;
}

function messageFromFailure(status, payload) {
  if (payload?.error?.message) return payload.error.message;
  if (status === 401) return "Нет сессии пользователя. Откройте дашборд из пункта «Дашборд сделок» в левом меню Битрикс24.";
  if (status === 403) return "Недостаточно прав для чтения CRM. Нужны скоупы crm и user.";
  if (status === 429) return "Превышен лимит запросов к API. Подождите несколько секунд и обновите страницу.";
  if (status === 502 || status === 503) return "Портал Битрикс24 или Вайбкод временно недоступен. Повторите попытку.";
  return "Не удалось получить данные.";
}

function formatMoney(amount, currency) {
  const code = currency || "RUB";
  let fmt = moneyCache.get(code);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("ru-RU", {
        style: "currency",
        currency: code,
        maximumFractionDigits: 0,
      });
    } catch {
      fmt = {
        format(value) {
          return `${numberFmt.format(value)} ${code}`;
        },
      };
    }
    moneyCache.set(code, fmt);
  }
  return fmt.format(amount);
}

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatIso(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateFmt.format(date);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
