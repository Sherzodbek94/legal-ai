# Outstanding work

- **Compiled:** 2026-08-06
- **Against:** `master` @ `bc97920`
- **Companion to:** [`prd.md`](./prd.md) (what the product is), [`../CLAUDE.md`](../CLAUDE.md) (how the code works)

Every figure here was measured, not estimated. Where something is unverified it
says so.

---

## 1. Where things actually stand

| | Measured |
| --- | --- |
| API tests | 1,410 across 67 suites |
| API statement coverage | 55.9% |
| Web tests | 133 across 7 suites |
| Web components with a test | 3 of 48 |
| Pages | 22 |
| UI primitives | 14 |
| Published templates | 7, five of them heavy |

Green: typecheck, ESLint, `next build`, both test suites.

**CI has never been observed running.** The workflow triggered on `main`, a
branch this repository does not have, so every push since the beginning ran no
jobs at all. That was fixed in `f0d06f4` — but nobody has yet opened the Actions
tab to confirm a run appeared. Until someone does, "CI is green" is an
assumption, not a fact.

---

## 2. Blocked on a decision or an external party

Nothing here is an engineering problem. Each one gates work that cannot start
without it.

### 2.1 Legislation corpus content — blocks the most

`data/legal-corpus/` is set up, wired, and verified working: a search for
*"mehnat shartnomasi muddati"* returns article 11 first, article-labelled. What
is in there is fragments — Civil Code articles 346–348, Labour Code articles 10
and 11. Five articles in total.

Two things unlock the moment the real text lands:

- **The legal chat starts citing.** Right now it answers from the model's own
  recollection of Uzbek law, which is exactly what the corpus exists to replace.
- **Six form defaults become answerable.** `weekly_working_hours`,
  `weekly_rest_days`, `annual_leave_days`, `termination_notice_days`,
  `work_start_time` / `work_end_time`, `probation_period_months`. These are
  statutory figures that end up in signed employment contracts; they should be
  read out of the Code with the article recorded beside them, not guessed. One
  field has already been done this way — `contract_duration_type`, grounded in
  article 11 — and it is the pattern for the rest.

See the directory's README for the format and the rule about where text may
lawfully come from.

### 2.2 Alfa Nom — the long pole

Operator approval for a branded SMS sender takes **1–2 months**. Nothing in the
code waits on it (sign-in codes go out under DevSMS's own approved sender), but
a launch date does. Max 11 characters, Latin only, no spaces.

### 2.3 DevSMS balance

200.00 UZS at 200.00 per message — **one SMS left**. When it runs out, phone
sign-in stops. The code logs at `error` once the balance can no longer cover
another message; nothing else notices.

### 2.4 Uzum payment contract

Uzum issues its integration contract per merchant. The signature base string in
`UzumService` implements their published checkout shape and **must be reconciled
against the contract issued for this merchant before go-live**. The tests added
in `a4b3bd4` pin what the code does, not what the contract says — they will keep
passing if the two disagree.

### 2.5 Data residency

PRD open question 3, and the only one still open. The stack can be self-hosted
end to end, but the AI providers are not in country and **every draft leaves the
jurisdiction**. PII redaction narrows what leaves; it does not change where the
text goes. This constrains hosting and needs an answer before the first
enterprise conversation.

### 2.6 Repository visibility

Confirm `github.com/Sherzodbek94/legal-ai` is private. Only the account owner
can see this. The code contains no secrets, but it does contain the payment and
OneID integration logic.

---

## 3. Engineering backlog

Ordered by what it costs to leave alone.

### P0 — failures a user has already hit

**3.1 ~~Validation errors never reach the form.~~ Checked — they do.**
An earlier revision of this document listed this as the worst outstanding bug,
on the strength of two `POST /api/documents → 422` lines in the log of a real
session that ended with a stuck "Generating…" button. That was an inference from
a log, not a finding, and it was wrong.

Tested against the running API: a create with missing variables returns 422
carrying eighteen issues, every one of them shaped `{key, message}`, and every
one passing the filter in `readErrorBody` that feeds `fieldErrors`. The chain —
`UnprocessableEntityException` → `AllExceptionsFilter` nesting →
`readErrorBody` unwrapping → server action → `state.fieldErrors[key]` — is
intact end to end.

What those two log lines actually show is the flow working: a drafter submitted,
saw the fields marked, filled them in, submitted again, saw the remainder,
filled those, and the third attempt got through to the AI — where it hung on the
missing client timeout, which was the real bug and is fixed in `e9c5347`.

Left in rather than deleted, because "we already looked at this" is worth more
than a shorter document.

**3.2 Generation is synchronous.** *(designed below, not started)*
`GeneratedDocumentStatus.GENERATING` exists in the schema and nothing sets it.
The browser holds an HTTP request open for the entire AI call — which is why an
absent client timeout could freeze the button for half an hour. `e9c5347` bounds
that wait at four minutes, which is a floor under the symptom, not a fix. The
designed shape is already in the schema: create the document `GENERATING`,
return immediately, generate on a worker, update status, push over the existing
Socket.IO gateway. The notification queues and the gateway are both already
built.

#### 3.2 in detail — read this before starting

Three things make it more than "move the call to a worker", and all three are
currently load-bearing in the synchronous path.

**Quota is reserved before the call and released on failure.** `buildWithAi`
reserves `AI_GENERATIONS`, and on a provider outage releases it again with the
comment that an outage must not cost the customer a generation. Move the call to
a worker and the reservation has to travel with the job: reserve at enqueue (so
the refusal is immediate and the queue cannot be used to exceed a plan), release
in the processor's failure path, and release on a job that exhausts its retries
and dies — the last of which has no equivalent today.

**Failure currently falls back to the plain template.** The route throws, the
web action shows a message, and the drafter can retry with AI off. Once the
document row exists as `GENERATING`, "throw" is no longer available: the
processor has to decide between marking it `FAILED` and writing the interpolated
template body instead. The second is closer to the current behaviour and leaves
the drafter with something usable; it should say in the document which happened.

**`FAILED` has no route back.** The status exists and `document-edit.service`
treats `GENERATING` as locked. A document stuck in either state with no retry
action is a dead row in a customer's list. Whatever the processor writes, the
UI needs a way out.

The shape, once those are settled:

```
create(useAi)  reserve → persist GENERATING → enqueue → return 202 + id
processor      generate → update GENERATED | FAILED | template-fallback
               → release reservation on failure
               → gateway.pushToUser(document.status_changed)
web            detail page subscribes while GENERATING; badge already renders
```

The queue infrastructure is already there — `QUEUE_NAMES`, `DEFAULT_JOB_OPTIONS`
and a `BaseNotificationProcessor` worth copying — but it is per notification
channel, so this needs a fourth queue rather than reusing one. The Socket.IO
gateway and `pushToUser` already exist and need no changes.

**Do not land the API half alone.** Returning `GENERATING` to a web app that
does not subscribe leaves the drafter on a document page that says "generating"
forever until they reload by hand — worse than today's four-minute bound, which
at least resolves by itself.

### P1 — untested code that decides something important

Coverage is 55.9% overall; these are the largest holes, with uncovered statement
counts.

| File | Uncovered | What it decides |
| --- | ---: | --- |
| `template/services/taxonomy.service.ts` | 146 | Which category tree a template lives in |
| `template/services/template-version.service.ts` | 97 | What every future document is generated from |
| `template/services/template.service.ts` | 78 | Template CRUD and tenant scoping |
| `admin/admin.controller.ts` | 75 | Cross-tenant operator endpoints |
| `admin/moderation/moderation.service.ts` | 69 | Account locking |
| `payment/providers/stripe/stripe.service.ts` | 65 | One of four money paths |
| `chat/chat.service.ts` | 61 | The cited-answer path |
| `admin/impersonation/impersonation.service.ts` | 57 | Operators acting as customers |
| `document/generator/document-export.service.ts` | 54 | PDF/DOCX with the verification QR |

The template services are the sharpest of these: publishing decides what every
future document is built from, and nothing tests it.

### P2 — the web app

**3.3 Forty-five of forty-eight components have no test.** The three that do —
`PhoneSignIn`, `CounterpartyLookup`, `GenerateForm` — were chosen because their
failures are total rather than cosmetic. The same standard picks the next few:
`template-builder`, `document-editor`, `plan-picker`, `team-manager`.

**3.4 Empty, loading and error states.** Four of twenty-two pages mention an
empty state. A legal workspace is empty on day one for every customer, and a
first impression of a blank table is a support ticket.

**3.5 The remaining template forms.** After the profile-prefill work in
`b0d146f`, the visible field counts are: services 28, lease 25, employment 21,
dismissal order 17, power of attorney 13. Employment is now the model — an enum
where the answer is enumerable, a default where the law supplies one, collapsed
where the profile already knows. The other four have had none of that applied.

---

## 4. Design brief

The application is competent and generic. It reads as an internal tool, which
is the wrong register for a product that produces documents people sign. What
follows is what would change that, in the order it pays off.

### 4.1 What is already right — do not redesign it

- **Document output typography.** PDF and DOCX both set real page rules: Times
  New Roman at 11.5pt, `@page` margins, monospace for reference codes. The thing
  a customer actually hands to a bank is already typeset like a legal document.
- **Motion.** Five keyframes total, entrances at 180–220ms with travel of 6px or
  less, every one removed rather than shortened under `prefers-reduced-motion`.
  That is a finished system; adding to it needs a reason.
- **The primitive set.** Fourteen components, consistent, dark-mode aware.

### 4.2 Identity — the actual gap

There is no visual identity. Generic sans, slate-and-navy, a scales glyph. For a
product asking Uzbek law firms to trust it with signed contracts, that reads as
unfinished rather than neutral.

What to decide, in this order:

1. **Wordmark.** "LegalTech AI" is a category, not a name. Whatever the product
   is called needs a Latin wordmark that also survives beside Cyrillic.
2. **One accent, used sparingly.** The current palette has no colour that means
   anything. An accent that appears only on the primary action and on
   "completed" would carry more than a full palette.
3. **Register.** The screenshots read Silicon Valley. The competition is Word
   documents and stamped paper. Something closer to the second — more paper,
   more type, less card — would be more credible to the buyer, not less modern.

### 4.3 Typography for two scripts

Every document surface renders Uzbek Latin, Uzbek Cyrillic and Russian, often on
the same page. The current stack does not name a font with proper Cyrillic
coverage, so Cyrillic falls back to whatever the OS supplies and the two scripts
sit at visibly different weights. Pick one family that covers both properly and
set it everywhere, including the PDF template.

### 4.4 The form problem, visually

The engineering half is done — prefilled fields collapse, enums replace free
text. The visual half is not:

- **Grouping.** Twenty-one fields in one flat column is a wall regardless of how
  many are hidden. They fall into obvious sections — the parties, the role, the
  money, the schedule — and are not sectioned.
- **The disclosure reads as risk.** "Already filled in — 8 fields" is honest but
  invites a click. Showing the values inline, small and greyed, would let a
  drafter confirm at a glance instead of opening it.
- **Field rhythm.** Every field is the same width regardless of content. A
  five-digit MFO and a full legal address should not occupy the same box.

### 4.5 ~~Empty and error states~~ Checked — already done

An earlier revision claimed eighteen pages had no designed empty state, and
ranked fixing them first. That came from one grep for the words "no results" and
"empty", which is not how this codebase writes them.

Audited properly: **31 empty states across twelve pages and three components**,
via a shared `EmptyState` and a `TableEmpty` for tables. They already meet the
standard that revision asked for — a line saying what goes there and how to put
something there:

> "No documents yet. Pick a published template to generate one."
> "Nothing uploaded yet. Add a scan above to make it searchable."

The ten files with no empty branch are collections that cannot be empty — the
sidebar, the plan catalogue, the notification event list — or primitives. Both
revenue charts handle zero too, through `total === 0` and `!anyMovement` rather
than a length check, which is why the grep missed them.

Nothing to do here.

---

## 5. Suggested order

1. **P1 template services** — publishing decides what every document is built
   from and nothing tests it. Measured from coverage, not inferred.
2. **3.2** — asynchronous generation. Verified: `GENERATING` appears twice in
   the codebase, once as a locked status and once in a comment. Nothing sets
   it. The timeout fix is a floor under the symptom, not a fix.
3. **3.5** — the other four template forms, applying the employment pattern.
4. **3.3** — the next few components, chosen the way the first three were.
5. **4.2 / 4.3** — identity and typography, once someone has decided what the
   product is called.

### A note on this document's reliability

Two of its original items — 3.1 and 4.5 — were wrong, and both in the same way:
a grep was read as a finding. 3.1 inferred a broken error path from two log
lines; 4.5 inferred missing empty states from a search for wording this codebase
does not use. Both were ranked first at the time of writing.

Everything now above the line was measured against the running system or read
out of `coverage-summary.json`. The design section (4) is the weakest part of
this document — 4.5 was in it — and its remaining claims are judgements about
register and identity rather than counts, so treat them as opinions to argue
with rather than findings to action.

With 3.1 and 4.5 struck, there is no known user-visible defect still open.

Items in section 2 run in parallel and are not on this critical path, except the
corpus, which blocks the six defaults.
