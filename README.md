# BlindSpot AI — See what you're not seeing.

A security-conscious AI thinking partner that helps users surface blind spots, assumptions, conflicts, missing information and useful questions **without making the decision for them**.

## Folder structure

```text
blindspot-ai/
├── index.html
├── style.css
├── script.js
├── noscript.css
├── intro.mp4
├── package.json
├── vercel.json
└── api/
    └── analyze.js
```

## Open locally

You can open `index.html` directly in a browser, or use VS Code Live Server.

- Local/static mode works with the built-in **Demo Analysis**.
- No API key is required in the browser.
- No user decision data is stored in localStorage/sessionStorage/cookies.

For the best local experience in VS Code:

1. Open this folder in VS Code.
2. Install/use Live Server if you have it.
3. Right-click `index.html` → **Open with Live Server**.

## Deploy live AI on Vercel

The live architecture is:

```text
Browser → /api/analyze → AI provider
```

1. Import this folder into Vercel.
2. Add **one** server environment variable:
   - `ANTHROPIC_API_KEY`, or
   - `OPENAI_API_KEY`
3. Optional: set `AI_MODEL`.
4. Optional: set `ALLOWED_ORIGIN` to your exact production origin.
5. Redeploy.

The browser never receives the provider key.

## Important deployment check

After deployment, use the sample internship decision and confirm the result says **Live AI analysis**, not Demo Analysis. In DevTools → Network, the request must be:

```text
POST /api/analyze → 200
```

Then test **Challenge My Thinking** and confirm it also calls `/api/analyze`.

## Security

- Provider keys are server-side only.
- Request body is limited to 16 KB and fields are length-clipped.
- Model output is parsed, schema-checked and filtered server-side.
- The frontend applies a second verdict-language filter before rendering model output.
- User/model text is rendered through DOM text nodes, not `innerHTML`.
- Prompt injection instructions inside user input are treated as data.
- Generic API errors do not expose provider errors or secrets.
- CSP disables third-party executable JavaScript.
- `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy` and HSTS are configured.
- The in-memory rate limiter is best-effort per serverless instance; production-scale abuse protection should use a distributed limiter/WAF.

## Intro

The cinematic intro has a short safety ceiling and a visible Skip intro control. If video playback fails or is blocked, the application continues to the landing page.

## Demo flow

1. Open the site.
2. Use the sample internship decision.
3. Reveal blind spots.
4. Walk through Fact / Assumption / Unknown.
5. Show Reasoning Coverage.
6. Show Blind Spots, Conflicts, Missing Information and Questions.
7. Click **Challenge My Thinking**.
8. Add information and run the analysis again for Round 2.

Core principle: **BlindSpot AI does not tell the user what decision to make. It helps the user see what they may not have considered.**


## Premium UI pass

The current build includes a responsive visual pass with animated cards, buttons, glass surfaces, mobile navigation, touch-friendly controls, native IntersectionObserver reveals, and reduced-motion support. No third-party executable animation library is required.

## Decision Intelligence 3.0

The current product layer adds: Decision Map, Reasoning Coverage Radar, Evidence Gaps, a stronger Challenge My Thinking pass, Round 2 reasoning comparison, and a Decision Brief. These are reflection layers built from the analysis; they do not produce a recommendation or decision score.


## Final submission notes

- `api/analyze.js` is included in this submission.
- The production intro filename is exactly `intro.mp4`.
- Round 2 comparison describes changes in reasoning structure; it does not label fewer surfaced items as an improvement.
- The reasoning coverage radar is a reflection of attention/evidence, not a decision-quality score.
