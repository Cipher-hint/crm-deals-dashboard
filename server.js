"use strict";

const path = require("path");
const express = require("express");

const PORT = Number(process.env.PORT) || 3000;
const VIBE_APP_KEY = process.env.VIBE_APP_KEY || "";
const VIBE_API = "https://vibecode.bitrix24.tech/v1";
const MOSCOW_OFFSET = "+03:00";
const APP_META = {
  name: "Дашборд сделок CRM",
  version: require("./package.json").version,
  vendor: "safekit.tech",
  support: "support@safekit.tech",
  site: "https://safekit.tech",
};
const MAX_RETRIES = 3;
const RETRYABLE_ITEM = /RATE_LIMITED|QUEUE_OVERFLOW|QUEUE_TIMEOUT|OPERATION_TIME_LIMIT|TIMEOUT_QUARANTINE|BITRIX_TIMEOUT|AUTO_PAGINATION_FAILED/;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, version: APP_META.version });
});

app.get("/api/meta", (_req, res) => {
  res.json({
    success: true,
    data: {
      ...APP_META,
      footer: `${APP_META.name} v${APP_META.version}  |  Разработчик: ${APP_META.vendor}  |  Поддержка: ${APP_META.support}`,
    },
  });
});

app.get("/api/dashboard", async (req, res) => {
  try {
    if (!VIBE_APP_KEY) {
      return res.status(500).json({
        success: false,
        error: { code: "MISSING_VIBE_APP_KEY", message: "Сервер запущен без ключа приложения." },
      });
    }

    const session = requireSession(req);
    const period = parsePeriod(req.query.from, req.query.to);
    if (!period.ok) {
      return res.status(400).json({ success: false, error: period.error });
    }

    const createdFilter = createdAtFilter(period.from, period.to);
    const aggregate = [
      { field: "*", function: "count" },
      { field: "amount", function: "sum" },
    ];
    const [funnelRes, openRes, wonRes, firstBatch, viewerRes] = await Promise.all([
      vibe(session, "POST", "/deals/aggregate", {
        aggregate,
        groupBy: ["stageId", "currency"],
        filter: createdFilter,
      }),
      vibe(session, "POST", "/deals/aggregate", {
        aggregate,
        groupBy: ["currency"],
        filter: { ...createdFilter, closed: false },
      }),
      vibe(session, "POST", "/deals/aggregate", {
        aggregate,
        groupBy: ["currency"],
        filter: { ...createdFilter, stageSemanticId: "S" },
      }),
      vibeBatch(session, [
        {
          id: "recent",
          entity: "deals",
          action: "search",
          params: {
            select: [
              "id",
              "title",
              "amount",
              "currency",
              "stageId",
              "stageSemanticId",
              "assignedById",
              "createdAt",
              "closed",
              "closedAt",
              "categoryId",
            ],
            filter: createdFilter,
            sort: { createdAt: "DESC" },
            limit: 20,
            withTotal: false,
            start: -1,
          },
        },
        {
          id: "categories",
          entity: "deal-categories",
          action: "list",
          params: { limit: 50, withTotal: false, start: -1 },
        },
      ]),
      vibe(session, "GET", "/users/me").catch(() => ({ data: null })),
    ]);

    requireBatchSuccess(firstBatch, ["recent"]);
    const recentRows = firstBatch.results.recent || [];
    const assigneeIds = uniqueIds(recentRows.map((deal) => deal.assignedById));

    const categories = (firstBatch.results.categories || [])
      .map((item) => ({ id: Number(item.id), name: item.name }))
      .filter((item) => Number.isFinite(item.id));
    const extraFunnels = categories.filter((item) => item.id > 0);
    const dictCalls = [
      {
        id: "st_default",
        entity: "statuses",
        action: "search",
        params: { filter: { entityId: "DEAL_STAGE" }, limit: 100, withTotal: false, start: -1 },
      },
      ...extraFunnels.map((item) => ({
        id: `st_${item.id}`,
        entity: "statuses",
        action: "search",
        params: { filter: { entityId: `DEAL_STAGE_${item.id}` }, limit: 100, withTotal: false, start: -1 },
      })),
    ];
    if (assigneeIds.length) {
      dictCalls.push({
        id: "assignees",
        entity: "users",
        action: "search",
        params: {
          select: ["id", "name", "lastName", "active"],
          filter: { id: assigneeIds },
          limit: Math.min(Math.max(assigneeIds.length, 1), 50),
          withTotal: false,
          start: -1,
        },
      });
    }
    const dictBatch = await vibeBatch(session, dictCalls);

    const dictionaries = buildDictionaries({
      viewer: viewerRes.data,
      categories,
      users: dictBatch.results.assignees || [],
      statusLists: dictCalls
        .filter((call) => call.entity === "statuses")
        .map((call) => dictBatch.results[call.id] || []),
    });

    const funnelAgg = funnelRes.data || {};
    const openAgg = openRes.data || {};
    const wonAgg = wonRes.data || {};
    const stages = mapFunnel(funnelAgg, dictionaries);
    const kpis = kpisFromCurrencyGroups(openAgg.groups || [], wonAgg.groups || [], stages);
    const truncated = isTruncated(funnelAgg, openAgg, wonAgg);

    const recentDeals = recentRows.map((deal) => ({
      id: deal.id,
      title: deal.title || "Без названия",
      amount: Number(deal.amount || 0),
      currency: deal.currency || kpis.currency || "RUB",
      stageId: deal.stageId,
      stageName: dictionaries.stageName(deal.stageId),
      stageSemanticId: deal.stageSemanticId,
      assignedById: deal.assignedById,
      assignedByName: dictionaries.userName(deal.assignedById),
      createdAt: deal.createdAt,
      closed: Boolean(deal.closed),
    }));

    res.json({
      success: true,
      data: {
        viewer: dictionaries.viewer,
        period: {
          from: period.from,
          to: period.to,
          label: period.label,
        },
        kpis,
        funnel: {
          stages,
          truncated,
        },
        recentDeals,
        categories: dictionaries.categories,
      },
    });
  } catch (err) {
    const mapped = mapPublicError(err);
    res.status(mapped.status).json({
      success: false,
      error: { code: mapped.code, message: mapped.message },
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`deals-dashboard listening on ${PORT}\n`);
});

function requireSession(req) {
  const raw = String(req.headers["x-vibe-authorization"] || "").trim();
  const bearer = raw.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) {
    const err = new Error("Нет сессии пользователя. Откройте дашборд из пункта «Дашборд сделок» в левом меню Битрикс24.");
    err.code = "TOKEN_MISSING";
    err.status = 401;
    throw err;
  }
  return bearer;
}

function parsePeriod(fromRaw, toRaw) {
  const from = normalizeDate(fromRaw, "start");
  const to = normalizeDate(toRaw, "end");
  if (fromRaw && !from) {
    return { ok: false, error: { code: "INVALID_PERIOD", message: "Некорректная дата начала периода." } };
  }
  if (toRaw && !to) {
    return { ok: false, error: { code: "INVALID_PERIOD", message: "Некорректная дата окончания периода." } };
  }
  if (from && to && from > to) {
    return { ok: false, error: { code: "INVALID_PERIOD", message: "Дата начала позже даты окончания." } };
  }
  return {
    ok: true,
    from,
    to,
    label: from || to ? "custom" : "all",
  };
}

function normalizeDate(value, edge) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return edge === "end" ? `${text}T23:59:59${MOSCOW_OFFSET}` : `${text}T00:00:00${MOSCOW_OFFSET}`;
}

function createdAtFilter(from, to) {
  const filter = {};
  if (from) filter[">=createdAt"] = from;
  if (to) filter["<=createdAt"] = to;
  return filter;
}

function uniqueIds(values) {
  const ids = [];
  const seen = new Set();
  for (const value of values) {
    const id = Number(value);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function buildDictionaries({ viewer, categories, users, statusLists }) {
  const stagesById = new Map();
  for (const list of statusLists) {
    for (const stage of list || []) {
      stagesById.set(String(stage.statusId), {
        id: String(stage.statusId),
        name: stage.name || String(stage.statusId),
        semantics: stage.semantics || null,
        color: stage.color || "#8b95a3",
        sort: Number(stage.sort || 0),
        categoryId: stage.categoryId == null ? 0 : Number(stage.categoryId),
      });
    }
  }

  const usersById = new Map();
  for (const user of users) {
    const fullName = [user.name, user.lastName].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    usersById.set(Number(user.id), fullName || `ID ${user.id}`);
  }

  const categoryName = (id) => {
    if (id === 0 || id == null) return "Общая воронка";
    const found = categories.find((item) => item.id === Number(id));
    return found ? found.name : `Воронка ${id}`;
  };

  return {
    viewer: viewer
      ? {
          id: viewer.id,
          name: [viewer.name, viewer.lastName].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
        }
      : null,
    categories: [{ id: 0, name: "Общая воронка" }, ...categories],
    stageName(stageId) {
      const stage = stagesById.get(String(stageId));
      return stage ? stage.name : String(stageId || "—");
    },
    userName(userId) {
      return usersById.get(Number(userId)) || (userId ? `ID ${userId}` : "—");
    },
    stageMeta(stageId) {
      return stagesById.get(String(stageId)) || {
        id: String(stageId || ""),
        name: String(stageId || "—"),
        semantics: null,
        color: "#8b95a3",
        sort: 9999,
        categoryId: guessCategory(stageId),
      };
    },
    categoryName,
  };
}

function guessCategory(stageId) {
  const match = String(stageId || "").match(/^C(\d+):/);
  return match ? Number(match[1]) : 0;
}

function mapFunnel(funnelAgg, dictionaries) {
  const groups = funnelAgg?.groups || [];
  const maxAmount = Math.max(0, ...groups.map((group) => Number(group.aggregates?.amount?.sum || 0)));
  const maxCount = Math.max(0, ...groups.map((group) => Number(group.count || 0)));

  return groups
    .map((group) => {
      const meta = dictionaries.stageMeta(group.stageId);
      const count = Number(group.count || 0);
      const amount = Number(group.aggregates?.amount?.sum || 0);
      return {
        stageId: String(group.stageId),
        name: meta.name,
        color: meta.color,
        semantics: meta.semantics,
        categoryId: meta.categoryId,
        categoryName: dictionaries.categoryName(meta.categoryId),
        sort: meta.sort,
        count,
        amount,
        currency: group.currency || "RUB",
        truncated: Boolean(group.truncated || group.aggregates?.amount?.truncated),
        countShare: maxCount ? count / maxCount : 0,
        amountShare: maxAmount ? amount / maxAmount : 0,
      };
    })
    .sort((a, b) => a.categoryId - b.categoryId || a.sort - b.sort || a.name.localeCompare(b.name, "ru"));
}

function kpisFromCurrencyGroups(openGroups, wonGroups, stages) {
  const byCurrency = new Map();
  const ensure = (code) => {
    const currency = code || "RUB";
    if (!byCurrency.has(currency)) {
      byCurrency.set(currency, {
        currency,
        openAmount: 0,
        openCount: 0,
        wonCount: 0,
        wonAmount: 0,
        periodCount: 0,
        periodAmount: 0,
      });
    }
    return byCurrency.get(currency);
  };

  for (const group of openGroups) {
    const row = ensure(group.currency);
    row.openCount += Number(group.count || 0);
    row.openAmount += Number(group.aggregates?.amount?.sum || 0);
  }
  for (const group of wonGroups) {
    const row = ensure(group.currency);
    row.wonCount += Number(group.count || 0);
    row.wonAmount += Number(group.aggregates?.amount?.sum || 0);
  }
  for (const stage of stages) {
    const row = ensure(stage.currency);
    row.periodCount += Number(stage.count || 0);
    row.periodAmount += Number(stage.amount || 0);
  }

  const rows = [...byCurrency.values()].map((row) => ({
    ...row,
    averageCheck: row.wonCount > 0 ? row.wonAmount / row.wonCount : row.periodCount > 0 ? row.periodAmount / row.periodCount : 0,
  }));
  rows.sort((a, b) => b.periodAmount - a.periodAmount || a.currency.localeCompare(b.currency));
  const primary = rows[0] || {
    currency: "RUB",
    openAmount: 0,
    openCount: 0,
    wonCount: 0,
    wonAmount: 0,
    averageCheck: 0,
    periodCount: 0,
    periodAmount: 0,
  };
  return {
    ...primary,
    currencies: rows.map((row) => row.currency),
    byCurrency: rows,
  };
}

function isTruncated(...aggs) {
  return aggs.some((agg) => {
    if (!agg) return false;
    if (agg.meta?.truncated || agg.truncated || agg.aggregates?.amount?.truncated) return true;
    return (agg.groups || []).some((group) => group.truncated || group.aggregates?.amount?.truncated);
  });
}

function requireBatchSuccess(batch, requiredIds) {
  const errors = batch.errors || {};
  const results = batch.results || {};
  for (const id of requiredIds) {
    if (errors[id] || !Object.prototype.hasOwnProperty.call(results, id)) {
      const item = errors[id] || {
        code: "BATCH_ITEM_FAILED",
        message: "Пакетный запрос не вернул обязательные данные.",
      };
      const err = new Error(item.message || "Ошибка пакетного запроса.");
      err.code = item.code || "BATCH_ITEM_FAILED";
      err.status = guessStatusFromCode(item.code);
      throw err;
    }
  }
}

function guessStatusFromCode(code) {
  const text = String(code || "");
  if (/401|UNAUTHORIZED|INVALID_API_KEY|MISSING_API_KEY|INVALID_SESSION|TOKEN_MISSING|SESSION_APP_MISMATCH/.test(text)) return 401;
  if (/403|FORBIDDEN|ACCESS_DENIED|WRITE_BLOCKED/.test(text)) return 403;
  if (/429|RATE_LIMIT|QUEUE_OVERFLOW|QUEUE_TIMEOUT/.test(text)) return 429;
  return 502;
}

function mapPublicError(err) {
  const status = Number(err.status) || 502;
  const code = err.code || "DASHBOARD_FAILED";
  if (status === 401 || /TOKEN_MISSING|INVALID_SESSION|INVALID_API_KEY|MISSING_API_KEY|UNAUTHORIZED|SESSION_APP_MISMATCH/.test(code)) {
    return {
      status: 401,
      code: code === "TOKEN_MISSING" ? "TOKEN_MISSING" : "UNAUTHORIZED",
      message: "Нет сессии пользователя. Откройте дашборд из пункта «Дашборд сделок» в левом меню Битрикс24.",
    };
  }
  if (status === 403 || /ACCESS_DENIED|FORBIDDEN|WRITE_BLOCKED|SCOPE_NOT_ALLOWED|MANAGEMENT_KEY/.test(code)) {
    return { status: 403, code: "FORBIDDEN", message: "Недостаточно прав для чтения CRM. Нужны скоупы crm и user." };
  }
  if (status === 429 || /RATE_LIMIT|QUEUE_OVERFLOW|QUEUE_TIMEOUT/.test(code)) {
    return { status: 429, code: "RATE_LIMITED", message: "Превышен лимит запросов к API. Подождите несколько секунд и обновите страницу." };
  }
  if (status === 502 || status === 503 || /UNAVAILABLE|NETWORK|VIBE_HTTP_ERROR|VIBE_NETWORK|BITRIX_TIMEOUT/.test(code)) {
    return { status: 502, code: "UPSTREAM_UNAVAILABLE", message: "Портал Битрикс24 или Вайбкод временно недоступен. Повторите попытку." };
  }
  if (status >= 400 && status < 500) {
    return { status, code, message: err.message || "Не удалось загрузить данные CRM." };
  }
  return { status: 502, code: "UPSTREAM_UNAVAILABLE", message: "Не удалось загрузить данные CRM. Повторите попытку." };
}

async function vibeBatch(session, calls) {
  try {
    return await vibeBatchOnce(session, calls);
  } catch (err) {
    if (err.status === 403 || err.code === "MANAGEMENT_KEY_NO_ENTITY_ACCESS") {
      return serialBatch(session, calls);
    }
    throw err;
  }
}

async function vibeBatchOnce(session, calls) {
  const pending = calls.slice();
  const results = {};
  const errors = {};
  for (let attempt = 0; attempt <= MAX_RETRIES && pending.length; attempt += 1) {
    const payload = await vibe(session, "POST", "/batch", { calls: pending });
    const batchResults = payload.data?.results || {};
    const batchErrors = payload.data?.errors || {};
    const retry = [];
    let waitSec = 0;
    for (const call of pending) {
      if (!batchErrors[call.id]) {
        results[call.id] = batchResults[call.id];
        continue;
      }
      const itemErr = batchErrors[call.id];
      if (RETRYABLE_ITEM.test(itemErr.code || "") && attempt < MAX_RETRIES) {
        retry.push(call);
        waitSec = Math.max(waitSec, Number(itemErr.retryAfter) || 0);
      } else {
        errors[call.id] = itemErr;
      }
    }
    pending.length = 0;
    if (retry.length) {
      await sleep(waitSec > 0 ? Math.min(waitSec * 1000, 30000) : retryDelayMs(null, null, attempt));
      pending.push(...retry);
    }
  }
  for (const call of pending) {
    errors[call.id] = {
      code: "RATE_LIMITED",
      message: "Превышен лимит запросов к API. Подождите несколько секунд и обновите страницу.",
    };
  }
  return { results, errors };
}

async function serialBatch(session, calls) {
  const results = {};
  const errors = {};
  for (const call of calls) {
    try {
      results[call.id] = await vibeCall(session, call);
    } catch (err) {
      errors[call.id] = { code: err.code || "CALL_FAILED", message: err.message };
    }
  }
  return { results, errors };
}

async function vibeCall(session, call) {
  if (call.action === "search") {
    const payload = await vibe(session, "POST", `/${call.entity}/search`, call.params);
    return payload.data;
  }
  if (call.action === "list") {
    const params = call.params || {};
    const query = new URLSearchParams();
    if (params.limit != null) query.set("limit", String(params.limit));
    if (params.withTotal != null) query.set("withTotal", String(params.withTotal));
    if (params.start != null) query.set("start", String(params.start));
    const suffix = query.toString() ? `?${query}` : "";
    const payload = await vibe(session, "GET", `/${call.entity}${suffix}`);
    return payload.data;
  }
  throw Object.assign(new Error(`Неподдерживаемое действие ${call.action}`), { code: "ACTION_NOT_SUPPORTED", status: 400 });
}

async function vibe(session, method, pathname, body) {
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let response;
    try {
      response = await fetch(`${VIBE_API}${pathname}`, {
        method,
        headers: {
          "X-Api-Key": VIBE_APP_KEY,
          Authorization: `Bearer ${session}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      lastError = Object.assign(new Error(err.cause?.message || err.message || "fetch failed"), {
        code: "VIBE_NETWORK_ERROR",
        status: 502,
      });
      if (attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(null, null, attempt));
        continue;
      }
      throw lastError;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (shouldRetryHttp(response.status, payload?.error?.code) && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(response, payload?.error?.retryAfter, attempt));
      continue;
    }

    if (!response.ok || (payload && payload.success === false)) {
      const error = new Error(payload?.error?.message || `Vibe API ${response.status}`);
      error.code = payload?.error?.code || "VIBE_HTTP_ERROR";
      error.status = response.status;
      throw error;
    }

    return payload || { success: true, data: null };
  }
  throw lastError || new Error("Vibe API failed");
}

function shouldRetryHttp(status, code) {
  if (status === 401 || status === 403) return false;
  if (status === 429 || status === 502 || status === 503) return true;
  return /RATE_LIMITED|QUEUE_OVERFLOW|QUEUE_TIMEOUT|BITRIX_TIMEOUT|BITRIX_UNAVAILABLE|VIBE_NETWORK/.test(String(code || ""));
}

function retryDelayMs(response, retryAfter, attempt) {
  const header = Number(response?.headers?.get("retry-after"));
  const fromBody = Number(retryAfter);
  const seconds = Number.isFinite(header) && header >= 0
    ? header
    : Number.isFinite(fromBody) && fromBody >= 0
      ? fromBody
      : null;
  const base = seconds != null ? Math.min(seconds * 1000, 30000) : Math.min(1000 * 2 ** attempt, 8000);
  const jitter = base * (0.85 + Math.random() * 0.3);
  return Math.round(jitter);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
