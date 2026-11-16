(() => {
  const SITE = window.SITE, PROJECTS = window.PROJECTS;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const pad = (n) => String(n).padStart(2, "0");

  /* ---------- shared ---------- */
  $$("[data-year]").forEach((el) => (el.textContent = new Date().getFullYear()));
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add("is-loaded")));

  const nav = $(".nav");
  const onScroll = () => nav.classList.toggle("is-stuck", scrollY > 40);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Custom cursor
  const cursor = $(".cursor");
  if (finePointer && !reduced && cursor) {
    document.documentElement.classList.add("has-cursor");
    let x = innerWidth / 2, y = innerHeight / 2, cx = x, cy = y;
    addEventListener("pointermove", (e) => { x = e.clientX; y = e.clientY; cursor.classList.add("is-live"); });
    (function loop() {
      cx += (x - cx) * 0.2; cy += (y - cy) * 0.2;
      cursor.style.transform = `translate(${cx}px,${cy}px)`;
      requestAnimationFrame(loop);
    })();
    document.addEventListener("pointerover", (e) => {
      const t = e.target.closest("a,button,[data-play],[data-zoom]");
      cursor.classList.toggle("is-hover", !!t);
      cursor.dataset.label = t ? t.dataset.cursor || "" : "";
    });
  }

  // Click-to-load Vimeo player
  const player = (id, poster, pos, title) => `
    <button class="player" data-play="${id}" data-cursor="Play" aria-label="Play ${title}">
      <img src="${poster}" alt="" loading="lazy" style="object-position:${pos || "50% 50%"}">
      <span class="player__btn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span>
      <span class="player__title mono">${title}</span>
    </button>`;
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-play]");
    if (!b) return;
    const f = document.createElement("iframe");
    f.src = `https://player.vimeo.com/video/${b.dataset.play}?autoplay=1&title=0&byline=0&portrait=0&dnt=1`;
    f.allow = "autoplay; fullscreen; picture-in-picture";
    f.allowFullscreen = true;
    f.title = b.getAttribute("aria-label").replace(/^Play /, "");
    f.className = "player player--live";
    b.replaceWith(f);
  });

  const observe = () => {
    const els = $$(".reveal:not(.is-in)");
    if (reduced || !("IntersectionObserver" in window)) return els.forEach((el) => el.classList.add("is-in"));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); } });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    els.forEach((el) => io.observe(el));
  };

  /* ---------- home ---------- */
  if (document.body.classList.contains("home")) {
    // Hero: slides + cursor-driven studio light
    const slides = [
      { src: "assets/img/car-render-1.jpg", pos: "50% 55%", name: "Night Bridge" },
      { src: "assets/img/kia-hatch-4.webp", pos: "50% 60%", name: "KIA K4 Hatchback" },
      { src: "assets/img/ferrari-cover.webp", pos: "50% 90%", name: "Ferrari Roma" },
      { src: "assets/img/gto-1.webp", pos: "50% 55%", name: "Pontiac GTO" },
      { src: "assets/img/audi-cover.webp", pos: "50% 72%", name: "Forest Run" },
    ];
    const hero = $(".hero"), layers = $$(".hero__layer");
    layers.forEach((l) => (l.innerHTML = slides.map((s, i) =>
      `<img src="${s.src}" alt="" style="object-position:${s.pos}" ${i ? 'loading="lazy"' : 'fetchpriority="high"'} class="${i ? "" : "is-on"}">`).join("")));
    $("[data-slide-total]").textContent = pad(slides.length);
    let cur = 0;
    const show = (i) => {
      cur = (i + slides.length) % slides.length;
      layers.forEach((l) => $$("img", l).forEach((im, k) => im.classList.toggle("is-on", k === cur)));
      $("[data-slide-no]").textContent = pad(cur + 1);
      $("[data-slide-name]").textContent = slides[cur].name;
    };
    show(0);
    if (!reduced) setInterval(() => { if (!document.hidden) show(cur + 1); }, 5200);

    // light position
    let lx = 0.68, ly = 0.42, tx = lx, ty = ly, manual = false, idle;
    hero.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      const r = hero.getBoundingClientRect();
      tx = (e.clientX - r.left) / r.width; ty = (e.clientY - r.top) / r.height;
      manual = true; hero.classList.add("is-lit");
      clearTimeout(idle); idle = setTimeout(() => (manual = false), 2500);
    });
    const t0 = performance.now();
    (function loop(now) {
      if (!manual && !reduced) {
        const t = (now - t0) / 1000;
        tx = 0.5 + Math.cos(t * 0.35) * 0.3; ty = 0.48 + Math.sin(t * 0.5) * 0.16;
      }
      lx += (tx - lx) * 0.08; ly += (ty - ly) * 0.08;
      hero.style.setProperty("--lx", (lx * 100).toFixed(2) + "%");
      hero.style.setProperty("--ly", (ly * 100).toFixed(2) + "%");
      // 24 fps timecode
      const f = Math.floor(((now - t0) / 1000) * 24);
      $("[data-timecode]").textContent =
        `${pad(Math.floor(f / 86400) % 24)}:${pad(Math.floor(f / 1440) % 60)}:${pad(Math.floor(f / 24) % 60)}:${pad(f % 24)}`;
      requestAnimationFrame(loop);
    })(t0);

    // Featured film
    const ft = SITE.featured;
    $("[data-featured]").innerHTML = player(ft.vimeo, ft.poster, "50% 50%", ft.title) +
      `<div class="film__meta mono"><span>${ft.note}</span><a href="project.html?p=${ft.slug}">Project details →</a></div>`;

    // Work list
    $("[data-work]").innerHTML = PROJECTS.map((p, i) => `
      <a class="card reveal" href="project.html?p=${p.slug}" data-cursor="View">
        <span class="card__no" aria-hidden="true">${pad(i + 1)}</span>
        <div class="card__img"><img src="${p.cover}" alt="${p.title}" loading="lazy" style="object-position:${p.pos}">
          ${p.videos.length ? '<span class="card__badge mono">▶ Film</span>' : '<span class="card__badge mono">Still</span>'}</div>
        <div class="card__body">
          <span class="mono">${p.year} · ${p.kicker}</span>
          <h3>${p.title}</h3>
          <ul class="tags mono">${p.tags.map((t) => `<li>${t}</li>`).join("")}</ul>
          <span class="card__go mono">View project <i>→</i></span>
        </div>
      </a>`).join("");

    // Contact buttons
    const links = Object.entries(SITE.links);
    $("[data-contact]").innerHTML =
      (SITE.email ? `<a class="btn btn--solid btn--xl" href="mailto:${SITE.email}">${SITE.email}</a>` : "") +
      links.map(([k, v], i) =>
        `<a class="btn ${!SITE.email && !i ? "btn--solid" : ""} btn--xl" href="${v}" target="_blank" rel="noopener">${!SITE.email && !i ? "Message me on " : ""}${k} ↗</a>`).join("");
  }

  /* ---------- project page ---------- */
  const root = $("[data-project]");
  if (root) {
    const slug = new URLSearchParams(location.search).get("p");
    const i = Math.max(0, PROJECTS.findIndex((p) => p.slug === slug));
    const p = PROJECTS[i], next = PROJECTS[(i + 1) % PROJECTS.length];
    document.title = `${p.title} — ${SITE.name}`;
    const poster = (k) => p.images[k % Math.max(1, p.images.length)] || p.cover;
    const stills = p.videos.length ? p.images : p.images.slice(1);
    const lead = p.videos.length
      ? player(p.videos[0].id, p.images[0] || p.cover, p.images[0] ? "50% 50%" : p.pos, p.videos[0].title)
      : `<button class="still" data-zoom="${p.images[0]}" data-cursor="Zoom"><img src="${p.images[0]}" alt="${p.title}"></button>`;

    root.innerHTML = `
      <section class="phero">
        <img class="phero__bg" src="${p.cover}" alt="" style="object-position:${p.pos}">
        <div class="phero__copy wrap">
          <p class="mono">${pad(i + 1)} / ${pad(PROJECTS.length)} · ${p.year} · ${p.kicker}</p>
          <h1>${p.title}</h1>
          <ul class="tags mono">${p.tags.map((t) => `<li>${t}</li>`).join("")}</ul>
        </div>
      </section>

      <section class="wrap pmain">
        <div class="pmain__lead reveal">${lead}</div>

        <div class="pinfo">
          <dl class="pinfo__specs mono reveal">
            ${p.specs.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
          </dl>
          <div class="pinfo__text reveal">
            ${p.body.map((b) => `<h2>${b.h}</h2><p>${b.p}</p>`).join("")}
            ${p.focus.length ? `<h2>Key focus</h2><ul class="focus">${p.focus.map((f) => `<li>${f}</li>`).join("")}</ul>` : ""}
            <p class="credits mono">${p.credits}</p>
          </div>
        </div>

        ${p.videos.length > 1 ? `<div class="pgrid pgrid--films">${p.videos.slice(1).map((v, k) =>
          `<div class="reveal">${player(v.id, poster(k + 1), "50% 50%", v.title)}</div>`).join("")}</div>` : ""}

        ${stills.length ? `<div class="pgrid">${stills.map((s) =>
          `<button class="still reveal" data-zoom="${s}" data-cursor="Zoom"><img src="${s}" alt="${p.title} — still" loading="lazy"></button>`).join("")}</div>` : ""}
      </section>

      <a class="pnext" href="project.html?p=${next.slug}" data-cursor="Next">
        <img src="${next.cover}" alt="" loading="lazy" style="object-position:${next.pos}">
        <span class="mono">Next project</span>
        <strong>${next.title}</strong>
      </a>`;

    const lb = $("[data-lightbox]");
    document.addEventListener("click", (e) => {
      const z = e.target.closest("[data-zoom]");
      if (z) { $("img", lb).src = z.dataset.zoom; lb.showModal(); }
      else if (e.target === lb || e.target.closest("[data-lightbox-close]")) lb.close();
    });
  }

  observe();
})();
