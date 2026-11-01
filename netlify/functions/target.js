// Gate 5m 事件目标价：Netlify Function
// 与桌面端一致：事件列表 -> 当前 eventId -> 指定事件页 -> price_to_beat
// 失败时返回 debug，方便定位是 Gate 直连、Jina、还是解析问题。

const GATE_API =
  "https://www.gatewebsite.com/apiw/v2/market_futures/contract_events/list?version=20260918&market_type=all&sub_website_id=0";
const GATE_PAGE = "https://www.gatewebsite.com/zh/trade-events/btc-updown-5m";
const JINA = "https://r.jina.ai/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Referer": GATE_PAGE,
  "Origin": "https://www.gatewebsite.com",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin"
};

const JINA_TEXT_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/plain",
  "X-No-Cache": "true"
};

const JINA_HTML_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html",
  "X-Return-Format": "html",
  "X-No-Cache": "true"
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function out(statusCode, obj) {
  return { statusCode, headers: CORS, body: JSON.stringify(obj) };
}

function snip(s) {
  return (s || "").replace(/\s+/g, " ").slice(0, 240);
}

async function fetchText(url, headers, maxMs, deadline) {
  const left = Math.max(0, deadline - Date.now());
  const timeout = Math.min(maxMs || 8000, left);
  if (timeout < 600) return { ok: false, status: 0, text: "", type: "", error: "deadline" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
    return {
      ok: res.ok,
      status: res.status,
      text: await res.text(),
      type: res.headers.get("content-type") || ""
    };
  } catch (e) {
    return { ok: false, status: 0, text: "", type: "", error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function jina(url, headers, deadline, maxMs) {
  const bust = (url.indexOf("?") >= 0 ? "&" : "?") + "_ts=" + Date.now();
  return fetchText(JINA + url + bust, headers, maxMs || 12000, deadline);
}

function jinaText(url, deadline, maxMs) {
  return jina(url, JINA_TEXT_HEADERS, deadline, maxMs);
}

function jinaHtml(url, deadline, maxMs) {
  return jina(url, JINA_HTML_HEADERS, deadline, maxMs);
}

function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) {}
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {}
  }
  return null;
}

function parsePrice(text) {
  if (!text) return null;
  let m = text.match(/price_to_beat\\?"\s*:\s*\\?"?([0-9]+(?:\.[0-9]+)?)/);
  if (!m) m = text.match(/目标价格[^\d]{0,40}([0-9,]+(?:\.[0-9]+)?)/);
  if (!m) m = text.match(/Target\s+([0-9,]+(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ""));
  return isFinite(v) && v > 0 ? v : null;
}

function parseQuestionEnd(text) {
  const m = text.match(/BTC\s*5分钟涨或跌\s*(\d{1,2}:\d{2})/);
  if (!m) return null;
  return m[1].length === 4 ? "0" + m[1] : m[1];
}

function expectedEndHHMM(startSec) {
  const d = new Date((startSec + 300) * 1000 + 8 * 3600 * 1000);
  return (
    String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0")
  );
}

function pickEvent(data, now) {
  const list = data && data.data && data.data.list;
  if (!Array.isArray(list)) return null;
  for (const e of list) {
    if (
      e &&
      e.slug === "btc-updown-5m" &&
      Number(e.start_date) <= now &&
      Number(e.end_date) > now
    ) {
      return { id: String(e.id), start: Number(e.start_date), end: Number(e.end_date) };
    }
  }
  return null;
}

function eventUrl(id) {
  return GATE_PAGE + "?eventId=" + encodeURIComponent(id) + "&outcome=Down";
}

exports.handler = async () => {
  const now = Math.floor(Date.now() / 1000);
  const curStart = now - (now % 300);
  const curEnd = curStart + 300;
  const expected = expectedEndHHMM(curStart);
  const deadline = Date.now() + 25000;
  const debug = { now, curStart, expected };

  // 1) 直连事件列表 + 指定事件页
  try {
    const lr = await fetchText(GATE_API, HEADERS, 4000, deadline);
    debug.directList = { ok: lr.ok, status: lr.status, type: lr.type, text: snip(lr.text), error: lr.error };
    const ev = lr.ok ? pickEvent(parseJsonLoose(lr.text), now) : null;
    debug.directEvent = ev;
    if (ev) {
      const dr = await fetchText(eventUrl(ev.id), HEADERS, 4000, deadline);
      debug.directDetail = { ok: dr.ok, status: dr.status, type: dr.type, text: snip(dr.text), error: dr.error };
      const price = dr.ok ? parsePrice(dr.text) : null;
      if (price) return out(200, { price, start: ev.start, end: ev.end, source: "gate" });
    }
  } catch (e) {
    debug.directError = String(e);
  }

  // 2) Jina 事件列表 + 指定事件页
  try {
    const lr = await jinaText(GATE_API, deadline, 8000);
    debug.jinaList = { ok: lr.ok, status: lr.status, type: lr.type, text: snip(lr.text), error: lr.error };
    const ev = lr.ok ? pickEvent(parseJsonLoose(lr.text), now) : null;
    debug.jinaEvent = ev;
    if (ev) {
      const url = eventUrl(ev.id);
      const hr = await jinaHtml(url, deadline, 9000);
      debug.jinaDetailHtml = { ok: hr.ok, status: hr.status, type: hr.type, text: snip(hr.text), error: hr.error };
      let price = hr.ok ? parsePrice(hr.text) : null;
      if (!price) {
        const tr = await jinaText(url, deadline, 9000);
        debug.jinaDetailText = { ok: tr.ok, status: tr.status, type: tr.type, text: snip(tr.text), error: tr.error };
        price = tr.ok ? parsePrice(tr.text) : null;
      }
      if (price) return out(200, { price, start: ev.start, end: ev.end, source: "jina" });
    }
  } catch (e) {
    debug.jinaError = String(e);
  }

  // 3) Jina 通用事件页兜底：必须校验期次时间，避免拿错期
  try {
    const gr = await jinaHtml(GATE_PAGE, deadline, 9000);
    debug.jinaGenericHtml = { ok: gr.ok, status: gr.status, type: gr.type, text: snip(gr.text), error: gr.error };
    let price = gr.ok ? parsePrice(gr.text) : null;
    let qEnd = gr.ok ? parseQuestionEnd(gr.text) : null;
    if (!price || !qEnd) {
      const tr = await jinaText(GATE_PAGE, deadline, 9000);
      debug.jinaGenericText = { ok: tr.ok, status: tr.status, type: tr.type, text: snip(tr.text), error: tr.error };
      if (!price) price = tr.ok ? parsePrice(tr.text) : null;
      if (!qEnd) qEnd = tr.ok ? parseQuestionEnd(tr.text) : null;
    }
    debug.jinaGenericParse = { price, qEnd, expected };
    if (price && qEnd === expected) {
      return out(200, { price, start: curStart, end: curEnd, source: "jina-generic" });
    }
  } catch (e) {
    debug.jinaGenericError = String(e);
  }

  return out(502, { error: "target unavailable", debug });
};
