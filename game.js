(() => {
  "use strict";

  const DURATION = 60; // seconds per round
  const MAX_DT = 1 / 20; // clamp long frames so nothing jumps after a stall
  const MAX_BUBBLES = 46;
  const SPRITE_R = 144; // bubble radius inside the pre-rendered sprite, in device pixels
  const SPRITE_PAD = 1.32; // sprite size relative to the bubble, leaves room for the glow
  const COLORS = ["#ff5a6e", "#ff9a3c", "#ffd23f", "#3ee0a1", "#3cc8ff", "#5b7cff", "#a66bff", "#ff5fae"];
  const BEST_KEY = "bubble-buster:best";
  const MUTE_KEY = "bubble-buster:muted";
  const TAU = Math.PI * 2;

  const $ = (id) => document.getElementById(id);
  const canvas = $("stage");
  const ctx = canvas.getContext("2d");
  const ui = {
    hud: $("hud"),
    score: $("score"),
    time: $("time"),
    timeStat: $("time").parentElement,
    timeBar: $("time-bar"),
    pauseBtn: $("pause-btn"),
    soundBtns: document.querySelectorAll(".sound-btn"),
    start: $("start-screen"),
    startBtn: $("start-btn"),
    startBest: $("start-best"),
    pause: $("pause-screen"),
    resumeBtn: $("resume-btn"),
    restartBtn: $("restart-btn"),
    over: $("over-screen"),
    againBtn: $("again-btn"),
    finalScore: $("final-score"),
    newBest: $("new-best"),
    statPopped: $("stat-popped"),
    statAccuracy: $("stat-accuracy"),
    statBest: $("stat-best"),
  };

  const fmt = new Intl.NumberFormat();
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => lerp(a, b, Math.random());
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* storage blocked (private mode); the game still works */
      }
    },
  };

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = motionQuery.matches;
  motionQuery.addEventListener?.("change", (e) => (reduced = e.matches));

  // ---------- Sprites: each colour is drawn once, then scaled per bubble ----------

  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;
  const tint = (rgb, t) => rgb.map((v) => Math.round(v + (255 - v) * t));

  function makeSprite(hex) {
    const rgb = hexToRgb(hex);
    const light = tint(rgb, 0.55);
    const size = Math.ceil(SPRITE_R * 2 * SPRITE_PAD);
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const m = size / 2;
    const r = SPRITE_R;

    // Soft outer glow
    let grad = g.createRadialGradient(m, m, r * 0.85, m, m, r * SPRITE_PAD);
    grad.addColorStop(0, rgba(rgb, 0.3));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);

    // Body: clear in the middle, colour gathering towards the rim like a soap film
    g.save();
    g.beginPath();
    g.arc(m, m, r, 0, TAU);
    g.clip();
    g.clearRect(0, 0, size, size);
    grad = g.createRadialGradient(m - r * 0.18, m - r * 0.22, r * 0.05, m, m, r);
    grad.addColorStop(0, rgba(light, 0.14));
    grad.addColorStop(0.62, rgba(rgb, 0.2));
    grad.addColorStop(0.88, rgba(rgb, 0.56));
    grad.addColorStop(1, rgba(light, 0.95));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);

    // Light bouncing up from the bottom edge
    grad = g.createRadialGradient(m + r * 0.3, m + r * 0.48, 0, m + r * 0.3, m + r * 0.48, r * 0.55);
    grad.addColorStop(0, "rgba(255,255,255,0.12)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    g.restore();

    // Rim
    g.lineWidth = r * 0.035;
    g.strokeStyle = rgba(light, 0.75);
    g.beginPath();
    g.arc(m, m, r - g.lineWidth / 2, 0, TAU);
    g.stroke();

    // Window highlight
    g.save();
    g.translate(m - r * 0.4, m - r * 0.42);
    g.rotate(-Math.PI / 4);
    g.scale(1, 0.55);
    grad = g.createRadialGradient(0, 0, 0, 0, 0, r * 0.27);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.5, "rgba(255,255,255,0.5)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, r * 0.27, 0, TAU);
    g.fill();
    g.restore();

    // Small glint
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.beginPath();
    g.arc(m - r * 0.08, m - r * 0.62, r * 0.045, 0, TAU);
    g.fill();

    return { canvas: c, color: hex, light: rgba(light, 1) };
  }

  const sprites = COLORS.map(makeSprite);

  // ---------- Sound (synthesised, no files) ----------

  let audio = null;
  let master = null;
  let noise = null;
  let muted = store.get(MUTE_KEY) === "1";

  function ensureAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audio) {
      audio = new AC();
      master = audio.createGain();
      master.gain.value = muted ? 0 : 0.55;
      master.connect(audio.destination);
      noise = audio.createBuffer(1, Math.floor(audio.sampleRate * 0.04), audio.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    if (audio.state === "suspended") audio.resume();
  }

  function tone({ type = "sine", from, to, start = 0, dur, gain }) {
    const t = audio.currentTime + start;
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur * 0.6);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(amp).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  const sound = {
    pop(sizeT) {
      if (!audio || muted) return;
      const f = 320 + (1 - sizeT) * 820 + Math.random() * 60;
      tone({ from: f, to: f * 1.9, dur: 0.12, gain: 0.32 });
      const src = audio.createBufferSource();
      const hp = audio.createBiquadFilter();
      const amp = audio.createGain();
      src.buffer = noise;
      hp.type = "highpass";
      hp.frequency.value = 2400;
      amp.gain.value = 0.12;
      src.connect(hp).connect(amp).connect(master);
      src.start();
    },
    tick() {
      if (audio && !muted) tone({ type: "triangle", from: 880, dur: 0.07, gain: 0.12 });
    },
    start() {
      if (!audio || muted) return;
      tone({ type: "triangle", from: 523, dur: 0.14, gain: 0.14 });
      tone({ type: "triangle", from: 784, start: 0.09, dur: 0.2, gain: 0.14 });
    },
    end() {
      if (!audio || muted) return;
      tone({ type: "triangle", from: 784, dur: 0.18, gain: 0.16 });
      tone({ type: "triangle", from: 523, start: 0.14, dur: 0.22, gain: 0.16 });
      tone({ type: "triangle", from: 392, start: 0.3, dur: 0.4, gain: 0.16 });
    },
  };

  function setMuted(value) {
    muted = value;
    store.set(MUTE_KEY, muted ? "1" : "0");
    if (master) master.gain.value = muted ? 0 : 0.55;
    ui.soundBtns.forEach((btn) => {
      btn.setAttribute("aria-pressed", String(muted));
      btn.setAttribute("aria-label", muted ? "Turn sound on" : "Mute sound");
    });
  }

  // ---------- World ----------

  let W = 0;
  let H = 0;
  let R_MIN = 18;
  let R_MAX = 48;
  let V_MIN = 80;
  let V_MAX = 300;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = "high";
    const m = Math.min(W, H);
    R_MIN = clamp(m * 0.045, 16, 26);
    R_MAX = clamp(m * 0.12, 40, 72);
    V_MIN = H * 0.11;
    V_MAX = H * 0.42;
    for (const b of bubbles) b.x0 = clamp(b.x0, b.r, Math.max(b.r, W - b.r));
  }

  let state = "menu"; // menu | playing | paused | over
  let bubbles = [];
  let pops = [];
  let drops = [];
  let floaters = [];
  let ripples = [];
  let score = 0;
  let popped = 0;
  let taps = 0;
  let hits = 0;
  let timeLeft = DURATION;
  let shownSecond = DURATION;
  let nextSpawn = 0;
  let lastColor = -1;
  let endTimer = 0;

  function spawnBubble(y, still = false) {
    const sizeT = Math.pow(Math.random(), 1.1); // 0 = smallest, 1 = biggest
    const r = lerp(R_MIN, R_MAX, sizeT);
    const speedT = clamp((1 - sizeT) * 0.62 + Math.random() * 0.38, 0, 1);
    const difficulty = state === "playing" ? 1 + 0.35 * ((DURATION - timeLeft) / DURATION) : 0.75;
    const vy = still ? 0 : lerp(V_MIN, V_MAX, speedT) * difficulty;
    const fastT = clamp((vy - V_MIN) / (V_MAX - V_MIN), 0, 1);
    // 10 for a big, slow bubble up to 80 for a tiny, fast one
    const points = 10 + 5 * Math.round((40 * (1 - sizeT) + 30 * fastT) / 5);
    let color = Math.floor(Math.random() * sprites.length);
    if (color === lastColor) color = (color + 1) % sprites.length;
    lastColor = color;
    const x0 = rand(r, Math.max(r, W - r));
    bubbles.push({
      x0,
      x: x0,
      y: y ?? H + r * SPRITE_PAD,
      r,
      vy,
      sizeT,
      points,
      still,
      sprite: sprites[color],
      phase: rand(0, TAU),
      amp: reduced || still ? 0 : rand(4, 14) * (0.6 + sizeT * 0.6),
      freq: rand(0.4, 0.8),
      squash: 0,
      age: 0,
    });
  }

  function spawnInterval() {
    const width = clamp(W / 700, 0.8, 1.6); // wider screens need more bubbles to feel as busy
    if (state === "playing") return 1 / (lerp(1.6, 3.6, (DURATION - timeLeft) / DURATION) * width);
    return reduced ? Infinity : 1 / (1.1 * width);
  }

  function seedField() {
    const count = Math.round(clamp((W * H) / 52000, 6, 14));
    for (let i = 0; i < count; i++) spawnBubble(rand(H * 0.12, H * 1.05), reduced);
  }

  // ---------- Effects ----------

  function popBubble(b) {
    bubbles.splice(bubbles.indexOf(b), 1);
    score += b.points;
    popped++;
    hits++;
    pops.push({ x: b.x, y: b.y, r: b.r, sprite: b.sprite, t: 0 });
    floaters.push({ x: b.x, y: b.y, text: `+${b.points}`, color: b.sprite.light, size: 18 + (b.points / 80) * 12, t: 0 });
    if (!reduced) {
      const count = 7 + Math.round(b.sizeT * 6);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU + rand(-0.3, 0.3);
        const speed = rand(90, 250) * (0.6 + b.r / R_MAX * 0.5);
        drops.push({
          x: b.x + Math.cos(a) * b.r * 0.8,
          y: b.y + Math.sin(a) * b.r * 0.8,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed - 40,
          size: rand(1.6, 3.6) * (0.6 + b.r / R_MAX * 0.6),
          color: b.sprite.light,
          life: 0,
          max: rand(0.4, 0.65),
        });
      }
    }
    sound.pop(b.sizeT);
    setScore(score, true);
  }

  // ---------- Loop ----------

  function update(dt) {
    if (state === "playing") {
      timeLeft = Math.max(0, timeLeft - dt);
      const second = Math.ceil(timeLeft);
      if (second !== shownSecond) {
        shownSecond = second;
        ui.time.textContent = second;
        if (second <= 5 && second > 0) sound.tick();
      }
      const low = timeLeft <= 10;
      ui.hud.classList.toggle("is-low", low);
      ui.timeStat.classList.toggle("is-low", low);
      ui.timeBar.style.transform = `scaleX(${timeLeft / DURATION})`;
      if (timeLeft <= 0) endGame();
    }

    nextSpawn -= dt;
    if (nextSpawn <= 0) {
      if (bubbles.length < MAX_BUBBLES && Number.isFinite(spawnInterval())) spawnBubble();
      nextSpawn = spawnInterval() * rand(0.55, 1.45);
    }

    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.age += dt;
      b.y -= b.vy * dt;
      b.x = b.x0 + Math.sin(b.age * b.freq * TAU + b.phase) * b.amp;
      b.squash = reduced ? 0 : Math.sin(b.age * 3.2 + b.phase) * 0.035;
      if (b.y < -b.r * SPRITE_PAD) bubbles.splice(i, 1);
    }

    for (const p of pops) p.t += dt;
    pops = pops.filter((p) => p.t < 0.32);

    for (const d of drops) {
      d.life += dt;
      d.vy += 520 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
    }
    drops = drops.filter((d) => d.life < d.max);

    for (const f of floaters) f.t += dt;
    floaters = floaters.filter((f) => f.t < 0.85);

    for (const r of ripples) r.t += dt;
    ripples = ripples.filter((r) => r.t < 0.35);
  }

  function drawSprite(sprite, x, y, r, sx = 1, sy = 1) {
    const d = r * 2 * SPRITE_PAD;
    ctx.drawImage(sprite.canvas, x - (d * sx) / 2, y - (d * sy) / 2, d * sx, d * sy);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    for (const b of bubbles) drawSprite(b.sprite, b.x, b.y, b.r, 1 + b.squash, 1 - b.squash);

    for (const p of pops) {
      const e = p.t / 0.32;
      if (p.t < 0.1) {
        const k = p.t / 0.1;
        ctx.globalAlpha = 1 - k;
        drawSprite(p.sprite, p.x, p.y, p.r * (1 + 0.22 * k));
      }
      ctx.globalAlpha = (1 - e) * 0.9;
      ctx.strokeStyle = p.sprite.light;
      ctx.lineWidth = Math.max(1, p.r * 0.12 * (1 - e));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1 + 0.55 * easeOut(e)), 0, TAU);
      ctx.stroke();
    }

    for (const d of drops) {
      ctx.globalAlpha = 1 - d.life / d.max;
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.size, 0, TAU);
      ctx.fill();
    }

    for (const r of ripples) {
      const e = r.t / 0.35;
      ctx.globalAlpha = 0.45 * (1 - e);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 6 + 18 * easeOut(e), 0, TAU);
      ctx.stroke();
    }

    if (floaters.length) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const f of floaters) {
        const e = f.t / 0.85;
        const rise = reduced ? 0 : 46 * easeOut(e);
        const pop = reduced ? 1 : 1 + 0.35 * Math.max(0, 1 - f.t / 0.12);
        ctx.globalAlpha = e < 0.55 ? 1 : 1 - (e - 0.55) / 0.45;
        ctx.font = `600 ${Math.round(f.size * pop)}px Fredoka, ui-rounded, system-ui, sans-serif`;
        ctx.shadowColor = f.color;
        ctx.shadowBlur = 14;
        ctx.fillStyle = "#fff";
        ctx.fillText(f.text, f.x, f.y - rise);
      }
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
    }

    ctx.globalAlpha = 1;
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, MAX_DT);
    last = now;
    if (state !== "paused") update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  // ---------- Input ----------

  function pointerToBubble(x, y, pad) {
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      if (Math.hypot(x - b.x, y - b.y) <= b.r) return b;
    }
    // Forgive near misses on touch screens: the closest edge within reach wins
    let best = null;
    let bestGap = pad;
    for (const b of bubbles) {
      const gap = Math.hypot(x - b.x, y - b.y) - b.r;
      if (gap <= bestGap) {
        best = b;
        bestGap = gap;
      }
    }
    return best;
  }

  canvas.addEventListener(
    "pointerdown",
    (e) => {
      if (state !== "playing") return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const pad = e.pointerType === "touch" ? 14 : e.pointerType === "pen" ? 8 : 4;
      const target = pointerToBubble(x, y, pad);
      taps++;
      if (target) popBubble(target);
      else ripples.push({ x, y, t: 0 });
    },
    { passive: false },
  );
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("dblclick", (e) => e.preventDefault());

  // ---------- Screens ----------

  function showScreen(el, focusEl) {
    el.hidden = false;
    void el.offsetWidth; // let the fade start from the hidden state
    el.classList.add("is-visible");
    if (focusEl) focusEl.focus({ preventScroll: true });
  }

  function hideScreen(el) {
    if (el.hidden) return;
    el.classList.remove("is-visible");
    setTimeout(() => {
      if (!el.classList.contains("is-visible")) el.hidden = true;
    }, reduced ? 0 : 340);
  }

  function setScore(value, bump) {
    ui.score.textContent = fmt.format(value);
    if (bump && !reduced) {
      ui.score.classList.remove("is-bump");
      void ui.score.offsetWidth;
      ui.score.classList.add("is-bump");
    }
  }

  function getBest() {
    return Number.parseInt(store.get(BEST_KEY) || "0", 10) || 0;
  }

  function renderStartBest() {
    const best = getBest();
    ui.startBest.hidden = best <= 0;
    if (best > 0) {
      const strong = document.createElement("strong");
      strong.textContent = fmt.format(best);
      ui.startBest.replaceChildren("Best score ", strong);
    }
  }

  function startGame() {
    ensureAudio();
    clearTimeout(endTimer);
    state = "playing";
    score = 0;
    popped = 0;
    taps = 0;
    hits = 0;
    timeLeft = DURATION;
    shownSecond = DURATION;
    bubbles = bubbles.filter((b) => !b.still);
    if (bubbles.length < 4) for (let i = 0; i < 4; i++) spawnBubble(rand(H * 0.6, H * 1.05));
    nextSpawn = 0.15;
    setScore(0, false);
    ui.time.textContent = DURATION;
    ui.timeBar.style.transform = "scaleX(1)";
    ui.hud.classList.remove("is-low");
    ui.timeStat.classList.remove("is-low");
    ui.hud.hidden = false;
    document.body.classList.add("is-playing");
    hideScreen(ui.start);
    hideScreen(ui.pause);
    hideScreen(ui.over);
    sound.start();
  }

  function pauseGame() {
    if (state !== "playing") return;
    state = "paused";
    document.body.classList.remove("is-playing");
    showScreen(ui.pause, ui.resumeBtn);
  }

  function resumeGame() {
    if (state !== "paused") return;
    ensureAudio();
    state = "playing";
    last = performance.now();
    document.body.classList.add("is-playing");
    hideScreen(ui.pause);
  }

  function endGame() {
    state = "over";
    document.body.classList.remove("is-playing");
    sound.end();
    const prevBest = getBest();
    const isBest = score > prevBest;
    if (isBest) store.set(BEST_KEY, String(score));
    const finalScore = score;
    endTimer = setTimeout(() => {
      ui.hud.hidden = true;
      ui.newBest.hidden = !isBest;
      ui.statPopped.textContent = fmt.format(popped);
      ui.statAccuracy.textContent = taps ? `${Math.round((hits / taps) * 100)}%` : "–";
      ui.statBest.textContent = fmt.format(Math.max(prevBest, finalScore));
      renderStartBest();
      showScreen(ui.over, ui.againBtn);
      countUp(ui.finalScore, finalScore);
    }, 550);
  }

  function countUp(el, target) {
    if (reduced || target === 0) {
      el.textContent = fmt.format(target);
      return;
    }
    const t0 = performance.now();
    const dur = 900;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      el.textContent = fmt.format(Math.round(target * easeOut(k)));
      if (k < 1 && state === "over") requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  ui.startBtn.addEventListener("click", startGame);
  ui.againBtn.addEventListener("click", startGame);
  ui.restartBtn.addEventListener("click", startGame);
  ui.resumeBtn.addEventListener("click", resumeGame);
  ui.pauseBtn.addEventListener("click", pauseGame);
  ui.soundBtns.forEach((btn) =>
    btn.addEventListener("click", () => {
      ensureAudio();
      setMuted(!muted);
    }),
  );

  document.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const key = e.key.toLowerCase();
    if (key === "escape" || key === "p") {
      if (state === "playing") pauseGame();
      else if (state === "paused") resumeGame();
      return;
    }
    if ((key === "enter" || key === " ") && !(e.target instanceof HTMLButtonElement)) {
      if (state === "menu" || (state === "over" && !ui.over.hidden)) {
        e.preventDefault();
        startGame();
      } else if (state === "paused") {
        e.preventDefault();
        resumeGame();
      }
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseGame();
  });

  window.addEventListener("resize", resize);

  // ---------- Boot ----------

  if (new URLSearchParams(location.search).has("debug")) {
    window.__bubbleBuster = {
      get state() {
        return state;
      },
      get score() {
        return score;
      },
      get timeLeft() {
        return timeLeft;
      },
      set timeLeft(v) {
        timeLeft = v;
      },
      bubbles: () => bubbles.map(({ x, y, r, points }) => ({ x, y, r, points })),
    };
  }

  setMuted(muted);
  resize();
  seedField();
  renderStartBest();
  showScreen(ui.start);
  requestAnimationFrame((now) => {
    last = now;
    frame(now);
  });
})();
