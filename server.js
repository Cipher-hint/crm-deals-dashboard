"use strict";

const path = require("path");
const express = require("express");

const PORT = Number(process.env.PORT) || 3000;
const VIBE_API_KEY = process.env.VIBE_API_KEY || "";
const VIBE_API = "https://vibecode.bitrix24.tech/v1";
const MOSCOW_OFFSET = "+03:00";
const APP_META = {
  name: "Дашборд сделок CRM",
  version: require("./package.json").version,
  vendor: "safekit.tech",
  support: "support@safekit.tech",
  site: "https://safekit.tech",
};

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
    if (!VIBE_API_KEY) {
      return res.status(500).json({
        success: false,
        error: { code: "MISSING_VIBE_API_KEY", message: "Сервер запущен без VIBE_API_KEY." },
      });
    }

    const period = parsePeriod(req.query.from, req.query.to);
    if (!period.ok) {
      return res.status(400).json({ success: false, error: period.error });
    }

    const createdFilter = createdAtFilter(period.from, period.to);
    const [funnelRes, openRes, wonRes, allPeriodRes, recentRes, dictionaries] = await Promise.all([
      vibe("POST", "/deals/aggregate", {
        aggregate: [
          { field: "*", function: "count" },
          { field: "amount", function: "sum" },
        ],
        groupBy: ["stageId"],
        filter: createdFilter,
      }),
      vibe("POST", "/deals/aggregate", {
        aggregate: [
          { field: "*", function: "count" },
          { field: "amount", function: "sum" },
        ],
        filter: { ...createdFilter, closed: false },
      }),
      vibe("POST", "/deals/aggregate", {
        aggregate: [
          { field: "*", function: "count" },
          { field: "amount", function: "sum" },
        ],
        filter: { ...createdFilter, stageSemanticId: "S" },
      }),
      vibe("POST", "/deals/aggregate", {
        aggregate: [
          { field: "*", function: "count" },
          { field: "amount", function: "sum" },
        ],
        filter: createdFilter,
      }),
      vibe("POST", "/deals/search", {
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
        order: { createdAt: "DESC" },
        limit: 20,
        withTotal: false,
      }),
      loadDictionaries(),
    ]);

    const funnelAgg = funnelRes.data || {};
    const openAgg = openRes.data || {};
    const wonAgg = wonRes.data || {};
    const allPeriodAgg = allPeriodRes.data || {};
    const stages = mapFunnel(funnelAgg, dictionaries);
    const openAmount = Number(openAgg.aggregates?.amount?.sum || 0);
    const openCount = Number(openAgg.count || 0);
    const wonCount = Number(wonAgg.count || 0);
    const wonAmount = Number(wonAgg.aggregates?.amount?.sum || 0);
    const periodCount = Number(allPeriodAgg.count || 0);
    const periodAmount = Number(allPeriodAgg.aggregates?.amount?.sum || 0);
    const averageCheck = wonCount > 0 ? wonAmount / wonCount : periodCount > 0 ? periodAmount / periodCount : 0;

    const recentDeals = (recentRes.data || []).map((deal) => ({
      id: deal.id,
      title: deal.title || "Без названия",
      amount: Number(deal.amount || 0),
      currency: deal.currency || "RUB",
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
        kpis: {
          openAmount,
          openCount,
          wonCount,
          wonAmount,
          averageCheck,
          periodCount,
          periodAmount,
          currency: "RUB",
        },
        funnel: {
          stages,
          truncated: Boolean(funnelAgg.meta?.truncated),
        },
        recentDeals,
        categories: dictionaries.categories,
      },
    });
  } catch (err) {
    const status = Number(err.status) || 502;
    res.status(status).json({
      success: false,
      error: {
        code: err.code || "DASHBOARD_FAILED",
        message: err.message || "Не удалось загрузить данные CRM.",
      },
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`deals-dashboard listening on ${PORT}\n`);
});

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

async function loadDictionaries() {
  const [viewerRes, categoriesRes, usersRes] = await Promise.all([
    vibe("GET", "/users/me"),
    vibe("GET", "/deal-categories?limit=50&withTotal=false"),
    vibe("POST", "/users/search", {
      select: ["id", "name", "lastName", "active"],
      limit: 200,
      withTotal: false,
    }),
  ]);

  const categories = (categoriesRes.data || []).map((item) => ({
    id: Number(item.id),
    name: item.name,
  }));
  const entityIds = ["DEAL_STAGE", ...categories.map((item) => `DEAL_STAGE_${item.id}`)];
  const stageLists = await Promise.all(
    entityIds.map((entityId) =>
      vibe("POST", "/statuses/search", {
        filter: { entityId },
        limit: 100,
        withTotal: false,
      }).catch(() => ({ success: false, data: [] }))
    )
  );

  const stagesById = new Map();
  for (const list of stageLists) {
    for (const stage of list.data || []) {
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
  for (const user of usersRes.data || []) {
    const fullName = [user.name, user.lastName].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    usersById.set(Number(user.id), fullName || `ID ${user.id}`);
  }

  const categoryName = (id) => {
    if (id === 0 || id == null) return "Общая воронка";
    const found = categories.find((item) => item.id === Number(id));
    return found ? found.name : `Воронка ${id}`;
  };

  return {
    viewer: viewerRes.data
      ? {
          id: viewerRes.data.id,
          name: [viewerRes.data.name, viewerRes.data.lastName].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
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
        countShare: maxCount ? count / maxCount : 0,
        amountShare: maxAmount ? amount / maxAmount : 0,
      };
    })
    .sort((a, b) => a.categoryId - b.categoryId || a.sort - b.sort || a.name.localeCompare(b.name, "ru"));
}

async function vibe(method, pathname, body) {
  let response;
  try {
    response = await fetch(`${VIBE_API}${pathname}`, {
      method,
      headers: {
        "X-Api-Key": VIBE_API_KEY,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const error = new Error(err.cause?.message || err.message || "fetch failed");
    error.code = "VIBE_NETWORK_ERROR";
    error.status = 502;
    throw error;
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || (payload && payload.success === false)) {
    const error = new Error(payload?.error?.message || `Vibe API ${response.status}`);
    error.code = payload?.error?.code || "VIBE_HTTP_ERROR";
    error.status = response.status;
    throw error;
  }

  return payload || { success: true, data: null };
}
