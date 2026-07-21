<h1 align="center">job-tailor</h1>

<p align="center">
  A CLI that tailors a CV and cover letter to a job posting with an LLM —
  <br />
  <strong>without ever letting the model invent a fact about you.</strong>
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" />
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white" />
  <img alt="Providers" src="https://img.shields.io/badge/LLM-Gemini%20%7C%20Claude-8A2BE2" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-91%20passing-success" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue" />
</p>

---

Job applications are a volume game, and the obvious way to win it is to have a model write the
letter. The obvious way is also how you end up sending an employer a CV bullet that never
happened.

`job-tailor` solves the volume problem under a hard constraint: **the model may only *select*
bullets you wrote by hand. It never generates a factual claim.** Everything checkable —
employers, dates, technologies, numbers — lives in `data/profile.yaml`. The model receives that
profile and returns a list of bullet **ids**; there is no schema field in which invented prose
could arrive, and a reconciliation pass drops any id that is not real.

That constraint is the whole design, and most of this README is about the places it had to be
enforced in code rather than asked for in a prompt — each one discovered by a real application
that came out wrong.

```console
$ job-tailor run job.txt

Company:     Kaufland e-commerce
Role:        Senior React Native Engineer
Match score: 74/100
Flags:       LANGUAGE_RISK, SALARY_BELOW_THRESHOLD
Provider:    gemini / gemini-2.5-flash
Gaps:
  - Posting expects native Kotlin work; profile has none
Written to:  output/kaufland-e-commerce-senior-react-native-engineer
```

**Contents** — [Quick start](#quick-start) · [Commands](#commands) ·
[Configuration](#configuration) · [Flags](#flags) · [Design notes](#design-notes) ·
[Architecture](#architecture) · [Tests](#tests) · [Roadmap](#roadmap)

## What it does

1. **extract** — parses raw job-description text into a validated `JobSpec`: company, role,
   country, required stack, salary, visa sponsorship, tone.
2. **tailor** — picks which of your pre-written CV bullets fit that role, writes a headline, a
   profile summary and a cover letter, and returns an honest match score plus a blunt list of
   gaps.

Every model response is validated with zod and repaired in-conversation on failure. Google
Gemini and Anthropic Claude are both supported and swappable per run with `--provider`.

## Quick start

```bash
npm install
cp .env.example .env                          # add the key for one provider
cp data/profile.example.yaml data/profile.yaml # then replace it with your own CV
```

`data/profile.yaml` is your CV as a set of tagged, pre-written bullets. Each bullet needs a
stable `id` — ids are the model's only handle on your history, and it can never rewrite the
text behind one.

Fill in `basics.work_authorisation` for every country you intend to apply in, keyed by ISO
3166-1 alpha-2 code. **Leave an entry empty rather than approximating one:** an empty string
means the letter says nothing about your status there, which is always safe.

```bash
npm run dev -- run job.txt        # from source
npm run build && node dist/cli.js run job.txt
```

## Commands

### `job-tailor extract <file|->`

Reads job text from a file or stdin, prints the `JobSpec` as pretty JSON. `--out <path>` also
writes it to a file.

```bash
job-tailor extract job.txt
pbpaste | job-tailor extract -
```

```json
{
  "company": "Kaufland e-commerce",
  "role": "Senior React Native Engineer",
  "location": "Köln, Germany",
  "country": "DE",
  "remote": "hybrid",
  "language": "de",
  "seniority": "senior",
  "required_stack": ["React Native", "TypeScript", "CI/CD"],
  "nice_to_have": ["Firebase"],
  "salary_min_eur": 42000,
  "visa_sponsorship": "not_mentioned",
  "key_responsibilities": ["Ship mobile features", "Own the release pipeline"],
  "tone": "corporate"
}
```

### `job-tailor tailor <jobspec.json>`

Loads `data/profile.yaml` and a `JobSpec`, prints a `TailoredApplication`. `--profile <path>`
and `--out <path>` are optional.

```json
{
  "selected_bullet_ids": ["pl-volume", "pl-cicd", "bt-opendata"],
  "bullet_order": ["pl-cicd", "pl-volume", "bt-opendata"],
  "cover_letter_bullet_refs": ["pl-cicd", "bt-opendata"],
  "headline": "Mobile engineer shipping cross-platform products",
  "profile_summary": "Publishes React Native apps end to end.",
  "cover_letter": "…150-200 words, in the language and tone of the posting…",
  "match_score": 74,
  "gaps": ["Posting expects native Kotlin work; profile has none"],
  "flags": ["LANGUAGE_RISK", "SALARY_BELOW_THRESHOLD"]
}
```

Note what is *not* in that object: bullet text. The model returns ids.

### `job-tailor run <file|->`

Extract then tailor in one pass. Writes `job.json` and `application.json` to
`output/{company-slug}-{role-slug}/` and prints the summary shown at the top of this README.
Below `JOB_TAILOR_MIN_SCORE` the cover letter is blanked and the gaps are kept; `--force`
generates it anyway.

Every command reports the provider and model it used, so an output is never ambiguous about
what produced it. `extract` and `tailor` report it on stderr, keeping stdout pure JSON for
piping. All commands exit non-zero with a one-line message on failure; stack traces only appear
under `DEBUG=1`.

## Configuration

### Providers

| Provider    | Env var             | Default model       | Structured output              |
| ----------- | ------------------- | ------------------- | ------------------------------ |
| `gemini`    | `GEMINI_API_KEY`    | `gemini-2.5-flash`  | Native, server-side constrained |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` | Prompted, validated locally     |

Gemini is the default; you only need a key for the provider you actually use. Switching for a
single invocation is the point of the abstraction:

```bash
job-tailor run job.txt --provider gemini    > /dev/null
job-tailor run job.txt --provider anthropic > /dev/null
diff -r output/acme-*/            # compare the two cover letters
```

### Environment

| Variable                   | Default             | Purpose                                              |
| -------------------------- | ------------------- | ---------------------------------------------------- |
| `JOB_TAILOR_PROVIDER`      | `gemini`            | `gemini` or `anthropic`.                             |
| `GEMINI_API_KEY`           | —                   | Required when the provider is `gemini`.              |
| `ANTHROPIC_API_KEY`        | —                   | Required when the provider is `anthropic`.           |
| `JOB_TAILOR_MODEL`         | per provider        | Model for every task.                                |
| `JOB_TAILOR_EXTRACT_MODEL` | —                   | Model for extraction only.                           |
| `JOB_TAILOR_TAILOR_MODEL`  | —                   | Model for tailoring only.                            |
| `JOB_TAILOR_MAX_TOKENS`    | `16000`             | Output cap per call (Anthropic).                     |
| `JOB_TAILOR_MAX_RETRIES`   | `2`                 | Repair attempts after a failed parse.                |
| `JOB_TAILOR_MIN_SCORE`     | `40`                | Below this, `run` blanks the letter (`--force` off). |
| `JOB_TAILOR_PROFILE`       | `data/profile.yaml` | Profile path.                                        |
| `JOB_TAILOR_OUTPUT_DIR`    | `output`            | Where `run` writes artefacts.                        |
| `DEBUG`                    | —                   | `1` logs usage, writes transcripts, full traces.     |

Model resolution per task is `JOB_TAILOR_{TASK}_MODEL` > `JOB_TAILOR_MODEL` > provider default,
so a cheap model can do extraction while a stronger one writes the letter:

```bash
JOB_TAILOR_EXTRACT_MODEL=gemini-2.5-flash JOB_TAILOR_TAILOR_MODEL=gemini-2.5-pro job-tailor run job.txt
```

## Flags

Flags are recomputed in code after every response — whatever the model puts in `flags` is
discarded.

| Flag                             | Meaning                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| `LOW_MATCH`                      | `match_score < 50`.                                              |
| `NO_SPONSORSHIP`                 | Posting says visa sponsorship is not available.                  |
| `LANGUAGE_RISK`                  | Application language is neither `en` nor `pt`.                   |
| `SALARY_BELOW_THRESHOLD`         | Stated salary is below €45,934/year.                             |
| `INVALID_BULLET_IDS_DROPPED`     | The model referenced bullets that do not exist.                  |
| `UNEXPECTED_AUTHORISATION_CLAIM` | The letter claims work authorisation that does not apply there.  |
| `MISSING_AUTHORISATION_CLAIM`    | A statement applies to this country but the letter omits it.     |
| `COVER_LETTER_REF_MISMATCH`      | The letter cites bullets that were not selected.                 |
| `UNSUPPORTED_TECH_CLAIM`         | The letter names a job requirement nothing in the profile backs. |
| `COVER_LETTER_TOO_LONG`          | Over 200 words.                                                  |
| `COVER_LETTER_NOT_PARAGRAPHED`   | Fewer than three paragraphs.                                     |
| `SKIPPED_LOW_MATCH`              | Score below `JOB_TAILOR_MIN_SCORE`; letter blanked.              |

Everything from `UNEXPECTED_AUTHORISATION_CLAIM` down means **read the letter before sending
it.** Nothing is repaired automatically.

## Design notes

### The model selects; it does not write facts

These documents go to real employers, and a hallucinated employer or an inflated number on a CV
is fraud, whoever typed it. Removing the model's ability to write factual claims removes the
failure mode entirely, instead of trying to detect it afterwards.

Three layers enforce it:

1. **Prompt.** The system prompt states the model may only use facts present in the profile,
   and the hard rules forbid inventing or altering bullets.
2. **Schema.** `TailoredApplication` carries `selected_bullet_ids: string[]` — there is no field
   in which bullet prose could arrive.
3. **Reconciliation.** After every call, `reconcile()` in `src/core/tailor.ts` intersects the
   returned ids with the real ids from the profile, drops anything invented, rebuilds
   `bullet_order` from the surviving set, and raises `INVALID_BULLET_IDS_DROPPED`. A prompt is a
   request; this is the guarantee.

The model does write free prose in exactly three places — `headline`, `profile_summary` and
`cover_letter`. They are rewrites of profile facts, they are short, and you read them before
sending. That is the deliberate boundary.

### Omission beats an inapplicable statement

The first real run closed an Irish cover letter with "I am eligible for an EU Blue Card under
section 18g AufenthG" — German immigration law, quoted at an employer in Cork. The profile held
work authorisation as one string, so there was only ever one thing to say.

It is now a map keyed by country, and the rule is asymmetric on purpose:

```yaml
work_authorisation:
  DE: "Eligible for the EU Blue Card under section 18g AufenthG…"
  IE: ""      # nothing to say — so say nothing
```

An empty entry, a missing entry, or a job whose country could not be determined all mean the
same thing: **the letter must not mention visas, permits or residence status at all.** Saying
nothing costs a sentence. Saying the wrong thing is a false claim about your legal status, made
to someone deciding whether to hire you.

`reconcile()` enforces both directions — `UNEXPECTED_AUTHORISATION_CLAIM` when the letter makes
a claim it should not, `MISSING_AUTHORISATION_CLAIM` when it drops one it should have made.

### Adjacency is not experience

The second real run described RevenueCat, a subscription billing SDK, as "payment platforms"
because the posting asked for payment provider integrations. The bullet id was cited correctly,
so no reference check fired: the id was right and the *description* drifted.

The prompt now forbids re-characterising anything to fit a requirement, with the boundaries
stated concretely — Firebase is not AWS, Firestore is not MongoDB, subscription billing is not
payment processing. `UNSUPPORTED_TECH_CLAIM` backs it up: any term from `required_stack` or
`nice_to_have` that reaches the letter without appearing in a selected bullet or the skills map
is flagged, with the term named.

This is a keyword check, not a semantic one, and it is not meant to be more. It catches the
common shape — the job's own vocabulary leaking into the letter with nothing behind it — and
will miss a re-characterisation phrased in words the posting never used. Stated limit, not a
bug.

### Give the extractor the company name

Recruiter listings routinely omit the employer, and an unnamed company costs the letter its
entire opening paragraph. Put a header line at the top of the job file:

```
Company: Acme Robotics
```

A `Company: X` line anywhere in the input wins over whatever the model infers — it is a
deterministic rule, so it is enforced in code rather than only asked for in the prompt. When no
company can be found, the CLI says so on stderr instead of silently producing a generic opening.

### Flag, never silently repair

Every check that touches a factual claim raises a flag and prints the offending text to stderr.
None of them edit the letter.

That is deliberate. A cover letter is a document you sign and send; code that quietly rewrites
its factual content would be making claims on your behalf that you never read. The same run
that produced the Blue Card line also wrote "in a freelance capacity I built an event check-in
platform used across 222 events" — true of the *project*, not of the freelance employment entry,
and that bullet was never selected. `cover_letter_bullet_refs` now forces the model to declare
which bullets it drew on, and any id outside `selected_bullet_ids` raises
`COVER_LETTER_REF_MISMATCH` with the id named. The offending refs are **not** dropped: dropping
them would hide the fact that the prose is still wrong.

Two smaller decisions follow the same instinct:

- **`gaps` is for you, never for the employer.** It is deliberately blunt and exists so you can
  decide whether the application is worth sending.
- **Below `JOB_TAILOR_MIN_SCORE` (default 40) the letter is blanked**, the gaps are kept, and
  `SKIPPED_LOW_MATCH` is raised. A letter for a 15/100 match is not worth your attention; the
  reasons it scored 15 are. `--force` overrides it.

### The provider is an implementation detail of `src/llm/`

Nothing in `core/` or `cli.ts` knows which vendor is answering — they call `callJson()` and get
a validated object back.

Two reasons that boundary is worth its cost. The first is comparison: prompt quality is the
whole product here, and the only way to know whether a cover letter reads better from Gemini or
from Claude is to run the same prompt through both and read the output. `--provider` makes that
a one-liner instead of a refactor. The second is leverage: extraction is a cheap, mechanical
task and tailoring is not, so they should not be forced onto the same model — or the same
vendor's pricing. `JOB_TAILOR_EXTRACT_MODEL` and `JOB_TAILOR_TAILOR_MODEL` exist for exactly
that split.

### Retry behaviour

`callJson()` strips markdown code fences, parses, and validates against the zod schema. On a
parse or validation failure it continues the same conversation with a repair message containing
the exact validation error, up to `JOB_TAILOR_MAX_RETRIES` extra attempts, then throws
`LlmValidationError`.

Gemini additionally receives the schema itself: zod's `z.toJSONSchema()` output, filtered to the
keywords `responseJsonSchema` accepts, so the model is constrained server-side. That reduces
repair rounds but does not remove them — a constrained response can still be semantically wrong
— so the loop runs for both providers. Anthropic's Messages API has no equivalent parameter, so
it relies on the prompt, which is why `supportsNativeJsonSchema` exists rather than being
assumed.

Gemini's free tier rate-limits aggressively. The provider retries 429s and 5xx three times with
exponential backoff (2s, 4s, plus jitter) and prints the reason for each wait to stderr, so a
stall is never unexplained. A per-day quota is detected and fails immediately rather than
burning the retry window; both surface as `LlmQuotaError` with a message pointing at
`--provider anthropic`.

### Debugging a bad run

`DEBUG=1` writes the full model interaction next to the artefacts, so a disappointing cover
letter or a validation failure can be read off disk rather than reproduced:

```
output/{company-slug}-{role-slug}/debug/
├── extract-1-request.json    { provider, model, system, user, history, jsonSchema }
├── extract-1-response.txt    raw text, before fence stripping or parsing
├── extract-1-error.txt       only when that attempt failed validation
├── extract-2-request.json    the repair attempt, including the conversation it was sent
└── tailor-1-…
```

`extract` and `tailor` run standalone have no slug yet, so they write to
`output/_debug/{timestamp}/`. In `run` the slug only exists after extraction, so the session
starts there and is moved under the artefact directory as soon as it is known — the path is
printed to stderr both times.

Nothing is redacted; these files contain your full profile and are local only. `output/` is
gitignored. With `DEBUG` unset, no directory is created and no write is attempted.

## Architecture

```
src/
├── cli.ts            commands, stdin/file I/O, --provider, error formatting
├── config.ts         all environment resolution: provider, per-task model, keys
├── types.ts          every zod schema and inferred type
├── llm/
│   ├── client.ts     callJson: fence stripping, validation, repair loop, DEBUG transcript
│   ├── prompts.ts    extractionPrompt, tailoringPrompt
│   └── providers/
│       ├── types.ts      LlmProvider interface, LlmProviderError, LlmQuotaError
│       ├── anthropic.ts  Messages API, prompted JSON
│       ├── gemini.ts     native responseJsonSchema, backoff, quota errors
│       └── index.ts      resolveProvider() factory
├── core/
│   ├── extract.ts    job text  -> JobSpec
│   ├── tailor.ts     profile + JobSpec -> TailoredApplication, reconciliation
│   ├── match.ts      stub, phase 2 — deterministic tag-based scoring
│   └── render.ts     stub, phase 2 — handlebars + puppeteer output
├── sources/index.ts  stub, phase 3 — job-board ingestion
└── tracker/store.ts  stub, phase 4 — SQLite application tracking
```

Stubs throw `NotImplemented: phase N` and already carry their intended type signatures.

## Tests

```bash
npm test          # tsc, then vitest
npm run test:watch
```

91 tests, no network calls. They cover the zod schemas against valid and malformed fixtures, the
`callJson` retry loop against mocked SDKs, provider and per-task model resolution, the
`ConfigError` for each provider's missing key, Gemini's backoff and quota handling, the JSON
Schema conversion, the `DEBUG=1` transcript (written when set, absent when not),
`data/profile.example.yaml` against the `Profile` schema, the reconciliation rules, per-country
work authorisation, the cover-letter reference/length/paragraph checks, unsupported technology
claims, the `Company:` header override, and the low-match short-circuit.

`npm test` runs `tsc` first, so a type error fails the suite.

## Roadmap

| Phase | Scope                                                       | Status |
| ----- | ----------------------------------------------------------- | ------ |
| 1     | extract + tailor + CLI + profile + tests                    | Done   |
| 1.5   | multi-provider LLM layer (Gemini default, Anthropic opt-in) | Done   |
| 1.6   | corrections from the first real run, low-match short-circuit | Done  |
| 1.7   | cover-letter quality fixes from the second real run         | Done   |
| 2     | deterministic tag scoring, CV/letter PDF rendering          | Stub   |
| 3     | job-board ingestion                                         | Stub   |
| 4     | SQLite application tracking                                 | Stub   |

## License

MIT — see [LICENSE](LICENSE).
