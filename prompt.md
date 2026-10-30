# Vuelitos Hotels: Backend Design and Frontend API Guide

Harshil, 29 Oct 2026. Source: Vuelitos Hotels System Map (spec draft 2026-10-07, commit 212aafd).

## How this doc is organised

**Part 1** is the backend design. It follows the system map in order (customer journey, pricing engine, booking lifecycle, staff and admin, exchange rates, tarifario import, platform, security) and says how each point is built. **Part 2** is the API guide for the frontend: conventions, every endpoint with request and response shapes, error codes, and which screen calls what. Where the map left a question open I picked a default and flagged it, so you can change it.

# PART 1: Backend design

## 1.1 Goals and assumptions

- One standalone service on your stack: **Express 5 + TypeScript, Prisma, PostgreSQL, Redis, BullMQ**. It replaces the Next.js route handlers from the spec. Web and React Native only talk to it over HTTP.
- **Request first, pay after.** Nothing is charged until the hotel confirms. Availability is manual (staff ask the hotel), so there is no live-inventory dependency.
- **Every price is computed on the server** by pure functions. The client never sends or computes a price.
- Public API lives under `/api/v1`, English snake\_case. Customer-facing text (status labels, descriptions) is localised by the server (`es`, `en`).
- Staff use cookie sessions. Customers use a per-booking access token. There are no customer accounts in v1.
- Money is exact: `Decimal` in Postgres, a rational type in code, rounded half-up to cents once at the end.
- Assumptions: the database is PostgreSQL through Prisma (the schema relies on Postgres features: partial and NULLS NOT DISTINCT indexes, sequences, triggers, advisory locks, array columns), hotel images live on your own file server (see 1.8a), Express 5 forwards errors from async handlers on its own, and this is a clean backend. The Supabase and Vercel rollback switches (`DATA_BACKEND`, `AUTH_BACKEND`, `STORAGE_BACKEND`) and the legacy `/api/public/*` shape are not carried over.

## 1.2 Decisions on the 12 open questions

| # | Question | Default decision |
| --- | --- | --- |
| 1 | Live availability | Keep `availability_mode = manual`. Model it as an enum on hotel (`manual`, `api`) behind an `AvailabilityProvider` interface so a supplier API can be plugged in later. `pay_first` stays off until a hotel is in `api` mode. |
| 2 | Stripe | Phase 2 behind `FEATURE_STRIPE`. Stripe Checkout Sessions, a webhook route with signature check and an idempotent event table, keys only in env. Surcharge comes from the hotel payment rule (default 0). |
| 3 | Mobile contract | Web and mobile use `/api/v1` only. Additive changes stay in v1; breaking changes go to `/api/v2` with a 6 month overlap. Search has cursor pagination from day one. |
| 4 | Children and supplements | v1 prices children as full guests (same as the spec). `child_ages` are stored on booking items. Child-band pricing (NINO, PAX\_ADICIONAL) is built behind `PRICING_CHILD_BANDS` and enabled per hotel after golden tests. |
| 5 | Engine edge cases | Fixed in the new engine and covered by golden tests: `pickRate` honours `max_nights`, undated Desde uses the same multi-room split as dated, catalog and detail rank by the same key (USDT, then base). |
| 6 | Group threshold | The server owns it. `GROUP_MIN_ROOMS = 5`, `GROUP_MIN_GUESTS = 12` live in config. Price returns `group_request: true` instead of totals, and `POST /bookings` rejects with `422 GROUP_REQUEST_REQUIRED`. |
| 7 | Observability | pino JSON logs with request id, Sentry for errors, Prometheus `/metrics`. Alerts on SLA breaches, rate feed older than 24 h, 5xx rate and p95 latency. |
| 8 | Scheduled jobs | BullMQ repeatable jobs: `expire_payment_window` (default 48 h, `PAYMENT_WINDOW_HOURS`, a business decision), SLA-breach alert, rate feeds. Rate limits live in Redis with a TTL, so nothing needs pruning. |
| 9 | CI coverage | CI runs unit, integration (Postgres and Redis service containers) and the booking e2e before the image is pushed. Parity and leak scans run on main. |
| 10 | Migrations | Gated release job: backup, `prisma migrate deploy`, then deploy the image. Expand-then-contract, so an image rollback never needs a schema rollback. |
| 11 | Decommission | Not applicable (see assumptions). |
| 12 | Scaling | Stateless containers. Limiter, catalog cache and sessions are in Redis, jobs run in a separate worker process, so you can run N API containers. |

## 1.3 Architecture

```
Web / React Native
      |
Cloudflare Tunnel  (Cloudflare Access on /admin)
      |
API (Express) ------ Redis (cache, rate limit, sessions, BullMQ)
      |                  |
PostgreSQL <-------- Worker (BullMQ: rate feeds, expiry, SLA alerts, imports)
      |
Own file server (hotel images)
```

Layering: **route** (zod schema in and out) then **service** (business rules, transactions) then **repo** (Prisma). The pricing engine imports nothing from Prisma or Express, so it is testable with plain objects.

```
src/
  app.ts  server.ts  worker.ts
  config/env.ts                 zod-validated env
  middleware/                   auth, rate-limit, validate, upload, errors, security
  modules/
    catalog/                    search, detail, destinations (+ Redis cache)
    pricing/                    PURE: window, split, season, pick-rate, calculate, payment-methods, money
    bookings/                   routes, service, state-machine, sla, access-token, code, public-view
    payments/                   report payment, (phase 2) stripe
    availability/               checks + provider interface
    rates/                      sources/{bcv,binance}, compose, latest, staleness
    tarifario/                  schema, readers, match, diff, import, catalog-fixes
    quotes/  leads/  files/       files: FileStorage interface + own file server drivers
    admin/                      auth, users, hotels, rooms, seasons, rates, images, settings
  jobs/                         queues, workers, schedules
  cli/                          create-admin, rates-fetch, tarifario-import, catalog-fixes
  lib/                          errors, caracas-time, ids, prisma, redis
prisma/  schema.prisma  migrations/
test/    unit  golden  integration  e2e  parity  leak
```

## 1.4 Data model (Prisma, condensed)

Drop `season_ranges`: the engine never read it (one `Season` row per range). Field names follow the spec; verify enum values against your real tarifario data before the first migration.

```prisma
enum BookingStatus { requested checking_availability awaiting_payment payment_submitted payment_verified confirmed alternatives_offered unavailable cancelled refund_pending refunded }
enum PaymentMethod { stripe_card pago_movil bs_transfer zelle usdt_binance cash_usd cash_eur }
enum RateConcept   { OCUPACION NINO PAX_ADICIONAL }
enum PriceKind     { IMPORTE BAJO_PEDIDO GRATIS PORCENTAJE_ADULTO }
enum Role          { agent admin super_admin }

model Hotel {
  id String @id @default(uuid())
  slug String @unique
  name String
  destination String
  category String
  starRating Int?
  baseCurrency Currency            // USD | EUR
  isSoloDivisas Boolean
  defaultCommissionPercent Decimal @db.Decimal(5,2)
  availabilityMode AvailabilityMode // manual | api
  isActive Boolean
  rooms RoomType[]  seasons Season[]  images HotelImage[]  paymentRules HotelPaymentTaxRule[]
  @@index([destination, isActive])
}
model RoomType { id String @id @default(uuid()) hotelId String hotel Hotel @relation(fields: [hotelId], references: [id]) name String maxOccupancy Int isActive Boolean rates Rate[] }
model Season {
  id String @id @default(uuid())
  hotelId String  hotel Hotel @relation(fields: [hotelId], references: [id])
  name String  priority Int            // 1 base, 2 promo on top, 3 sell-until promos
  dateFrom DateTime @db.Date  dateTo DateTime @db.Date   // dateTo inclusive = last covered night
  bookingFrom DateTime? @db.Date  bookingTo DateTime? @db.Date
  isActive Boolean
  rates Rate[]
}
model Rate {
  id String @id @default(uuid())
  roomTypeId String  seasonId String
  mealPlan String  concept RateConcept?  priceKind PriceKind
  occupancy Int?  pricingUnit PricingUnit      // per_room | per_person
  netRate Decimal @db.Decimal(12,2)  markupPercent Decimal?  sellRate Decimal?   // admin-only columns
  percentOfAdult Decimal?  childAgeMin Int?  childAgeMax Int?
  daysOfWeek Int[]  minNights Int  maxNights Int?  packageNights Int?  sourcePage Int?
  isActive Boolean
}
model ExchangeRate { id BigInt @id @default(autoincrement()) bcvUsd Decimal bcvEur Decimal binanceUsdt Decimal bcvUsdSource String bcvEurSource String usdtSource String recordedAt DateTime fetchedAt DateTime bcvValueDate DateTime @db.Date source RateSource isManualOverride Boolean @@index([recordedAt]) }
model BcvPublishedRate { valueDate DateTime @id @db.Date usd Decimal eur Decimal publishedAt DateTime }
model HotelPaymentTaxRule { hotelId String method PaymentMethod ivaRate Decimal surchargePercent Decimal? @@id([hotelId, method]) }
model Booking {
  id String @id @default(uuid())
  code String @unique                       // VH-YYYY-NNNNNN
  status BookingStatus
  accessKey String @db.Uuid                 // first 128 bits of SHA-256(token)
  locale String  contactName String  contactEmail String  contactPhone String?  notes String?
  paymentMethodPref PaymentMethod?  termsAcceptedAt DateTime
  totalsByMethod Json  fxSnapshot Json      // frozen at request time
  slaDueAt DateTime?  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
  items BookingItem[]  events BookingEvent[]  payments Payment[]
  @@index([slaDueAt], map: bookings_sla_due_at_idx)   // make it partial in raw SQL: status IN (requested, checking_availability)
}
model BookingItem { id String @id @default(uuid()) bookingId String type String hotelId String checkIn DateTime @db.Date checkOut DateTime @db.Date mealPlan String roomSelections Json priceSnapshot Json }
model BookingEvent { id BigInt @id @default(autoincrement()) bookingId String event String fromStatus BookingStatus? toStatus BookingStatus actorType String actorId String? note String? createdAt DateTime @default(now()) }
model Payment { id String @id @default(uuid()) bookingId String method PaymentMethod currency String amountQuoted Decimal reference String status PaymentStatus submittedAt DateTime verifiedAt DateTime? verifiedBy String? }
model AvailabilityCheck { id String @id @default(uuid()) bookingId String? hotelId String checkIn DateTime @db.Date checkOut DateTime @db.Date status CheckStatus checkedBy String? checkedAt DateTime? note String? }
model HotelImage { id String @id @default(uuid()) hotelId String key String sourceUrl String? sourceKind String? status ImageStatus sortOrder Int }   // held | published
model Quote { id String @id @default(uuid()) code String @unique tokenKey String @db.Uuid status QuoteStatus lines Json commissionPercent Decimal commissionAmount Decimal internalNotes String? expiresAt DateTime }
model Lead { id String @id @default(uuid()) name String email String phone String? message String? createdAt DateTime @default(now()) }
model StaffUser { id String @id @default(uuid()) email String @unique passwordHash String role Role sessions Session[] }
model Session { id String @id tokenHash String @unique userId String expiresAt DateTime lastSeenAt DateTime userAgent String? }
model Holiday { date DateTime @id @db.Date name String }
```

Raw SQL in the first migration (Prisma cannot express these):

```sql
CREATE SEQUENCE booking_code_seq;
CREATE UNIQUE INDEX rates_unica_por_ocupacion ON rates (room_type_id, season_id, meal_plan, occupancy, concept, price_kind, days_of_week, min_nights, child_age_min, child_age_max) NULLS NOT DISTINCT WHERE is_active;
CREATE FUNCTION booking_events_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'booking_events is append-only' USING ERRCODE = 'restrict_violation'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER booking_events_no_change BEFORE UPDATE OR DELETE ON booking_events FOR EACH ROW EXECUTE FUNCTION booking_events_immutable();
CREATE TRIGGER booking_events_no_truncate BEFORE TRUNCATE ON booking_events FOR EACH STATEMENT EXECUTE FUNCTION booking_events_immutable();
CREATE INDEX bookings_sla_due_at_idx ON bookings (sla_due_at) WHERE status IN ('requested','checking_availability');
```

Rules: child foreign keys are `ON DELETE RESTRICT`, bookings are never hard-deleted, rates are deactivated and never deleted, and these columns never leave the service in a public response: `net_rate`, `markup_percent`, `sell_rate`, `commission_*`, `internal_notes`.

## 1.5 Pricing engine (`modules/pricing`, pure functions)

Pipeline: `parseStayWindow` then `effectiveRooms` then `splitGuests` then `resolveStayPrice` (seasons, `pickRate`) then `calculatePricing` then `priceByPaymentMethod`. The same pipeline feeds catalog cards, hotel detail, the checkout price call, booking totals and quote lines.

```ts
export const splitGuests = (pax: number, rooms: number): number[] => {
  const n = Math.min(rooms, pax)                 // never an empty room
  const base = Math.floor(pax / n)
  return Array.from({ length: n }, (_, i) => base + (i < pax % n ? 1 : 0))
}                                                // (5,2) -> [3,2]   (2,3) -> [1,1]

export const effectiveRooms = (rooms: number, pax: number, maxOcc: number) =>
  Math.min(pax, Math.max(rooms, Math.ceil(pax / maxOcc)))

export function pickRate(rates: Rate[], night: Date, guests: number, stayNights: number) {
  const ok = rates.filter(r =>
    (r.concept === 'OCUPACION' || r.concept === null) && r.priceKind === 'IMPORTE' &&
    (r.occupancy === null || r.occupancy === guests) &&
    (!r.daysOfWeek.length || r.daysOfWeek.includes(night.getUTCDay())) &&
    (r.maxNights === null || stayNights <= r.maxNights))          // new vs legacy (Q5)
  const sellable = ok.filter(r => r.minNights <= stayNights)      // total stay length, not segment length
  if (!sellable.length)
    return ok.length ? { error: 'min_nights', required: Math.min(...ok.map(r => r.minNights)) } : { error: 'no_rate' }
  sellable.sort((a, b) =>
    Number(b.daysOfWeek.length > 0) - Number(a.daysOfWeek.length > 0) ||   // day-specific first
    b.minNights - a.minNights || a.netRate.cmp(b.netRate))                  // then longer min, then cheaper
  return { rate: sellable[0] }
}
```

**Season resolution** (`resolveStayPrice`):

1. Stay window is `[check_in, check_out)`, 1 to 60 nights, priced night by night. Invalid window: undated mode on search, `422` on price and booking.
2. Drop seasons whose booking window is closed on the booking date (the Caracas wall date). Order the rest by priority desc, later `dateFrom`, then id.
3. For each night take the first covering season that has an applicable rate. A covering season with no rate does not veto the night.
4. No season can price a night: `no_rate`, or `min_nights` (with `min_nights_required`) when a rate exists but the stay is too short.
5. Regroup consecutive nights on the same rate row and price each run once.
6. Multi-room: `splitGuests`, price each room at its own occupancy with `rooms = 1`, sum. If any room cannot be priced the whole request is unavailable. One room short-circuits to the single-room path.

**Gross price** (`calculatePricing`):

```
base  = net_rate x nights x (per_room ? 1 : guests_in_room)      // hotel currency
bs    = base x BCV(base_currency) x (1 + iva_bs)                  // none for solo-divisas
usdt  = bs / binance_usdt                                         // solo-divisas: usdt = base 1:1, no bs, no iva
```

Commission is deducted from the commissionable fare, never added, and stays internal. Keep intermediates as exact rationals (`BigInt` numerator and denominator in `money.ts`) and round half-up to cents once.

**Per payment method** (`priceByPaymentMethod`): one row per method the hotel offers. A missing payment rule row means the method is not offered. Solo-divisas hotels get no VES rows.

| Method | Currency | Amount |
| --- | --- | --- |
| `pago_movil`, `bs_transfer` | VES | `base x BCV(base)`, then x (1 + iva) |
| `zelle`, `cash_usd`, `cash_eur` | USD or EUR | `base` if same currency, else `base x BCV(base) / BCV(target)`, then x (1 + iva) |
| `stripe_card` | USD | as above plus optional surcharge (default 0). Phase 2 |
| `usdt_binance` | USDT | `base x BCV(base) x (1 + iva_pago_movil) / binance`. Solo-divisas: `base` 1:1 |

The row with the lowest USD-equivalent (VES via BCV USD, EUR via BCV cross, USDT as USD) gets `is_lowest: true`. It is a neutral tag only: the API never ranks, recommends or preselects a method.

Every pricing change needs golden tests and the parity run. Outside production, `PRICING_NOW` pins the booking date and is ignored when `NODE_ENV=production`.

## 1.6 Customer journey: how each step is served

| Step | Endpoint | What the server does |
| --- | --- | --- |
| Search and catalog | `GET /hotels` | Parse and clamp params (nights 1 to 60, adults 1 to 20 default 2, children 0 to 20, rooms 1 to 10, dates both or neither). Per hotel: `rooms_quoted = effectiveRooms(...)`. Undated: cheapest active room-price row matching the party. Dated: cheapest option by USDT, else base. Cursor pagination. Cached in Redis under a `catalog` version key that every admin write bumps. |
| Hotel detail | `GET /hotels/:slug` | Rooms matrix, seasonal rates, `stay.options[]` priced server-side, availability notice, group-request block. Unknown slug is `404`. |
| Checkout price | `POST /hotels/:slug/price` | Read-only, never writes. Returns per-room prices and `methods[]`. Union on `priced`. |
| Create request | `POST /bookings` | Rate limit, validation, honeypot, server re-pricing, one transaction (see 1.7), `201` with code and token. |
| Status page | `GET /bookings/:code` | Token check, allow-listed public view, `no-store`. |
| Report payment | `POST /bookings/:code/payments` | Stores a submitted payment with the amount quoted for that method, moves to `payment_submitted`. |
| Cancel | `POST /bookings/:code/cancel` | Transition via the state machine, `409` if not allowed. |
| Exchange info | `GET /exchange-rates` | Latest effective rates plus the `stale` flag. |
| Leads | `POST /leads` | 10 per 10 min per IP. |

## 1.7 Booking lifecycle, SLA and access token

**State machine.** `bookings/state-machine.ts` is the only place the rules live. `transition(booking, event, actor)` is pure and returns the next status plus the `booking_events` row. The service applies it with a compare-and-set inside one transaction:

```sql
UPDATE bookings SET status = $to WHERE id = $id AND status = $from   -- 0 rows => 409 INVALID_TRANSITION
```

| Event | From | To | Actor |
| --- | --- | --- | --- |
| `start_check` | requested | checking\_availability | agent |
| `hotel_confirmed` | requested, checking\_availability, alternatives\_offered | awaiting\_payment | agent |
| `offer_alternatives` | checking\_availability | alternatives\_offered | agent |
| `accept_alternative` | alternatives\_offered | checking\_availability | customer |
| `mark_unavailable` | checking\_availability, alternatives\_offered | unavailable | agent |
| `submit_payment` | awaiting\_payment | payment\_submitted | customer |
| `verify_payment` | payment\_submitted | payment\_verified | agent |
| `reject_payment` | payment\_submitted | awaiting\_payment | agent |
| `confirm_booking` | payment\_verified | confirmed | agent |
| `expire_payment_window` | awaiting\_payment | cancelled | system |
| `cancel` | requested, checking\_availability, awaiting\_payment, alternatives\_offered | cancelled | customer, agent |
| `cancel` | payment\_submitted, payment\_verified, confirmed | refund\_pending | customer, agent |
| `complete_refund` | refund\_pending | refunded | admin |

Terminal: `unavailable`, `cancelled`, `refunded`. The map lists the states and four events; the rest of this table is my proposal, so confirm it with the business. `booking_events` is append-only (database trigger).

**Create-booking transaction.** Re-price every item on the server (`422 STAY_NOT_BOOKABLE` if unpriceable). Then, in one transaction: insert `bookings` (code from `booking_code_seq`, status `requested`, `totals_by_method`, exchange-rate snapshot with `bcv_value_date`, `sla_due_at`), insert `booking_items` with a frozen `price_snapshot`, insert the `requested` event and a `pending` availability check. Return `{ code, access_token, status, sla_due_at }`. Later rate changes never alter an existing booking.

```ts
router.post('/bookings',
  rateLimit({ bucket: 'booking-create', max: 5, windowSec: 600 }),
  validate({ body: bookingCreateSchema }),
  async (req, res) => {                       // Express 5: a thrown error reaches the error middleware by itself
    if (req.body.website) return sendData(res.status(201), bookingCreatedSchema, fakeCreated())   // honeypot: look successful, store nothing
    const data = await bookingService.create(req.body, { ip: req.ip })
    sendData(res.status(201), bookingCreatedSchema, data)
  })
```

**Access token.** The code `VH-YYYY-NNNNNN` is a reference, not a secret. The token is the key.

```ts
const token = randomBytes(32).toString('base64url')                          // returned once
const key = createHash('sha256').update(token).digest().subarray(0, 16)       // stored as uuid
timingSafeEqual(storedKey, derivedKey)                                        // constant-time compare
```

Unknown code or wrong token is always `404`, never `401`. Responses carry `Cache-Control: no-store`.

**SLA.** `sla_due_at` is 4 business hours in Caracas time: fixed UTC-4 (no DST), Monday to Saturday 08:00 to 18:00, skipping dates in the `holidays` table (seeded from the Venezuelan holiday list, editable by admin). Algorithm: convert to Caracas local, if outside hours move to the next opening, then consume minutes day by day. Check from the spec: a request at 17:00 on Saturday is due Monday 11:00 (1 h Saturday, then 3 h Monday from 08:00). A job alerts when a `requested` or `checking_availability` booking passes `sla_due_at`.

## 1.8 Staff and admin

- **Auth:** email and password with `argon2id` (12 to 128 chars, no composition rules). Sign-up is disabled; users are created by `cli create-admin`. Session cookie `__Secure-vh_session` (HttpOnly, SameSite=Lax), 12 h sliding with a refresh when older than 1 h, stored hashed in `sessions` and cached in Redis, all revoked on password reset. Sign-in limit: 5 per minute per IP, in Redis.
- **Cloudflare Access** guards the exact path `/admin*` at the edge, including login. It is defence in depth, not the boundary.
- **Authorization:** `requireRole(minRole)` is an Express middleware on every admin router and runs first: same-origin check for browser writes (`Sec-Fetch-Site`, then `Origin`) giving `403`, then session `401`, then role `403`, all before params, body or database. Roles `agent < admin < super_admin`; unknown roles grant nothing. A test walks the router stack and fails if an admin route lacks the guard.
- **Capabilities:** agent: view everything, bookings, availability checks, quotes. admin: also hotels, rooms, seasons, rates, images, manual exchange rates, settings, payment methods and IVA, holidays. super\_admin: also staff users.
- **After any admin write** an `onResponse` hook bumps the `catalog` cache version.
- **Availability checks:** staff record what the hotel answered (`available`, `unavailable`, `on_request`) with `checked_by`, `checked_at` and an internal note. Constraint: `check_out > check_in`; any non-pending status needs `checked_at`. Customers never see invented availability or urgency.
- **Images:** uploaded with `multer` (memory storage, size and MIME limits), processed with `sharp`, and written through `FileStorage` to your own file server (see 1.8a). New photos are `held` and appear publicly only once `published`.

## 1.8a File storage (own file server)

Hotel images go to your own file server. Business code depends only on a `FileStorage` interface, so the server behind it can change without touching bookings, pricing or the catalog.

```ts
interface FileStorage {
  put(key: string, data: Buffer, opts: { contentType: string }): Promise<void>
  move(fromKey: string, toKey: string): Promise<void>        // held -> published
  delete(key: string): Promise<void>
  url(key: string): string                                    // FILES_PUBLIC_BASE_URL + key
}
```

| Driver | Use when | How it works |
| --- | --- | --- |
| `LocalDiskStorage` | The file server is the same machine or a mounted volume | Writes under `FILES_ROOT`. nginx (or `express.static`) serves the public folder. |
| `HttpFileServerStorage` | The file server is a separate service | Calls its upload and delete API with a service token (`FILES_SERVER_URL`, `FILES_TOKEN`) |

Rules:

- The database stores the **key** (`public/hotels/{hotel_id}/{image_id}.webp`), never a full URL. The API builds URLs from `FILES_PUBLIC_BASE_URL`, so the file server host can move without a migration. The `image_url` and `images[].url` fields in Part 2 come from this.
- `held` images are stored under a non-public prefix (`private/...`) that the web server does not serve. Publishing calls `move` to the `public/` prefix and updates the key in one transaction.
- Uploads: `multipart/form-data`, max 10 MB, accept only JPEG, PNG and WebP. Check the type from the file's magic bytes (`file-type`), not the extension or the client header. Generate the file name; never use the client's.
- `sharp` resizes (for example 1600 px and a 480 px thumbnail), strips EXIF (including GPS) and converts to WebP.
- Serve public files with `Cache-Control: public, max-age=31536000, immutable`. Keys include the image id, so a changed image gets a new key.
- Include the file volume in the daily backup next to the database dump.
- Env: `FILES_DRIVER` (`local` or `http`), `FILES_ROOT`, `FILES_SERVER_URL`, `FILES_TOKEN`, `FILES_PUBLIC_BASE_URL`.

## 1.9 Exchange rates

Sources: BCV home page (with its Fecha Valor) and the Binance P2P ads for USDT/VES (2 pages, 40 BUY ads, IQR filter, then median). BCV serves an incomplete TLS chain, so pin the missing intermediate certificate and trust it for BCV requests only, with verification left on.

BullMQ repeatable jobs in the worker: USDT every 2 h, BCV hourly 12:00 to 20:00 Caracas (cron in UTC). Each run takes `pg_advisory_xact_lock`, reads, composes and writes in one transaction.

- **Compose:** a run with at least one fresh value writes a complete row, copying the other values from the last good row and prefixing their source with `carried:` (logged). If every source fails, write nothing and alert.
- **BCV publications** are upserted into `bcv_published_rates` by `value_date`. A new `exchange_rates` row is inserted only if the applicable BCV changed or USDT is fresh.
- **Which rate applies:** the newest `auto` row, unless a newer `manual` row exists. BCV applies by Fecha Valor: the publication with the greatest `value_date <= today` in Caracas. A rate published Tuesday afternoon for Wednesday prices nothing until 00:00 Caracas on Wednesday.
- **Staleness:** `stale = true` when there is no effective rate, the read fails, or it is older than 24 h. The frontend shows a reference-only banner.
- Cache the latest effective rate in Redis for 60 s and clear it on write.

## 1.10 Tarifario import

Supplier sheets become one normalized JSON shape, are diffed against the catalog, and are committed in one transaction. Supplier PDFs are still extracted by a supervised Claude session into that JSON; xlsx files are read by `readers/*`.

1. **Normalized format v1** (`tarifarioSchema`, zod): `format_version`, `source`, `hotels[]` with currency, room types, seasons and rates. The schema rejects the same incoherent rows the database would.
2. **Match:** hotel by slug, then `aliases.json`, then normalized name within a compatible destination. Room type by normalized name when unambiguous. Season by range and name (same name and range, else same range, else same name). Rate by room type, season, meal plan, occupancy, concept, price kind, weekdays and child ages, with money equal within 0.005.
3. **Dry run (default):** validate, diff, write `diff-<date>.md`, print the plan.
4. **Commit:** refuses and writes nothing if the snapshot hash changed or the plan recomputed inside the transaction differs. New hotels are inserted as `is_active = false` drafts, removed rates are deactivated, never deleted, destination differences are not written. Output `applied-<timestamp>.md`.
5. **Manual review:** rates that cannot be compared row by row are flagged `manualReview` and not written. `BAJO_PEDIDO` fares are quoted by hand. `catalog-fixes` runs each fix in its own transaction with before and after price assertions through `resolveStayPrice`.
6. **Admin access:** the CLI is the source of truth. Admins can also drive it via `POST /admin/tarifario/imports` (dry run, returns the diff) and `POST /admin/tarifario/imports/:id/commit`, both running as BullMQ jobs. Never run during a parity window.

## 1.11 Security

| Concern | Design |
| --- | --- |
| Secrets | Only in the host environment (DB URL, session secret, file server token, later Stripe). `NEXT_PUBLIC_*`-style values never contain secrets. No customer PII in git. |
| Leak prevention | Every public response has a zod response schema; a sendData(res, schema, data) helper parses the payload with it and drops unknown fields, so internals cannot leak by accident. A contract test fails if a public schema names `net_rate`, `commission_*`, `markup*` or `internal_notes`. `scan:leak` hits live public endpoints in CI. Public 5xx returns the fixed string `Internal error`; details are only logged. |
| Rate limits | Redis fixed window (Lua `INCR` + `EXPIRE`): bookings 5 per 10 min per IP, leads 10 per 10 min, sign-in 5 per min. `429 RATE_LIMITED` with `Retry-After`. |
| Client IP | `trust proxy` limited to the tunnel. Read `cf-connecting-ip` only while the origin is reachable exclusively through the tunnel. |
| CORS and CSRF | CORS allow-list for the web and app origins. Admin writes need same-origin. Customer booking writes are authorised by the body token, not cookies. |
| Headers | `helmet`: HSTS 2 years, `nosniff`, frame-ancestors none, no `X-Powered-By`. CSP lives on the frontend host. |
| Public booking view | Allow-list schema (`bookingPublicViewSchema`), `no-store`, constant-time token compare, `404` for wrong code or token. |
| Input | zod on every body, query and param. Strings trimmed and length-capped, email lowercased (max 254), notes max 1000. |
| Known accepted risks | The 'Me interesa' quote link can flip a declined quote to accepted within its 30-day token: block the transition from `declined` and `expired`. Admin routes must not return `error.message` on 500. |

## 1.12 Platform, jobs, delivery and tests

**Jobs (BullMQ, worker process):**

| Job | Schedule | Purpose |
| --- | --- | --- |
| `rates.usdt` | every 2 h | Binance P2P fetch and compose |
| `rates.bcv` | hourly 12:00 to 20:00 Caracas | BCV fetch and compose |
| `bookings.expire-payment-window` | every 15 min | `expire_payment_window` on stale `awaiting_payment` |
| `bookings.sla-watch` | every 5 min | Alert on bookings past `sla_due_at` |
| `tarifario.import` | on demand | Dry run and commit from admin |

**Environment:** `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `FILES_*`, `PUBLIC_API_ORIGIN`, `ALLOWED_ORIGINS`, `PAYMENT_WINDOW_HOURS`, `GROUP_MIN_ROOMS`, `GROUP_MIN_GUESTS`, `FEATURE_STRIPE`, `STRIPE_*` (phase 2), `SENTRY_DSN`, `PRICING_NOW` (non-production only). Validated at boot by zod; the process exits on a bad config.

**Delivery:** one image, two commands (`node dist/server.js`, `node dist/worker.js`), plus a tools run for CLI scripts. `HEALTHCHECK` on `/health` (liveness) and `/ready` (DB and Redis reachable). Pipeline: install, lint, typecheck, unit, integration and e2e on service containers, build and push image, then the gated migration job, then deploy. Roll back by pinning the previous image tag.

**Tests:**

| Layer | What |
| --- | --- |
| Unit | state machine, SLA, split, pickRate, money, token, compose, staleness |
| Golden pricing | frozen input and output cases for the engine; any change needs review |
| Integration | real Postgres and Redis: booking create, transitions, rate limits, tarifario dry run and commit |
| E2E | booking happy path plus cancel and reject payment |
| Parity | replay the old system's case matrix against the new engine, ignore volatile keys such as `stale` |
| Leak | contract test and live scan |
| Performance | catalog p95 under 500 ms |

## 1.13 Suggested build order

1. Foundation: env, Prisma schema and migrations, Express app, error handler, response helper, logging, health.
2. Pricing engine with golden tests, then exchange-rate feed and `latest`.
3. Public catalog: destinations, search, detail, price. Frontend can switch from dummy data here.
4. Bookings: create, status view, payments report, cancel, state machine, SLA, expiry job.
5. Staff: auth, bookings inbox, transitions, availability, catalog admin, tarifario import.
6. Hardening: leak scan, observability, CI gates. Then phase 2: Stripe, child-band pricing.

# PART 2: Frontend API guide

For the web and React Native apps. The Hotels UI can be built against dummy data first: put every call behind one `hotelsApi` object (section 2.7) and swap the mock for the real client when the endpoints are live.

## 2.1 Basics

| Topic | Rule |
| --- | --- |
| Base URL | `{API_ORIGIN}/api/v1` (set per environment) |
| Format | JSON, UTF-8, `snake_case` keys. Spanish URL params on pages (`/buscar?destino=`) are a frontend concern only: the API always uses the English names below. |
| Dates | `YYYY-MM-DD` hotel calendar dates, no time zone. `check_out` is the departure day, so a stay is `[check_in, check_out)`. |
| Timestamps | ISO 8601 UTC, for example `2026-12-01T14:30:00Z`. Show them in the user's zone, except SLA text which is stated in Caracas time. |
| Money | JSON numbers with 2 decimals, always next to a currency. Never do arithmetic on them beyond display (one allowed exception: per-night figure `total.base / nights`). |
| Success | `{ data: ... }`, plus `meta` for lists |
| Error | `{ error: { code, message, details?, request_id } }` (see 2.5) |
| Language | Send `Accept-Language: es` or `en`. Status labels and descriptions come back localised. |
| Auth | Public endpoints: none. Booking endpoints: the `access_token` returned when the booking was created. Admin: session cookie, send `credentials: 'include'`. |
| Rate limits | `429 RATE_LIMITED` with a `Retry-After` header (seconds). Show the wait time, do not auto-retry in a loop. |
| Caching | Never cache `price` or booking responses (`no-store`). Catalog reads are fine to cache for about a minute in your data layer. |
| Compatibility | Changes inside v1 are additive. Ignore unknown fields and do not crash on an unknown enum value: fall back to a generic label. |

## 2.2 Shared types

```ts
type Currency = 'USD' | 'EUR'                                   // hotel base currency
type PayCurrency = 'VES' | 'USD' | 'EUR' | 'USDT'
type PaymentMethod = 'stripe_card' | 'pago_movil' | 'bs_transfer' | 'zelle' | 'usdt_binance' | 'cash_usd' | 'cash_eur'
type MealPlan = string                                          // for example 'room_only' | 'breakfast' | 'all_inclusive'; take values from the API

type Money = { base: number; bs: number | null; usdt: number }  // bs is null for solo-divisas hotels
type Exchange = {
  available: boolean; bcv_usd: number | null; bcv_eur: number | null
  binance_usdt: number | null; bcv_value_date: string | null; stale: boolean
}
type MethodTotal = {
  method: PaymentMethod; currency: PayCurrency; amount: number
  iva_rate: number; iva_amount: number; exchange_rate_used: number | null
  is_lowest: boolean                                            // neutral tag 'Monto menor'; never preselect or recommend
}
type Availability = { mode: 'manual' | 'api'; status: 'on_request' | 'available' | 'unavailable'; last_checked_at: string | null }
type GroupRequest = { whatsapp_url: string; email: string }     // prefilled with dates and party
type RoomSelection = { room_type_id: string; adults: number; children: number; child_ages: number[] }   // adults 1..20, children 0..10
type PriceFailure = 'no_season' | 'no_rate' | 'min_nights'
```

**Exchange banner rule:** whenever a response carries `exchange.stale === true` (no rate, read failed, or rate older than 24 h), show a `role=status` banner saying Bs and USDT amounts are for reference. Under every Bs amount show 'Tasa BCV del {bcv\_value\_date}'.

## 2.3 Public endpoints

### GET /exchange-rates

Returns the latest effective rates, for banners and rate labels outside a priced response.

```ts
// 200
{ data: Exchange }
```

### GET /destinations

For the home page and the destination picker.

```ts
// 200
{ data: { destinations: { slug: string; name: string; hotel_count: number }[] } }
```

### GET /hotels (search and catalog)

| Query param | Type | Notes |
| --- | --- | --- |
| `destination` | string | destination `slug` |
| `check_in`, `check_out` | `YYYY-MM-DD` | both or neither. Neither means undated 'Desde' mode. |
| `adults` | int | 1 to 20, default 2 |
| `children` | int | 0 to 20, default 0 |
| `rooms` | int | 1 to 10, default 1 |
| `meal_plan` | string | filter |
| `max_price` | number | maximum price in USDT |
| `category` | string | for example hotel, posada |
| `q` | string | name search |
| `sort` | `price_asc` (default), `price_desc`, `stars_desc` |  |
| `cursor`, `limit` | string, int | `limit` default 20, max 50 |

Out-of-range values are **clamped, not rejected**. The values the server actually used come back in `meta.applied`, so read them from there instead of trusting what you sent.

```ts
type HotelCard = {
  slug: string; name: string; destination: string; category: string; star_rating: number | null
  base_currency: Currency; is_solo_divisas: boolean; image_url: string | null
  meal_plans: MealPlan[]
  rooms_quoted: number                                // rooms needed for the party (may exceed the rooms you asked for)
  price: Money | null                                 // null unless availability === 'ok'
  price_basis: 'per_night_from' | 'stay_total'        // undated: 'Desde' per night. dated: whole stay.
  availability: 'ok' | PriceFailure
  min_nights_required?: number                       // only with 'min_nights'
}

// 200
{
  data: { items: HotelCard[]; exchange: Exchange },
  meta: { next_cursor: string | null,
          applied: { check_in: string | null; check_out: string | null; nights: number | null; adults: number; children: number; rooms: number } }
}
```

UI rules: show the price label from `price_basis` (not from whether you sent dates). For `no_season`, `no_rate` and `min_nights` show a clear unavailable-for-these-dates state, with 'minimum N nights' when `min_nights_required` is present. Never show urgency ('only 2 left') because availability is not live.

### GET /hotels/:slug (detail)

Same query params as search except `destination`, `meal_plan`, `max_price`, `category`, `q`, `sort`, `cursor` and `limit`. Unknown slug is `404`.

```ts
type StayOption =
  | { id: string; room_type_id: string; room_name: string; meal_plan: MealPlan; fits_party: boolean
      priced: true; total: Money; methods: MethodTotal[] }
  | { id: string; room_type_id: string; room_name: string; meal_plan: MealPlan; fits_party: boolean
      priced: false; reason: PriceFailure; min_nights_required?: number }

type HotelDetail = {
  hotel: { slug: string; name: string; destination: string; category: string; star_rating: number | null
           base_currency: Currency; is_solo_divisas: boolean; description: string | null
           images: { url: string; alt: string | null }[]; meal_plans: MealPlan[] }
  rooms: { id: string; name: string; max_occupancy: number }[]
  seasonal_rates: { season: string; date_from: string; date_to: string
                    rows: { room_type_id: string; meal_plan: MealPlan; occupancy: number; per: 'room' | 'person'
                            price: Money; min_nights: number }[] }[]      // one-night list prices
  from_price: { price: Money; per: 'night' } | null        // undated 'Desde $X por noche'
  stay: null | {                                           // null when no dates were sent
    nights: number; rooms_effective: number
    options: StayOption[]; lowest_option_id: string | null
  }
  availability: Availability
  group_request: GroupRequest | null                        // set for 5+ rooms or 12+ guests
  exchange: Exchange
}
```

UI rules, in this order on the page: dates, rates, availability notice.

- **Undated:** show `from_price` as 'Desde $X por noche'.
- **Dated:** the sidebar card shows the total of the cheapest sellable option (`lowest_option_id`) and per night `total.base / nights`. Skip options with `fits_party: false` (label them 'No cabe'). While the dated request is loading show a loading state: never fall back to a nightly price or to the previous total.
- **Group request:** when `group_request` is not null, hide prices and show the WhatsApp link or the email instead.
- **Availability notice:** always render 'Disponibilidad por confirmar' with what happens if the hotel has no room, and `last_checked_at` on dated searches.
- The page recomputes nothing. Every amount comes from the response.

### POST /hotels/:slug/price (checkout pricing)

Read-only: it never creates anything. Call it when entering the payment step and again whenever dates, meal plan or rooms change.

```ts
// request
{ check_in: string; check_out: string; meal_plan: MealPlan; room_selections: RoomSelection[] }   // 1..10 rooms

// 200: a union on 'priced'. Check it before reading anything else.
type PriceResponse = { data:
  | { priced: true; nights: number; base_currency: Currency
      rooms: { room_type_id: string; guests: number; price: Money }[]
      total: Money; methods: MethodTotal[]; exchange: Exchange }
  | { priced: false; reason: PriceFailure | 'group_request'
      min_nights_required?: number; group_request?: GroupRequest }
}
```

Example (single room, 3 nights, shape only):

```ts
{ data: { priced: true, nights: 3, base_currency: 'USD',
  rooms: [{ room_type_id: 'rt_1', guests: 2, price: { base: 360, bs: 16200, usdt: 346.15 } }],
  total: { base: 360, bs: 16200, usdt: 346.15 },
  methods: [
    { method: 'zelle',      currency: 'USD', amount: 360,     iva_rate: 0,    iva_amount: 0,    exchange_rate_used: null, is_lowest: false },
    { method: 'pago_movil', currency: 'VES', amount: 18792,   iva_rate: 0.16, iva_amount: 2592, exchange_rate_used: 45,   is_lowest: true } ],
  exchange: { available: true, bcv_usd: 45, bcv_eur: 49, binance_usdt: 46.8, bcv_value_date: '2026-10-29', stale: false } } }
```

UI rules for the payment step: render **one total per method** in the order the API returns them (`stripe_card, pago_movil, bs_transfer, zelle, usdt_binance, cash_usd, cash_eur`, only those the hotel offers). Show the `is_lowest` tag if you want, but **do not preselect or recommend a method**. `stripe_card` only appears once the Stripe phase is live. Errors: `422 INVALID_STAY_WINDOW` (not 1 to 60 nights), `404`.

### POST /bookings (create the request)

Turns checkout into a stored request. The server re-prices everything; anything price-like you send is ignored. Rate limit: 5 per 10 minutes per IP.

```ts
// request
{
  items: [{                                   // 1..5 items, v1 supports only 'hotel_stay'
    type: 'hotel_stay', hotel_slug: string, check_in: string, check_out: string,
    meal_plan: MealPlan, room_selections: RoomSelection[]
  }],
  contact: { name: string; email: string; phone?: string },   // email is lowercased server-side, max 254
  locale: 'es' | 'en',
  payment_method?: PaymentMethod,             // the customer's preference, not a payment
  notes?: string,                             // max 1000
  terms_accepted: true,                       // must be literally true
  website: ''                                 // honeypot: render a hidden input and always send it empty
}

// 201
{ data: { code: string; access_token: string; status: 'requested'; sla_due_at: string } }
```

- `code` looks like `VH-2026-000123`. It is only a reference you can show and say over the phone.
- `access_token` is **returned once and cannot be recovered**. Build the status link immediately: `/reserva/{code}?token={access_token}`. Email it to the customer (the backend sends it too) and keep it in the URL only.
- `sla_due_at` is when the team promises a first answer (4 business hours, Caracas time). Show it as 'We reply before {date}'.
- Errors: `400 VALIDATION_ERROR` (`details` lists fields), `422 STAY_NOT_BOOKABLE` (dates no longer priceable, send the user back to pick dates), `422 GROUP_REQUEST_REQUIRED` (use the WhatsApp or email path), `429 RATE_LIMITED`.
- Do not double-submit: disable the button on click. If the request times out, do not blindly retry: the user may have created a booking already.

### GET /bookings/:code (status page)

Send the token in the header `X-Booking-Token: {access_token}`. Responses are `no-store`. A wrong code **or** a wrong token both return `404`, so never tell the user which one was wrong: show 'We could not find this booking'.

```ts
type BookingStatus = 'requested' | 'checking_availability' | 'awaiting_payment' | 'payment_submitted'
  | 'payment_verified' | 'confirmed' | 'alternatives_offered' | 'unavailable' | 'cancelled'
  | 'refund_pending' | 'refunded'

type BookingView = {
  code: string; status: BookingStatus
  status_label: string; status_description: string          // localised, show as-is
  sla_due_at: string | null; payment_due_at: string | null   // payment_due_at only while awaiting_payment
  contact: { name: string; email: string }
  items: { type: 'hotel_stay'; hotel: { slug: string; name: string; destination: string }
           check_in: string; check_out: string; nights: number; meal_plan: MealPlan
           rooms: { room_type_id: string; room_name: string; adults: number; children: number; child_ages: number[] }[]
           price: Money }[]
  totals_by_method: MethodTotal[]                            // frozen when the request was made
  exchange_snapshot: { bcv_usd: number | null; bcv_eur: number | null; binance_usdt: number | null; bcv_value_date: string | null }
  payments: { id: string; method: PaymentMethod; currency: PayCurrency; amount: number; reference: string
              status: 'submitted' | 'verified' | 'rejected' | 'refunded'; submitted_at: string }[]
  timeline: { at: string; event: string; label: string }[]
  allowed_actions: ('report_payment' | 'cancel')[]
  created_at: string
}
// 200
{ data: BookingView }
```

**Drive the buttons from `allowed_actions`, never from `status`.** Amounts on this page are the snapshot taken at request time: a later rate change never changes them. The page must send `Referrer-Policy: no-referrer` and `noindex`, because the token is in the URL.

### POST /bookings/:code/payments (report a payment)

Only valid while `allowed_actions` contains `report_payment` (status `awaiting_payment`). Staff then verify it manually.

```ts
// request
{ token: string; method: PaymentMethod; reference: string }    // reference: transfer or confirmation number

// 200
{ data: BookingView }                                          // status is now 'payment_submitted'
```

Errors: `404` (bad code or token), `409 INVALID_TRANSITION` (not payable now: refetch the booking and re-render), `400 VALIDATION_ERROR`. If staff reject the payment the booking goes back to `awaiting_payment` and the customer can report again.

### POST /bookings/:code/cancel

```ts
// request
{ token: string }
// 200
{ data: BookingView }          // 'cancelled', or 'refund_pending' if money was already held
```

Error `409 INVALID_TRANSITION` when cancelling is not allowed. Ask the user to confirm first, and explain that a refund is handled by the team when money was already held.

### POST /leads

Contact form. Limit 10 per 10 minutes per IP.

```ts
// request
{ name: string; email: string; phone?: string; message?: string }
// 201
{ data: { id: string } }
```

## 2.4 Booking status reference

The API sends `status_label` and `status_description` already localised, so use those for text. This table is for designing the status page and its icons. Drive actions from `allowed_actions`.

| `status` | Meaning for the customer | `allowed_actions` | Terminal |
| --- | --- | --- | --- |
| `requested` | Request stored, team will check with the hotel | `cancel` | no |
| `checking_availability` | Team is asking the hotel | `cancel` | no |
| `awaiting_payment` | Hotel confirmed, customer pays by their method | `report_payment`, `cancel` | no |
| `payment_submitted` | Customer reported a payment, team is verifying | `cancel` | no |
| `payment_verified` | Payment verified, final confirmation pending | `cancel` | no |
| `confirmed` | Booking confirmed with the hotel | `cancel` | no |
| `alternatives_offered` | Hotel full, team offered similar stays | `cancel` | no |
| `unavailable` | No room and no alternatives | none | yes |
| `cancelled` | Cancelled before money was held | none | yes |
| `refund_pending` | Cancelled while funds were held, refund in progress | none | no |
| `refunded` | Refund completed | none | yes |

In v1 a customer accepts an alternative by contacting the team (WhatsApp or email), and staff apply the event. A customer endpoint can be added later without breaking v1.

The `timeline` array is the customer-safe event history (label already localised). Render it newest first and do not try to interpret `event` strings.

**Refreshing:** refetch on window focus and every 60 s while the status is not terminal. Stop polling on `unavailable`, `cancelled` and `refunded`. Do not retry a `404`.

## 2.5 Errors

Every error has the same shape. Show `message` only for a developer or a toast of last resort; build user-facing copy from `code`. Always log `request_id` and include it in support links.

```ts
type ApiError = { error: { code: string; message: string; details?: unknown; request_id: string } }
```

| HTTP | `code` | When | What the UI does |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Body or query failed validation. `details` is a list of `{ path, message }`. | Highlight the fields |
| 401 | `UNAUTHENTICATED` | Admin session missing or expired | Redirect to admin login |
| 403 | `FORBIDDEN` | Role too low, or cross-origin admin write | Show no-access state |
| 404 | `NOT_FOUND` | Unknown slug, unknown booking code, **or wrong token** | 'We could not find this' |
| 409 | `INVALID_TRANSITION` | Action not allowed in the current status | Refetch the booking, re-render |
| 422 | `INVALID_STAY_WINDOW` | Not 1 to 60 nights, or `check_out <= check_in` | Ask for new dates |
| 422 | `STAY_NOT_BOOKABLE` | Server could not price the stay | Send back to date and room selection |
| 422 | `GROUP_REQUEST_REQUIRED` | 5+ rooms or 12+ guests | Show WhatsApp or email path |
| 429 | `RATE_LIMITED` | Too many requests. `Retry-After` header has seconds. | Disable submit, show wait time |
| 500 | `INTERNAL` | Message is always `Internal error` | Generic error with `request_id` |

## 2.6 Which screen calls what

| Screen | Calls | Notes |
| --- | --- | --- |
| Home (Hotels tab in the search bar) | `GET /destinations` | Feed the destination picker. No prices needed. |
| Search results | `GET /hotels` | Re-run on every filter change. Read `meta.applied` to show the real dates and party. Paginate with `meta.next_cursor`. |
| Hotel detail | `GET /hotels/:slug` | Send the same dates and party as the search. Re-request when the user changes dates. |
| Checkout 1: Estadia (stay) | none | Dates, rooms and meal plan come from the detail page state |
| Checkout 2: Datos del huesped (guest details) | none | Collect `contact`, `notes`, terms checkbox |
| Checkout 3: Forma de pago (payment) | `POST /hotels/:slug/price` | One total per method. No preselection. |
| Checkout 4: Revision (review) | none | Show the last `price` response. If the user goes back and changes anything, call `price` again. |
| Checkout 5: Confirmacion (confirm) | `POST /bookings` | On `201` redirect to `/reserva/{code}?token={access_token}` and clear the checkout state |
| Booking status | `GET /bookings/:code`, `POST .../payments`, `POST .../cancel` | Token in the `X-Booking-Token` header. Poll while not terminal. |
| Rates banner (global) | `exchange` from any response, or `GET /exchange-rates` | Show the reference-only banner when `stale` |

## 2.7 Client code

One thin HTTP layer, one interface, one mock. The UI imports only `hotelsApi`.

```ts
// api/http.ts
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string,
              public requestId?: string, public retryAfter?: number, public details?: unknown) { super(message) }
}

export async function request<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, headers, ...rest } = init
  const res = await fetch(`${API_ORIGIN}/api/v1${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': currentLocale(),                       // 'es' | 'en'
      ...(token ? { 'X-Booking-Token': token } : {}),
      ...headers,
    },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const e = body?.error
    throw new ApiError(res.status, e?.code ?? 'UNKNOWN', e?.message ?? 'Request failed',
      e?.request_id, Number(res.headers.get('Retry-After')) || undefined, e?.details)
  }
  return body as T                                              // callers read .data and .meta
}
```

```ts
// api/hotels.ts
export interface HotelsApi {
  destinations(): Promise<Destination[]>
  search(q: SearchQuery): Promise<{ items: HotelCard[]; exchange: Exchange; meta: SearchMeta }>
  detail(slug: string, q: StayQuery): Promise<HotelDetail>
  price(slug: string, body: PriceRequest): Promise<PriceData>
  createBooking(body: CreateBookingBody): Promise<CreatedBooking>
  booking(code: string, token: string): Promise<BookingView>
  reportPayment(code: string, body: ReportPaymentBody): Promise<BookingView>
  cancelBooking(code: string, token: string): Promise<BookingView>
}
export const hotelsApi: HotelsApi = USE_MOCK ? mockHotelsApi : httpHotelsApi
```

```ts
// hooks/useBooking.ts (React Query)
const TERMINAL = ['unavailable', 'cancelled', 'refunded']
export const useBooking = (code: string, token: string) =>
  useQuery({
    queryKey: ['booking', code],
    queryFn: () => hotelsApi.booking(code, token),
    refetchInterval: q => (TERMINAL.includes(q.state.data?.status ?? '') ? false : 60_000),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  })
```

Mock tips: write one fixture per branch so every UI state exists before the API does: `priced: true` and each `priced: false` reason, each `availability` value on a card, a card with `min_nights_required`, `stale: true`, a `group_request`, a solo-divisas hotel (`bs: null`), and one booking per status in 2.4. Keep the fixtures typed with the same types as 2.2 so the swap is a one-line change. Better still, generate the types from the backend's OpenAPI document (`@asteasolutions/zod-to-openapi` is built from the same zod schemas) with `openapi-typescript`.

## 2.8 Admin API reference

For the staff console. Base path `/api/admin` (not versioned), cookie session, `credentials: 'include'`. Every write must come from the same origin as the console (otherwise `403`). Roles: `agent < admin < super_admin`. Admin writes refresh the public catalog automatically.

| Area | Endpoint | Role | Purpose |
| --- | --- | --- | --- |
| Auth | `POST /auth/sign-in`, `POST /auth/sign-out`, `GET /auth/me` | none, any, any | Email and password sign-in, current user and role. Sign-in limit 5 per minute per IP. |
| Bookings | `GET /bookings?status=&overdue=&q=&cursor=` | agent | Inbox, sorted by `sla_due_at`, with countdown data and prefilled contact links |
| Bookings | `GET /bookings/:code` | agent | Items, price snapshot, totals by method, full event history |
| Bookings | `POST /bookings/:code/transition` with `{ event, note? }` | agent (`complete_refund`: admin) | Apply a lifecycle event. The role comes from the session, never the body. `409 INVALID_TRANSITION` if not allowed. |
| Availability | `POST /availability` | agent | Record the hotel's answer: status, `checked_at`, note |
| Hotels | `GET/POST /hotels`, `GET/PATCH /hotels/:id` | admin | Hotel data, availability mode, active flag |
| Rooms, seasons, rates | `GET/POST/PATCH /hotels/:id/rooms`, `/seasons`, `/rates` | admin | Rates are deactivated, never deleted |
| Payment methods | `PUT /hotels/:id/payment-methods` | admin | Methods offered, IVA rate and surcharge per method |
| Images | `POST /hotels/:id/images`, `PATCH /images/:id` | admin | Upload (multipart/form-data, field named file), then publish or hold |
| Exchange rates | `GET /exchange-rates`, `POST /exchange-rates/manual` | admin | History and a manual override |
| Holidays | `GET/POST/DELETE /holidays` | admin | Used by the SLA calculation |
| Quotes | `GET/POST/PATCH /quotes` | agent | Quotes with share links. Commission fields are admin-only in responses. |
| Tarifario | `POST /tarifario/imports`, `POST /tarifario/imports/:id/commit` | admin | Dry run returns the diff, commit applies it |
| Users | `GET/POST /users`, `PATCH /users/:id/role`, `POST /users/:id/reset-password` | super\_admin | Staff management |

Admin responses may include internal fields (`net_rate`, commission, internal notes). They are never present in `/api/v1`, so do not share types between the customer app and the console.

## 2.9 Frontend rules to keep

- Never send, compute or trust a price in the client. Display what the API returns; the only arithmetic allowed is per night `total.base / nights`.
- Never preselect, rank or recommend a payment method. `is_lowest` is a neutral label.
- Never invent urgency or live availability. Always show the availability notice.
- Drive buttons from `allowed_actions`, and amounts on the status page from the snapshot in the booking.
- Treat `access_token` like a password: only in the status link, never in logs, analytics events, error reports or referrer headers. On mobile, store `{ code, token }` in secure storage (Keychain or Keystore) if you want a 'my bookings' shortcut.
- Send `website` empty and keep the honeypot input hidden from users and assistive tech.
- Handle `429` with the `Retry-After` value, `409` by refetching, and `404` on a booking as one generic message.
- Ignore unknown fields and unknown enum values.

## 2.10 Things to confirm before building

1. **Payment window:** how long can a booking sit in `awaiting_payment` before it expires (I assumed 48 h)?
2. **Lifecycle table (1.7):** only the states and four events come from the map. The remaining transitions are my proposal.
3. **Rate column meaning:** the engine uses `net_rate` as the base fare as the map describes; confirm whether `sell_rate` or `markup_percent` should ever override it.
4. **Meal plan and category values:** I used placeholders; take the real values from your tarifario data.
5. **Honeypot behaviour:** I chose to return a fake `201` and store nothing. Alternative: a plain `400`.
6. **Token in a header:** the map's GET shows the token on the page URL. For the API I recommend the `X-Booking-Token` header so tokens stay out of server logs. The status page URL keeps `?token=`.
7. **Idempotency:** v1 has none. Adding an optional `Idempotency-Key` header to `POST /bookings` would make timeout retries safe; worth doing before launch.
8. **Alternatives:** customer acceptance through the team in v1 (see 2.4), or build the endpoint now?
9. **Stripe and child pricing:** both are phase 2. Say when, because they change the checkout and the price response.
