/**
 * BlindSpot AI — frontend
 *
 * Security notes
 *  - No API keys, tokens or secrets exist in this file. AI calls go to /api/analyze,
 *    a server-side function that holds the key in an environment variable.
 *  - All user- and AI-generated text is rendered with textContent (via h()), never innerHTML.
 *  - Nothing is persisted: no localStorage / sessionStorage / cookies. State lives in memory only.
 */
(function () {
  "use strict";

  const ENDPOINT = "/api/analyze";
  const REQUEST_TIMEOUT_MS = 32000;
  const MIN_LOADING_MS = 1800;
  const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const LOADING_STAGES = [
    "Mapping your decision…",
    "Separating facts from assumptions…",
    "Checking for overlooked factors…",
    "Looking for conflicts between priorities…",
    "Drafting questions worth asking…",
  ];

  const state = {
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    introDone: false,
    formData: null,
    analysis: null,
    challenge: null,
    isDemo: false,
    demoReason: "",
    round: 0,
    busy: false,
    challengeBusy: false,
    backend: "unknown", // unknown | live | none
    selectedPriorities: [],
    previousAnalysis: null,
    previousData: null,
    lastFocus: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    intro: $("intro"), video: $("intro-video"), skip: $("skip-intro"), app: $("app"),
    views: { landing: $("landing"), form: $("form-view"), loading: $("loading-view"), analysis: $("analysis-view") },
    form: $("decision-form"), optionsList: $("options-list"), addOption: $("add-option"),
    priorityGrid: $("priority-grid"), priorityOther: $("priority-other"),
    otherWrap: document.querySelector(".other-priority"), formStatus: $("form-status"),
    loaderStage: $("loader-stage"), modeLabel: $("analysis-mode-label"), modeNote: $("mode-note"),
    summary: $("decision-summary"), fau: $("fau-grid"), coverage: $("coverage-list"),
    decisionMap: $("decision-map"), radar: $("blindspot-radar"), evidenceGaps: $("evidence-gap-list"),
    evidenceGapCount: $("evidence-gap-count"), roundComparison: $("round-comparison"), roundComparisonGrid: $("round-comparison-grid"),
    roundChangeLabel: $("round-change-label"), briefGrid: $("brief-grid"), briefNext: $("brief-next"),
    blindspots: $("blindspots-grid"), assumptions: $("assumptions-grid"), conflicts: $("conflicts-grid"),
    missing: $("missing-grid"), questions: $("questions-list"), challengeGrid: $("challenge-grid"),
    challengeBtn: $("challenge-btn"), challengeLoading: $("challenge-loading"),
    challengeResults: $("challenge-results"), challengeNote: $("challenge-note"),
    banner: $("api-banner"), navToggle: $("nav-toggle"), mobileNav: $("mobile-nav"),
    submit: $("submit-decision"), refineBlock: $("refine-block"), roundNum: $("round-num"),
    formEyebrow: $("form-eyebrow"),
  };

  /* ==========================================================
   * Safe DOM helpers
   * ========================================================== */

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else el.setAttribute(k, v);
      }
    }
    kids.flat().forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      el.append(c instanceof Node ? c : String(c)); // strings become text nodes
    });
    return el;
  }
  const clear = (node) => node.replaceChildren();
  const str = (v, max = 600) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);

  // Defense in depth: the server is the primary safety boundary, but the client
  // also refuses to render common decision-verdict language from model output.
  const VERDICT = new RegExp([
    "you should (definitely |probably |really )?(accept|decline|choose|pick|take|go with|reject|select|opt)",
    "i (strongly )?(recommend|suggest you)",
    "my recommendation",
    "the (best|better|right|wrong|correct) (option|choice|decision)",
    "you must (accept|choose|decline|take)",
    "therefore,? (you )?(accept|choose|decline|take)",
    "(go ahead and|just) (accept|decline|take it)"
  ].join("|"), "i");

  function safeAIText(value, fallback = "") {
    const text = str(value, 800);
    return text && !VERDICT.test(text) ? text : fallback;
  }
  const arr = (v) => (Array.isArray(v) ? v : []);
  const stagger = (el, i) => { el.style.setProperty("--i", String(i)); return el; };

  /* ==========================================================
   * Text utilities for the local (demo) reasoning engine
   * ========================================================== */

  function snip(text, n = 110) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    const first = t.split(/(?<=[.!?])\s/)[0] || t;
    const cut = first.length <= n ? first : first.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
    return cut.replace(/[.]$/, "");
  }
  const q = (t) => "“" + t + "”";
  function sentenceMatching(re, text) {
    const parts = String(text || "").split(/(?<=[.!?])\s+|\n+/);
    const hit = parts.find((s) => { re.lastIndex = 0; return re.test(s); });
    return hit ? snip(hit, 120) : "";
  }
  function clauses(text, max) {
    const seen = new Set();
    return String(text || "")
      .split(/[.;\n]+|,\s+(?![^()]*\))/)
      .map((s) => s.trim().replace(/^(and|but|also)\s+/i, ""))
      .filter((s) => s.length >= 3 && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
      .map((s) => (s.length > 120 ? s.slice(0, 117).trim() + "…" : s))
      .slice(0, max);
  }
  const listJoin = (items) =>
    items.length <= 1 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1];

  /* ==========================================================
   * Reasoning Coverage (deterministic; explicitly NOT a quality score)
   * ========================================================== */

  const DIMENSIONS = [
    { key: "Career", re: /\b(career|job|role|intern(ship)?|work|promotion|resume|cv|industry|skills?|profession|employer|company|hiring)\b/gi, prio: ["Career growth", "Experience", "Learning"] },
    { key: "Money", re: /(₹|\$|€|£|\b(money|stipend|salary|pay|paid|cost|fees?|price|loan|income|budget|savings?|afford\w*|rent|rs\.?|inr)\b)/gi, prio: ["Money"] },
    { key: "Time", re: /\b(hours?|time|schedule|deadlines?|weeks?|months?|commute|flexib\w*|weekends?|workload|busy)\b/gi, prio: ["Time"] },
    { key: "Education", re: /\b(college|study|studies|academic\w*|exams?|grades?|courses?|degree|university|school|class(es)?|gpa|semester|thesis)\b/gi, prio: ["Education"] },
    { key: "Health", re: /\b(health\w*|stress\w*|sleep|burn\s?out|energy|mental|tired|exhaust\w*|well-?being|fitness|anxiety)\b/gi, prio: ["Health"] },
    { key: "Relationships", re: /\b(family|friends?|parents?|partner|spouse|relationships?|social|community|colleagues?|team)\b/gi, prio: ["Family", "Location"] },
    { key: "Long-term impact", re: /\b(long[- ]term|future|years?|eventually|conversion|full[- ]time|reversible|growth|path|trajectory|later)\b/gi, prio: ["Stability", "Personal goals"] },
    { key: "Unknowns", re: /\b(unsure|not sure|don'?t know|unknown|uncertain|depends|maybe|might|unclear|wonder\w*)\b/gi, prio: [] },
  ];
  const LEVELS = ["Not mentioned", "Light", "Moderate", "Detailed"];

  function computeCoverage(data) {
    const text = [data.decision, data.known, data.leaning, data.concerns, data.unsure, data.update].join(" \n ");
    return DIMENSIONS.map((d) => {
      d.re.lastIndex = 0;
      let n = (text.match(d.re) || []).length;
      if (d.prio.some((p) => data.priorities.includes(p))) n += 2;
      if (d.key === "Unknowns" && data.unsure) n += 2;
      const level = n === 0 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : 3;
      return { key: d.key, level, label: LEVELS[level], n };
    });
  }

  /* ==========================================================
   * Local reasoning engine (Demo Mode). Grounded in the user's own words.
   * ========================================================== */

  const isInternshipSample = (d) => /intern(ship)?/i.test(d.decision || "");

  const DIM_BLINDSPOTS = {
    Time: (c) => ({ category: "Time and energy", title: "The time each option really demands",
      explanation: `Your write-up leans on ${c.strong}, but says little about how many hours and how much energy each option would take from the rest of your life.`,
      whyItMatters: "Options that look similar on paper can differ sharply in the focus, hours and recovery time they quietly consume.",
      question: "In a typical week under each option, where would the hours actually come from?" }),
    Education: (c) => ({ category: "Studies and skill-building", title: "Effect on your studies or learning path",
      explanation: `You emphasize ${c.strong}, but your reasoning doesn't yet say how each option affects your studies or the skills you're building.`,
      whyItMatters: "Short-term gains can crowd out learning that would have paid off later.",
      question: "What would each option add to, or take from, what you're trying to learn?" }),
    Health: () => ({ category: "Health and sustainability", title: "Whether you could sustain this",
      explanation: "Health, stress and sleep don't appear anywhere in the reasoning you described.",
      whyItMatters: "Costs to wellbeing tend to surface late, and they can change how a decision feels months in.",
      question: "What would you notice first if this option started to wear you down?" }),
    Relationships: () => ({ category: "People affected", title: "Other people who are touched by this",
      explanation: "Family, friends or colleagues are not part of your reasoning so far.",
      whyItMatters: "Decisions often depend on, or ripple out to, people whose views and constraints you haven't heard yet.",
      question: "Who else is affected by this, and have you actually heard their view?" }),
    "Long-term impact": () => ({ category: "Long-term impact", title: "Where this leads in two to five years",
      explanation: "Your reasoning is mostly about the near term. The longer arc of each option isn't described.",
      whyItMatters: "Options that feel equivalent now can open or close very different paths later.",
      question: "Where does each option plausibly put you in two years, and how sure are you of that path?" }),
    Money: (c) => ({ category: "Financial picture", title: "Money beyond the headline figure",
      explanation: `Your reasoning leans on ${c.strong}, but the wider financial picture of each option isn't described.`,
      whyItMatters: "Recurring costs, opportunity costs and future earnings can outweigh the number that is easiest to see.",
      question: "Over the whole period, what does each option cost and return, including things that are hard to put a number on?" }),
    Career: () => ({ category: "Goal fit", title: "How each option connects to the goal behind it",
      explanation: "The link between each option and what you ultimately want isn't spelled out.",
      whyItMatters: "A path can feel productive without moving you toward the thing you care about.",
      question: "How does each option connect to your goal, and what is your evidence rather than your hope?" }),
  };

  const ASSUMPTION_PATTERNS = [
    { re: /\b(close|near(by)?|convenient|easy|easier|comfortable|familiar)\b/i, title: "Convenience is a reliable sign of good fit",
      why: "This appears to treat how easy something looks as evidence that it will work well. Ease on one dimension doesn't always carry over to the others.",
      q: "What would still be hard about this option even if the convenient part holds?" },
    { re: /\b(experience|exposure|opportunit(y|ies)|networking)\b/i, title: "Having the opportunity automatically produces the benefit",
      why: "Access to an experience isn't the same as gaining from it. The benefit usually depends on what you would actually do and who you would learn from.",
      q: "What specifically would you do or learn, and what evidence suggests that will really happen?" },
    { re: /\b(pay|paid|salary|stipend|money|income|package|cheap|affordable|save|savings)\b/i, title: "The financial figure captures the value of the option",
      why: "A clear number is easy to weigh, so it can crowd out factors that are harder to quantify.",
      q: "If the money were different, would the rest of your reasoning change? What does that tell you?" },
    { re: /\b(everyone|everybody|people say|they say|my friends|my parents|recommended|popular|trending)\b/i, title: "What others do or say applies to your situation",
      why: "Other people's experience may differ from your circumstances in ways that matter.",
      q: "Which parts of their experience actually match your situation, and which don't?" },
    { re: /\b(definitely|obviously|certainly|surely|always|never|guaranteed|for sure|no doubt)\b/i, title: "The outcome is more certain than the evidence shows",
      why: "Strongly certain wording can hide that part of the outcome is still an expectation rather than a known fact.",
      q: "What would have to be true for this to turn out differently?" },
    { re: /\b(brand|reputed|reputation|famous|prestig\w*|big name|well[- ]known|good company|good name)\b/i, title: "A good name transfers to your own outcome",
      why: "Reputation may describe the organisation more than your personal experience of it.",
      q: "What does the name give you directly, and what would you still have to earn yourself?" },
    { re: /\b(will (help|give|lead|open|improve|work out|be fine)|going to|should be fine)\b/i, title: "The future will unfold as hoped",
      why: "Statements about what will happen are predictions. They may hold, but they aren't yet facts.",
      q: "What is the least favourable realistic version of how this could play out?" },
    { re: /\b(feel|feels|gut|instinct|just know)\b/i, title: "A strong feeling already reflects the relevant information",
      why: "A feeling can carry real information, but it isn't always clear what it is responding to. Naming that may help.",
      q: "If your gut feeling had to give three reasons, what would they be?" },
  ];

  const MISSING_BY_PRIORITY = {
    "Career growth": ["How each option connects to your career goal", "Without a clear link, “career value” stays a hope rather than something you have evaluated."],
    Money: ["The full financial picture over the whole period", "One figure rarely shows recurring costs, opportunity costs, or what you would earn or save elsewhere."],
    Education: ["Effect on your studies or learning path", "Academic or learning impact can change the real cost of an option more than its visible benefits."],
    Time: ["The actual time commitment, including its peaks", "Averages hide crunch periods, which are often when options collide with the rest of life."],
    Family: ["The views and constraints of people close to you", "Their circumstances and reactions can shape what is realistic more than your own preferences."],
    Health: ["How sustainable each option is for your health and energy", "Wellbeing costs tend to appear late and can quietly change how everything else feels."],
    Location: ["Day-to-day logistics of each option", "Location is concrete, so it can feel decisive even when practical details are unknown."],
    Learning: ["What you would actually learn, and from whom", "Titles describe a role; teaching quality and responsibility determine how much you grow."],
    Stability: ["How secure each path is, and for how long", "Stability can mean different things: income, routine, or future options. Which one matters to you?"],
    Experience: ["Concrete responsibilities rather than job titles", "“Experience” varies enormously in depth depending on what you are trusted to do."],
    "Personal goals": ["How each option fits the goal beyond this decision", "A personal goal is easy to name and easy to drift from without a specific link to the choice."],
  };

  const CONFLICTS = [
    [["Money", "Time"], "Earning versus free time", "Both money and time matter to you. Options that pay well often claim more of your hours, so these two may pull against each other."],
    [["Career growth", "Education"], "Career progress versus studies", "You value career growth and education. Pursuing both at once may stretch the time and attention available for each."],
    [["Career growth", "Health"], "Ambition versus sustainability", "Career growth and health can compete when an option demands sustained intensity."],
    [["Career growth", "Family"], "Career growth versus family", "Advancing a career may reduce the time or flexibility you have for family, or depend on their support."],
    [["Money", "Learning"], "Pay versus learning", "The option that pays more is not necessarily the one that teaches most. These priorities may point in different directions."],
    [["Money", "Personal goals"], "Income versus personal goals", "Short-term income and a longer-term personal goal can compete for the same months and energy."],
    [["Stability", "Career growth"], "Security versus growth", "Stability and rapid growth often involve opposite levels of risk, which may create tension in your reasoning."],
    [["Stability", "Experience"], "Security versus new experience", "Seeking new experience may mean accepting less predictability."],
    [["Location", "Career growth"], "Convenience versus opportunity", "Staying close to home and reaching for the strongest growth opportunity may not point the same way."],
    [["Time", "Education"], "Time versus studies", "Time spent elsewhere is time not spent on academics. Both are priorities for you."],
    [["Time", "Family"], "Time versus family", "The hours an option consumes may directly reduce time with the people you care about."],
    [["Experience", "Education"], "Experience versus studies", "Gaining experience and keeping up academic work may compete for the same hours."],
    [["Money", "Health"], "Income versus wellbeing", "Higher earnings sometimes come with costs to rest and stress. Both matter to you."],
    [["Location", "Learning"], "Proximity versus learning", "The most convenient option may not be the one that teaches you the most."],
  ];

  function ctxFor(data, coverage) {
    const ranked = coverage.filter((c) => c.key !== "Unknowns").slice().sort((a, b) => b.n - a.n);
    const strongKeys = ranked.filter((c) => c.level >= 2).slice(0, 2).map((c) => c.key.toLowerCase());
    return {
      strong: strongKeys.length ? listJoin(strongKeys) : "the factors you listed",
      weak: coverage.filter((c) => c.key !== "Unknowns" && c.level === 0).map((c) => c.key.toLowerCase()),
      coverage,
    };
  }

  function localAnalysis(data) {
    return isInternshipSample(data) ? internshipDemo(data) : genericAnalysis(data);
  }

  function genericAnalysis(data) {
    const coverage = computeCoverage(data);
    const c = ctxFor(data, coverage);
    const [A, B] = [data.options[0] || "your first option", data.options[1] || "your other option"];
    const sel = data.priorities;
    const covOf = (k) => (coverage.find((x) => x.key === k) || { n: 0 }).n;

    // ---- blind spots (3–5) ----
    const blindSpots = [];
    if (data.concerns) {
      blindSpots.push({ category: "An unresolved concern", title: "A doubt you named but haven't tested",
        explanation: `You noted ${q(snip(data.concerns, 130))}. Your reasoning for leaning the way you do doesn't yet say how this concern would be checked or addressed.`,
        whyItMatters: "Doubts you already have are often the most reliable pointers to what deserves investigation before deciding.",
        question: "What would you need to find out to know how serious this concern really is?" });
    }
    const dimOrder = ["Time", "Education", "Health", "Relationships", "Long-term impact", "Money", "Career"];
    dimOrder.slice().sort((a, b) => covOf(a) - covOf(b)).slice(0, 2).forEach((k) => blindSpots.push(DIM_BLINDSPOTS[k](c)));
    blindSpots.push({ category: "Opportunity cost", title: "What the other options replace",
      explanation: `Your reasoning describes the appeal of what you're leaning toward more than what you'd give up. With options like ${q(A)} and ${q(B)}, choosing one also means not doing the other.`,
      whyItMatters: "A choice can look clearly attractive until it is compared with the best realistic use of the same time, money and energy.",
      question: "If you didn't pick what you're leaning toward, what would you concretely do instead?" });
    blindSpots.push({ category: "Reversibility", title: "How easily either choice could be undone",
      explanation: "Nothing in your description says how costly it would be to change course after choosing.",
      whyItMatters: "Reversible choices can be tried; hard-to-reverse ones deserve more evidence first.",
      question: "If this turned out to be the wrong call after three months, what would undoing it cost?" });

    // ---- assumptions (2–4) ----
    const reasoningText = data.leaning + " . " + data.known;
    const assumptions = [];
    ASSUMPTION_PATTERNS.forEach((p) => {
      if (assumptions.length >= 3) return;
      p.re.lastIndex = 0;
      if (p.re.test(reasoningText)) {
        const quote = sentenceMatching(p.re, data.leaning) || sentenceMatching(p.re, data.known);
        assumptions.push({ title: p.title, explanation: (quote ? `You wrote ${q(quote)}. ` : "") + p.why, question: p.q });
      }
    });
    if (assumptions.length < 2) {
      assumptions.push({ title: "The facts you listed are the facts that matter",
        explanation: `Your reasoning rests on ${clauses(data.known, 99).length} stated facts, mostly about ${c.strong}. This appears to assume that these are the deciding factors, which hasn't been tested.`,
        question: "Which fact, if it turned out differently, would change how you think about this?" });
    }
    if (assumptions.length < 4 && data.unsure) {
      assumptions.push({ title: "The open questions will resolve in a workable way",
        explanation: `You flagged ${q(snip(data.unsure, 120))} as unsure. Proceeding as if these will turn out fine would be an assumption.`,
        question: "What would you do if the answers came back unfavourable?" });
    }
    if (assumptions.length < 2 && sel.length > 1) {
      assumptions.push({ title: "Your leaning reflects all of your priorities",
        explanation: `You selected ${sel.length} priorities (${listJoin(sel.slice(0, 4))}), but the reasoning you gave appears to rest mainly on ${c.strong}.`,
        question: "Which of your priorities is your current leaning actually serving least?" });
    }

    // ---- conflicts (1–3) ----
    const conflicts = [];
    CONFLICTS.forEach(([pair, title, explanation]) => {
      if (conflicts.length < 2 && pair.every((p) => sel.includes(p))) conflicts.push({ title, priorities: pair.slice(), explanation });
    });
    if (data.concerns) {
      conflicts.push({ title: "Your leaning versus your own doubts", priorities: ["What you lean toward", "What worries you"],
        explanation: `You lean toward the option described as ${q(snip(data.leaning, 90))}, and you also noted ${q(snip(data.concerns, 90))}. These may pull in different directions, and the reasoning doesn't yet say how they are reconciled.` });
    }
    if (!conflicts.length) {
      const p = sel[0] || "Your main priority";
      conflicts.push({ title: "One priority, several options", priorities: [p, "Your other options"],
        explanation: `${p} may be served very differently by ${q(A)} and ${q(B)}. Your reasoning doesn't yet compare them on this priority.` });
    }

    // ---- missing information (4–5) ----
    const missingInformation = [];
    if (data.unsure) {
      missingInformation.push({ item: "The questions you've already flagged",
        whyItMatters: `You listed ${q(snip(data.unsure, 120))}. Until these are answered, parts of the reasoning rest on guesses.` });
    }
    sel.forEach((p) => {
      const m = MISSING_BY_PRIORITY[p];
      if (m && missingInformation.length < 3) missingInformation.push({ item: m[0], whyItMatters: m[1] });
      else if (!m && p && missingInformation.length < 3) missingInformation.push({ item: `More detail about ${q(p)}`, whyItMatters: "You called this important, but it isn't described anywhere in your reasoning yet." });
    });
    [
      { item: "What each alternative looks like in concrete terms", whyItMatters: "Comparing a detailed option with a vague one tilts the evaluation toward whichever is better described." },
      { item: "What it would cost to undo or change course", whyItMatters: "How reversible a choice is affects how much evidence you need before making it." },
      { item: "People with direct experience of these options", whyItMatters: "First-hand accounts can reveal practical details that aren't visible from outside." },
    ].forEach((m) => { if (missingInformation.length < 5) missingInformation.push(m); });

    // ---- questions (6–7) ----
    const questions = [
      `What evidence would make you more confident, or more cautious, about ${q(A)}?`,
      `If you had to give up one of ${listJoin(sel.slice(0, 3).length > 1 ? sel.slice(0, 3) : ["your priorities"])} first, which would it be, and why?`,
      `Six months from now, what would you regret more: acting on ${q(A)} and being wrong, or acting on ${q(B)} and missing out?`,
      data.concerns ? `You mentioned ${q(snip(data.concerns, 100))}. What would tell you how serious that is?` : `What worries you about this decision that you haven't written down yet?`,
      blindSpots.find((b) => b.category !== "An unresolved concern") ? blindSpots.find((b) => b.category !== "An unresolved concern").question : "",
      "Who could you talk to who has direct experience of either option?",
      `If a friend described exactly this situation to you, what is the first thing you would ask them to double-check?`,
    ].filter(Boolean);

    const weak = c.weak.slice(0, 3);
    const summary = `Your reasoning leans mostly on ${c.strong}, and the main reason you gave for your current leaning is ${q(snip(data.leaning, 100))}. ` +
      (weak.length ? `Dimensions such as ${listJoin(weak)} are barely mentioned. ` : "") +
      "This is a map of what the reasoning currently covers, not a verdict on any option.";

    const facts = clauses(data.known, 5);
    const unknowns = clauses(data.unsure, 3);
    missingInformation.forEach((m) => { if (unknowns.length < 4 && m.item !== "The questions you've already flagged") unknowns.push(m.item); });

    return { summary, facts, unknowns, blindSpots: blindSpots.slice(0, 5), assumptions: assumptions.slice(0, 4), conflicts: conflicts.slice(0, 3), missingInformation: missingInformation.slice(0, 5), questions: questions.slice(0, 7) };
  }

  function internshipDemo(data) {
    const known = data.known || "₹25,000 stipend, 40 hours/week, 10 km from home, software development role, overlapping college schedule";
    return {
      summary: "Your current reasoning emphasizes proximity, the stipend, and the value of industry experience. Academic fit, the real quality of the learning, and how flexible the workload is appear less developed than the visible benefits.",
      facts: clauses(known, 5),
      unknowns: ["How much technical work you would actually perform", "Who would mentor you, and how often", "Whether hours flex around exams", "Whether the role could lead to a longer-term offer"],
      blindSpots: [
        { category: "Academic impact", title: "Workload versus the academic calendar",
          explanation: "You emphasized the stipend and proximity, but your reasoning doesn't yet address how 40 hours per week could affect your academic schedule.",
          whyItMatters: "Your available time may affect whether the internship actually fits your broader goals. A role that looks convenient on paper can still collide with exams or major deadlines.",
          question: "How would this work during exams and major academic deadlines?" },
        { category: "Learning quality", title: "Experience is not automatically skill-building",
          explanation: "“Software development role” is doing a lot of work. The title doesn't yet say what you would build, who would review your work, or how quickly you would grow.",
          whyItMatters: "Six months can compound strongly or weakly depending on mentorship and task quality, not merely on being at a company.",
          question: "What evidence do you have about the technical depth of the work you would be given?" },
        { category: "Opportunity cost", title: "What these six months would replace",
          explanation: "Accepting means not using that time for another internship, a research project, coursework, or rest. That alternative use of time is mostly absent from your reasoning.",
          whyItMatters: "A choice can look clearly attractive until it is compared with the next-best use of the same months.",
          question: "If you declined, what would you intentionally do with the same six months?" },
      ],
      assumptions: [
        { title: "Industry experience automatically means strong career value",
          explanation: "Your reasoning appears to connect “experience” with career benefit, but the actual value may depend on the responsibilities, mentorship and work you would do.",
          question: "What evidence do you have that this particular role provides meaningful technical experience?" },
        { title: "A short distance means the internship will be convenient",
          explanation: "Ten kilometres reduces travel friction, but it appears to be treated as evidence that the role will fit the rest of your life. Workload, overtime and meeting load are harder to see and often matter more.",
          question: "What would still be inconvenient even with a short commute?" },
        { title: "The stipend is a stable picture of the trade",
          explanation: "₹25,000 is a clear number, so it can crowd out less numeric factors such as learning, credential value, or academic risk. The number is real; it may not be the whole bargain.",
          question: "If the stipend were half, or double, would the rest of your reasoning look the same?" },
      ],
      conflicts: [
        { title: "Career experience versus academic performance", priorities: ["Career experience", "Academic performance"],
          explanation: "Your reasoning prioritizes both industry experience and academic performance. The workload may create tension between these goals." },
        { title: "Earning and proximity versus time and health", priorities: ["Money + location", "Time + health"],
          explanation: "A paid, nearby role is attractive on money and location. A 40-hour week can still tax time, sleep and recovery alongside college. That is a tension to examine, not a sign that wanting both is a mistake." },
      ],
      missingInformation: [
        { item: "Exact working hours and overtime culture", whyItMatters: "“40 hours/week” can be a firm ceiling or a polite average. The difference matters for academics." },
        { item: "Mentor availability and review cadence", whyItMatters: "Without knowing who would teach you, “industry experience” remains a hope rather than an evaluated claim." },
        { item: "Exam and academic flexibility", whyItMatters: "Whether leave around exams is possible can change the academic-risk picture more than stipend size." },
        { item: "Technical responsibilities and any conversion path", whyItMatters: "The work you would do, and whether a longer-term offer is realistic, can shift how you weigh six months." },
      ],
      questions: [
        "What evidence suggests this role will provide meaningful technical experience?",
        "What happens to your academic performance if the workload increases?",
        "Who will mentor you?",
        "What would you regret more six months from now?",
        "Are you valuing the stipend more heavily than the learning opportunity?",
        "What would make you more confident, or more cautious, without anyone else choosing for you?",
      ],
    };
  }

  function localChallenge(data) {
    const A = data.options[0] || "your first option";
    const B = data.options[1] || "your other option";
    const leanQuote = snip(data.leaning, 130);
    const sel = data.priorities;
    if (isInternshipSample(data)) {
      return {
        weakAssumptions: [{ title: "Convenience may be doing too much work", quote: leanQuote,
          body: "Proximity may reduce commute time, but your reasoning seems to treat convenience as evidence that the internship will fit your life well. What happens if the workload conflicts with your academic schedule?" }],
        missingEvidence: [{ title: "Learning quality is asserted, not shown",
          body: "You name “software development” and “industry experience”, but no stack, manager, sample project or past-intern outcome is mentioned. Those would be evidence; titles are labels." }],
        alternativePerspectives: [{ title: "Visible benefits may be leading", body: "Another reading: pay and distance, the most visible features, may be steering the reasoning while mentorship, the least visible, goes unexamined. That is not a recommendation, it is a frame to test." }],
        tradeoffs: [{ title: "Six months of hours have a cost even with a short commute", body: "You can value experience and still ask what you are trading: depth in coursework, rest, family time, or another project. Naming the trade-off keeps both priorities honest." }],
        scenarios: [{ title: "Mid-semester crunch", body: "Imagine week ten: two submissions, a midterm and a work sprint. Does your plan still hold? If the honest answer is “I'm not sure”, that uncertainty is useful information." }],
      };
    }
    const p1 = sel[0] || "your main priority", p2 = sel[1];
    return {
      weakAssumptions: [{ title: "A visible reason may be standing in for evidence", quote: leanQuote,
        body: "This reads as a reason, but it isn't yet shown to be sufficient. What would you expect to see if the reason were wrong, and have you looked for it?" }],
      missingEvidence: [{ title: "What could you check rather than believe?",
        body: `Your reasoning includes ${clauses(data.known, 99).length} stated facts, but most describe the option rather than test it. Which one claim your leaning depends on most could you verify with someone who knows first-hand?` }],
      alternativePerspectives: [{ title: "Run the same facts in reverse",
        body: `Suppose you were leaning toward ${q(B)} instead. Which of the same facts would you cite in its favour? If the facts support both stories equally, they may not be discriminating between ${q(A)} and ${q(B)}. This is not a recommendation, it tests how much your facts are really doing.` }],
      tradeoffs: [{ title: p2 ? `${p1} versus ${p2}` : `What ${p1} costs elsewhere`,
        body: p2 ? `You named both ${p1} and ${p2} as important. Which option serves each, and what would you accept losing on one to protect the other?` : `Serving ${p1} well usually means giving something up. What is the thing you would be least willing to give up, and does your reasoning protect it?` }],
      scenarios: [{ title: "The unfavourable realistic case",
        body: `Imagine the least favourable realistic version of ${q(A)} and of ${q(B)}. Does your current reasoning still hold in each? If it only holds in the favourable versions, that may be worth knowing before deciding.` }],
    };
  }

  /* ==========================================================
   * Backend client (key stays server-side; any failure degrades gracefully)
   * ========================================================== */

  async function callBackend(mode, data, analysis) {
    if (state.backend === "none") return { kind: "unavailable" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const body = { mode, data };
      if (analysis) body.analysis = { summary: analysis.summary, assumptions: analysis.assumptions.slice(0, 4).map((a) => ({ title: a.title })) };
      const res = await fetch(ENDPOINT, {
        method: "POST", credentials: "omit", signal: ctrl.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (res.status === 404 || res.status === 405 || res.status === 501) { state.backend = "none"; return { kind: "unavailable" }; }
      const isJson = (res.headers.get("content-type") || "").includes("json");
      if (!isJson) { state.backend = "none"; return { kind: "unavailable" }; }
      const json = await res.json();
      if (res.status === 503 && json && json.error === "not_configured") { state.backend = "none"; return { kind: "unavailable" }; }
      if (!res.ok || !json || !json.ok || !json.result) return { kind: "error", status: res.status };
      state.backend = "live";
      return { kind: "ok", result: json.result };
    } catch (err) {
      if (location.protocol === "file:") { state.backend = "none"; return { kind: "unavailable" }; }
      return { kind: "error", timeout: !!(err && err.name === "AbortError") };
    } finally {
      clearTimeout(timer);
    }
  }

  function coerceAnalysis(raw, data) {
    const fallback = genericAnalysis(data);
    const objs = (v, keys) => arr(v).filter((o) => o && typeof o === "object").map((o) => Object.fromEntries(keys.map((k) => [k, safeAIText(o[k])])));
    const out = {
      summary: safeAIText(raw.summary, fallback.summary),
      facts: arr(raw.facts).map((s) => safeAIText(s)).filter(Boolean).slice(0, 6),
      unknowns: arr(raw.unknowns).map((s) => safeAIText(s)).filter(Boolean).slice(0, 6),
      blindSpots: objs(raw.blindSpots, ["category", "title", "explanation", "whyItMatters", "question"]).slice(0, 5),
      assumptions: objs(raw.assumptions, ["title", "explanation", "question"]).slice(0, 4),
      conflicts: arr(raw.conflicts).filter((o) => o && typeof o === "object").slice(0, 3).map((o) => ({
        title: safeAIText(o.title), explanation: safeAIText(o.explanation),
        priorities: [safeAIText(arr(o.priorities)[0], "Priority A"), safeAIText(arr(o.priorities)[1], "Priority B")] })),
      missingInformation: objs(raw.missingInformation, ["item", "whyItMatters"]).slice(0, 5),
      questions: arr(raw.questions).map((s) => safeAIText(s)).filter(Boolean).slice(0, 8),
    };
    if (!out.facts.length) out.facts = fallback.facts;
    if (!out.unknowns.length) out.unknowns = fallback.unknowns;
    ["blindSpots", "assumptions", "conflicts", "missingInformation", "questions"].forEach((k) => { if (!out[k].length) out[k] = fallback[k]; });
    return out;
  }

  function coerceChallenge(raw, data) {
    const fallback = localChallenge(data);
    const list = (v, fb) => {
      const items = arr(v).filter((o) => o && typeof o === "object")
        .map((o) => ({ title: safeAIText(o.title), body: safeAIText(o.body), quote: safeAIText(o.quote) })).filter((o) => o.title || o.body).slice(0, 2);
      return items.length ? items : fb;
    };
    return {
      weakAssumptions: list(raw.weakAssumptions, fallback.weakAssumptions),
      missingEvidence: list(raw.missingEvidence, fallback.missingEvidence),
      alternativePerspectives: list(raw.alternativePerspectives, fallback.alternativePerspectives),
      tradeoffs: list(raw.tradeoffs, fallback.tradeoffs),
      scenarios: list(raw.scenarios, fallback.scenarios),
    };
  }

  /* ==========================================================
   * Intro (never blocks the product)
   * ========================================================== */

  function finishIntro() {
    if (state.introDone) return;
    state.introDone = true;
    els.intro.classList.add("is-gone");
    els.intro.setAttribute("aria-hidden", "true");
    els.app.classList.add("is-visible");
    els.app.inert = false;
    try { els.video.pause(); els.video.removeAttribute("src"); els.video.load(); } catch (_) { /* ignore */ }
    window.setTimeout(playLandingMotion, 120);
  }

  function bindIntro() {
    els.app.inert = true;
    document.documentElement.classList.add("js");
    if (state.reducedMotion) { finishIntro(); return; }

    const v = els.video;
    let startTimer = window.setTimeout(finishIntro, 2500);   // video never started
    let maxTimer = window.setTimeout(finishIntro, 7000);    // absolute ceiling
    const stop = () => { window.clearTimeout(startTimer); window.clearTimeout(maxTimer); finishIntro(); };

    v.addEventListener("ended", stop);
    v.addEventListener("error", stop);
    v.addEventListener("stalled", () => window.setTimeout(() => { if (v.readyState < 3 && !state.introDone) stop(); }, 4000));
    v.addEventListener("loadedmetadata", () => {
      if (isFinite(v.duration)) { window.clearTimeout(maxTimer); maxTimer = window.setTimeout(stop, Math.min(v.duration * 1000 + 1500, 7000)); }
    });
    v.addEventListener("playing", () => window.clearTimeout(startTimer), { once: true });
    els.skip.addEventListener("click", stop);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !state.introDone) stop(); });

    const play = v.play();
    if (play && typeof play.catch === "function") play.catch(() => { v.muted = true; v.play().catch(stop); });
    els.skip.focus({ preventScroll: true });
  }

  /* ==========================================================
   * Views
   * ========================================================== */

  function showView(name) {
    Object.entries(els.views).forEach(([key, node]) => { node.hidden = key !== name; });
    els.mobileNav.hidden = true;
    els.navToggle.setAttribute("aria-expanded", "false");
    window.scrollTo({ top: 0, behavior: "auto" });
    const focusId = { form: "form-title", analysis: "analysis-title" }[name];
    if (focusId) $(focusId).focus({ preventScroll: true });
    if (name === "form") playFormMotion();
  }

  function updateFormMode() {
    const refining = state.round >= 1;
    els.refineBlock.hidden = !refining;
    els.roundNum.textContent = String(state.round + 1);
    els.submit.textContent = refining ? "Run analysis again" : "Reveal my blind spots";
    els.formEyebrow.textContent = refining ? "Refining your decision" : "Decision intake";
  }

  function lockButtons(on) {
    ["submit-decision", "run-again", "refine-rerun", "challenge-btn", "api-retry", "api-demo"].forEach((id) => { const b = $(id); if (b) b.disabled = on; });
  }

  /* ==========================================================
   * Form
   * ========================================================== */

  const optionLabel = (i) => "Option " + OPTION_LETTERS[i];

  function addOptionRow() {
    const index = els.optionsList.querySelectorAll(".option-row").length;
    if (index >= 8) return;
    const input = h("input", { id: "option-" + index, name: "options[]", type: "text", maxlength: "160", placeholder: "Another option" });
    els.optionsList.append(h("div", { class: "option-row" }, h("label", { for: "option-" + index, text: optionLabel(index) }), input));
    input.focus();
  }

  function setError(name, message) {
    const node = document.querySelector('[data-error-for="' + name + '"]');
    if (!node) return;
    node.hidden = !message;
    node.textContent = message || "";
    const field = name === "options" ? document.getElementById("option-0") : $(name);
    if (field) { if (message) field.setAttribute("aria-invalid", "true"); else field.removeAttribute("aria-invalid"); }
  }

  const val = (id) => $(id).value.trim();

  function collectForm() {
    const priorities = state.selectedPriorities.slice();
    const other = val("priority-other");
    const i = priorities.indexOf("Other");
    if (i >= 0) { if (other) priorities.splice(i, 1, other); else priorities.splice(i, 1); }
    return {
      decision: val("decision"),
      options: Array.from(document.querySelectorAll('input[name="options[]"]')).map((x) => x.value.trim()).filter(Boolean).slice(0, 8),
      known: val("known"), leaning: val("leaning"), concerns: val("concerns"), unsure: val("unsure"),
      update: val("update"), priorities,
    };
  }

  function validate(data) {
    let ok = true;
    [["decision", "Please describe the decision you are considering."],
     ["known", "Share what you already know so there is something to examine."],
     ["leaning", "Tell us why you are leaning the way you are."]].forEach(([name, msg]) => {
      const bad = !data[name]; setError(name, bad ? msg : ""); if (bad) ok = false;
    });
    const badOpts = data.options.length < 2;
    setError("options", badOpts ? "Add at least two options so the decision has real alternatives." : ""); if (badOpts) ok = false;
    const badPrio = !data.priorities.length;
    setError("priorities", badPrio ? "Select at least one thing that matters to you." : ""); if (badPrio) ok = false;
    els.formStatus.textContent = ok ? "" : "A few fields still need your input.";
    return ok;
  }

  function setPriorities(names) {
    state.selectedPriorities = [];
    els.priorityGrid.querySelectorAll(".chip").forEach((chip) => {
      const on = names.includes(chip.getAttribute("data-priority"));
      chip.classList.toggle("is-on", on);
      chip.setAttribute("aria-pressed", String(on));
      if (on) state.selectedPriorities.push(chip.getAttribute("data-priority"));
    });
    els.otherWrap.hidden = !state.selectedPriorities.includes("Other");
  }

  function bindPriorities() {
    els.priorityGrid.querySelectorAll(".chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", () => {
        const value = chip.getAttribute("data-priority");
        const on = !chip.classList.contains("is-on");
        chip.classList.toggle("is-on", on);
        chip.setAttribute("aria-pressed", String(on));
        state.selectedPriorities = state.selectedPriorities.filter((p) => p !== value);
        if (on) state.selectedPriorities.push(value);
        if (value === "Other") els.otherWrap.hidden = !on;
      });
    });
  }

  function prefillSample() {
    $("decision").value = "Should I accept a 6-month software engineering internship?";
    const inputs = document.querySelectorAll('input[name="options[]"]');
    if (inputs[0]) inputs[0].value = "Accept internship";
    if (inputs[1]) inputs[1].value = "Decline internship";
    $("known").value = "₹25,000 stipend, 40 hours/week, 10 km from home, software development role, industry experience, overlapping college schedule.";
    $("leaning").value = "I'm leaning toward accepting because the company is close to home, so the internship will be convenient, and I would gain industry experience.";
    $("concerns").value = "I'm worried about balancing 40 hours a week with my college schedule, especially around exams.";
    $("unsure").value = "Mentor availability, exam flexibility, actual technical responsibilities, and whether it could lead to a full-time offer.";
    setPriorities(["Career growth", "Money", "Education", "Location", "Experience"]);
    ["decision", "known", "leaning", "concerns", "unsure"].forEach((id) => setError(id, ""));
    setError("options", ""); setError("priorities", "");
    els.formStatus.textContent = "";
  }

  function resetAll() {
    els.form.reset();
    els.optionsList.querySelectorAll(".option-row").forEach((row, i) => { if (i > 1) row.remove(); });
    setPriorities([]);
    Object.assign(state, { formData: null, analysis: null, challenge: null, round: 0, isDemo: false, previousAnalysis: null, previousData: null });
    els.roundComparison.hidden = true;
    els.challengeResults.hidden = true; els.challengeLoading.hidden = true;
    els.formStatus.textContent = "";
    ["decision", "known", "leaning", "options", "priorities"].forEach((n) => setError(n, ""));
    updateFormMode();
  }

  /* ==========================================================
   * Rendering (textContent only)
   * ========================================================== */

  const ICONS = { "Academic impact": "▣", "Learning quality": "◎", "Opportunity cost": "◇", Reversibility: "↺", "An unresolved concern": "!", "Time and energy": "◔", "Health and sustainability": "♡", "People affected": "☺", "Long-term impact": "➚", "Financial picture": "₹", "Goal fit": "◎", "Studies and skill-building": "▣" };

  function renderSummary(data, a) {
    clear(els.summary);
    els.summary.append(
      h("h2", { text: data.decision }),
      h("p", { text: a.summary }),
      h("p", { class: "summary-options", text: data.options.map((o, i) => optionLabel(i) + ": " + o).join("  ·  ") }),
      h("div", { class: "summary-meta" }, state.round > 1 ? h("span", { class: "tag tag--round", text: "Round " + state.round }) : null, data.priorities.map((p) => h("span", { class: "tag", text: p })))
    );
    if (data.update) els.summary.append(h("p", { class: "summary-update" }, h("strong", { text: "New information you added: " }), data.update));
  }

  function renderFau(a) {
    clear(els.fau);
    const col = (kind, label, sub, items) =>
      h("section", { class: "fau__col fau__col--" + kind, "aria-label": label },
        h("h3", { class: "fau__label", text: label }), h("p", { class: "fau__sub", text: sub }),
        h("ul", { class: "fau__list" }, items.length ? items.map((t, i) => stagger(h("li", { text: t }), i)) : [h("li", { class: "fau__empty", text: "Nothing identified." })]));
    els.fau.append(
      col("fact", "Fact", "What you explicitly stated", a.facts),
      col("assumption", "Assumption", "What your reasoning appears to rely on", a.assumptions.map((x) => x.title)),
      col("unknown", "Unknown", "What isn't known yet", a.unknowns)
    );
  }

  function renderCoverage(data) {
    clear(els.coverage);
    computeCoverage(data).forEach((d) => {
      els.coverage.append(h("li", { class: "cov cov--l" + d.level },
        h("span", { class: "cov__name", text: d.key }),
        h("span", { class: "cov__bar", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
        h("span", { class: "cov__level", text: d.label })));
    });
  }

  function renderBlindSpots(items) {
    clear(els.blindspots);
    items.forEach((it, i) => els.blindspots.append(stagger(h("article", { class: "insight-card insight-card--blind" },
      h("p", { class: "insight-card__cat" }, h("span", { class: "feature__icon", "aria-hidden": "true", text: ICONS[it.category] || "◎" }), "Potential blind spot"),
      h("p", { class: "insight-card__sub", text: it.category || "" }),
      h("h3", { text: it.title }), h("p", { text: it.explanation }),
      h("p", { class: "why" }, h("strong", { text: "Why this matters. " }), it.whyItMatters),
      h("p", { class: "ask" }, h("strong", { text: "Question to explore. " }), it.question)), i)));
  }

  function renderAssumptions(items) {
    clear(els.assumptions);
    items.forEach((it, i) => els.assumptions.append(stagger(h("article", { class: "insight-card insight-card--assume" },
      h("p", { class: "insight-card__cat", text: "Assumption detected" }),
      h("h3", { text: q(it.title) }), h("p", { text: it.explanation }),
      h("p", { class: "ask" }, h("strong", { text: "Ask yourself. " }), it.question)), i)));
  }

  function renderConflicts(items) {
    clear(els.conflicts);
    items.forEach((it, i) => els.conflicts.append(stagger(h("article", { class: "insight-card insight-card--conflict" },
      h("p", { class: "insight-card__cat", text: "Potential conflict" }),
      h("div", { class: "conflict-pair" }, h("span", { text: it.priorities[0] }), h("span", { class: "conflict-pair__arrow", "aria-label": "in tension with", text: "↕" }), h("span", { text: it.priorities[1] })),
      h("h3", { text: it.title }), h("p", { text: it.explanation })), i)));
  }

  function renderMissing(items) {
    clear(els.missing);
    items.forEach((it, i) => els.missing.append(stagger(h("article", { class: "insight-card insight-card--missing" },
      h("p", { class: "insight-card__cat", text: "Missing information" }),
      h("h3", { text: it.item }), h("p", { text: it.whyItMatters })), i)));
  }

  function renderQuestions(items) {
    clear(els.questions);
    items.forEach((t, i) => els.questions.append(stagger(h("li", { text: t }), i)));
  }

  const CHALLENGE_KINDS = [
    ["weakAssumptions", "weak", "Weak assumption", "⚠"],
    ["missingEvidence", "evidence", "Missing evidence", "⌕"],
    ["alternativePerspectives", "alt", "Alternative perspective", "⇆"],
    ["tradeoffs", "trade", "Trade-off", "⚖"],
    ["scenarios", "scenario", "Scenario to consider", "◐"],
  ];

  function renderChallenge(c) {
    clear(els.challengeGrid);
    let i = 0;
    CHALLENGE_KINDS.forEach(([key, kind, label, icon]) => {
      arr(c[key]).forEach((it) => {
        els.challengeGrid.append(stagger(h("article", { class: "challenge-card", "data-kind": kind },
          h("p", { class: "kind" }, h("span", { "aria-hidden": "true", text: icon }), " " + label),
          h("h3", { text: it.title }),
          it.quote ? h("blockquote", { class: "challenge-quote" }, h("span", { class: "sr-only", text: "You wrote: " }), q(it.quote)) : null,
          h("p", { text: it.body })), i++));
      });
    });
  }

  function renderDecisionMap(data, a) {
    clear(els.decisionMap);
    const nodes = [
      { kind: "fact", label: "FACTS", value: a.facts.length, detail: "stated" },
      { kind: "assumption", label: "ASSUMPTIONS", value: a.assumptions.length, detail: "relied on" },
      { kind: "unknown", label: "UNKNOWNS", value: a.unknowns.length, detail: "open" },
      { kind: "blind", label: "BLIND SPOTS", value: a.blindSpots.length, detail: "to explore" },
    ];
    const wrap = h("div", { class: "map-flow" });
    const decision = h("div", { class: "map-node map-node--decision" },
      h("span", { class: "map-node__eyebrow", text: "YOUR DECISION" }),
      h("strong", { text: snip(data.decision, 76) }));
    wrap.append(decision, h("div", { class: "map-connector", "aria-hidden": "true", text: "↓" }));
    const row = h("div", { class: "map-node-row" });
    nodes.forEach((n, i) => row.append(h("div", { class: "map-node map-node--" + n.kind, style: "--i:" + i },
      h("span", { class: "map-node__eyebrow", text: n.label }),
      h("strong", { class: "map-node__count", text: String(n.value) }),
      h("span", { class: "map-node__detail", text: n.detail }))));
    wrap.append(row);
    wrap.append(h("div", { class: "map-insight" },
      h("span", { class: "map-insight__pulse", "aria-hidden": "true" }),
      h("span", { text: "The map shows where your reasoning has evidence — and where it asks you to investigate." })));
    els.decisionMap.append(wrap);
  }

  function renderRadar(data) {
    clear(els.radar);
    const dims = computeCoverage(data).filter((x) => x.key !== "Unknowns").slice(0, 7);
    const size = 300, cx = 150, cy = 150, maxR = 102;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 300 300"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Blind spot radar");
    const point = (i, r) => { const a = (-Math.PI / 2) + (i * Math.PI * 2 / dims.length); return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };
    [0.34, 0.67, 1].forEach((scale) => {
      const poly = document.createElementNS(ns, "polygon"); poly.setAttribute("points", dims.map((_, i) => point(i, maxR * scale).join(",")).join(" ")); poly.setAttribute("class", "radar-ring"); svg.appendChild(poly);
    });
    dims.forEach((d, i) => {
      const [x, y] = point(i, maxR); const line = document.createElementNS(ns, "line"); line.setAttribute("x1", cx); line.setAttribute("y1", cy); line.setAttribute("x2", x); line.setAttribute("y2", y); line.setAttribute("class", "radar-axis"); svg.appendChild(line);
    });
    const values = dims.map((d) => Math.max(0.12, Math.min(1, (d.level + 1) / 3)));
    const area = document.createElementNS(ns, "polygon"); area.setAttribute("points", values.map((v, i) => point(i, maxR * v).join(",")).join(" ")); area.setAttribute("class", "radar-area"); svg.appendChild(area);
    values.forEach((v, i) => { const [x,y]=point(i,maxR*v); const c=document.createElementNS(ns,"circle"); c.setAttribute("cx",x); c.setAttribute("cy",y); c.setAttribute("r","4"); c.setAttribute("class","radar-point"); svg.appendChild(c); });
    dims.forEach((d, i) => { const [x,y]=point(i,maxR+18); const t=document.createElementNS(ns,"text"); t.setAttribute("x",x); t.setAttribute("y",y); t.setAttribute("text-anchor", x < 125 ? "end" : x > 175 ? "start" : "middle"); t.setAttribute("class","radar-label"); t.textContent=d.key; svg.appendChild(t); });
    els.radar.append(svg);
  }

  function buildEvidenceGaps(data, a) {
    const gaps = [];
    a.missingInformation.slice(0, 5).forEach((m, i) => gaps.push({ status: i === 0 ? "HIGH VALUE" : "OPEN", item: m.item, why: m.whyItMatters }));
    a.unknowns.slice(0, 4).forEach((u) => { if (!gaps.some((g) => g.item === u)) gaps.push({ status: "UNKNOWN", item: u, why: "This is not established in the information you provided yet." }); });
    return gaps.slice(0, 6);
  }

  function renderEvidenceGaps(data, a) {
    const gaps = buildEvidenceGaps(data, a); clear(els.evidenceGaps); els.evidenceGapCount.textContent = gaps.length + (gaps.length === 1 ? " gap" : " gaps");
    gaps.forEach((g, i) => els.evidenceGaps.append(stagger(h("article", { class: "evidence-gap", "data-status": g.status },
      h("span", { class: "evidence-gap__status", text: g.status }), h("div", {}, h("h4", { text: g.item }), h("p", { text: g.why })),
      h("span", { class: "evidence-gap__arrow", "aria-hidden": "true", text: "→" })), i)));
  }

  function renderRoundComparison() {
    if (state.round < 2 || !state.previousAnalysis) { els.roundComparison.hidden = true; return; }
    const before = state.previousAnalysis, after = state.analysis;
    const metrics = [
      ["Blind spots", before.blindSpots.length, after.blindSpots.length],
      ["Assumptions", before.assumptions.length, after.assumptions.length],
      ["Unknowns", before.unknowns.length, after.unknowns.length],
      ["Questions", before.questions.length, after.questions.length],
    ];
    clear(els.roundComparisonGrid);
    metrics.forEach(([label,b,a]) => els.roundComparisonGrid.append(h("div", { class: "compare-metric" }, h("span", { text: label }), h("strong", { text: b + " → " + a }), h("small", { text: a > b ? "more surfaced in Round 2" : a < b ? "fewer surfaced in Round 2" : "same count" }))));
    const beforeUnknown = before.unknowns[0] || "No leading unknown captured";
    const afterUnknown = after.unknowns[0] || "No leading unknown captured";
    els.roundComparisonGrid.append(h("div", { class: "compare-story" }, h("span", { class: "compare-story__label", text: "Reasoning shift" }), h("p", {}, h("strong", { text: "Round 1: " }), beforeUnknown), h("p", {}, h("strong", { text: "Round 2: " }), afterUnknown)));
    els.roundChangeLabel.textContent = state.formData && state.formData.update ? "New evidence added" : "Second pass";
    els.roundComparison.hidden = false;
  }

  function renderDecisionBrief(data, a) {
    const biggest = a.blindSpots[0];
    const assumption = a.assumptions[0];
    const unknown = a.unknowns[0] || (a.missingInformation[0] && a.missingInformation[0].item) || "An important unknown remains";
    const cards = [
      ["DECISION", snip(data.decision, 150)],
      ["WHAT YOU KNOW", a.facts.length + " explicit facts"],
      ["WHAT YOU'RE ASSUMING", assumption ? snip(assumption.title, 120) : "No major assumption surfaced"],
      ["BIGGEST BLIND SPOT", biggest ? snip(biggest.title, 120) : "Keep testing what is not yet visible"],
      ["EVIDENCE GAP", snip(unknown, 120)],
      ["YOUR OPTIONS", data.options.map((o,i)=>optionLabel(i)+": "+snip(o,45)).join(" · ")],
    ];
    clear(els.briefGrid); cards.forEach(([label,value],i)=>els.briefGrid.append(h("article", { class:"brief-item", style:"--i:"+i }, h("span", {class:"brief-item__label",text:label}), h("strong", {text:value}))));
    clear(els.briefNext);
    const nextQ = a.questions[0] || (biggest && biggest.question) || "What evidence would materially change your reasoning?";
    els.briefNext.append(h("span", { class:"brief-next__label", text:"MOST VALUABLE NEXT QUESTION" }), h("p", {text:nextQ}), h("span", {class:"brief-next__note",text:"The next step is evidence-gathering, not a verdict."}));
  }

  function renderModeInfo() {
    els.modeLabel.textContent = state.isDemo ? "Demo Analysis" : "Live AI analysis";
    els.modeLabel.classList.toggle("is-demo", state.isDemo);
    els.modeNote.hidden = !state.isDemo;
    if (state.isDemo) {
      els.modeNote.textContent = state.demoReason === "failed"
        ? "The live AI service was unreachable, so this is the built-in analysis, generated locally from your own words."
        : "No live AI backend is connected, so this is the built-in, rule-based analysis generated locally from your own words. Nothing left your browser.";
    }
  }

  function renderAll(data, a) {
    renderModeInfo(); renderSummary(data, a); renderFau(a); renderCoverage(data);
    renderBlindSpots(a.blindSpots); renderAssumptions(a.assumptions); renderConflicts(a.conflicts);
    renderMissing(a.missingInformation); renderQuestions(a.questions);
    renderDecisionMap(data, a); renderRadar(data); renderEvidenceGaps(data, a); renderRoundComparison(); renderDecisionBrief(data, a);
    els.challengeResults.hidden = true; els.challengeLoading.hidden = true; clear(els.challengeGrid);
  }

  /* ==========================================================
   * Flows
   * ========================================================== */

  const sleep = (ms) => new Promise((r) => window.setTimeout(r, state.reducedMotion ? 0 : ms));

  async function runAnalysis({ forceDemo = false } = {}) {
    if (state.busy || !state.formData) return;
    state.busy = true; lockButtons(true);
    els.banner.hidden = true;
    showView("loading");
    let i = 0;
    els.loaderStage.textContent = LOADING_STAGES[0];
    const ticker = window.setInterval(() => { i = Math.min(i + 1, LOADING_STAGES.length - 1); els.loaderStage.textContent = LOADING_STAGES[i]; }, 650);
    try {
      const data = state.formData;
      const started = Date.now();
      const outcome = forceDemo ? { kind: "forced" } : await callBackend("analyze", data);
      await sleep(Math.max(0, MIN_LOADING_MS - (Date.now() - started)));

      if (outcome.kind === "error") { showView("form"); openBanner(); return; }

      let analysis; let demo = true; let reason = "no-backend";
      if (outcome.kind === "ok") { analysis = coerceAnalysis(outcome.result, data); demo = false; reason = ""; }
      else { analysis = localAnalysis(data); if (forceDemo) reason = "failed"; }

      if (state.analysis) { state.previousAnalysis = state.analysis; state.previousData = state.formData ? JSON.parse(JSON.stringify(state.formData)) : null; }
      state.analysis = analysis; state.isDemo = demo; state.demoReason = reason; state.challenge = null;
      state.round += 1;
      renderAll(data, analysis);
      updateFormMode();
      showView("analysis");
    } catch (_) {
      showView("form"); openBanner();
    } finally {
      window.clearInterval(ticker);
      state.busy = false; lockButtons(false);
    }
  }

  async function submitFromForm() {
    const data = collectForm();
    if (!validate(data)) {
      const first = document.querySelector(".field-error:not([hidden])");
      if (first) first.scrollIntoView({ behavior: state.reducedMotion ? "auto" : "smooth", block: "center" });
      return;
    }
    state.formData = data;
    await runAnalysis();
  }

  async function runChallenge() {
    if (state.challengeBusy || state.busy || !state.analysis) return;
    state.challengeBusy = true; lockButtons(true);
    els.challengeResults.hidden = true; els.challengeLoading.hidden = false;
    els.challengeLoading.scrollIntoView({ behavior: state.reducedMotion ? "auto" : "smooth", block: "center" });
    try {
      const data = state.formData;
      let result = null; let note = "";
      if (!state.isDemo) {
        const out = await callBackend("challenge", data, state.analysis);
        if (out.kind === "ok") result = coerceChallenge(out.result, data);
        else note = "The live challenge pass was unavailable, so this is the built-in challenge generated from your own words.";
      }
      if (!result) result = localChallenge(data);
      await sleep(1100);
      state.challenge = result;
      renderChallenge(result);
      els.challengeNote.hidden = !note; els.challengeNote.textContent = note;
      els.challengeLoading.hidden = true; els.challengeResults.hidden = false;
      $("chr-title").focus({ preventScroll: true });
      els.challengeResults.scrollIntoView({ behavior: state.reducedMotion ? "auto" : "smooth", block: "start" });
    } catch (_) {
      els.challengeLoading.hidden = true;
    } finally {
      state.challengeBusy = false; lockButtons(false);
    }
  }

  function openBanner() {
    state.lastFocus = document.activeElement;
    els.banner.hidden = false;
    // the busy-lock may still have these disabled; a disabled button can't take focus
    ["api-retry", "api-demo"].forEach((id) => { $(id).disabled = false; });
    $("api-retry").focus();
  }
  function closeBanner() {
    els.banner.hidden = true;
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus({ preventScroll: true });
  }

  /* ==========================================================
   * Motion — native CSS/IntersectionObserver only
   * ========================================================== */

  function playLandingMotion() {
    if (state.reducedMotion) return;
    document.querySelectorAll(".hero .reveal").forEach((el, i) => {
      el.style.setProperty("--i", String(i));
      el.classList.add("is-inview");
    });
  }

  function playFormMotion() {
    if (state.reducedMotion) return;
    document.querySelectorAll(".decision-form .form-block:not([hidden])").forEach((el, i) => {
      el.style.setProperty("--i", String(i));
      el.classList.add("is-inview");
    });
  }

  /* ==========================================================
   * Events
   * ========================================================== */

  function openForm() { updateFormMode(); showView("form"); }

  function bindEvents() {
    document.querySelectorAll("[data-open-form]").forEach((b) => b.addEventListener("click", openForm));
    $("try-sample").addEventListener("click", () => { prefillSample(); openForm(); });
    $("prefill-sample").addEventListener("click", prefillSample);

    document.querySelectorAll('[data-nav="landing"]').forEach((el) => {
      el.addEventListener("click", (event) => {
        const landingHidden = els.views.landing.hidden;
        if (landingHidden) {
          event.preventDefault();
          showView("landing");
          const href = el.getAttribute("href");
          if (href && href.startsWith("#")) window.setTimeout(() => { const t = document.querySelector(href); if (t) t.scrollIntoView({ behavior: state.reducedMotion ? "auto" : "smooth" }); }, 50);
        }
      });
    });

    $("form-back").addEventListener("click", () => showView(state.analysis ? "analysis" : "landing"));
    els.addOption.addEventListener("click", addOptionRow);
    bindPriorities();

    els.form.addEventListener("submit", (e) => { e.preventDefault(); submitFromForm(); });

    const addMore = () => { openForm(); $("update").focus({ preventScroll: true }); };
    const rerun = () => { const d = collectForm(); if (!validate(d)) { openForm(); return; } state.formData = d; runAnalysis(); };
    $("add-more").addEventListener("click", addMore);
    $("refine-add").addEventListener("click", addMore);
    $("run-again").addEventListener("click", rerun);
    $("refine-rerun").addEventListener("click", rerun);
    const startNew = () => { resetAll(); openForm(); };
    $("start-new").addEventListener("click", startNew);
    $("refine-new").addEventListener("click", startNew);

    els.challengeBtn.addEventListener("click", runChallenge);

    $("api-retry").addEventListener("click", () => runAnalysis());
    $("api-demo").addEventListener("click", () => runAnalysis({ forceDemo: true }));
    $("api-dismiss").addEventListener("click", closeBanner);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !els.banner.hidden) closeBanner(); });

    els.navToggle.addEventListener("click", () => {
      const open = els.mobileNav.hidden;
      els.mobileNav.hidden = !open;
      els.navToggle.setAttribute("aria-expanded", String(open));
      els.navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });
    els.mobileNav.querySelectorAll("a, button").forEach((n) => n.addEventListener("click", () => { els.mobileNav.hidden = true; els.navToggle.setAttribute("aria-expanded", "false"); }));
  }


  /* ==========================================================
   * Native motion enhancement (no third-party animation library)
   * ========================================================== */
  function initPremiumMotion() {
    const staggerGroups = [
      ".steps .step-card",
      ".feature-grid .feature",
      ".split__grid .split__card",
      ".peek__col",
      ".view--analysis .insight-card",
      ".view--analysis .question-list li",
      ".view--analysis .fau__list li",
      ".view--analysis .challenge-card",
      ".decision-map .map-node",
      ".evidence-gap",
      ".brief-item",
      ".compare-metric"
    ];

    staggerGroups.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el, i) => {
        el.style.setProperty("--i", String(i));
      });
    });

    if (state.reducedMotion || !("IntersectionObserver" in window)) return;

    const observer = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-inview");
        obs.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: "0px 0px -40px 0px" });

    document.querySelectorAll(
      ".section__head, .steps .step-card, .feature-grid .feature, .split__card, .peek, .cta-final__card"
    ).forEach((el) => observer.observe(el));
  }

  bindEvents();
  bindIntro();
  initPremiumMotion();

  // Test hook (read-only helpers; harmless in production)
  window.__blindspot = { localAnalysis, localChallenge, computeCoverage };
})();
