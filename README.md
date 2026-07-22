<h1 align="center">job-tailor</h1>

<p align="center">
  A CLI that tailors a CV and cover letter to a job posting with an LLM —
  <br />
  <strong>without ever letting the model invent a fact about you.</strong>
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" />
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white" />
  <img alt="Providers" src="https://img.shields.io/badge/LLM-Gemini%20%7C%20Claude-8A2BE2" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-390%20passing-success" />
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
[Configuration](#configuration) · [Countries](#countries) · [Where a posting is](#where-a-posting-is) ·
[German or English](#german-or-english) · [Discovery](#discovery-a-verification-problem-not-a-research-one) ·
[Flags](#flags) · [Design notes](#design-notes) · [Web interface](#web-interface) ·
[Architecture](#architecture) · [Tests](#tests) · [Roadmap](#roadmap)

## What it does

1. **discover** — finds which companies have a Greenhouse, Lever or Ashby board by probing
   public endpoints, so `data/companies.yaml` is filled by verification rather than by hand.
2. **search** — collects postings from documented public job APIs and writes one to a job file,
   in the same plain text a pasted posting has.
3. **extract** — parses raw job-description text into a validated `JobSpec`: company, role,
   country, required stack, salary, visa sponsorship, tone.
4. **tailor** — picks which of your pre-written CV bullets fit that role, writes a headline, a
   profile summary and a cover letter, and returns an honest match score plus a blunt list of
   gaps.
5. **render** — lays the selected bullets and the letter into a CV and cover letter as A4 PDFs,
   and refuses to produce either from an application still carrying a factual flag.
6. **track** — a local web UI and a SQLite tracker over all of it, from first sighting to
   outcome. It never submits anything.

Every model response is validated with zod and repaired in-conversation on failure. Google
Gemini and Anthropic Claude are both supported and swappable per run with `--provider`.

## Quick start

```bash
npm install                                    # puppeteer fetches a Chromium for rendering
cp .env.example .env                          # add the key for one provider
cp data/profile.example.yaml data/profile.yaml # then replace it with your own CV
```

To skip that Chromium download and point at a browser you already have, set
`PUPPETEER_SKIP_DOWNLOAD=1` before installing and `PUPPETEER_EXECUTABLE_PATH` at run time.

`data/profile.yaml` is your CV as a set of tagged, pre-written bullets. Each bullet needs a
stable `id` — ids are the model's only handle on your history, and it can never rewrite the
text behind one.

`data/countries.yaml` is the other file you edit by hand: one entry per market you target, with
its salary threshold and the sentence you may truthfully say about your right to work there.
See [Countries](#countries) — only Germany ships with a real figure, deliberately.

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
  "salary_currency": "EUR",
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
`output/{company-slug}-{role-slug}/`, renders the CV and cover-letter PDFs beside them, and
prints the summary shown at the top of this README. Below `JOB_TAILOR_MIN_SCORE` the cover
letter is blanked and the gaps are kept; `--force` generates it anyway.

| Flag          | Meaning                                                         |
| ------------- | --------------------------------------------------------------- |
| `--force`     | Generate and render past the score and refusal checks.          |
| `--no-render` | Write JSON only; skip the PDFs.                                  |
| `--open`      | Open the rendered CV with the OS default handler.               |
| `--provider`  | `gemini` or `anthropic` for this run.                           |

### `job-tailor search [keywords...]`

Searches every configured source and prints the results ordered by pre-score.
**It never calls the model** — searching has to be free, or it will not be done often enough
to matter.

```console
$ job-tailor search engineer --source ashby --limit 5

  #   COMPANY       TITLE                                LOCATION                SOURCE    PRE
  1   Nory          Senior Mobile Engineer               Spain, Dublin, London…  ashby      50
  2   Nory          Senior Product Engineer - Insights   Dublin, Spain, London…  ashby      50
```

`--source <name>` (repeatable), `--country`, `--location`, `--remote`,
`--language <de|en|unknown>` (repeatable), `--english`, `--posted-within <days>`,
`--limit <n>` (50), `--refresh`, `--json`.

> **`discover --country` filters companies; `search --country` filters postings.** They are
> different questions and they take the same flag, so it is worth saying plainly. A company
> headquartered in Germany posts roles in Lisbon, Dublin and San Francisco — `discover --country
> DE` decides *whose boards to probe*, `search --country DE` decides *which postings are
> actually in Germany*, judged on the posting's own location field. Nothing about the company's
> entry in `candidates.yaml` or `companies.yaml` reaches the search filter.

```console
$ job-tailor search engineer --country de --limit 3

  #   COMPANY         TITLE                                LOCATION          SOURCE      LANG  PRE
  1   GetYourGuide    Connectivity Partner Program Manager Berlin            greenhouse  en    100
  2   HelloFresh      Director UX Design                   Berlin, Germany   greenhouse  en    100
  3   SumUp           Senior Analytics Engineer            Berlin, Germany   greenhouse  en    100

Filtered to Germany: 58 of 311 postings matched.
```

Those last lines are there so a zero-result search is obviously the filter working and not a
source breaking. See [Where a posting is](#where-a-posting-is) for how the matching works, and
[German or English](#german-or-english) for the `LANG` column.

The pre-score is `preScore()` from `core/match.ts` against a lightweight JobSpec built from the
technologies the posting names. It is an ordering hint, nothing more — a `—` means the posting
named no technology the vocabulary recognises, which is not the same as scoring zero.

### `job-tailor pull <sourceId | index>`

Writes a posting to `jobs/{company}-{title}.txt` in the same plain-text shape a pasted posting
has, `Company:` header included. Takes a source id or the row number from the last search.

```bash
job-tailor pull 2                     # the second row of the last search
job-tailor run --from ashby:nory:abc  # pull and run the whole pipeline in one step
```

### `job-tailor serve`

Starts the local web interface. `--port <n>` (4321), `--open`.

```bash
job-tailor serve --open
```

See [Web interface](#web-interface) below.

### `job-tailor stats`

Prints the tracker's counts and the gaps that come up most often — the same figures
`/api/stats` returns, for when you are already in a terminal.

### `job-tailor sources`

Lists each source, whether its credentials are present, and the board tokens configured for it.

### `job-tailor discover`

Finds board tokens for the companies in `data/candidates.yaml` by probing the public board
endpoints. See [Discovery](#discovery).

```console
$ job-tailor discover --country IE

Probing 9 companies (9 slugs) against greenhouse, lever, ashby. Cached results are not re-probed.
16 probes sent, 5 boards reported (>= 1 matching).
COMPANY                 CC    BOARD        TOKEN                 TOTAL  MATCH  SAMPLE TITLE
-------------------------------------------------------------------------------------------
Stripe                  IE    greenhouse   stripe                  525     52  AI Engineer
Intercom                IE    greenhouse   intercom                130     13  AI Infrastructure Engineer
Tines                   IE    greenhouse   tines                    22      6  Engineering Manager - Government Cloud
Nory                    IE    ashby        nory                      7      4  Senior Product Designer – Inventory
Wayflyer                IE    ashby        wayflyer                 15      3  Frontend Software Engineer
```

`--input <path>`, `--country <code>` (repeatable), `--board <name>` (repeatable),
`--min-matching <n>`, `--refresh`, `--write`, `--json`.

`--write` appends the confirmed tokens to `data/companies.yaml`, where `search` picks them up.

### `job-tailor probe <board> <token>`

One token, verbosely — for checking a company by hand. Exits non-zero when the token does not
resolve to a board.

```console
$ job-tailor probe ashby nory

Board:       ashby
Token:       nory
Valid:       yes
Postings:    7
Matching:    4
```

### `job-tailor countries`

Lists the configured markets, so it is obvious at a glance which ones are ready to target.

```console
$ job-tailor countries

CODE    COUNTRY           THRESHOLD         AUTHORISATION
---------------------------------------------------------
DE *    Germany           EUR 45,934        present
ES      Spain             not set           none
IE      Ireland           not set           none
NL      Netherlands       not set           none
PT      Portugal          not set           none
```

### `job-tailor render <output-dir>`

Re-render the CV and cover letter from the `job.json` and `application.json` already in a
directory — no model call. This is the loop for editing a letter by hand and regenerating:
open `cover-letter.html`, fix a sentence, `job-tailor render output/acme-…`. `--force` and
`--open` behave as in `run`.

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
| `JOB_TAILOR_PRESCORE_MIN`  | `0`                 | Above 0, skip a posting below this keyword pre-score before tailoring. |
| `JOB_TAILOR_PROFILE`       | `data/profile.yaml` | Profile path.                                        |
| `JOB_TAILOR_OUTPUT_DIR`    | `output`            | Where `run` writes artefacts.                        |
| `PUPPETEER_EXECUTABLE_PATH`| —                   | Use a system Chromium for rendering instead of the bundled one. |
| `ARBEITSAGENTUR_API_KEY`   | —                   | Public client key for the German job board source.   |
| `ADZUNA_APP_ID` / `_KEY`   | —                   | Adzuna account; without both, the source is skipped. |
| `JOB_TAILOR_COMPANIES`     | `data/companies.yaml` | Board tokens `search` watches.                     |
| `JOB_TAILOR_COUNTRIES`     | `data/countries.yaml` | Salary thresholds and authorisation statements.    |
| `JOB_TAILOR_DEFAULT_COUNTRY` | from the file     | Overrides `default:` in `countries.yaml`.            |
| `JOB_TAILOR_CANDIDATES`    | `data/candidates.yaml` | Companies worth checking, by country.             |
| `JOB_TAILOR_JOBS_DIR`      | `jobs`              | Where `pull` writes job files.                       |
| `JOB_TAILOR_PORT`          | `4321`              | Port `serve` listens on; `--port` still wins.        |
| `DEBUG`                    | —                   | `1` logs usage, writes transcripts, full traces.     |

Model resolution per task is `JOB_TAILOR_{TASK}_MODEL` > `JOB_TAILOR_MODEL` > provider default,
so a cheap model can do extraction while a stronger one writes the letter:

```bash
JOB_TAILOR_EXTRACT_MODEL=gemini-2.5-flash JOB_TAILOR_TAILOR_MODEL=gemini-2.5-pro job-tailor run job.txt
```

## Countries

Two things about an application depend on **where the job is**, and neither can be inferred:
the salary an offer has to clear, and what you may truthfully say about your right to work
there. Both live in `data/countries.yaml`, one entry per market:

```yaml
default: DE

countries:
  DE:
    label: Germany
    currency: EUR
    salary_min: 45934
    salary_note: "EU Blue Card, shortage occupation, 2026"
    work_authorisation: >-
      Eligible for the EU Blue Card under section 18g AufenthG as an IT
      specialist, based on 4+ years of professional software experience.
  IE:
    label: Ireland
    currency: EUR
    salary_min: null        # no figure looked up yet — check disabled
    work_authorisation: ""  # nothing to say — so say nothing
```

**A null threshold disables the check. It is never read as zero.** That is the entire point of
the field being nullable: a €38,000 role in Lisbon measured against a German Blue Card figure
tells you nothing, and a missing figure silently defaulting to zero would tell you less. No
figure means no claim.

**Only `DE` ships with a real number, on purpose.** Every other threshold is `null` and every
other authorisation statement is empty. A stale immigration figure is worse than no figure —
it looks checked. Look yours up from the national immigration authority, not a blog, and type
it in. `salary_note` is where you record which rule the number came from, so whoever updates it
next year knows what they are updating.

The work-authorisation rule from phase 1.6 is unchanged, only its home moved out of
`data/profile.yaml`: an empty entry, a missing country, and a posting whose country could not
be determined all mean **the letter says nothing about visas, permits or residence status.**
See [Omission beats an inapplicable statement](#omission-beats-an-inapplicable-statement).

An unconfigured country code is allowed, not an error: it gets no threshold and no statement,
and says so once on stderr. `JOB_TAILOR_DEFAULT_COUNTRY` overrides `default`.

Currencies are compared, never converted. If a posting quotes GBP against a EUR market, the
threshold check does not run — `SALARY_CURRENCY_MISMATCH` is raised and you check by hand.
Converting at a rate the posting never stated would manufacture a number nobody can verify.

`data/candidates.yaml` is the companion list of companies worth checking, grouped by country so
one file serves several markets. It ships as a seed of ~55 European employers; edit it freely,
since being wrong about a company costs you one skimmed posting.

## Flags

Flags are recomputed in code after every response — whatever the model puts in `flags` is
discarded.

| Flag                             | Meaning                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| `LOW_MATCH`                      | `match_score < 50`.                                              |
| `NO_SPONSORSHIP`                 | Posting says visa sponsorship is not available.                  |
| `LANGUAGE_RISK`                  | Application language is neither `en` nor `pt`.                   |
| `SALARY_BELOW_THRESHOLD`         | Stated salary is below the target country's threshold.           |
| `SALARY_CURRENCY_MISMATCH`       | Salary is quoted in another currency; check it by hand.          |
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

The constants above are the contract — they are what `--json` emits, what the tracker stores and
what `reconcile()` sets. They are not what you read. `src/core/flags.ts` turns each one into a
label and a sentence saying what to do about it, and both surfaces print from that single table:
the CLI inlines it in the summary, the web UI fetches it from `/api/flags`.

```console
Flags:
  - Unbacked tech claim — The letter names a technology from the posting that no selected
    bullet and no skill in your profile backs up. Cut it, or replace it with work you have
    really done.
```

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

It is now one statement per country in `data/countries.yaml`, and the rule is asymmetric on
purpose:

```yaml
countries:
  DE:
    work_authorisation: "Eligible for the EU Blue Card under section 18g AufenthG…"
  IE:
    work_authorisation: ""   # nothing to say — so say nothing
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

### Flag, and give the model one chance to fix it

Every check that touches a factual claim raises a flag and prints the offending text to stderr.
None of them edit the letter — but when a reconciled application still carries a **blocking** flag,
the model is asked, once, to fix it, and the same checks judge the result.

This stays inside the rule that the model may not write facts unchecked. The instruction only ever
says *what to remove* — "the letter uses 'data engineering concepts' from the posting, but no
selected bullet backs that up; remove the claim" — never what to write. The rewrite comes from the
model; `reconcile()` then judges it exactly as it judged the first attempt. A repair that does not
clear the flag is **accepted and flagged**, never forced through, so the guarantee is unchanged:
nothing reaches a PDF that would not have passed on the first try.

It is deliberately **one** attempt. Each retry is another chance for the model to find wording that
slips past a keyword check without being any truer, so the budget is bounded and the repair is
announced on stderr — "asked the model to fix a factual flag; the re-check now passes" — so a
clean result is never mistaken for one that needed no correction. `JOB_TAILOR` note: pass
`maxSemanticRepairs: 0` to `tailorApplication` to turn it off entirely.

The machinery is the schema-repair loop that already existed in `callJson`, extended with a
`validate` hook that runs after the schema passes: a well-formed but wrong response is sent back
with the instruction, on a budget separate from and smaller than the schema retries. A schema
failure is fatal once exhausted; a semantic one is not.

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

### Rendering: the template holds the look, the JSON holds the facts

`render.ts` turns an application into a CV and a cover letter as A4 PDFs (handlebars for the
HTML, headless Chromium via puppeteer for the print). The split that runs through the whole
project runs through rendering too:

- **The template is the single source of visual truth.** Fonts, margins, the header block, the
  section rules — all of it lives in `templates/`, shared between both documents so a CV and a
  letter read as one set. Change the look in one place.
- **The JSON is the single source of factual truth.** The template never *decides* anything. CV
  bullets are the ones whose id is in `selected_bullet_ids`, ordered by `bullet_order`, with the
  prose taken verbatim from the profile; an experience entry with no selected bullet is dropped
  entirely, heading and all. The renderer arranges facts; it never introduces one.

**The renderer refuses to produce a document from a flagged application.** If the application
carries `UNEXPECTED_AUTHORISATION_CLAIM`, `COVER_LETTER_REF_MISMATCH`, `UNSUPPORTED_TECH_CLAIM`
or `INVALID_BULLET_IDS_DROPPED`, `renderApplication` throws `RenderBlockedError` and writes no
PDF. The reason is the difference between the two artefacts: JSON is a thing you *read*, a PDF
is a thing you *attach*, and a flagged draft one drag from an email is exactly the accident this
project exists to prevent. Fix the letter, re-render, or pass `--force`.

`--force` does render a flagged application — and stamps `DRAFT — UNVERIFIED CLAIMS` in grey on
page one of both documents, so a forced render can never be mistaken for a clean one. A
`SKIPPED_LOW_MATCH` application renders the CV and no letter: the CV is still true, the letter
was never written.

Alongside the PDFs the renderer writes the exact `cv.html` and `cover-letter.html` it printed
from. That HTML is what makes a bad document debuggable and the output testable — the tests
assert on it, never on PDF bytes, which are not stable across Chromium versions. Files a
recruiter receives are named for the candidate and company (`moreira-cv-meridian.pdf`), not
`cv.pdf`.

A cover letter that will not fit one page throws `RenderOverflowError` rather than shrinking the
type: an overflowing letter is too long, which is a content problem, not a layout one.

### Web interface

`job-tailor serve` puts a page over the same pipeline: search, generate, read, edit, mark as
applied, record what came of it.

**It binds to `127.0.0.1` and nothing else, and there is no authentication.** The bind address
*is* the boundary. The page reads your profile, your postings and your generated letters, so do
not put it behind a proxy, a tunnel or a `--host` flag — there is deliberately no option to
change the interface it listens on.

Plain HTML, CSS and vanilla JS, served as static files. No framework, no bundler, no build step
for the front end: this is a CLI with a UI attached, not a web app. Every string that reaches
the DOM goes in as `textContent` — job descriptions are third-party text and are never parsed as
HTML.

The toolbar's **language** select filters the postings already in the tracker, not only the next
search — it is the same question asked of rows you have. A posting stored before language
detection existed is backfilled from its saved text when the database is opened, because a null
language is "never asked", not "unknown", and it would otherwise be invisible to that filter.

**Generation is queued, one at a time.** It costs a model call and takes tens of seconds, so the
server serialises it and exposes what is running at `GET /api/status`; the page polls that every
two seconds rather than opening a socket, and **stops polling when nothing is running** — a quiet
server is left alone. A queued generation cannot be started twice, and the row's own button says
where it is in the queue instead of offering to add it again.

A strip above the list reports the posting being generated, which of the three steps it is on —
*Reading the posting*, *Writing the application*, *Building the PDFs* — and how long that step has
been running. **No progress bar and no percentage:** tailoring dwarfs the other two and neither is
knowable in advance, so a bar would have to invent one, and a bar stuck at 60% is worse than a
number that keeps moving. Anything waiting behind it is listed in order with a cancel button.

Cancelling applies to a posting that has not started. The one already running cannot be cancelled
— the model call is in flight, and stopping it in the UI would hide it rather than end it, so the
route returns 409 and says so. A posting merely waiting is still `new`, which is what makes
cancelling it a matter of dropping it from the queue and nothing else.

The queue lives in memory, so a server that stops mid-generation would leave rows in `generating`
— a status whose only exits belong to the run that died. Startup resets them to `failed` with
"interrupted by server restart", so nothing is stranded in a status it can never leave.

The primary manual step has a box of its own: the cover letter is editable, and saving re-runs
`reconcile()` and the renderer **without calling the model**. That matters more than convenience
— flags describe the letter on disk, and an edit is exactly when they stop being true. A claim
you remove by hand clears its flag; one you introduce raises it. Editing and re-rendering is
free and repeatable.

**The tool never submits an application.** There is no button for it and there will not be one.
The last step is always a human attaching the PDFs and pressing send.

Application state lives in SQLite at `data/tracker.db`, with `status` as an enforced state
machine:

```
new       -> generating | dismissed
generating-> generated  | failed
failed    -> generating | dismissed
generated -> applied    | dismissed | generating
applied   -> closed
dismissed -> new
closed     (terminal)
```

An illegal move fails with a sentence naming the moves that *are* available. An outcome
(`no_response`, `rejected`, `interview`, `offer`) can only be set once you have applied, because
before that there is nothing to describe.

Gaps are kept in the database for one reason: `stats()` counts the ones that come up most often
across everything generated. A gap repeated across twenty postings is a study plan, not a
rejection.

### Sources: documented APIs only

| Source           | Kind       | Credentials                     | Notes                              |
| ---------------- | ---------- | ------------------------------- | ---------------------------------- |
| `greenhouse`     | board      | none                            | Per-company board, full text.      |
| `lever`          | board      | none                            | Per-company board, full text.      |
| `ashby`          | board      | none                            | Per-company board, full text.      |
| `adzuna`         | aggregator | `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` | Descriptions are **truncated**. |
| `arbeitsagentur` | aggregator | `ARBEITSAGENTUR_API_KEY`        | German federal job board.          |

**Only documented public JSON APIs are used.** There is no scraper here for LinkedIn, Indeed,
Glassdoor or any site whose terms prohibit automated access, and there will not be one. Every
fetcher identifies itself with a descriptive User-Agent, honours `Retry-After`, backs off on 429
and 5xx, and runs under a global concurrency limit of 3.

The board sources are per-company, not search engines: you list board tokens in
`data/companies.yaml` and the keyword filtering happens client-side. The aggregators take the
query itself. `job-tailor discover` fills that token list for you — see
[Discovery](#discovery-a-verification-problem-not-a-research-one).

**Every automated posting flows through the same path as a pasted one.** A fetched posting is
converted to plain text — paragraphs as blank lines, list items as `- ` lines — with the
`Company:`/`Location:` header prepended, which is the deterministic override `companyFromHeader()`
already enforces in `extract.ts`. From there it is the identical extract → tailor → reconcile →
render pipeline, with every check intact. Automation changes where the text comes from and
nothing about what is done with it.

Two consequences worth stating:

- **A failing source is normal, not fatal.** A dead board token, a 500 from an aggregator or a
  missing credential produces a warning on stderr and an empty result set. Partial results are
  the expected case.
- **Aggregator text is truncated, and the tool says so.** Adzuna returns a shortened description;
  those postings are marked, printed with a `*`, and the CLI warns before tailoring from one,
  because a truncated posting hides requirements the letter would then be written against.

Fetched postings are cached in `data/postings.cache.json`, keyed by source id and evicted after
30 days. The cache stops a posting being fetched twice — for `arbeitsagentur`, whose search
returns metadata only, that saves a detail request per result. `--refresh` bypasses it. The same
role often appears on both a board and an aggregator; dedupe by normalised company + title +
location keeps the board copy, since its text is complete.

### Where a posting is

`search --country de` used to return Lisbon, Dublin, San Francisco, Warsaw and "US Remote". The
board sources have no country parameter at all, so the flag was quietly doing nothing to them —
and because the boards had been found with `discover --country DE`, the results *looked* filtered
by country while actually being filtered by **whose board it was**. A company headquartered in
Germany posts roles worldwide. Those are different questions.

The filter reads the posting's own `location` field, in `src/sources/location.ts`:

- **`matchesCountry`** compares against a hand-written vocabulary of each country's names and the
  cities that actually appear in postings — a board writes "Munich", never "DE". Case- and
  diacritic-insensitive, so `München`, `Munchen` and `MUNICH` are one place, and whole-token, so
  `UK` does not match `Ukraine`. Ireland explicitly excludes "Northern Ireland".
- **A null or empty location never matches.** An unstated location is not evidence of anything,
  and treating it as a match is exactly how San Francisco ends up in a German search.
- **`--remote` with `--country`** also keeps a role open to a region containing the country —
  "Remote (Europe)", "EMEA Remote", "Remote — Anywhere". A bare "US Remote" does not pass
  `--country de`. The United Kingdom is deliberately not inside `EU` or `EEA` scopes; that is a
  work-authorisation fact, not pedantry.
- **`--remote` alone** keeps anything remote. **`--location`** is unchanged: substring match.
- **A country the vocabulary does not know warns and filters nothing**, rather than silently
  returning an empty table. Extending it is a one-line edit to that file, which is the point of
  it being a plain list.

**Every source is filtered here, aggregators included.** They were exempt at first, on the
assumption that a source taking a country parameter had already answered the question. The
Bundesagentur does not: its index carries Austrian listings, and `search softwareentwickler
--country de` came back as Vienna, Linz, Graz, Innsbruck and Salzburg. A source's own filter is a
bandwidth optimisation and never a correctness guarantee. The cost of the rule is stated rather
than hidden: an aggregator row whose location is "Home Office" no longer passes a country filter,
because a match nobody can confirm is not a match.

Austria and Switzerland are in the vocabulary for the same reason — German-language postings from
all three countries are interleaved in the same feeds, so DE cannot be told from AT without
knowing what AT looks like. The German and Austrian **states** matter more than the cities: the
Bundesagentur writes every location as "Ort, Bundesland", so without all sixteen Länder a real
posting in "Burgwedel, Niedersachsen" reads as nowhere and is dropped from a German search — the
mirror image of the leak, and just as wrong.

**Ambiguity is a property of a place name, not of a location string.** A posting listing
"Berlin, Germany; Dublin, Ireland" is not ambiguous — it is open in two countries, and it matches
both. Only a single name that genuinely belongs to more than one country is ambiguous, and only
while nothing else in the string settles it: **Freiburg** is a city in Baden-Württemberg and a
canton in Switzerland, so `Freiburg` alone is withheld and counted, while `Freiburg im Breisgau,
Baden-Württemberg` is German because the state says so.

```
Filtered to Germany: 158 of 1369 postings matched.
1 named Germany alongside another country and were withheld rather than guessed at.
```

Withheld postings are counted because a silent drop looks identical to a source failing. The
count should sit near zero; if it climbs, a place name is missing from the map.

### German or English

The target market is two populations wearing one coat: international companies posting in English,
which sponsor work permits as a matter of routine, and domestic postings in German, most of which
expect fluent German. Reading one undifferentiated list is how you spend an evening on roles you
cannot apply for.

Every posting carries `language`, from `src/sources/language.ts`: count the high-frequency
function words of each language — `und`/`der`/`für` against `and`/`the`/`for` — and take the
larger, or `unknown` when there is too little prose or the two are within 20% of each other.
Function words, not content words, because a German software posting is full of "Developer",
"Cloud" and "Agile".

It is deliberately not a model call. This runs on every row of every search, and a search that
costs money is a search you stop running.

`(m/w/d)` and `(w/m/d)` — the German gender markers — are weighted at about three function words
rather than being decisive, because German employers put them in the titles of English postings
too. The tokeniser splits on Unicode letters rather than using `\b`, which is ASCII-only in
JavaScript and would silently miss `über` and `für`.

`--language de|en|unknown` (repeatable) and `--english` filter on it, there is a `LANG` column in
the table, and a country search whose results are more than 60% one language says so:

```
73 of 92 postings are in German. Use --english to see only English-language postings.
```

### Discovery: a verification problem, not a research one

The board sources are per-company: they need a token like `nory` or `stripe`, the slug in the
board URL. There is no directory of these anywhere. But the endpoints are public and cheap, and
a token either resolves to a job board or it does not — so finding tokens is **verification**,
not research. `discover` guesses slugs from the company name and asks.

Four guesses per name, in order, deduplicated:

| Rule | `N26 GmbH` | `Trade Republic` |
| ---- | ---------- | ---------------- |
| strip everything non-alphanumeric | `n26gmbh` | `traderepublic` |
| strip a legal suffix first (`gmbh`, `ag`, `se`, `bv`, `ltd`…) | `n26` | — |
| hyphenate word boundaries | `n26-gmbh` | `trade-republic` |
| first word only | — | `trade` |

`GetYourGuide` collapses to a single candidate, so it costs one request. A company stops the
moment any board answers: at most twelve requests, in practice one to three. Pin the token
yourself with a `slugs:` list on the candidate when the guesses all miss.

**A guessed slug can land on someone else's board**, which would quietly pour a stranger's jobs
into your searches. The board's own company name is the only evidence available, so any
disagreement is printed under the table — `greenhouse:intercom` reports itself as "Fin" — and
`--write` records the name *you* listed, never the board's.

**Invalid tokens are cached, and that is the point.** `data/discovery.cache.json` keeps a dead
slug for 30 days and a live board for 7; without it, every re-run re-probes hundreds of slugs
that were dead the first time. A live board expires sooner because its job counts move. Changing
your keywords is a cache miss for hits, since the counts were computed against the old ones —
stale counts would be worse than another request. A network failure is never cached: it says
nothing about the token, and one bad moment must not blacklist a real board. `--refresh` ignores
all of it.

An empty board counts as invalid. A real company with no open postings is indistinguishable from
a wrong slug, and worth nothing to `search` either way.

**These are third-party endpoints, so probing is deliberately slow.** The phase-3 User-Agent,
the same global concurrency of 3, a minimum 250ms between requests to the same board host, a
60-second stand-down for a board that answers 429, and a hard cap of 500 probes per invocation
that halts the run with a message rather than continuing quietly.

`data/candidates.yaml` is expected to be edited by hand over time — it is a list of employers
you would actually join, and it ships seeded rather than empty only so the first run has
something to do. Delete what you would never work for; add what you would.

### Whole words, and the title carries the weight

`search react native typescript` used to return "Senior CRM Strategy Manager, Reactivations" at
pre-score 100. Two separate mistakes were stacked on top of each other.

The first was substring matching: `react` is inside `reactivation`, `proactive` and `reactive`.
Keyword matching now runs on **whole tokens**, in `src/core/terms.ts` — Unicode letter/digit runs,
not `\b`, which is ASCII-only in JavaScript and would break on the German half of this market.
A multi-word keyword keeps its order-independent semantic ("mobile entwickler" finds "Entwickler
für mobile Systeme"), but every one of its words must now land on a whole token.

Technologies whose meaning lives in punctuation get an explicit table rather than a special case
at each call site: `.NET` survives inside `ASP.NET`, `C#` and `C++` stay distinct instead of both
collapsing to `c`, and `Node.js` matches text spelling it `nodejs`. The spelling aliases that
`preScore` already used are the same table, so a posting writing TypeScript as `TS` is found.

The second mistake was treating every mention as equal. A posting can name TypeScript once in a
paragraph about the engineering culture and still be an Account Executive role. So:

- a technology in the **title** counts double — it is what the role *is*;
- one only in the **body** counts single;
- and if the title names none at all, the pre-score is **capped at 40**, however much boilerplate
  the body contains.

The weighting is not a new scoring rule: title matches become `required_stack` and body-only ones
`nice_to_have`, which `preScore` already weights 2 against 1. Measured over the same 289 postings,
substring matching returned 60 and whole-token matching returns 52 — nine false positives removed,
one recovered by the alias table. It is still a crude ordering hint, still deterministic, still
free.

### A cheap filter before an expensive call

`match.ts` computes a deterministic, zero-cost pre-score from keyword overlap between the
profile and the posting — required stack weighted double, nice-to-have single, widened only by a
small table of spelling aliases (`rn` = `react native`). It is a filter, not a judgement: it
never reaches a document, and it is not the model's `match_score`. With `JOB_TAILOR_PRESCORE_MIN`
above 0, `run` skips a posting below the threshold before spending the tailoring call, printing
the matched and missing terms. It is off by default, because rejecting a posting on keyword
overlap alone is a decision to opt into.

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
├── config.ts         environment resolution + country profiles from countries.yaml
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
│   ├── match.ts      deterministic keyword pre-score, the cheap pre-filter
│   ├── terms.ts      whole-token matching, spelling aliases, C#/.NET/Node.js
│   ├── render.ts     selection + templates -> HTML -> PDF, refusal rules
│   └── slug.ts       company/role/name slugs, shared by dirs and filenames
├── sources/
│   ├── types.ts      RawPosting, SourceQuery, JobSource
│   ├── http.ts       User-Agent, 20s timeout, Retry-After, backoff, concurrency 3
│   ├── text.ts       HTML -> the plain text the extract prompt was tuned on
│   ├── location.ts   country/city/state vocabulary: where a posting actually is
│   ├── language.ts   de/en/unknown from function-word frequency, no model call
│   ├── board.ts      shared per-company-board runner
│   ├── greenhouse.ts / lever.ts / ashby.ts      company boards, full text
│   ├── adzuna.ts / arbeitsagentur.ts            aggregators
│   ├── candidates.ts companies worth checking, by country
│   ├── discover.ts   board-token probing: slug guesses, pacing, probe budget
│   ├── cache.ts      postings by sourceId + probed tokens, with eviction
│   ├── registry.ts   name -> source
│   └── index.ts      searchAll(), fetchPosting(), dedupe, pre-scoring
├── tracker/
│   ├── store.ts      SQLite, the status state machine, stats()
│   └── schema.sql
└── server/
    ├── index.ts      fastify app, loopback bind, empty-body JSON parser
    ├── pipeline.ts   generate / re-render orchestration behind one seam
    ├── queue.ts      one generation at a time
    ├── routes.ts     the API, including path-traversal-safe file serving
    └── public/       index.html, app.js, style.css — no framework, no build

templates/            the single source of visual truth
├── base-styles.hbs   fonts, margins, header block — shared by both documents
├── cv.hbs
└── cover-letter.hbs

data/                 everything you edit by hand
├── profile.yaml      your CV as tagged bullets (gitignored; .example is the template)
├── countries.yaml    per-market salary threshold + work-authorisation statement
├── candidates.yaml   companies worth checking, grouped by country
└── companies.yaml    board tokens `search` fetches
```

Every phase is now implemented; nothing throws `NotImplemented`.

## Tests

```bash
npm test          # tsc, then vitest
npm run test:watch
```

390 tests. All but one make no network call and drive no browser. They cover the zod schemas
against valid and malformed fixtures, the `callJson` retry loop against mocked SDKs, provider and
per-task model resolution, the `ConfigError` for each provider's missing key, Gemini's backoff
and quota handling, the JSON Schema conversion, the `DEBUG=1` transcript (written when set,
absent when not), `data/profile.example.yaml` against the `Profile` schema, the reconciliation
rules, per-country work authorisation, the cover-letter reference/length/paragraph checks,
unsupported technology claims, the `Company:` header override, and the low-match short-circuit.

The country profiles have their own suite: that a null threshold never fires
`SALARY_BELOW_THRESHOLD` and is never read as zero, that Germany's fires at €45,933 and not at
€45,934, that a GBP salary raises `SALARY_CURRENCY_MISMATCH` instead of being converted, that an
unconfigured code warns exactly once and does not throw, that a `data/profile.yaml` still
carrying `basics.work_authorisation` fails with a message naming the new location, and that both
`countries.yaml` and `candidates.yaml` parse against their schemas.

The tracker and the server are tested with an in-memory database and `fastify.inject()`: every
legal status transition and every illegal one, that an outcome is refused before you have
applied, the list ordering, that the file route rejects `../` and absolute paths, that saving an
edited letter re-renders **without** the model being called, that the generation queue
serialises, and that gap frequency aggregates correctly.

Term matching has its own suite: that "react" is not found in "Reactivation", "proactive" or
"reactive" but is found in "react-native", that `.NET` survives inside `ASP.NET` and `C#` never
matches `C++`, that `Node.js` matches text spelling it `nodejs`, that a body-only posting is
capped at 40, and that a title match outscores the same term in the body.

Location and language filtering have their own suite: the country vocabulary against cities,
states, diacritics, case and whole-token boundaries, that a null location never matches, that
`--country de --remote` keeps "Remote Europe" and rejects "US Remote", that "Wien, Landstraße"
and "Zürich" do not pass a German filter while every Bundesland does, that a posting listing
Berlin and Dublin matches both while a bare "Freiburg" is withheld and counted, that aggregators
are country-filtered like everything else, and that language detection separates a German posting from an English one without
`(m/w/d)` alone deciding it.

Discovery is tested with a stubbed fetch and no live call: slug generation for each rule, that a
404 is not retried, that keyword counting is right, that a company stops at its first hit, that
the negative cache prevents a re-probe and `--refresh` overrides it, that a transport failure is
never cached, that the probe cap halts the run with one message, and that `--write` appends to
`companies.yaml` without disturbing existing entries or comments.

The sources are tested against fixtures recorded from the real APIs, with no live call in the
suite: each source parses into well-formed postings, HTML becomes the expected plain-text shape,
the `Company:` header survives into `companyFromHeader()`, cross-source dedupe keeps the board
copy, a cached posting is not refetched, a failing source warns without aborting the search, the
backoff retries a 429 and honours `Retry-After`, and Adzuna is skipped with a readable message
when its credentials are absent.

Rendering is tested on its HTML, never on PDF bytes: the refusal for every blocking flag, the
`--force` watermark, that only selected bullets appear and in `bullet_order`, that an entry with
no selected bullets vanishes, the skipped-low-match CV-only path, the omitted recipient block,
and paragraph splitting. The pre-score has its own suite for weighting, aliases and the
no-fuzzy-match rule. One integration test drives real Chromium and asserts only that a >1KB PDF
lands on disk; it skips when `JOB_TAILOR_SKIP_PDF=1`, which CI sets so the suite needs no
browser.

`npm test` runs `tsc` first, so a type error fails the suite.

## Roadmap

| Phase | Scope                                                       | Status |
| ----- | ----------------------------------------------------------- | ------ |
| 1     | extract + tailor + CLI + profile + tests                    | Done   |
| 1.5   | multi-provider LLM layer (Gemini default, Anthropic opt-in) | Done   |
| 1.6   | corrections from the first real run, low-match short-circuit | Done  |
| 1.7   | cover-letter quality fixes from the second real run         | Done   |
| 2     | keyword pre-filter, CV/letter PDF rendering with refusal rules | Done |
| 3     | job-board ingestion from documented public APIs             | Done   |
| 3.5   | board-token discovery by probing public endpoints           | Done   |
| 4     | local web UI + SQLite application tracking                  | Done   |
| 3.6   | country profiles: per-market salary threshold + authorisation | Done |
| 3.7   | location filtering: `search --country` reads the posting, not the company | Done |
| 3.8   | DACH disambiguation, posting language, multi-word keyword matching | Done |
| 3.9   | whole-token keywords, title weighting, multi-location postings | Done |

## License

MIT — see [LICENSE](LICENSE).
