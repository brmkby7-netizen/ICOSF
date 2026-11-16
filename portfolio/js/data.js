/* ------------------------------------------------------------------
   All site content lives here. Edit this file to change text, links,
   projects and videos — no other file needs touching.
------------------------------------------------------------------- */

window.SITE = {
  name: "Bahri Ben Youssef",
  brand: "The Green Goat",
  role: "Automotive CGI & Unreal Engine cinematics",
  // Leave email empty to hide the email button.
  email: "",
  links: {
    ArtStation: "https://www.artstation.com/bahribenyoussef2",
    // Add more, e.g.  Instagram: "https://instagram.com/…",  LinkedIn: "…"
  },
  // The film shown in the "Featured film" block on the home page.
  featured: {
    vimeo: "1163397025",
    poster: "assets/img/kia-hatch-2.webp",
    title: "KIA K4 Hatchback 2026",
    note: "Client production · Unreal Engine 5 · Path traced",
    slug: "kia-k4-hatchback",
  },
};

window.PROJECTS = [
  {
    slug: "bugatti-tourbillon",
    title: "Bugatti Tourbillon",
    kicker: "CGI automotive render",
    year: "2026",
    tags: ["Unreal Engine 5", "Lumen", "Film"],
    cover: "assets/img/bugatti-cover.jpg",
    pos: "50% 62%",
    videos: [{ id: "1163779845", title: "Bugatti Tourbillon — film" }],
    images: [],
    specs: [
      ["Software", "Unreal Engine 5, Blender"],
      ["Rendering", "Lumen — real-time lighting and reflections"],
      ["Lighting", "Cinematic setup for balanced highlights and shadows"],
      ["Materials", "Automotive paint, glass, surface detailing"],
      ["Workflow", "Real-time automotive visualization"],
    ],
    body: [
      {
        h: "Overview",
        p: "The Bugatti Tourbillon, built as a CGI automotive render inside Unreal Engine using the Lumen workflow. The focus was on presenting the vehicle with a clean cinematic look while studying lighting, reflections and overall composition.",
      },
      {
        h: "Approach & direction",
        p: "The goal was a strong automotive visual that highlights the design and presence of the Tourbillon. I kept the environment simple to let the car stand out, using controlled lighting and camera angles to emphasize the body lines and materials.",
      },
    ],
    focus: [
      "Automotive CGI presentation",
      "Lighting and reflection control using Lumen",
      "Clean composition and framing",
      "Real-time rendering workflow in Unreal Engine",
    ],
    credits: "Created by Bahri Ben Youssef. CGI automotive render developed in Unreal Engine.",
  },
  {
    slug: "kia-k4-hatchback",
    title: "KIA K4 Hatchback 2026",
    kicker: "Automotive cinematic · Client production",
    year: "2026",
    tags: ["Unreal Engine 5", "Path tracing", "Client work"],
    cover: "assets/img/kia-hatch-cover.webp",
    pos: "50% 68%",
    videos: [
      { id: "1163397025", title: "KIA K4 Hatchback — film 01" },
      { id: "1163409231", title: "KIA K4 Hatchback — film 02" },
      { id: "1163409835", title: "KIA K4 Hatchback — film 03" },
    ],
    images: [
      "assets/img/kia-hatch-1.webp",
      "assets/img/kia-hatch-2.webp",
      "assets/img/kia-hatch-3.webp",
      "assets/img/kia-hatch-4.webp",
    ],
    specs: [
      ["Software", "Unreal Engine 5, Blender"],
      ["Rendering", "Path tracing workflow"],
      ["Lighting", "Cinematic setup for natural reflections and depth"],
      ["Materials", "Realistic automotive paint, glass, surface detailing"],
      ["Pipeline", "Real-time automotive visualization for client delivery"],
    ],
    body: [
      {
        h: "Overview",
        p: "A cinematic realism study focused on lighting, reflections and clean automotive presentation. The KIA K4 Hatchback 2026 was created in Unreal Engine as part of a professional client production, with the goal of delivering a clean, cinematic presentation and a strong sense of mood.",
      },
      {
        h: "Approach & direction",
        p: "The visual direction was inspired by modern car commercials and launch visuals. I focused on building a believable environment and using controlled lighting to highlight the design and shape of the vehicle while keeping the look polished and professional.",
      },
    ],
    focus: [
      "Cinematic automotive presentation",
      "Lighting and reflections workflow",
      "Clean composition and mood",
      "Real-time rendering for production use",
    ],
    credits: "Created by Bahri Ben Youssef. Professional automotive visualization project developed in Unreal Engine for client use.",
  },
  {
    slug: "ferrari-roma",
    title: "Ferrari Roma Un_reel",
    kicker: "Cinematic car animation",
    year: "2025",
    tags: ["Unreal Engine 5", "Animation", "Camera work"],
    cover: "assets/img/ferrari-cover.webp",
    pos: "50% 88%",
    videos: [{ id: "1145489442", title: "Ferrari Roma Un_reel — film" }],
    images: [],
    specs: [
      ["Software", "Unreal Engine 5"],
      ["Format", "Short cinematic teaser"],
      ["Shots", "Close-ups, tracking shots, hero angles"],
      ["Type", "Personal practice piece"],
    ],
    body: [
      {
        h: "Overview",
        p: "A cinematic animation of the Ferrari Roma, created in Unreal Engine as a study in car movement, camera work and mood. I wanted it to feel like a short teaser you might see in a commercial or launch trailer — clean and stylish.",
      },
      {
        h: "Inspiration & narrative",
        p: "The piece is inspired by modern Ferrari promo films and the work of Matheus Ventura, whose shots and pacing pushed me to try my own take on a Roma cinematic. The idea was simple: let the car glide through the frame, keep the background minimal, and use light and reflections to highlight its shape and attitude.",
      },
    ],
    focus: [
      "Car animation and camera work",
      "Cinematic framing and shot variety",
      "Lighting and reflections to show off the body lines",
      "Automotive cinematics in Unreal Engine",
    ],
    credits: "Created by Bahri Ben Youssef. Inspired by the work of Matheus Ventura.",
  },
  {
    slug: "kia-k4-nature",
    title: "KIA K4 — Between Nature and Motion",
    kicker: "Path-traced automotive animation",
    year: "2025",
    tags: ["Unreal Engine 5", "Blender", "Path tracing"],
    cover: "assets/img/kia-nature-cover.webp",
    pos: "50% 82%",
    videos: [{ id: "1135085063", title: "Kia K4 — UE5 path-traced automotive animation" }],
    images: [],
    specs: [
      ["Software", "Unreal Engine 5, Blender"],
      ["Rendering", "Path tracing"],
      ["Focus", "Lighting, mood, realism"],
    ],
    body: [
      {
        h: "Overview",
        p: "A fun creative challenge — building a peaceful environment that still feels grounded and believable. My main focus was on lighting, mood and realism, using Unreal Engine and Blender to bring everything together.",
      },
    ],
    focus: ["Environment building", "Natural lighting and mood", "Path-traced realism"],
    credits: "Created by Bahri Ben Youssef.",
  },
  {
    slug: "pontiac-gto",
    title: "Pontiac GTO",
    kicker: "Classic muscle studio render",
    year: "2025",
    tags: ["Unreal Engine 5", "Path tracing", "Studio still"],
    cover: "assets/img/gto-1.webp",
    pos: "50% 50%",
    videos: [],
    images: ["assets/img/gto-1.webp"],
    specs: [
      ["Software", "Unreal Engine 5, Blender"],
      ["Render", "Path-traced studio setup"],
      ["Lighting", "Soft, controlled studio lighting"],
      ["Materials", "Glossy paint, chrome details, believable tires"],
      ["Post", "Very light contrast and clarity adjustments, in-engine"],
    ],
    body: [
      {
        h: "Overview",
        p: "A clean, monochrome take on a classic American muscle car. I wanted the image to feel like a high-end studio photoshoot, where the focus is fully on the lines of the car, the chrome, and the attitude it carries.",
      },
      {
        h: "Inspiration & narrative",
        p: "Inspired by old magazine ads and black-and-white car photography. The idea was simple: strip everything back, remove the noise, and let the shape, reflections and stance of the Pontiac GTO do the talking. No busy background, just a bold car sitting in a quiet studio.",
      },
    ],
    focus: [
      "Silhouette and curves of a classic muscle car",
      "Clean, minimalist studio composition",
      "Reflections, chrome and paint",
      "Realism, lighting and presentation",
    ],
    credits: "All rigging, lighting and rendering by Bahri Ben Youssef. A personal realism and lighting study.",
  },
  {
    slug: "path-traced-run",
    title: "Path-Traced Forest Run",
    kicker: "Unreal Engine car animation",
    year: "2024",
    tags: ["Unreal Engine", "Path tracing", "Animation"],
    cover: "assets/img/audi-cover.webp",
    pos: "50% 72%",
    videos: [{ id: "990056595", title: "Path tracing Unreal Engine car animation" }],
    images: [],
    specs: [
      ["Software", "Unreal Engine"],
      ["Rendering", "Path tracing"],
      ["Plugins", "Cinematic Car Rig, Citybld"],
    ],
    body: [
      {
        h: "Overview",
        p: "A 3D environment and car animation built in Unreal Engine, leaning on its path tracing for photorealistic lighting and reflections and to bring the small details to life.",
      },
    ],
    focus: ["Photorealistic lighting", "Reflections", "Vehicle animation"],
    credits: "Created by Bahri Ben Youssef. Thanks to the creators of the Cinematic Car Rig and Citybld plugins.",
  },
  {
    slug: "car-render",
    title: "Night Bridge",
    kicker: "Car render · Early study",
    year: "2024",
    tags: ["Still", "Night lighting"],
    cover: "assets/img/car-render-1.jpg",
    pos: "50% 50%",
    videos: [],
    images: ["assets/img/car-render-1.jpg"],
    specs: [["Type", "Still render"]],
    body: [],
    focus: [],
    credits: "Created by Bahri Ben Youssef.",
  },
];
