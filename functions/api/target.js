// Gate 5m 事件目标价：Cloudflare Pages Function（实时优先版）
// 路由：/api/target（文件位于 functions/api/target.js）
// 思路：直连 Gate 多域名抢最快结果；直连被拦时用 Jina 文本模式；
// 边界期次切换时自动重试，确保新一期一开始就能拿到目标价。

const GATE_HOSTS = [
  "https://www.gate.io",
  "https://www.gate.com",
  "https://www.gatewebsite.com"
];
const GATE_PAGE = "https://www.gatewebsite.com/zh/trade-events/btc-updown-5m";
const GATE_LIST = "/apiw/v2/market_futures/contract_events/list?version=20260918&market_type=all&sub_website_id=0";
const JINA = "https://r.jina.ai/";
const BAR = 300;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Referer": "https://www.gate.com/zh/trade-events/btc-updown-5m"
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function out(status, body) {
  return new Response(JSON.stringify(body), { status, headers: cors() });
}

function snip(t) {
  return (t || "").slice(0, 420);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url, headers, timeoutMs, deadline) {
  const left = deadline - Date.now();
  if (left < 400) return { ok: false, status: 0, type: "", text: "", error: "deadline" };
  const ms = Math.max(800, Math.min(timeoutMs, left));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url + (url.indexOf("?") >= 0 ? "&" : "?") + "_ts=" + Date.now(), {
      headers: Object.assign({}, headers, { "Cache-Control": "no-cache" }),
      signal: ctrl.signal,
      redirect: "follow"
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      type: res.headers.get("content-type") || "",
      text,
      error: ""
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      type: "",
      text: "",
      error: String(e && e.name ? e.name + ": " + e.message : e)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function jinaText(url, deadline, timeoutMs) {
  const left = deadline - Date.now();
  if (left < 500) return { ok: false, status: 0, type: "", text: "", error: "deadline" };
  const ms = Math.max(1000, Math.min(timeoutMs, left));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const bust = (url.indexOf("?") >= 0 ? "&" : "?") + "_ts=" + Date.now();
  try {
    const res = await fetch(JINA + url + bust, {
      headers: { "X-No-Cache": "true", "Accept": "text/plain", "User-Agent": UA },
      signal: ctrl.signal,
      cache: "no-store"
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      type: res.headers.get("content-type") || "",
      text,
      error: ""
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      type: "",
      text: "",
      error: String(e && e.name ? e.name + ": " + e.message : e)
    };
  } finally {
    clearTimeout(timer);
  }
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

function pickEvent(data, nowSec) {
  const list = data && data.data && data.data.list;
  if (!Array.isArray(list)) return null;
  for (const e of list) {
    if (e && e.slug === "btc-updown-5m" &&
        Number(e.start_date) <= nowSec && Number(e.end_date) > nowSec) {
      return {
        id: String(e.id),
        start: Number(e.start_date),
        end: Number(e.end_date)
      };
    }
  }
  return null;
}

function parsePrice(text) {
  if (!text) return null;
  let m = text.match(/price_to_beat\\?"\s*:\s*\\?"?([0-9.]+)/);
  if (!m) m = text.match(/目标价格[^\d]{0,40}([0-9,]+\.\d+)/);
  if (!m) m = text.match(/Target\s+([0-9,]+\.\d+)/i);
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ""));
  return isFinite(v) && v > 0 ? v : null;
}

// Jina 文本会返回 "Final URL: `...eventId=xxx...`"
function parseEventIdFromText(text) {
  if (!text) return null;
  let m = text.match(/Final URL:\s*`[^`]*eventId=(\d+)/i);
  if (!m) m = text.match(/URL Source:\s*`[^`]*eventId=(\d+)/i);
  if (!m) m = text.match(/eventId=(\d+)/);
  return m ? m[1] : null;
}

function normTime(t) {
  const m = (t || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  // 5m 期次时间一定是 5 分钟对齐，排除倒计时之类的误匹配
  if (Number(m[2]) % 5 !== 0) return null;
  return String(m[1]).padStart(2, "0") + ":" + m[2];
}

// 从页面文本里解析期次结束时间（UTC+8）
function parsePageEnd(text) {
  if (!text) return null;
  let m = text.match(/BTC\s*5\s*(?:分钟|Min)[^\d]{0,20}(\d{1,2}:\d{2})/i);
  if (m) return normTime(m[1]);
  m = text.match(/(\d{1,2}:\d{2})\s*[-–—~至]\s*(\d{1,2}:\d{2})/);
  if (m) return normTime(m[2]);
  m = text.match(/(\d{1,2}:\d{2})\s*[（(]?UTC\+8/i);
  if (m) return normTime(m[1]);
  return null;
}

function expectedEndHHMM(curStart) {
  const d = new Date((curStart + BAR) * 1000);
  const h = String((d.getUTCHours() + 8) % 24).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return h + ":" + m;
}

function eventUrlOn(host, id) {
  return host + "/zh/trade-events/btc-updown-5m?eventId=" + encodeURIComponent(id) + "&outcome=Down";
}

export async function onRequestGet() {
  const now = Math.floor(Date.now() / 1000);
  const curStart = now - (now % BAR);
  const curEnd = curStart + BAR;
  const expected = expectedEndHHMM(curStart);
  const deadline = Date.now() + 24000;
  const debug = { now, curStart, expected };

  // 1) 直连 Gate 多域名并发，哪个先通用哪个
  let directEvent = null;
  try {
    const rs = await Promise.all(
      GATE_HOSTS.map((h) => fetchText(h + GATE_LIST, HEADERS, 2500, deadline))
    );
    debug.directList = rs.map((r, i) => ({
      host: GATE_HOSTS[i],
      ok: r.ok,
      status: r.status,
      type: r.type,
      text: snip(r.text),
      error: r.error
    }));

    for (const r of rs) {
      if (!r.ok) continue;
      const ev = pickEvent(parseJsonLoose(r.text), now);
      if (ev) { directEvent = ev; break; }
    }
    debug.directEvent = directEvent;

    if (directEvent) {
      const listPrice = parsePrice(JSON.stringify(directEvent));
      if (listPrice) {
        return out(200, {
          price: listPrice,
          start: directEvent.start,
          end: directEvent.end,
          source: "gate-list",
          eventId: directEvent.id
        });
      }

      const pages = await Promise.all(
        GATE_HOSTS.map((h) => fetchText(eventUrlOn(h, directEvent.id), HEADERS, 2500, deadline))
      );
      debug.directDetail = pages.map((r, i) => ({
        host: GATE_HOSTS[i],
        ok: r.ok,
        status: r.status,
        type: r.type,
        text: snip(r.text),
        error: r.error
      }));
      for (const r of pages) {
        if (!r.ok) continue;
        const price = parsePrice(r.text);
        if (price) {
          return out(200, {
            price,
            start: directEvent.start,
            end: directEvent.end,
            source: "gate",
            eventId: directEvent.id
          });
        }
      }
    }
  } catch (e) {
    debug.directError = String(e);
  }

  // 2) Jina 通用事件页文本，最多两次；边界期次切换时重试
  for (let attempt = 0; attempt < 2; attempt++) {
    const gr = await jinaText(GATE_PAGE, deadline, attempt === 0 ? 10000 : 9000);
    debug["jinaGeneric" + attempt] = {
      ok: gr.ok,
      status: gr.status,
      type: gr.type,
      text: snip(gr.text),
      error: gr.error
    };

    if (gr.ok) {
      const price = parsePrice(gr.text);
      const id = parseEventIdFromText(gr.text);
      const endStr = parsePageEnd(gr.text);
      const live = /进行中|Live|交易中/i.test(gr.text);
      const ended = /已结束|Ended/i.test(gr.text);
      const timeOk = endStr === expected;
      const idOk = !!(directEvent && id && id === directEvent.id);

      debug["jinaGenericParse" + attempt] = {
        price,
        id,
        endStr,
        expected,
        directId: directEvent ? directEvent.id : null,
        timeOk,
        idOk,
        live,
        ended
      };

      // 页面期次时间必须是当前期；页面还没切到新一期就重试
      if (price && !ended) {
        if (timeOk) {
          return out(200, {
            price,
            start: curStart,
            end: curEnd,
            source: "jina-generic",
            eventId: id || null
          });
        }
        if (idOk) {
          return out(200, {
            price,
            start: directEvent.start,
            end: directEvent.end,
            source: "jina-generic",
            eventId: id
          });
        }
        // 既没解析到期次时间，也没有事件 ID 可比对时，才用"进行中"兜底
        if (!endStr && !directEvent && live) {
          return out(200, {
            price,
            start: curStart,
            end: curEnd,
            source: "jina-generic",
            eventId: id || null
          });
        }
      }
    }

    if (Date.now() + 1500 >= deadline) break;
    await sleep(1200);
  }

  // 3) Jina 事件列表 + 指定事件页
  let listEvent = directEvent;
  if (!listEvent) {
    try {
      const lr = await jinaText(GATE_HOSTS[2] + GATE_LIST, deadline, 8000);
      debug.jinaList = {
        ok: lr.ok,
        status: lr.status,
        type: lr.type,
        text: snip(lr.text),
        error: lr.error
      };
      listEvent = lr.ok ? pickEvent(parseJsonLoose(lr.text), now) : null;
      debug.jinaEvent = listEvent;
    } catch (e) {
      debug.jinaListError = String(e);
    }
  }

  if (listEvent) {
    try {
      const tr = await jinaText(eventUrlOn(GATE_HOSTS[2], listEvent.id), deadline, 9000);
      debug.jinaDetail = {
        ok: tr.ok,
        status: tr.status,
        type: tr.type,
        text: snip(tr.text),
        error: tr.error
      };
      const price = tr.ok ? parsePrice(tr.text) : null;
      const id = tr.ok ? parseEventIdFromText(tr.text) : null;
      if (price) {
        return out(200, {
          price,
          start: listEvent.start,
          end: listEvent.end,
          source: "jina-detail",
          eventId: id || listEvent.id
        });
      }
    } catch (e) {
      debug.jinaDetailError = String(e);
    }
  }

  return out(502, { error: "target unavailable", debug });
}
