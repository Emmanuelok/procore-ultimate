import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link } from "react-router-dom";
import "./landing.css";

const FILM_DESKTOP =
  "https://d2ol7oe51mr4n9.cloudfront.net/user_3ChJ2tLVG7i2Ag6ynWBf8Xmyz6a/13c7ccbd-a31a-400d-8404-66bd65e14016.mp4";
const FILM_MOBILE =
  "https://d2ol7oe51mr4n9.cloudfront.net/user_3ChJ2tLVG7i2Ag6ynWBf8Xmyz6a/cd8da2e8-50fa-438b-84af-47988d92d692.mp4";
const FILM_POSTER = "/assets/landing/constructos-proof-line-poster-v1.webp";
const EVIDENCE_ORIGIN = "/assets/landing/constructos-evidence-origin-v1.webp";
const EVIDENCE_ORIGIN_MOBILE = "/assets/landing/constructos-evidence-origin-mobile-v1.webp";
const EVIDENCE_MEASURE = "/assets/landing/constructos-evidence-measure-v1.webp";
const EVIDENCE_CUSTODY = "/assets/landing/constructos-evidence-custody-v1.webp";
const EVIDENCE_CUSTODY_MOBILE = "/assets/landing/constructos-evidence-custody-mobile-v1.webp";

type MotionConnection = {
  saveData?: boolean;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
};

type LandingStyle = CSSProperties & Record<`--${string}`, string | number>;

type ModeId = "deliver" | "control" | "govern" | "assure";

interface OperatingMode {
  id: ModeId;
  number: string;
  label: string;
  command: string;
  title: string;
  description: string;
  object: string;
  objectMeta: string;
  modules: readonly string[];
}

const TRACE_STEPS = [
  {
    number: "01",
    kind: "FIELD",
    code: "OBS-231",
    title: "Fire stopping not accepted",
    meta: "14:32 · East concourse · Level 04",
    datum: "3 photos · marked drawing · inspector note",
    impact: "ORIGIN",
  },
  {
    number: "02",
    kind: "DESIGN",
    code: "RFI-042",
    title: "Interface detail challenged",
    meta: "Linked to drawing A-417 · revision 06",
    datum: "Response required before enclosure",
    impact: "2 APPROVALS",
  },
  {
    number: "03",
    kind: "PROGRAMME",
    code: "C-210",
    title: "Critical activity exposed",
    meta: "Partition closure · float consumed",
    datum: "Logic link retained with baseline",
    impact: "+6 DAYS",
  },
  {
    number: "04",
    kind: "COMMERCIAL",
    code: "VO-018",
    title: "Entitlement position opened",
    meta: "Instruction SI-009 · Clause 13.3",
    datum: "Scope, cause and substantiation connected",
    impact: "$184K",
  },
  {
    number: "05",
    kind: "ASSURANCE",
    code: "REC-007",
    title: "Claim tested against fact",
    meta: "Claimed 90% · independently verified 82%",
    datum: "Measurement, programme and approvals compared",
    impact: "8% SIGNAL",
  },
  {
    number: "06",
    kind: "RECORD",
    code: "SEAL-884",
    title: "Decision record sealed",
    meta: "Reviewer approved · sequence 000884",
    datum: "Portable manifest ready for verification",
    impact: "DEFENSIBLE",
  },
] as const;

const OPERATING_MODES: readonly OperatingMode[] = [
  {
    id: "deliver",
    number: "01",
    label: "Deliver",
    command: "COORDINATE WHAT GETS BUILT",
    title: "Field reality stays attached to design intent.",
    description:
      "Drawings, BIM, RFIs, submittals, daily logs, photos and quality records retain the context that made them consequential.",
    object: "RFI-042",
    objectMeta: "A-417 / REV 06 / EAST CONCOURSE",
    modules: ["Drawings + BIM", "RFIs + submittals", "Field + quality"],
  },
  {
    id: "control",
    number: "02",
    label: "Control",
    command: "FOLLOW THE MONEY TO THE DECISION",
    title: "Commercial movement keeps its cause.",
    description:
      "Budgets, commitments, variations, valuations and payments remain bound to scope, entitlement, evidence and approval history.",
    object: "VO-018",
    objectMeta: "FORECAST MOVEMENT / $184K / REVIEW PENDING",
    modules: ["Budget + forecast", "Contracts + changes", "Valuations + payments"],
  },
  {
    id: "govern",
    number: "03",
    label: "Govern",
    command: "SEE EXPOSURE BEFORE IT HARDENS",
    title: "The quiet failures surface early.",
    description:
      "Schedule, risk, finance, land, workforce, ESG, insurance and jurisdiction controls reveal intersections before they become outcomes.",
    object: "OBL-207",
    objectMeta: "NOTICE WINDOW / 12 DAYS / PROGRAMME-LINKED",
    modules: ["Schedule + risk", "Finance + safeguards", "ESG + jurisdiction"],
  },
  {
    id: "assure",
    number: "04",
    label: "Assure",
    command: "MAKE EVERY CLAIM MEET ITS EVIDENCE",
    title: "Assertions do not grade themselves.",
    description:
      "Evidence is reconciled against assertions, consequential findings become obligations, and the authorised result enters a verifiable ledger.",
    object: "REC-007",
    objectMeta: "3 SOURCES / 1 VARIANCE / REVIEWER REQUIRED",
    modules: ["Evidence + reconciliation", "Signals + obligations", "Ledger + receipts"],
  },
] as const;

const AI_QUESTIONS = [
  {
    question: "Why is the east concourse late?",
    answer:
      "Partition closure is forecast six days late after observation OBS-231 stopped enclosure at Level 04. The active cause chain runs through RFI-042 and instruction SI-009; the notice obligation remains open.",
    action: "Draft notice against Clause 13.3",
    reviewer: "Contract administrator",
    sources: ["OBS-231", "RFI-042", "C-210"],
  },
  {
    question: "Show the evidence behind VO-018.",
    answer:
      "VO-018 is supported by instruction SI-009, the marked coordination drawing A-417 and measured rework. Two photos pre-date the instruction and are excluded from the current substantiation set.",
    action: "Open substantiation exceptions",
    reviewer: "Commercial manager",
    sources: ["SI-009", "A-417", "REC-007"],
  },
  {
    question: "What changed since the last seal?",
    answer:
      "One programme update, three measurement records and an approval response entered the project record. The new reconciliation exposes an eight-percent difference between claimed and verified progress.",
    action: "Compare sequence 883 → 884",
    reviewer: "Assurance lead",
    sources: ["UPD-017", "MEAS-31", "SEAL-884"],
  },
] as const;

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

function useScrollFilm(
  sectionRef: React.RefObject<HTMLElement | null>,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  staticVisual: boolean,
) {
  useEffect(() => {
    const section = sectionRef.current;
    const video = videoRef.current;
    if (!section) return;

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
      const progress = staticVisual ? 0 : Math.min(1, Math.max(0, -rect.top / travel));
      const clamp = (value: number) => Math.min(1, Math.max(0, value));
      const openingOpacity = clamp((0.3 - progress) / 0.09);
      const middleOpacity = Math.min(clamp((progress - 0.25) / 0.1), clamp((0.69 - progress) / 0.1));
      const closingOpacity = clamp((progress - 0.66) / 0.12);

      setPhase(progress < 0.3 ? "opening" : progress < 0.69 ? "middle" : "closing");
      section.style.setProperty("--film-progress", progress.toFixed(4));
      section.style.setProperty("--film-opening-opacity", openingOpacity.toFixed(4));
      section.style.setProperty("--film-middle-opacity", middleOpacity.toFixed(4));
      section.style.setProperty("--film-closing-opacity", closingOpacity.toFixed(4));
      section.style.setProperty("--film-percent", `"${Math.round(progress * 100).toString().padStart(2, "0")}"`);

      if (video && !staticVisual && Number.isFinite(video.duration) && video.duration > 0) {
        const target = Math.min(video.duration - 0.04, progress * video.duration);
        if (Math.abs(video.currentTime - target) > 0.025) video.currentTime = target;
      }
    };

    const requestRender = () => {
      if (!frame) frame = window.requestAnimationFrame(render);
    };

    const renderPointer = () => {
      pointerFrame = 0;
      section.style.setProperty("--pointer-x", pointerX.toFixed(4));
      section.style.setProperty("--pointer-y", pointerY.toFixed(4));
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerX = event.clientX / window.innerWidth - 0.5;
      pointerY = event.clientY / window.innerHeight - 0.5;
      if (!pointerFrame) pointerFrame = window.requestAnimationFrame(renderPointer);
    };

    const onLoaded = () => {
      video?.pause();
      requestRender();
    };

    if (!staticVisual) {
      window.addEventListener("scroll", requestRender, { passive: true });
      window.addEventListener("resize", requestRender);
      window.addEventListener("pointermove", onPointerMove, { passive: true });
    }
    video?.addEventListener("loadedmetadata", onLoaded);
    requestRender();

    return () => {
      window.removeEventListener("scroll", requestRender);
      window.removeEventListener("resize", requestRender);
      window.removeEventListener("pointermove", onPointerMove);
      video?.removeEventListener("loadedmetadata", onLoaded);
      if (frame) window.cancelAnimationFrame(frame);
      if (pointerFrame) window.cancelAnimationFrame(pointerFrame);
    };
  }, [sectionRef, staticVisual, videoRef]);
}

function useNarrativeProgress(
  sectionRef: React.RefObject<HTMLElement | null>,
  steps: number,
  staticVisual: boolean,
) {
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    let frame = 0;

    const render = () => {
      frame = 0;
      const rect = section.getBoundingClientRect();
      const travel = Math.max(1, section.offsetHeight - window.innerHeight);
      const progress = staticVisual ? 1 : Math.min(1, Math.max(0, -rect.top / travel));
      const nextStep = Math.min(steps - 1, Math.floor(progress * steps));
      section.style.setProperty("--section-progress", progress.toFixed(4));
      section.dataset.step = String(nextStep);
      setActiveStep((current) => (current === nextStep ? current : nextStep));
    };

    const requestRender = () => {
      if (!frame) frame = window.requestAnimationFrame(render);
    };

    if (!staticVisual) {
      window.addEventListener("scroll", requestRender, { passive: true });
      window.addEventListener("resize", requestRender);
    }
    requestRender();
    return () => {
      window.removeEventListener("scroll", requestRender);
      window.removeEventListener("resize", requestRender);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sectionRef, staticVisual, steps]);

  return [activeStep, setActiveStep] as const;
}

function useBuildIn<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          node.dataset.built = "";
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -10%", threshold: 0.12 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return ref;
}

function ConstructOSMark({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" role="img" aria-label="ConstructOS">
      <path d="M29 8H16l-6 6v12l6 6h13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" />
      <path d="M17 14h12M17 26h12" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="29" cy="20" r="2.4" fill="currentColor" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3 10h13M11 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function LandingHeader() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        window.requestAnimationFrame(() => buttonRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header className="witness-header">
      <a className="witness-brand" href="#top" aria-label="ConstructOS home" onClick={close}>
        <ConstructOSMark />
        <span>CONSTRUCT<span>OS</span></span>
      </a>
      <nav className="witness-nav" aria-label="Marketing navigation">
        <a href="#trace"><span>01</span> Live trace</a>
        <a href="#system"><span>02</span> System</a>
        <a href="#assurance"><span>03</span> Assurance</a>
        <a href="#verify"><span>04</span> Verify</a>
      </nav>
      <div className="witness-header-actions">
        <Link to="/login">Sign in</Link>
        <Link className="witness-header-cta" to="/register">Enter the system <ArrowIcon /></Link>
      </div>
      <button
        ref={buttonRef}
        className="witness-menu-button"
        type="button"
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        aria-controls="witness-mobile-menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span /><span />
      </button>
      <div id="witness-mobile-menu" className="witness-mobile-menu" data-open={open ? "" : undefined} aria-hidden={!open} inert={!open}>
        <nav aria-label="Mobile marketing navigation">
          <a href="#trace" onClick={close}><span>01</span> Live trace</a>
          <a href="#system" onClick={close}><span>02</span> System</a>
          <a href="#assurance" onClick={close}><span>03</span> Assurance</a>
          <a href="#verify" onClick={close}><span>04</span> Verify</a>
        </nav>
        <div>
          <Link to="/login" onClick={close}>Sign in</Link>
          <Link to="/register" onClick={close}>Create workspace <ArrowIcon /></Link>
        </div>
      </div>
    </header>
  );
}

function CinematicHero({ staticVisual }: { staticVisual: boolean }) {
  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [filmFailed, setFilmFailed] = useState(false);
  useScrollFilm(sectionRef, videoRef, staticVisual || filmFailed);
  const showPoster = staticVisual || filmFailed;

  return (
    <section ref={sectionRef} id="top" className="witness-film" data-film-phase="opening" data-static={showPoster ? "" : undefined} aria-labelledby="landing-title">
      <div className="witness-film-sticky">
        {showPoster ? (
          <img className="witness-film-media" src={FILM_POSTER} alt="" aria-hidden="true" />
        ) : (
          <video ref={videoRef} className="witness-film-media" muted playsInline preload="auto" poster={FILM_POSTER} aria-hidden="true" tabIndex={-1} onError={() => setFilmFailed(true)}>
            <source media="(max-width: 767px)" src={FILM_MOBILE} type="video/mp4" />
            <source src={FILM_DESKTOP} type="video/mp4" />
          </video>
        )}
        <div className="witness-film-shade" aria-hidden="true" />
        <div className="witness-film-grid" aria-hidden="true" />
        <div className="witness-film-scan" aria-hidden="true" />
        <div className="witness-film-spine" aria-hidden="true"><i /></div>

        <div className="witness-film-hud witness-film-hud--left" aria-hidden="true">
          <span>PROJECT / CAX-001</span><span>51.0447° N / 114.0719° W</span>
        </div>
        <div className="witness-film-hud witness-film-hud--right" aria-hidden="true">
          <span>RECORD / LIVE</span><span>TRACE / ARMED</span>
        </div>

        <div className="witness-film-chapter witness-film-opening" data-film-chapter="opening" aria-hidden="false">
          <p className="witness-kicker"><span /> Evidence-native project operating system</p>
          <h1 id="landing-title"><span>The project</span><span>that can</span><em>testify.</em></h1>
          <p className="witness-hero-copy">ConstructOS binds what was designed, instructed, built, valued and verified into one defensible project record.</p>
          <div className="witness-hero-actions">
            <Link className="witness-button witness-button--copper" to="/register">Create your workspace <ArrowIcon /></Link>
            <a className="witness-line-link" href="#trace">Follow one event <span>↓</span></a>
          </div>
        </div>

        <div className="witness-film-chapter witness-film-middle" data-film-chapter="middle" aria-hidden="true" inert>
          <p className="witness-film-index">ACT 02 / THE CONSEQUENCE</p>
          <h2>ONE SITE EVENT.<span>EVERY CONSEQUENCE.</span></h2>
          <div className="witness-film-chain" aria-hidden="true"><span>FIELD</span><i /><span>PROGRAMME</span><i /><span>COST</span><i /><span>CONTRACT</span></div>
        </div>

        <div className="witness-film-chapter witness-film-closing" data-film-chapter="closing" aria-hidden="true" inert>
          <p className="witness-film-index"><i /> SIGNAL ACQUIRED / 14:32</p>
          <div className="witness-closing-code">OBS-231</div>
          <h2>FIRE STOPPING<br /><em>NOT ACCEPTED.</em></h2>
          <p>East concourse · Level 04 · Illustrative project trace</p>
          <a className="witness-button witness-button--chalk" href="#trace">Trace the impact <ArrowIcon /></a>
        </div>

        <div className="witness-scroll-cue" aria-hidden="true"><span>Scroll to build the record</span><i /></div>
        <div className="witness-film-meter" aria-hidden="true"><span>FRAME</span><strong /><i><b /></i><span>EVIDENCE SPINE</span></div>
      </div>
    </section>
  );
}

function TraceRibbon() {
  return (
    <div className="witness-trace-ribbon" aria-label="Illustrative live project signal">
      <div className="witness-trace-ribbon-track" aria-hidden="true">
        {[0, 1].map((copy) => (
          <div key={copy}><span><i /> LIVE SIGNAL</span><b>OBS-231</b><span>EAST CONCOURSE</span><b>RFI-042</b><span>PROGRAMME +6D</span><b>VO-018</b><span>RECONCILIATION OPEN</span></div>
        ))}
      </div>
    </div>
  );
}

function ConsequenceEngine({ staticVisual }: { staticVisual: boolean }) {
  const sectionRef = useRef<HTMLElement>(null);
  const [activeStep, setActiveStep] = useNarrativeProgress(sectionRef, TRACE_STEPS.length, staticVisual);
  const active = TRACE_STEPS[activeStep] ?? TRACE_STEPS[0];

  const selectStep = (index: number) => {
    const section = sectionRef.current;
    if (!section || staticVisual) {
      setActiveStep(index);
      return;
    }

    const travel = Math.max(1, section.offsetHeight - window.innerHeight);
    const sectionTop = window.scrollY + section.getBoundingClientRect().top;
    const progress = (index + 0.5) / TRACE_STEPS.length;
    window.scrollTo({ top: sectionTop + travel * progress, behavior: "auto" });
  };

  return (
    <section ref={sectionRef} id="trace" className="witness-consequence" data-step={activeStep} aria-labelledby="trace-title">
      <div className="witness-consequence-sticky">
        <div className="witness-section-rail" aria-hidden="true"><span>01</span><i /><b>THE CASCADE</b></div>
        <div className="witness-consequence-copy">
          <p className="witness-kicker witness-kicker--copper"><span /> Illustrative live trace</p>
          <h2 id="trace-title">One event can move the <em>entire project.</em></h2>
          <p>Follow a linked field observation across design, programme, commercial control and assurance—without losing its origin.</p>
          <div className="witness-consequence-tally" aria-label="Illustrative consequence summary">
            <div><strong>01</strong><span>origin</span></div><div><strong>06</strong><span>linked records</span></div><div><strong>01</strong><span>defensible chain</span></div>
          </div>
        </div>

        <div className="witness-consequence-stage">
          <figure className="witness-origin-plate">
            <picture>
              <source media="(max-width: 680px)" srcSet={EVIDENCE_ORIGIN_MOBILE} />
              <img
                src={EVIDENCE_ORIGIN}
                alt="Illustrative scene of a site inspector documenting incomplete fire stopping before enclosure."
                width="1600"
                height="1000"
                loading="lazy"
                decoding="async"
              />
            </picture>
            <figcaption><span>ORIGIN CAPTURE</span><strong>FIELD REALITY / PRESERVED AT SOURCE</strong></figcaption>
          </figure>
          <svg className="witness-network-lines" viewBox="0 0 720 520" preserveAspectRatio="none" aria-hidden="true">
            {TRACE_STEPS.slice(0, -1).map((_, index) => (
              <path key={index} pathLength="1" d={`M ${90 + index * 108} ${index % 2 === 0 ? 160 : 350} C ${142 + index * 108} ${index % 2 === 0 ? 160 : 350}, ${145 + index * 108} ${index % 2 === 0 ? 350 : 160}, ${198 + index * 108} ${index % 2 === 0 ? 350 : 160}`} style={{ "--edge": index } as LandingStyle} />
            ))}
          </svg>
          <div className="witness-network-grid" aria-hidden="true" />
          <div className="witness-network-pulse" aria-hidden="true" />
          <div className="witness-network-nodes" role="list" aria-label="Trace steps">
            {TRACE_STEPS.map((step, index) => (
              <button key={step.code} type="button" className="witness-network-node" data-active={index === activeStep ? "" : undefined} data-passed={index < activeStep ? "" : undefined} style={{ "--node": index } as LandingStyle} onClick={() => selectStep(index)} aria-current={index === activeStep ? "step" : undefined}>
                <span>{step.number}</span><i /><strong>{step.kind}</strong>
              </button>
            ))}
          </div>

          <article className="witness-dossier" key={active.code} aria-live="polite">
            <div className="witness-dossier-edge" aria-hidden="true" />
            <header><span>{active.kind} / {active.number}</span><b>{active.impact}</b></header>
            <div className="witness-dossier-code">{active.code}</div>
            <h3>{active.title}</h3><p>{active.meta}</p>
            <dl><div><dt>CONNECTED DATUM</dt><dd>{active.datum}</dd></div><div><dt>TRACE STATE</dt><dd><i /> Context preserved</dd></div></dl>
            <footer><span>CONSTRUCTOS / TRACE ENGINE</span><span>{String(activeStep + 1).padStart(2, "0")}—06</span></footer>
          </article>
        </div>
        <div className="witness-consequence-progress" aria-hidden="true">{TRACE_STEPS.map((step, index) => <i key={step.code} data-active={index <= activeStep ? "" : undefined} />)}</div>
      </div>
    </section>
  );
}

function DeliverCanvas() {
  return (
    <div className="witness-mode-canvas witness-mode-canvas--deliver" aria-hidden="true">
      <div className="witness-model-floor witness-model-floor--1" /><div className="witness-model-floor witness-model-floor--2" /><div className="witness-model-floor witness-model-floor--3" /><div className="witness-model-core" />
      <span className="witness-hotspot witness-hotspot--1"><i /> OBS-231</span><span className="witness-hotspot witness-hotspot--2"><i /> RFI-042</span><div className="witness-drawing-tag">A-417 <span>REV 06</span></div>
    </div>
  );
}

function ControlCanvas() {
  return (
    <div className="witness-mode-canvas witness-mode-canvas--control" aria-hidden="true">
      <div className="witness-cost-total"><span>FORECAST EXPOSURE</span><strong>$184,000</strong><em>+ 2.8%</em></div>
      <div className="witness-waterfall">{[38, 56, 43, 74, 62, 88].map((height, index) => <i key={index} style={{ "--bar-height": `${height}%`, "--bar-index": index } as LandingStyle} />)}</div>
      <div className="witness-approval-chain"><span>SI-009</span><i /><span>VO-018</span><i /><span>REVIEW</span></div>
    </div>
  );
}

function GovernCanvas() {
  return (
    <div className="witness-mode-canvas witness-mode-canvas--govern" aria-hidden="true">
      <div className="witness-deadline"><span>NOTICE WINDOW</span><strong>12</strong><em>DAYS</em><i /></div>
      <div className="witness-programme-lanes"><span><b style={{ "--lane": "72%" } as LandingStyle}>C-190 / SERVICES</b></span><span><b style={{ "--lane": "88%" } as LandingStyle}>C-210 / PARTITIONS</b><i>CRITICAL</i></span><span><b style={{ "--lane": "54%" } as LandingStyle}>C-230 / FINISHES</b></span></div>
      <div className="witness-risk-intersection"><i /> OBLIGATION INTERSECTION</div>
    </div>
  );
}

function AssureCanvas() {
  return (
    <div className="witness-mode-canvas witness-mode-canvas--assure" aria-hidden="true">
      <div className="witness-reconcile-mini"><div><span>CLAIMED</span><strong>90%</strong></div><i><b /></i><div><span>VERIFIED</span><strong>82%</strong></div></div>
      <div className="witness-source-orbit"><span>MEASURE</span><span>PHOTO</span><span>PROGRAMME</span><span>APPROVAL</span><i /></div>
      <div className="witness-mini-signal">VARIANCE / 8% / REVIEW REQUIRED</div>
    </div>
  );
}

function OperatingStructure() {
  const [modeId, setModeId] = useState<ModeId>("deliver");
  const sectionRef = useBuildIn<HTMLElement>();
  const modeIndex = OPERATING_MODES.findIndex((mode) => mode.id === modeId);
  const mode = OPERATING_MODES[modeIndex] ?? OPERATING_MODES[0]!;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + direction + OPERATING_MODES.length) % OPERATING_MODES.length;
    const next = OPERATING_MODES[nextIndex];
    if (!next) return;
    setModeId(next.id);
    document.getElementById(`mode-${next.id}`)?.focus();
  };

  return (
    <section ref={sectionRef} id="system" className="witness-system" aria-labelledby="system-title">
      <div className="witness-section-rail witness-section-rail--dark" aria-hidden="true"><span>02</span><i /><b>THE OPERATING STRUCTURE</b></div>
      <div className="witness-system-head"><p className="witness-kicker"><span /> One project model</p><h2 id="system-title">Everything the team runs.<br /><em>One record the owner can interrogate.</em></h2><p>Four operating layers. One evidence spine. Select a level to enter the project.</p></div>
      <div className="witness-system-shell">
        <div className="witness-mode-tabs" role="tablist" aria-label="ConstructOS operating layers">
          {OPERATING_MODES.map((item, index) => (
            <button id={`mode-${item.id}`} key={item.id} type="button" role="tab" aria-selected={item.id === modeId} aria-controls="operating-mode-panel" tabIndex={item.id === modeId ? 0 : -1} data-active={item.id === modeId ? "" : undefined} onClick={() => setModeId(item.id)} onKeyDown={(event) => onKeyDown(event, index)}>
              <span>{item.number}</span><strong>{item.label}</strong><i />
            </button>
          ))}
        </div>
        <div id="operating-mode-panel" className="witness-control-room" role="tabpanel" aria-labelledby={`mode-${mode.id}`} key={mode.id}>
          <header><span>CONSTRUCTOS / {mode.id.toUpperCase()}</span><span><i /> LIVE MODEL</span><span>ILLUSTRATIVE DATA</span></header>
          <div className="witness-control-body">
            <aside>
              <p>{mode.command}</p><h3>{mode.title}</h3><p>{mode.description}</p>
              <div className="witness-active-object"><span>ACTIVE OBJECT</span><strong>{mode.object}</strong><small>{mode.objectMeta}</small></div>
              <ul>{mode.modules.map((module) => <li key={module}><i />{module}</li>)}</ul>
            </aside>
            <div className="witness-control-canvas">
              {mode.id === "deliver" && <DeliverCanvas />}{mode.id === "control" && <ControlCanvas />}{mode.id === "govern" && <GovernCanvas />}{mode.id === "assure" && <AssureCanvas />}
              <div className="witness-canvas-coordinates" aria-hidden="true"><span>X / 04—88</span><span>Y / 17—42</span></div>
            </div>
          </div>
          <footer><span>DELIVER</span><span>CONTROL</span><span>GOVERN</span><span>ASSURE</span></footer>
        </div>
      </div>
    </section>
  );
}

function ReconciliationLab() {
  const sectionRef = useBuildIn<HTMLElement>();
  const [caseId, setCaseId] = useState(0);
  const cases = [
    { label: "Payment claim", claim: "90%", verified: "82%", signal: "8% VARIANCE", obligation: "OBL-207" },
    { label: "Inspection", claim: "ACCEPT", verified: "HOLD", signal: "2 ITEMS OPEN", obligation: "OBL-211" },
    { label: "Permit", claim: "CLOSED", verified: "12 DAYS", signal: "DEADLINE LIVE", obligation: "OBL-219" },
  ] as const;
  const activeCase = cases[caseId] ?? cases[0];

  return (
    <section ref={sectionRef} id="assurance" className="witness-lab" aria-labelledby="lab-title">
      <div className="witness-section-rail" aria-hidden="true"><span>03</span><i /><b>THE RECONCILIATION LAB</b></div>
      <div className="witness-lab-head"><p className="witness-kicker witness-kicker--copper"><span /> Independent assurance</p><h2 id="lab-title">A claim should never grade <em>its own homework.</em></h2><p>Assertion enters from one side. Evidence enters from the other. ConstructOS preserves the difference—and the decision that resolves it.</p></div>
      <div className="witness-case-switcher" role="tablist" aria-label="Illustrative assurance cases">
        {cases.map((item, index) => <button key={item.label} type="button" role="tab" aria-selected={index === caseId} data-active={index === caseId ? "" : undefined} onClick={() => setCaseId(index)}>{String(index + 1).padStart(2, "0")} / {item.label}</button>)}
      </div>
      <div className="witness-lab-stage" key={activeCase.label}>
        <div className="witness-claim-column"><span>CONTRACTOR ASSERTION</span><strong>{activeCase.claim}</strong><p>Claim / programme / submitted record</p><div className="witness-claim-sheet"><i /><b>PAY-007</b><span>AUTHORED SOURCE</span></div></div>
        <div className="witness-lab-core"><span className="witness-scan-label">RECONCILING</span><div className="witness-scanner"><i /><b /></div><div className="witness-variance"><span>SIGNAL</span><strong>{activeCase.signal}</strong></div><div className="witness-obligation"><i />{activeCase.obligation}<span>REVIEW REQUIRED</span></div></div>
        <div className="witness-evidence-column"><span>INDEPENDENT STREAM</span><strong>{activeCase.verified}</strong><p>Measurement / imagery / approved state</p><figure className="witness-measure-plate"><img src={EVIDENCE_MEASURE} alt="Illustrative independent measurement of installed work used to compare claimed and verified progress." width="1200" height="675" loading="lazy" decoding="async" /><figcaption><span>MEAS</span><span>PHOTO</span><span>PROG</span></figcaption></figure></div>
      </div>
      <div className="witness-proof-verdict" aria-label="Assurance sequence"><span>ASSERTION</span><i>→</i><span>EVIDENCE</span><i>→</i><span>RECONCILIATION</span><i>→</i><span>SIGNAL</span><i>→</i><strong>AUTHORISED RECORD</strong></div>
    </section>
  );
}

function ProjectIntelligence() {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [sourceIndex, setSourceIndex] = useState(0);
  const sectionRef = useBuildIn<HTMLElement>();
  const response = AI_QUESTIONS[questionIndex] ?? AI_QUESTIONS[0];

  const selectQuestion = (index: number) => { setQuestionIndex(index); setSourceIndex(0); };

  return (
    <section ref={sectionRef} id="intelligence" className="witness-intelligence" aria-labelledby="intelligence-title">
      <div className="witness-section-rail witness-section-rail--dark" aria-hidden="true"><span>04</span><i /><b>AI UNDER CROSS-EXAMINATION</b></div>
      <div className="witness-intelligence-head"><p className="witness-kicker"><span /> Project intelligence</p><h2 id="intelligence-title">Ask the project.<br /><em>Inspect every answer.</em></h2><p>AI can read across the connected record, show its sources and propose a next move. Consequential drafts enter permission-checked human review.</p></div>
      <div className="witness-ai-questions" aria-label="Sample project questions">{AI_QUESTIONS.map((item, index) => <button key={item.question} type="button" data-active={index === questionIndex ? "" : undefined} onClick={() => selectQuestion(index)}><span>0{index + 1}</span>{item.question}</button>)}</div>
      <div className="witness-cross-exam">
        <div className="witness-transcript" key={response.question} aria-live="polite">
          <header><span>CONSTRUCTOS INTELLIGENCE</span><span><i /> RECORD CONNECTED</span></header>
          <div className="witness-transcript-question"><span>QUESTION</span><h3>{response.question}</h3></div>
          <div className="witness-transcript-answer"><span>ANSWER / SOURCE-GROUNDED</span><p>{response.answer}</p></div>
          <div className="witness-review-bar"><span>PROPOSED ACTION</span><strong>{response.action}</strong><i /><span>REQUIRED REVIEWER</span><strong>{response.reviewer}</strong></div>
          <footer><i /> NO PROJECT RECORD CHANGED BY THIS PREVIEW</footer>
        </div>
        <div className="witness-source-room">
          <header><span>SOURCE GRAPH</span><span>0{sourceIndex + 1} / 03</span></header>
          <div className="witness-source-graph" aria-hidden="true"><svg viewBox="0 0 500 300"><path d="M75 80 C170 80 170 150 250 150S345 220 425 220" /><path d="M75 220 C170 220 170 150 250 150S345 80 425 80" /></svg>{response.sources.map((source, index) => <i key={source} data-active={index === sourceIndex ? "" : undefined} style={{ "--source": index } as LandingStyle}>{source}</i>)}<b>ANSWER</b></div>
          <div className="witness-source-tabs">{response.sources.map((source, index) => <button key={source} type="button" data-active={index === sourceIndex ? "" : undefined} onClick={() => setSourceIndex(index)}>{source}<span>{index === sourceIndex ? "OPEN" : "INSPECT"}</span></button>)}</div>
        </div>
      </div>
    </section>
  );
}

function LifecycleAtlas() {
  const sectionRef = useBuildIn<HTMLElement>();
  const stages = ["Bid", "Design", "Procure", "Build", "Inspect", "Handover", "Operate", "Dispute"];
  return (
    <section ref={sectionRef} className="witness-atlas" aria-labelledby="atlas-title">
      <div className="witness-atlas-head"><p className="witness-kicker witness-kicker--copper"><span /> The project lifecycle</p><h2 id="atlas-title">The claim is already assembling.</h2><p>Every phase adds context to the record. By the time the project is questioned, the story should already exist.</p></div>
      <div className="witness-atlas-grid" aria-label="ConstructOS project lifecycle"><div className="witness-atlas-spine" aria-hidden="true"><i /></div>{stages.map((stage, index) => <div key={stage} className="witness-atlas-stage" style={{ "--stage": index } as LandingStyle}><span>{String(index + 1).padStart(2, "0")}</span><strong>{stage}</strong><div><i>DELIVER</i><i>CONTROL</i><i>GOVERN</i><i>ASSURE</i></div></div>)}</div>
      <div className="witness-claim-chain"><span>EVENT</span><i>→</i><span>CLAUSE</span><i>→</i><span>NOTICE</span><i>→</i><span>TIA</span><i>→</i><span>PROGRAMME</span><i>→</i><span>PROLONGATION</span><i>→</i><strong>MANIFEST</strong></div>
    </section>
  );
}

const VERIFICATION_CHECKS = ["Hash chain intact", "Signature matches", "Seal sequence confirmed", "Time-authority condition reported", "Offline verification complete"] as const;

function EvidenceVault({ staticVisual }: { staticVisual: boolean }) {
  const sectionRef = useBuildIn<HTMLElement>();
  const [verificationStage, setVerificationStage] = useState(0);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (!verifying) return;
    if (staticVisual) { setVerificationStage(VERIFICATION_CHECKS.length); setVerifying(false); return; }
    const timer = window.setInterval(() => {
      setVerificationStage((current) => {
        if (current >= VERIFICATION_CHECKS.length) { window.clearInterval(timer); setVerifying(false); return current; }
        return current + 1;
      });
    }, 520);
    return () => window.clearInterval(timer);
  }, [verifying, staticVisual]);

  const runVerification = () => { setVerificationStage(0); setVerifying(true); };

  return (
    <section ref={sectionRef} id="verify" className="witness-vault" aria-labelledby="vault-title">
      <picture className="witness-vault-backdrop" aria-hidden="true">
        <source media="(max-width: 680px)" srcSet={EVIDENCE_CUSTODY_MOBILE} />
        <img src={EVIDENCE_CUSTODY} alt="" width="1600" height="1000" loading="lazy" decoding="async" />
      </picture>
      <div className="witness-section-rail" aria-hidden="true"><span>05</span><i /><b>PORTABLE PROOF</b></div>
      <div className="witness-vault-copy"><p className="witness-kicker witness-kicker--copper"><span /> Verify, don’t trust</p><h2 id="vault-title">Even ConstructOS should not have to vouch for <em>its own record.</em></h2><p>Export a signed manifest and test its sequence outside the platform. The seal proves record integrity; it does not, by itself, prove the underlying real-world event was true.</p><button className="witness-button witness-button--copper" type="button" onClick={runVerification} disabled={verifying}>{verifying ? "Verification running" : verificationStage === VERIFICATION_CHECKS.length ? "Verify again" : "Verify sample receipt"}<ArrowIcon /></button><span className="witness-simulation-note">Illustrative local verification · no upload</span></div>
      <div className="witness-vault-stage">
        <div className="witness-hash-chain" aria-hidden="true">{["7A2C", "91F0", "C44E", "884D"].map((hash, index) => <i key={hash} data-locked={verificationStage > index ? "" : undefined}><span>{String(index + 881)}</span>{hash}</i>)}</div>
        <article className="witness-receipt" data-sealed={verificationStage === VERIFICATION_CHECKS.length ? "" : undefined}>
          <header><ConstructOSMark /><div><strong>SEQUENCE RECEIPT</strong><span>PORTABLE PROJECT RECORD</span></div><b>000884</b></header>
          <div className="witness-receipt-project"><span>PROJECT</span><strong>CAX-001 / EAST CONCOURSE</strong></div>
          <dl><div><dt>PREVIOUS HASH</dt><dd>91f0…c44e</dd></div><div><dt>CONTENT HASH</dt><dd>7a2c…884d</dd></div><div><dt>SIGNATURE</dt><dd>ed25519 / valid</dd></div><div><dt>AUTHORISED BY</dt><dd>Assurance reviewer</dd></div></dl>
          <div className="witness-receipt-seal"><ConstructOSMark /><span>RECORD INTEGRITY</span><strong>VERIFIED</strong></div><footer><span>CONSTRUCTOS / OFFLINE MANIFEST</span><span>ILLUSTRATIVE</span></footer>
        </article>
        <div className="witness-verifier" aria-live="polite"><header><span>LOCAL VERIFIER / V1.0</span><span>{verificationStage === VERIFICATION_CHECKS.length ? "COMPLETE" : verifying ? "RUNNING" : "READY"}</span></header>{VERIFICATION_CHECKS.map((check, index) => <div key={check} data-pass={verificationStage > index ? "" : undefined}><i>{verificationStage > index ? "✓" : "·"}</i><span>{check}</span><b>{verificationStage > index ? "PASS" : "WAIT"}</b></div>)}</div>
      </div>
    </section>
  );
}

function ClosingWitness() {
  return (
    <section className="witness-close" aria-labelledby="close-title">
      <img src={FILM_POSTER} alt="" aria-hidden="true" /><div className="witness-close-shade" aria-hidden="true" /><div className="witness-close-spine" aria-hidden="true"><i /><ConstructOSMark /></div>
      <div className="witness-close-inner"><p className="witness-kicker"><span /> The closing witness</p><h2 id="close-title">When the project is questioned,<br /><em>the answer is already built.</em></h2><p>Run the project. Preserve the proof.</p><div><Link className="witness-button witness-button--copper" to="/register">Build your project record <ArrowIcon /></Link><Link className="witness-line-link" to="/login">Enter ConstructOS <span>↗</span></Link></div></div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="witness-footer"><div className="witness-footer-top"><div className="witness-footer-brand"><ConstructOSMark /><div><strong>CONSTRUCTOS</strong><span>DELIVERY / CONTROL / ASSURANCE</span></div></div><p>THE EVIDENCE-NATIVE OPERATING SYSTEM<br />FOR CAPITAL PROJECTS.</p><div className="witness-footer-links"><a href="#trace">Live trace</a><a href="#system">System</a><a href="#assurance">Assurance</a><Link to="/login">Sign in</Link></div></div><div className="witness-footer-bottom"><span>© {new Date().getFullYear()} ConstructOS</span><span>Built for accountable delivery.</span><span>PROJECT RECORD / READY</span></div></footer>
  );
}

export default function LandingPage() {
  const staticVisual = useStaticVisual();
  useEffect(() => {
    const previousTitle = document.title;
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previousThemeColor = themeMeta?.content;
    document.title = "ConstructOS — The project that can testify.";
    if (themeMeta) themeMeta.content = "#050607";
    return () => { document.title = previousTitle; if (themeMeta && previousThemeColor) themeMeta.content = previousThemeColor; };
  }, []);

  return (
    <div className="witness-page">
      <a className="witness-skip-link" href="#landing-main">Skip to content</a><LandingHeader /><CinematicHero staticVisual={staticVisual} />
      <main id="landing-main" tabIndex={-1}><TraceRibbon /><ConsequenceEngine staticVisual={staticVisual} /><OperatingStructure /><ReconciliationLab /><ProjectIntelligence /><LifecycleAtlas /><EvidenceVault staticVisual={staticVisual} /><ClosingWitness /></main>
      <LandingFooter />
    </div>
  );
}
