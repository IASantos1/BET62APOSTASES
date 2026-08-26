// =============================================================================
//  MOTOR 2D DO MINI CAMPO (Canvas 2D nativo) — substitui o anterior Three.js
//  Carregado por index.html <script src="tracker2d.js"> ANTES de app.js.
//  Todas as funções aqui são globais: pauseTracker2D, ensureTracker2DCanvas,
//  mountTracker2D, updateTracker2DFromPoints, repaintTracker2D — app.js chama-as.
// =============================================================================
//
//  MARCAÇÕES FIFA OFICIAIS 105×68m, todos os overlays visíveis pedidos pelo
//  utilizador: ⚽ Golo, 🏳️ Escanteio, 🚩 Cobrança Lateral, 🏁 Penálti.
//
//  DEPENDÊNCIAS (globais já existentes em app.js, injectadas por chamada):
//    ballDangerZone(x), isInCornerZone(x,y), nearestCorner(x,y),
//    detectNewGoal(e), showGoalFlashOverlay(ev), matchPulseState.
//    Para evitar acoplamento forte, usamos lookup em window[fnName].
//
//  SINGLETON REANCORÁVEL: igual ideia do 3D — MESMO <canvas> partilhado
//  entre cabeçalho compacto e modal cheio. Nada é destruído entre navegações.

(function () {
  "use strict";

  let tp2d = null;

  // ============ helpers de lookup (pegam funções do app.js via window) ============
  const g = (name) => window[name];
  const call = (name, ...a) => { const f = g(name); return typeof f === "function" ? f(...a) : undefined; };
  const pulseState = () => window.matchPulseState || { eventId: null, events: [] };

  // ============ construção do canvas ============
  function ensureTracker2DCanvas() {
    if (tp2d) return tp2d;
    const canvas = document.createElement("canvas");
    canvas.className = "tp2d-canvas";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.background = "#0d2815";
    const pitchCacheCanvas = document.createElement("canvas");
    tp2d = {
      canvas,
      ctx: canvas.getContext("2d"),
      mountedIn: null,
      dpr: 1,
      // Cache estático offscreen: relva + marcações FIFA. Re-pintado SÓ em resize.
      // Entre updates de bola, basta drawImage(cache, 0,0) — ~15% do custo original.
      pitchCache: pitchCacheCanvas,
      pitchCacheCtx: pitchCacheCanvas.getContext("2d"),
      // Chave que identifica a configuração do cache atual (tamanho + dpr + box).
      // Se mudar, invalidamos e re-pintamos.
      pitchCacheKey: "",
      lastEvent: null, lastPoints: [], lastCompact: false,
    };
    return tp2d;
  }

  function mountTracker2D(container) {
    const st = ensureTracker2DCanvas();
    if (st.mountedIn !== container) {
      container.appendChild(st.canvas);
      st.mountedIn = container;
    }
    resizeTracker2D();
    if (st.lastEvent) repaintTracker2D();
  }

  function resizeTracker2D() {
    const st = tp2d; if (!st || !st.mountedIn) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = st.mountedIn.clientWidth, h = st.mountedIn.clientHeight;
    if (!w || !h) return;
    st.dpr = dpr;
    st.canvas.width = Math.round(w * dpr);
    st.canvas.height = Math.round(h * dpr);
    st.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Invalida o cache de marcações FIFA para ser re-pintado no próximo repaintTracker2D
    // com o novo tamanho (tamanho do offscreen também muda).
    st.pitchCacheKey = "";
  }

  window.addEventListener("resize", () => {
    if (tp2d && tp2d.mountedIn) { resizeTracker2D(); if (tp2d.lastEvent) repaintTracker2D(); }
  });

  function pauseTracker2D() {
    /* 2D reativo: não há loop de animação contínuo (só re-pinta em updates).
       Esta função existe só para manter a interface igual ao 3D. */
  }

  // ============ fit box e helpers px ↔ normalizado ============
  const FIFA_W_M = 105, FIFA_H_M = 68;
  function fitPitchBox(cw, ch) {
    const ratio = FIFA_W_M / FIFA_H_M;
    let pw = cw, ph = cw / ratio;
    if (ph > ch) { ph = ch; pw = ch * ratio; }
    return { x: (cw - pw) / 2, y: (ch - ph) / 2, w: pw, h: ph };
  }
  const nx = (x, b) => b.x + x * b.w;
  const ny = (y, b) => b.y + y * b.h;

  // medidas FIFA em percentagem normalizada 0..1
  const PM = {
    yd6Depth: 5.5 / 105,
    yd6Top: (68 - 18.32) / 2 / 68,
    yd16Depth: 16.5 / 105,
    yd16Top: (68 - 40.32) / 2 / 68,
    penaltyX: 11 / 105,
    goalW_M: 7.32,
    arcR_M: 9.15,
    centerArcR_M: 9.15,
    cornerArcR_M: 1,
  };

  // ============ desenho de campo + marcações ============
  function drawPitchMarkings2D(ctx, box) {
    const scaleX = box.w / FIFA_W_M;
    // faixas relva
    ctx.fillStyle = "#1e7a39";
    ctx.fillRect(box.x, box.y, box.w, box.h);
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#1e7a39" : "#1a6f33";
      ctx.fillRect(box.x + (box.w * i) / 10, box.y, box.w / 10, box.h);
    }
    // danger zones (14% de cada baliza — igual ballDangerZone)
    ctx.fillStyle = "rgba(255,90,90,0.10)";
    ctx.fillRect(box.x, box.y, box.w * 0.14, box.h);
    ctx.fillRect(box.x + box.w * 0.86, box.y, box.w * 0.14, box.h);

    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    const L = (x1,y1,x2,y2) => { ctx.beginPath(); ctx.moveTo(nx(x1,box),ny(y1,box)); ctx.lineTo(nx(x2,box),ny(y2,box)); ctx.stroke(); };
    // exterior
    L(0,0,1,0); L(0,1,1,1); L(0,0,0,1); L(1,0,1,1);
    // linha central
    L(0.5,0,0.5,1);
    // círculo central
    ctx.beginPath(); ctx.arc(nx(0.5,box), ny(0.5,box), PM.centerArcR_M * scaleX, 0, Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.arc(nx(0.5,box), ny(0.5,box), 2.5, 0, Math.PI*2); ctx.fill();
    // 6 jardas
    const y6t = PM.yd6Top, y6b = 1-PM.yd6Top;
    L(0, y6t, PM.yd6Depth, y6t); L(0, y6b, PM.yd6Depth, y6b); L(PM.yd6Depth, y6t, PM.yd6Depth, y6b);
    L(1-PM.yd6Depth, y6t, 1, y6t); L(1-PM.yd6Depth, y6b, 1, y6b); L(1-PM.yd6Depth, y6t, 1-PM.yd6Depth, y6b);
    // 16 jardas
    const y16t = PM.yd16Top, y16b = 1-PM.yd16Top;
    L(0, y16t, PM.yd16Depth, y16t); L(0, y16b, PM.yd16Depth, y16b); L(PM.yd16Depth, y16t, PM.yd16Depth, y16b);
    L(1-PM.yd16Depth, y16t, 1, y16t);
    L(1-PM.yd16Depth, y16b, 1, y16b);
    L(1-PM.yd16Depth, y16t, 1-PM.yd16Depth, y16b);
    // marcas penalti + semicírculos
    const arcR = PM.arcR_M * scaleX;
    ctx.beginPath(); ctx.arc(nx(PM.penaltyX, box), ny(0.5, box), 2.5, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(nx(1 - PM.penaltyX, box), ny(0.5, box), 2.5, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(nx(PM.penaltyX, box), ny(0.5, box), arcR, -Math.PI/2.3, Math.PI/2.3); ctx.stroke();
    ctx.beginPath(); ctx.arc(nx(1-PM.penaltyX, box), ny(0.5, box), arcR, Math.PI - Math.PI/2.3, Math.PI + Math.PI/2.3); ctx.stroke();
    // cantos (1m arco)
    const cr = PM.cornerArcR_M * scaleX;
    const arcs = [[0,0,0,Math.PI/2],[1,0,Math.PI/2,Math.PI],[1,1,Math.PI,1.5*Math.PI],[0,1,1.5*Math.PI,2*Math.PI]];
    arcs.forEach(([cx,cy,a,b]) => { ctx.beginPath(); ctx.arc(nx(cx,box), ny(cy,box), cr, a, b); ctx.stroke(); });
    // bandeirinhas dos cantos
    ctx.save(); ctx.fillStyle = "#f5c842";
    [[0,0],[1,0],[1,1],[0,1]].forEach(([cx,cy]) => {
      ctx.fillRect(nx(cx,box)+(cx===0?-2:-2), ny(cy,box)+(cy===0?-10:2), 4, 10);
    });
    ctx.restore();
    // balizas
    const gy0 = 0.5 - (PM.goalW_M/68)/2, gy1 = 0.5 + (PM.goalW_M/68)/2;
    ctx.fillStyle = "rgba(230,230,230,0.85)";
    ctx.fillRect(box.x - 4, ny(gy0,box), 4, (gy1-gy0)*box.h);
    ctx.fillRect(box.x + box.w, ny(gy0,box), 4, (gy1-gy0)*box.h);
    // labels CASA / FORA
    ctx.save(); ctx.font = "bold 10px system-ui,-apple-system,Segoe UI,Roboto"; ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(245,200,66,0.35)"; ctx.textAlign = "left"; ctx.fillText("CASA", box.x + 4, box.y + 3);
    ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.textAlign = "right"; ctx.fillText("FORA", box.x + box.w - 4, box.y + 3);
    ctx.restore();
  }

  // ============ overlays (corner, lateral, penalty) ============
  function drawCornerOverlay(ctx, box, latest) {
    if (!call("isInCornerZone", latest.x, latest.y)) return;
    const nc = call("nearestCorner", latest.x, latest.y) || { cx: latest.x<0.5?0:1, cy: latest.y<0.5?0:1 };
    const bx = nx(latest.x, box), by = ny(latest.y, box);
    const fx = nx(nc.cx, box), fy = ny(nc.cy, box);
    // seta tracejada
    ctx.save();
    ctx.setLineDash([5, 4]); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(fx, fy); ctx.stroke();
    ctx.restore();
    // tag 🏳️ ESCANTEIO
    ctx.save(); const label = "🏳️  ESCANTEIO";
    ctx.font = "bold 11px system-ui, -apple-system, Segoe UI, Roboto";
    const tw = ctx.measureText(label).width + 10;
    const tx = nc.cx === 0 ? Math.min(box.x + 6, box.x + box.w - tw - 4) : Math.max(box.x + box.w - tw - 6, box.x + 4);
    const ty = nc.cy === 0 ? box.y + 4 : box.y + box.h - 20;
    ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fillRect(tx, ty, tw, 16);
    ctx.fillStyle = "#0b4a20"; ctx.textBaseline = "middle"; ctx.fillText(label, tx + 5, ty + 8);
    ctx.restore();
  }

  function drawThrowInOverlay(ctx, box, latest) {
    if (call("isInCornerZone", latest.x, latest.y)) return;
    const THROW_Y = 0.03;
    const atL = latest.y < THROW_Y;
    const atR = latest.y > 1 - THROW_Y;
    if (!atL && !atR) return;
    const bx = nx(latest.x, box);
    const y = atL ? box.y + 4 : box.y + box.h - 20;
    ctx.save();
    const label = "🚩  LATERAL";
    ctx.font = "bold 11px system-ui, -apple-system, Segoe UI, Roboto";
    const tw = ctx.measureText(label).width + 10;
    const tx = Math.min(Math.max(bx - tw / 2, box.x + 4), box.x + box.w - tw - 4);
    ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fillRect(tx, y, tw, 16);
    ctx.fillStyle = "#0b4a20"; ctx.textBaseline = "middle"; ctx.fillText(label, tx + 5, y + 8);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(bx, ny(latest.y, box)); ctx.lineTo(bx, ny(atL?0:1, box)); ctx.stroke();
    ctx.restore();
  }

  function drawPenaltyOverlay(ctx, box, latest, e) {
    const inHome = latest.x <= PM.yd16Depth;
    const inAway = latest.x >= 1 - PM.yd16Depth;
    const nearHome = Math.abs(latest.x - PM.penaltyX) < 0.02;
    const nearAway = Math.abs(latest.x - (1 - PM.penaltyX)) < 0.02;
    let lastIsPen = false;
    const ps = pulseState();
    if (ps.eventId === e?.id && ps.events?.length) {
      const last = ps.events[ps.events.length - 1];
      if (last && (last.kind === "penalty" || /penalt|pênal|Penalt|PENALT/i.test(last.label || ""))) lastIsPen = true;
    }
    const isPen = lastIsPen || ((inHome && nearHome) || (inAway && nearAway));
    if (!isPen) return;
    const markX = inHome || nearHome ? PM.penaltyX : 1 - PM.penaltyX;
    const px = nx(markX, box); const py = ny(0.5, box);
    ctx.save();
    ctx.strokeStyle = "#f5c842"; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(px, py, 18, 0, Math.PI*2); ctx.stroke();
    const label = "🏁  PENÁLTI";
    ctx.font = "bold 11px system-ui, -apple-system, Segoe UI, Roboto";
    const tw = ctx.measureText(label).width + 10;
    const tx = Math.min(Math.max(px - tw / 2, box.x + 4), box.x + box.w - tw - 4);
    const ty = py + 22;
    ctx.fillStyle = "rgba(245,200,66,0.95)"; ctx.fillRect(tx, ty, tw, 18);
    ctx.fillStyle = "#241400"; ctx.textBaseline = "middle"; ctx.fillText(label, tx + 5, ty + 9);
    ctx.restore();
  }

  // ============ trail + bola + HUD ============
  function drawTrail(ctx, box, points) {
    const total = points.length;
    for (let i = total - 1; i >= 0; i--) {
      const p = points[i];
      const t = 1 - i / Math.max(1, total - 1);
      const r = 3 + t * 4;
      const alpha = 0.18 + t * 0.65;
      const rr = Math.round(160 + t * 95);
      const gg = Math.round(100 + t * 155);
      const bb = Math.round(60 + t * 195);
      ctx.fillStyle = `rgba(${rr},${gg},${bb},${alpha})`;
      ctx.beginPath(); ctx.arc(nx(p.x, box), ny(p.y, box), r, 0, Math.PI*2); ctx.fill();
    }
  }

  function drawBall(ctx, box, latest, compact) {
    const bx = nx(latest.x, box), by = ny(latest.y, box);
    const R = compact ? 4 : 6;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 1.5;
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(bx, by, R, 0, Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.lineWidth = 1.2; ctx.strokeStyle = "#111";
    ctx.beginPath(); ctx.arc(bx, by, R, 0, Math.PI*2); ctx.stroke();
    ctx.fillStyle = "#111";
    ctx.beginPath();
    const hr = R * 0.42;
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI/2 + (2*Math.PI*i)/5;
      const x = bx + Math.cos(a)*hr, y = by + Math.sin(a)*hr;
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawHud(ctx, box, points) {
    const latest = points[0];
    ctx.save();
    ctx.font = "10px system-ui,-apple-system,Segoe UI,Roboto";
    ctx.textBaseline = "bottom"; ctx.fillStyle = "rgba(255,255,255,0.92)";
    const mins = latest?.timer ?? "--:--";
    let zone = "—";
    if (latest) zone = latest.x < 0.34 ? "DEFESA" : (latest.x > 0.66 ? "ATAQUE" : "MEIO-CAMPO");
    ctx.fillText(`🕐 ${mins}   •   ${zone}`, box.x + 6, box.y + box.h - 4);
    ctx.restore();
  }

  // ============ repaint master ============
  function repaintTracker2D() {
    const st = tp2d; if (!st || !st.mountedIn) return;
    const ctx = st.ctx;
    const cw = st.mountedIn.clientWidth, ch = st.mountedIn.clientHeight;
    const box = fitPitchBox(cw, ch);
    const cacheKey = `${cw}x${ch}@${st.dpr}|box:${box.x.toFixed(2)},${box.y.toFixed(2)},${box.w.toFixed(2)},${box.h.toFixed(2)}`;
    if (st.pitchCacheKey !== cacheKey) {
      // Redesenha relva + marcações FIFA SÓ quando o tamanho muda (resize / mount compact→full).
      const cCache = st.pitchCache;
      const dpr = st.dpr;
      cCache.width = Math.round(cw * dpr);
      cCache.height = Math.round(ch * dpr);
      const cctx = st.pitchCacheCtx;
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cctx.clearRect(0, 0, cw, ch);
      cctx.fillStyle = "#0d2815"; cctx.fillRect(0, 0, cw, ch);
      drawPitchMarkings2D(cctx, box);
      st.pitchCacheKey = cacheKey;
    }
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(st.pitchCache, 0, 0, cw, ch);
    const pts = st.lastPoints || [];
    if (pts.length) {
      drawTrail(ctx, box, pts.slice().reverse());
      const latest = pts[0];
      drawCornerOverlay(ctx, box, latest);
      drawThrowInOverlay(ctx, box, latest);
      drawPenaltyOverlay(ctx, box, latest, st.lastEvent);
      drawBall(ctx, box, latest, st.lastCompact);
      if (!st.lastCompact) {
        const goalEvent = call("detectNewGoal", st.lastEvent);
        if (goalEvent) call("showGoalFlashOverlay", goalEvent);
      }
    }
    drawHud(ctx, box, pts);
  }

  // ============ entry points usados pelo app.js ============
  function updateTracker2DFromPoints(e, points, compact) {
    const st = ensureTracker2DCanvas();
    st.lastEvent = e;
    st.lastPoints = points || [];
    st.lastCompact = !!compact;
    repaintTracker2D();
  }

  // expor globais
  window.pauseTracker2D = pauseTracker2D;
  window.ensureTracker2DCanvas = ensureTracker2DCanvas;
  window.mountTracker2D = mountTracker2D;
  window.updateTracker2DFromPoints = updateTracker2DFromPoints;
  window.repaintTracker2D = repaintTracker2D;
})();
