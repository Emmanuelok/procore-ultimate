import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import "./landing.css";

const FILM_DESKTOP =
  "https://d2ol7oe51mr4n9.cloudfront.net/user_3ChJ2tLVG7i2Ag6ynWBf8Xmyz6a/13c7ccbd-a31a-400d-8404-66bd65e14016.mp4";
const FILM_MOBILE =
  "https://d2ol7oe51mr4n9.cloudfront.net/user_3ChJ2tLVG7i2Ag6ynWBf8Xmyz6a/cd8da2e8-50fa-438b-84af-47988d92d692.mp4";
const FILM_POSTER = "/assets/landing/constructos-proof-line-poster-v1.webp";

type ModeId = "deliver" | "control" | "govern" | "assure";

interface OperatingMode {
  label: string;
  index: string;
  title: string;
  description: string;
  signal: string;
  signalMeta: string;
  modules: readonly string[];
  rail: readonly string[];
}

const OPERATING_MODES: Record<ModeId, OperatingMode> = {
  deliver: {
    label: "Deliver",
    index: "01",
    title: "The work stays connected.",
    description:
      "Drawings, BIM, RFIs, submittals, daily logs, photos and punch records keep their project context from first issue to final closeout.",
    signal: "RFI-042 resolved against drawing A-417",
    signalMeta: "2 linked decisions · 4 evidence items",
    modules: ["Drawings + BIM", "RFIs + submittals", "Field + quality"],
    rail: ["Issue", "Review", "Build", "Verify"],
  },
  control: {
    label: "Control",
    index: "02",
    title: "Money follows the decision.",
    description:
      "Budgets, contracts, valuations, variations and payments stay bound to scope, entitlement, evidence and approval history.",
    signal: "Variation VO-018 traced to instruction SI-009",
    signalMeta: "Basis recorded · approval separation intact",
    modules: ["Budget + forecast", "Contracts + changes", "Valuations + payments"],
    rail: ["Scope", "Entitle", "Value", "Certify"],
  },
  govern: {
    label: "Govern",
    index: "03",
    title: "Exposure becomes visible early.",
    description:
      "Schedule, risk, finance, land, workforce, ESG, insurance and jurisdiction controls expose the consequence before it becomes the outcome.",
    signal: "Permit obligation intersects critical activity C-210",
    signalMeta: "12 days to due date · programme link verified",
    modules: ["Schedule + risk", "Finance + safeguards", "ESG + jurisdiction"],
    rail: ["Detect", "Assess", "Oblige", "Escalate"],
  },
  assure: {
    label: "Assure",
    index: "04",
    title: "Every claim meets its evidence.",
    description:
      "Independent evidence is reconciled against assertions, consequential findings become obligations, and the result is preserved in a verifiable ledger.",
    signal: "Payment claim reconciled against measured progress",
    signalMeta: "3 independent sources · seal ready",
    modules: ["Evidence + reconciliation", "Signals + entity graph", "Ledger + escrow"],
    rail: ["Assert", "Test", "Resolve", "Seal"],
  },
};

const MODE_ORDER: readonly ModeId[] = ["deliver", "control", "govern", "assure"];

const CAPABILITY_GROUPS = [
  {
    number: "01",
    title: "Project delivery",
    body: "Drawings, BIM, RFIs, submittals, daily logs, punch, photos, documents and digital-twin handover.",
  },
  {
    number: "02",
    title: "Commercial control",
    body: "BoQs, budgets, contracts, commitments, variations, valuations, invoicing, payments and forensic claims.",
  },
  {
    number: "03",
    title: "Capital governance",
    body: "Schedule, risk, stage gates, finance, disputes, land, workforce, ESG, insurance and jurisdiction.",
  },
  {
    number: "04",
    title: "Evidence assurance",
    body: "Independent ingestion, reconciliation, signals, obligations, entity intelligence, sealed ledger and escrow receipts.",
  },
] as const;

type MotionConnection = {
  saveData?: boolean;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
};

function useStaticVisual(): boolean {
  const readPreference = () => {
    const connection = (navigator as Navigator & { connection?: MotionConnection }).connection;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches || connection?.saveData === true;
  };
  const [staticVisual, setStaticVisual] = useState(readPreference);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const connection = (navigator as Navigator & { connection?: MotionConnection }).connection;
    const update = () => setStaticVisual(query.matches || connection?.saveData === true);
    update();
    query.addEventListener("change", update);
    connection?.addEventListener?.("change", update);
    return () => {
      query.removeEventListener("change", update);
      connection?.removeEventListener?.("change", update);
    };
  }, []);

  return staticVisual;
}

function ConstructOSMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 40 40"
      role="img"
      aria-label="ConstructOS"
    >
      <path
        d="M29 8H16l-6 6v12l6 6h13"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <path d="M17 14h12M17 26h12" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="29" cy="20" r="2.4" fill="currentColor" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <span className="landing-menu-icon" aria-hidden="true" data-open={open ? "" : undefined}>
      <span />
      <span />
    </span>
  );
}

function LandingHeader() {
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        window.requestAnimationFrame(() => menuButtonRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header className="landing-header">
      <a className="landing-brand" href="#top" aria-label="ConstructOS home" onClick={close}>
        <ConstructOSMark className="landing-brand-mark" />
        <span className="landing-brand-name">ConstructOS</span>
      </a>

      <nav className="landing-nav" aria-label="Marketing navigation">
        <a href="#system">System</a>
        <a href="#assurance">Assurance</a>
        <a href="#intelligence">Intelligence</a>
        <a href="#capabilities">Capabilities</a>
      </nav>

      <div className="landing-header-actions">
        <Link className="landing-sign-in" to="/login">
          Sign in
        </Link>
        <Link className="landing-header-cta" to="/register">
          Create workspace
          <ArrowIcon />
        </Link>
      </div>

      <button
        ref={menuButtonRef}
        className="landing-menu-button"
        type="button"
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        aria-controls="landing-mobile-menu"
        onClick={() => setOpen((value) => !value)}
      >
        <MenuIcon open={open} />
      </button>

      <div
        id="landing-mobile-menu"
        className="landing-mobile-menu"
        data-open={open ? "" : undefined}
        aria-hidden={!open}
        inert={!open}
      >
        <nav aria-label="Mobile marketing navigation">
          <a href="#system" onClick={close}>
            <span>01</span> System
          </a>
          <a href="#assurance" onClick={close}>
            <span>02</span> Assurance
          </a>
          <a href="#intelligence" onClick={close}>
            <span>03</span> Intelligence
          </a>
          <a href="#capabilities" onClick={close}>
            <span>04</span> Capabilities
          </a>
        </nav>
        <div className="landing-mobile-actions">
          <Link to="/login" onClick={close}>
            Sign in
          </Link>
          <Link to="/register" onClick={close}>
            Create your workspace <ArrowIcon />
          </Link>
        </div>
      </div>
    </header>
  );
}

function useScrollFilm(
  sectionRef: React.RefObject<HTMLElement | null>,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  reducedMotion: boolean,
) {
  useEffect(() => {
    const section = sectionRef.current;
    const video = videoRef.current;
    if (!section || !video) return;

    let frame = 0;
    let pointerFrame = 0;
    let pointerX = 0;
    let pointerY = 0;
    let activePhase = "";

    const setPhase = (phase: "opening" | "middle" | "closing") => {
      if (phase === activePhase) return;
      activePhase = phase;
      section.dataset.filmPhase = phase;
      section.querySelectorAll<HTMLElement>("[data-film-chapter]").forEach((chapter) => {
        const active = chapter.dataset.filmChapter === phase;
        chapter.toggleAttribute("inert", !active);
        chapter.setAttribute("aria-hidden", String(!active));
      });
    };

    const render = () => {
      frame = 0;
      const rect = section.getBoundingClientRect();
      const travel = Math.max(1, section.offsetHeight - window.innerHeight);
      const progress = reducedMotion ? 0 : Math.min(1, Math.max(0, -rect.top / travel));
      const clamp = (value: number) => Math.min(1, Math.max(0, value));
      const openingOpacity = clamp((0.31 - progress) / 0.1);
      const middleIn = clamp((progress - 0.26) / 0.1);
      const middleOut = clamp((0.66 - progress) / 0.1);
      const closingOpacity = clamp((progress - 0.65) / 0.12);
      setPhase(progress < 0.31 ? "opening" : progress < 0.66 ? "middle" : "closing");
      section.style.setProperty("--film-progress", progress.toFixed(4));
      section.style.setProperty("--film-opening-opacity", openingOpacity.toFixed(4));
      section.style.setProperty("--film-middle-opacity", Math.min(middleIn, middleOut).toFixed(4));
      section.style.setProperty("--film-closing-opacity", closingOpacity.toFixed(4));
      section.style.setProperty("--film-opening-y", `${(1 - openingOpacity) * -24}px`);
      section.style.setProperty(
        "--film-middle-x",
        `${(1 - Math.min(middleIn, middleOut)) * 24}px`,
      );
      section.style.setProperty("--film-closing-y", `${(1 - closingOpacity) * 28}px`);
      section.style.setProperty("--film-percent", `"${Math.round(progress * 100)
        .toString()
        .padStart(2, "0")}"`);

      if (!reducedMotion && Number.isFinite(video.duration) && video.duration > 0) {
        const target = Math.min(video.duration - 0.04, progress * video.duration);
        if (Math.abs(video.currentTime - target) > 0.025) video.currentTime = target;
      }
    };

    const requestRender = () => {
      if (frame === 0) frame = window.requestAnimationFrame(render);
    };

    const renderPointer = () => {
      pointerFrame = 0;
      section.style.setProperty("--pointer-video-x", `${pointerX * -12}px`);
      section.style.setProperty("--pointer-video-y", `${pointerY * -8}px`);
      section.style.setProperty("--pointer-grain-x", `${pointerX * 8}px`);
      section.style.setProperty("--pointer-grain-y", `${pointerY * 8}px`);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerX = event.clientX / window.innerWidth - 0.5;
      pointerY = event.clientY / window.innerHeight - 0.5;
      if (pointerFrame === 0) pointerFrame = window.requestAnimationFrame(renderPointer);
    };

    const onLoadedData = () => {
      video.pause();
      if (reducedMotion && Number.isFinite(video.duration)) {
        video.currentTime = Math.max(0, video.duration * 0.82);
      } else {
        requestRender();
      }
    };

    if (!reducedMotion) {
      window.addEventListener("scroll", requestRender, { passive: true });
      window.addEventListener("resize", requestRender);
      window.addEventListener("pointermove", onPointerMove, { passive: true });
    }
    video.addEventListener("loadedmetadata", onLoadedData);
    requestRender();

    return () => {
      if (!reducedMotion) {
        window.removeEventListener("scroll", requestRender);
        window.removeEventListener("resize", requestRender);
        window.removeEventListener("pointermove", onPointerMove);
      }
      video.removeEventListener("loadedmetadata", onLoadedData);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      if (pointerFrame !== 0) window.cancelAnimationFrame(pointerFrame);
    };
  }, [reducedMotion, sectionRef, videoRef]);
}

function CinematicHero() {
  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const staticVisual = useStaticVisual();
  useScrollFilm(sectionRef, videoRef, staticVisual);

  return (
    <section
      ref={sectionRef}
      id="top"
      className="landing-film"
      data-film-phase="opening"
      data-reduced-motion={staticVisual ? "" : undefined}
      aria-labelledby="landing-title"
    >
      <div className="landing-film-sticky">
        {staticVisual ? (
          <img className="landing-film-video" src={FILM_POSTER} alt="" aria-hidden="true" />
        ) : (
          <video
            ref={videoRef}
            className="landing-film-video"
            muted
            playsInline
            preload="auto"
            poster={FILM_POSTER}
            aria-hidden="true"
            tabIndex={-1}
          >
            <source media="(max-width: 767px)" src={FILM_MOBILE} type="video/mp4" />
            <source src={FILM_DESKTOP} type="video/mp4" />
          </video>
        )}
        <div className="landing-film-vignette" aria-hidden="true" />
        <div className="landing-film-grain" aria-hidden="true" />
        <div className="landing-film-coordinate" aria-hidden="true">
          <span>51.0447° N</span>
          <span>114.0719° W</span>
        </div>

        <div
          className="landing-film-chapter landing-film-chapter--opening"
          data-film-chapter="opening"
          aria-hidden="false"
        >
          <p className="landing-eyebrow">
            <span /> AI-native construction delivery + assurance
          </p>
          <h1 id="landing-title">
            Run the project.
            <br />
            <em>Preserve the proof.</em>
          </h1>
          <p className="landing-hero-copy">
            ConstructOS connects drawings, BIM, fieldwork, cost, contracts and risk to
            independent evidence—so every consequential decision can be traced, tested and
            defended.
          </p>
          <div className="landing-hero-actions">
            <Link className="landing-primary-button" to="/register">
              Create your workspace <ArrowIcon />
            </Link>
            <a className="landing-text-link" href="#system">
              Explore the system <span aria-hidden="true">↘</span>
            </a>
          </div>
        </div>

        <div
          className="landing-film-chapter landing-film-chapter--middle"
          data-film-chapter="middle"
          aria-hidden="true"
          inert
        >
          <span className="landing-chapter-number">01 / 03</span>
          <p>Every decision connected.</p>
          <h2>
            Drawing <span>→</span> work <span>→</span> evidence
          </h2>
        </div>

        <div
          className="landing-film-chapter landing-film-chapter--closing"
          data-film-chapter="closing"
          aria-hidden="true"
          inert
        >
          <span className="landing-chapter-number">03 / 03</span>
          <p>The record becomes defensible.</p>
          <h2>Build what can be proven.</h2>
          <Link className="landing-primary-button landing-primary-button--light" to="/register">
            Start with ConstructOS <ArrowIcon />
          </Link>
        </div>

        <div className="landing-scroll-cue" aria-hidden="true">
          <span>Scroll through the build</span>
          <i />
        </div>

        <div className="landing-film-progress" aria-hidden="true">
          <span className="landing-film-progress-label">FRAME</span>
          <span className="landing-film-progress-value" />
          <i>
            <b />
          </i>
          <span>PROOF LINE</span>
        </div>
      </div>
    </section>
  );
}

function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          node.dataset.visible = "";
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -12%", threshold: 0.12 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`landing-reveal ${className}`}
      style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}
    >
      {children}
    </div>
  );
}

function ProofStrip() {
  return (
    <section className="landing-proof-strip" aria-label="ConstructOS operating model">
      <div className="landing-shell landing-proof-strip-grid">
        <p>One project record</p>
        <span>Delivery</span>
        <span>Commercial</span>
        <span>Governance</span>
        <span>Independent assurance</span>
      </div>
    </section>
  );
}

function EventChain() {
  const steps = ["Site event", "RFI", "Schedule effect", "Variation", "Payment", "Evidence pack"];
  return (
    <section className="landing-event-section" aria-labelledby="event-title">
      <div className="landing-shell">
        <div className="landing-section-grid">
          <Reveal className="landing-section-heading">
            <p className="landing-kicker">The connected event</p>
            <h2 id="event-title">One event. Every consequence.</h2>
          </Reveal>
          <Reveal className="landing-section-copy" delay={90}>
            <p>
              A site issue should not disappear into a folder. ConstructOS keeps the drawing,
              instruction, programme effect, commercial consequence and proof on one traceable
              line.
            </p>
          </Reveal>
        </div>

        <Reveal className="landing-event-chain" delay={140}>
          <div className="landing-event-line" aria-hidden="true">
            <i />
          </div>
          {steps.map((step, index) => (
            <div className="landing-event-step" key={step}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <i aria-hidden="true" />
              <p>{step}</p>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

function SystemViewport({ mode }: { mode: OperatingMode }) {
  return (
    <div
      className="landing-product-frame"
      role="img"
      aria-label={`Illustrative ConstructOS ${mode.label} workspace showing a connected project trace`}
    >
      <div className="landing-product-topbar">
        <div className="landing-product-wordmark">
          <ConstructOSMark />
          <span>ConstructOS</span>
        </div>
        <span className="landing-product-project">Northline Civic Works / Live</span>
        <div className="landing-product-avatars" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </div>

      <div className="landing-product-body">
        <aside className="landing-product-sidebar" aria-hidden="true">
          <span className="is-active" />
          <span />
          <span />
          <span />
          <span />
          <span />
        </aside>

        <div className="landing-product-content">
          <div className="landing-product-content-head">
            <div>
              <span>{mode.label} workspace</span>
              <h3>{mode.title}</h3>
            </div>
            <span className="landing-product-new-record">
              New record <span>＋</span>
            </span>
          </div>

          <div className="landing-product-status">
            <div className="landing-product-status-icon" aria-hidden="true">
              <span />
            </div>
            <div>
              <span>Current trace · illustrative data</span>
              <strong>{mode.signal}</strong>
              <small>{mode.signalMeta}</small>
            </div>
            <span className="landing-product-status-pill">Connected</span>
          </div>

          <div className="landing-product-rail">
            {mode.rail.map((item, index) => (
              <div key={item}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <i aria-hidden="true" />
                <strong>{item}</strong>
                <small>{index === mode.rail.length - 1 ? "Ready" : "Complete"}</small>
              </div>
            ))}
          </div>

          <div className="landing-product-lower">
            <div className="landing-product-chart" aria-hidden="true">
              <div className="landing-product-chart-head">
                <span>Project confidence</span>
                <strong>87.4</strong>
              </div>
              <svg viewBox="0 0 540 130" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="productArea" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor="currentColor" stopOpacity="0.24" />
                    <stop offset="1" stopColor="currentColor" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0 108C60 94 86 98 130 75s74 6 119-20 83 7 126-16 81 1 165-31v122H0Z" fill="url(#productArea)" />
                <path d="M0 108C60 94 86 98 130 75s74 6 119-20 83 7 126-16 81 1 165-31" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
            </div>
            <div className="landing-product-modules">
              <span>Connected modules</span>
              {mode.modules.map((module, index) => (
                <div key={module}>
                  <i>{index + 1}</i>
                  <strong>{module}</strong>
                  <span>↗</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OperatingSystemSection() {
  const [activeMode, setActiveMode] = useState<ModeId>("deliver");
  const mode = OPERATING_MODES[activeMode];

  return (
    <section id="system" className="landing-system-section" aria-labelledby="system-title">
      <div className="landing-shell">
        <Reveal className="landing-system-intro">
          <p className="landing-kicker">The operating system</p>
          <h2 id="system-title">
            The field, cost, programme and proof finally speak the same language.
          </h2>
        </Reveal>

        <div className="landing-system-layout">
          <div className="landing-mode-selector" role="group" aria-label="ConstructOS systems">
            {MODE_ORDER.map((id) => {
              const item = OPERATING_MODES[id];
              const active = id === activeMode;
              return (
                <button
                  key={id}
                  id={`mode-tab-${id}`}
                  type="button"
                  aria-pressed={active}
                  aria-controls="mode-panel"
                  data-active={active ? "" : undefined}
                  onClick={() => setActiveMode(id)}
                >
                  <span>{item.index}</span>
                  <strong>{item.label}</strong>
                  <i aria-hidden="true" />
                </button>
              );
            })}
          </div>

          <div
            id="mode-panel"
            className="landing-mode-copy"
            aria-labelledby={`mode-tab-${activeMode}`}
            key={`${activeMode}-copy`}
          >
            <span>{mode.index} / 04</span>
            <h3>{mode.title}</h3>
            <p>{mode.description}</p>
          </div>
        </div>

        <Reveal className="landing-product-wrap" delay={100}>
          <SystemViewport mode={mode} key={activeMode} />
        </Reveal>
      </div>
    </section>
  );
}

function AssuranceSection() {
  const stages = [
    { number: "01", title: "Assertion", copy: "What a project actor says is true." },
    { number: "02", title: "Independent evidence", copy: "What a separate pathway records." },
    { number: "03", title: "Reconciliation", copy: "A visible test between the two." },
    { number: "04", title: "Signal + obligation", copy: "A finding that cannot quietly disappear." },
    { number: "05", title: "Signed seal", copy: "A verifiable commitment to the record." },
  ];

  return (
    <section id="assurance" className="landing-assurance-section" aria-labelledby="assurance-title">
      <div className="landing-shell">
        <div className="landing-assurance-intro">
          <Reveal>
            <p className="landing-kicker landing-kicker--copper">Independent assurance</p>
            <h2 id="assurance-title">A record is not evidence.</h2>
          </Reveal>
          <Reveal delay={80}>
            <p>
              ConstructOS separates a claim from the evidence used to test it. The system
              reconciles the two, creates action where needed and preserves the result on a
              hash-chained ledger.
            </p>
          </Reveal>
        </div>

        <Reveal className="landing-assurance-flow" delay={130}>
          <div className="landing-assurance-line" aria-hidden="true">
            <i />
          </div>
          {stages.map((stage) => (
            <article key={stage.number}>
              <span>{stage.number}</span>
              <i aria-hidden="true" />
              <h3>{stage.title}</h3>
              <p>{stage.copy}</p>
            </article>
          ))}
        </Reveal>

        <Reveal className="landing-assurance-statement" delay={100}>
          <p>Claim</p>
          <span aria-hidden="true">≠</span>
          <p>Proof</p>
          <small>until they have been independently reconciled</small>
        </Reveal>
      </div>
    </section>
  );
}

function IntelligenceSection() {
  return (
    <section id="intelligence" className="landing-intelligence-section" aria-labelledby="ai-title">
      <div className="landing-shell landing-intelligence-grid">
        <Reveal className="landing-intelligence-copy">
          <p className="landing-kicker">Auditable intelligence</p>
          <h2 id="ai-title">AI that shows its work.</h2>
          <p>
            Search project knowledge with citations. Review RFIs and submittals. Read drawings
            and site photos. Draft daily logs. Consequential outputs enter human review, and every
            run leaves an audit record.
          </p>
          <ul>
            <li>Cited project search</li>
            <li>Permission-aware actions</li>
            <li>Human review before consequence</li>
          </ul>
          <Link className="landing-inline-cta" to="/register">
            Put your project knowledge to work <ArrowIcon />
          </Link>
        </Reveal>

        <Reveal className="landing-intelligence-console" delay={110}>
          <div className="landing-console-head">
            <span>ConstructOS intelligence</span>
            <i>Human review on</i>
          </div>
          <div className="landing-console-query">
            <span>Q</span>
            <p>What is delaying the east concourse handover?</p>
          </div>
          <div className="landing-console-response">
            <span className="landing-console-label">Synthesised answer · sample workspace</span>
            <p>
              Handover is exposed by three connected conditions: commissioning package CP-14 is
              six days behind its accepted sequence; two fire-stopping observations remain open;
              and the occupancy permit obligation is due before the revised completion date.
            </p>
            <div className="landing-console-citations">
              <span>
                01 · Schedule baseline 04
              </span>
              <span>
                02 · QA observations
              </span>
              <span>
                03 · Permit register
              </span>
            </div>
          </div>
          <div className="landing-console-review">
            <div>
              <span>Review gate</span>
              <strong>No project record changed</strong>
            </div>
            <span className="landing-console-review-action">
              Review proposed actions
            </span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function CapabilitiesSection() {
  return (
    <section id="capabilities" className="landing-capabilities-section" aria-labelledby="capabilities-title">
      <div className="landing-shell">
        <Reveal className="landing-capabilities-heading">
          <p className="landing-kicker">Bid to handover</p>
          <h2 id="capabilities-title">One connected system across the project lifecycle.</h2>
          <p>
            Deep delivery capability on the surface. A common evidence and governance spine
            underneath.
          </p>
        </Reveal>

        <div className="landing-capability-index">
          {CAPABILITY_GROUPS.map((group, index) => (
            <Reveal key={group.number} delay={index * 60}>
              <article>
                <span>{group.number}</span>
                <h3>{group.title}</h3>
                <p>{group.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function IntegritySection() {
  return (
    <section className="landing-integrity-section" aria-labelledby="integrity-title">
      <div className="landing-shell landing-integrity-grid">
        <Reveal className="landing-receipt-wrap">
          <div className="landing-receipt-glow" aria-hidden="true" />
          <div className="landing-receipt">
            <div className="landing-receipt-head">
              <ConstructOSMark />
              <div>
                <span>Escrow receipt</span>
                <small>Offline-verifiable record</small>
              </div>
              <i>SEALED</i>
            </div>
            <dl>
              <div>
                <dt>Ledger entries</dt>
                <dd>004,812</dd>
              </div>
              <div>
                <dt>Merkle root</dt>
                <dd>8e4c…91a2</dd>
              </div>
              <div>
                <dt>Seal sequence</dt>
                <dd>000,047</dd>
              </div>
              <div>
                <dt>Verification</dt>
                <dd className="is-valid">Signature valid</dd>
              </div>
            </dl>
            <div className="landing-receipt-chain" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
            <p>Illustrative receipt · no production data</p>
          </div>
        </Reveal>

        <Reveal className="landing-integrity-copy" delay={100}>
          <p className="landing-kicker landing-kicker--copper">Integrity that travels</p>
          <h2 id="integrity-title">The proof can leave the platform.</h2>
          <p>
            Export signed escrow receipts that an auditor, lender or regulator can verify
            offline—without asking ConstructOS to vouch for its own record.
          </p>
          <div className="landing-integrity-notes">
            <span>Tamper-evident chain</span>
            <span>Signed sequence seals</span>
            <span>Offline verification</span>
          </div>
          <small>
            Integrity guarantees remain bounded by signing-key custody and the configured time
            authority. ConstructOS reports those limits with the receipt.
          </small>
        </Reveal>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="landing-final-section" aria-labelledby="final-title">
      <div className="landing-final-line" aria-hidden="true">
        <i />
      </div>
      <div className="landing-shell landing-final-inner">
        <Reveal>
          <p className="landing-kicker">The next project record starts here</p>
          <h2 id="final-title">
            Run the project.
            <br />
            <em>Preserve the proof.</em>
          </h2>
          <p>Bring delivery and assurance into the same operating system.</p>
          <div>
            <Link className="landing-primary-button landing-primary-button--light" to="/register">
              Create your workspace <ArrowIcon />
            </Link>
            <Link className="landing-text-link landing-text-link--light" to="/login">
              Sign in to ConstructOS <span aria-hidden="true">→</span>
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="landing-footer">
      <div className="landing-shell landing-footer-grid">
        <div className="landing-footer-brand">
          <ConstructOSMark />
          <div>
            <strong>ConstructOS</strong>
            <span>Delivery · Assurance</span>
          </div>
        </div>
        <div className="landing-footer-links">
          <a href="#system">System</a>
          <a href="#assurance">Assurance</a>
          <a href="#intelligence">Intelligence</a>
          <Link to="/login">Sign in</Link>
        </div>
        <p>© {new Date().getFullYear()} ConstructOS. Built for accountable delivery.</p>
      </div>
    </footer>
  );
}

export default function LandingPage() {
  useEffect(() => {
    const previousTitle = document.title;
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previousThemeColor = themeMeta?.content;
    document.title = "ConstructOS — Run the project. Preserve the proof.";
    if (themeMeta) themeMeta.content = "#090c0f";
    return () => {
      document.title = previousTitle;
      if (themeMeta && previousThemeColor) themeMeta.content = previousThemeColor;
    };
  }, []);

  return (
    <div className="landing-page">
      <a className="landing-skip-link" href="#landing-main">
        Skip to content
      </a>
      <LandingHeader />
      <CinematicHero />
      <main id="landing-main" tabIndex={-1}>
        <ProofStrip />
        <EventChain />
        <OperatingSystemSection />
        <AssuranceSection />
        <IntelligenceSection />
        <CapabilitiesSection />
        <IntegritySection />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
