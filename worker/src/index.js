/**
 * 에코비즈마켓 백엔드 API (Cloudflare Worker + KV)
 *
 * 저장 구조: KV의 각 키에 JSON 배열
 *   members, inquiries, sell_regs, newsletter(구독자), newsletters, nav, actions
 *
 * 공개 엔드포인트:
 *   GET  /pub                → 공개 데이터 (매도등록, 발행 뉴스레터, 카운트)
 *   POST /push               → {key, item} 항목 추가 (중복 제거)
 *   POST /login              → {email, pw} 로그인 검증
 * 관리자 엔드포인트 (x-admin-token 헤더 필요):
 *   GET  /all                → 전체 데이터
 *   POST /replace            → {key, items} 배열 전체 교체
 */

const KEYS = ['members', 'inquiries', 'sell_regs', 'newsletter', 'newsletters', 'nav', 'actions'];
const PUSH_KEYS = new Set(KEYS);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

async function getArr(env, key) {
  const raw = await env.EBM_DATA.get(key);
  try { return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
}

async function setArr(env, key, arr) {
  await env.EBM_DATA.put(key, JSON.stringify(arr));
}

function stripPw(m) {
  const { pw, ...rest } = m;
  return rest;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const isAdmin = request.headers.get('x-admin-token') === env.ADMIN_TOKEN;

    // ── GET /pub — 공개 데이터
    if (request.method === 'GET' && path === '/pub') {
      const [sell_regs, newsletters, subscribers, members] = await Promise.all([
        getArr(env, 'sell_regs'),
        getArr(env, 'newsletters'),
        getArr(env, 'newsletter'),
        getArr(env, 'members'),
      ]);
      return json({
        sell_regs,
        newsletters: newsletters.filter(n => n.status === 'published'),
        subscribers_count: subscribers.length,
        members_count: members.length,
      });
    }

    // ── GET /all — 전체 (관리자)
    if (request.method === 'GET' && path === '/all') {
      if (!isAdmin) return json({ error: 'unauthorized' }, 401);
      const out = {};
      for (const k of KEYS) out[k] = await getArr(env, k);
      return json(out);
    }

    // ── POST /push — 항목 추가
    if (request.method === 'POST' && path === '/push') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      const { key, item } = body || {};
      if (!PUSH_KEYS.has(key) || item == null) return json({ error: 'bad key/item' }, 400);

      const arr = await getArr(env, key);

      // 회원가입: 이메일 중복 체크
      if (key === 'members') {
        const email = String(item.email || '').toLowerCase();
        if (!email) return json({ error: 'email required' }, 400);
        if (arr.some(m => String(m.email || '').toLowerCase() === email)) {
          return json({ error: 'duplicate', message: '이미 가입된 이메일입니다.' }, 409);
        }
      }
      // 구독: 이메일 중복 시 성공 처리 (idempotent)
      if (key === 'newsletter') {
        const email = String(item.email || '').toLowerCase();
        if (arr.some(s => String(s.email || '').toLowerCase() === email)) {
          return json({ ok: true, duplicate: true, count: arr.length });
        }
      }
      // 일반 중복 제거 (JSON 동일 항목)
      const s = JSON.stringify(item);
      if (!arr.some(x => JSON.stringify(x) === s)) {
        arr.unshift(item);
        await setArr(env, key, arr);
      }
      return json({ ok: true, count: arr.length });
    }

    // ── POST /login — 로그인 검증
    if (request.method === 'POST' && path === '/login') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      const email = String(body.email || '').toLowerCase();
      const pw = String(body.pw || '');
      const members = await getArr(env, 'members');
      const m = members.find(x => String(x.email || '').toLowerCase() === email && String(x.pw || '') === pw);
      if (!m) return json({ ok: false, message: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401);
      return json({ ok: true, user: stripPw(m) });
    }

    // ── POST /replace — 배열 전체 교체 (관리자)
    if (request.method === 'POST' && path === '/replace') {
      if (!isAdmin) return json({ error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      const { key, items } = body || {};
      if (!PUSH_KEYS.has(key) || !Array.isArray(items)) return json({ error: 'bad key/items' }, 400);
      await setArr(env, key, items);
      return json({ ok: true, count: items.length });
    }

    return json({ error: 'not found', app: 'ecobiz-market-api' }, 404);
  },
};
