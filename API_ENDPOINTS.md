# hotel-backend — API endpoint reference

Generated from route definitions in `src/app.ts` and module routers.

## Base paths

| Prefix | Audience |
|--------|----------|
| `/api/v1` | Public customer API |
| `/api/admin` | Staff admin API (session cookie or Bearer token) |

**Role hierarchy (admin):** `agent` &lt; `admin` &lt; `super_admin`. Endpoints marked `agent+` require at least agent; higher roles inherit access.

---

## Infrastructure

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Liveness probe: `{ status: 'ok', uptime }`. |
| GET | `/ready` | — | Readiness: Postgres + Redis; **503** if unavailable. |
| GET | `/files/*` | — | Static uploaded files (local `FILES_ROOT` driver). |

---

## Public API — `/api/v1`

### Exchange rates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/exchange-rates` | Latest effective BCV/Binance rates for display and pricing (`available`, `bcv_usd`, `bcv_eur`, `binance_usdt`, `bcv_value_date`, `stale`). |

### Catalog

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/destinations` | List destinations for search and filters. |
| GET | `/api/v1/hotels` | Search hotels. **Query:** `destination`, `check_in`, `check_out`, `adults`, `children`, `rooms`, `meal_plan`, `max_price`, `category`, `q`, `sort` (`price_asc` \| `price_desc` \| `stars_desc`), `cursor`, `limit`. |
| GET | `/api/v1/hotels/:slug` | Hotel detail by slug. **Query (optional):** `check_in`, `check_out`, `adults`, `children`, `rooms`. |
| POST | `/api/v1/hotels/:slug/price` | Checkout price quote. **Body:** `check_in`, `check_out`, `meal_plan`, `room_selections[]` (`room_type_id`, `adults`, `children`, `child_ages`). Response: `Cache-Control: no-store`. |

### Bookings (guest)

| Method | Path | Limits / auth | Description |
|--------|------|---------------|-------------|
| POST | `/api/v1/bookings` | 5 req / 10 min | Create booking request. Honeypot: if `website` is non-empty, returns fake success without saving. Returns `code`, `access_token`, `status`, `sla_due_at`. |
| GET | `/api/v1/bookings/:code` | Token required | Guest booking view. **`X-Booking-Token`** header or **`?token=`**. Missing token → 404. `Cache-Control: no-store`. |
| POST | `/api/v1/bookings/:code/payments` | Body includes token | Guest reports payment (`method`, `reference`, `token`). Returns updated public booking view. |
| POST | `/api/v1/bookings/:code/cancel` | Body: `token` | Guest cancellation. Returns updated public booking view. |

### Leads

| Method | Path | Limits | Description |
|--------|------|--------|-------------|
| POST | `/api/v1/leads` | 10 req / 10 min | Contact form: `name`, `email`, optional `phone`, `message`. Returns `{ id }`. |

---

## Admin API — `/api/admin`

### Authentication

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/admin/auth/sign-in` | — | Email + password; 12h session (httpOnly cookie + `token` in JSON). **5 req / min.** |
| POST | `/api/admin/auth/sign-out` | agent+ | End session, clear cookie, remove Redis cache. |
| GET | `/api/admin/auth/me` | agent+ | Current user: `id`, `email`, `role`. |

### Bookings & availability (agent+)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/bookings` | List up to 50 bookings. **Query:** `status`, `overdue=true`, `q`, `cursor`. SLA summary fields included. |
| GET | `/api/admin/bookings/:code` | Full booking: items, events, payments, availability checks. |
| POST | `/api/admin/bookings/:code/transition` | Booking state machine. **Body:** `event`, optional `note`. Events include: `start_check`, `hotel_confirmed`, `offer_alternatives`, `accept_alternative`, `mark_unavailable`, `submit_payment`, `verify_payment`, `reject_payment`, `confirm_booking`, `expire_payment_window`, `cancel`, `complete_refund` (**admin+** for `complete_refund`). |
| POST | `/api/admin/availability` | Create availability check. **Body:** `hotel_id`, `check_in`, `check_out`, `status` (`pending` \| `available` \| `unavailable` \| `on_request`), optional `booking_id`, `note`. |

### Quotes (agent+)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/quotes` | List quotes. |
| POST | `/api/admin/quotes` | Create quote (`lines`, commission fields, `internal_notes`); 30-day expiry. |
| PATCH | `/api/admin/quotes/:id` | Update quote; validates accept transition (not declined/expired). |

### Hotels & catalog (admin+)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/hotels` | All hotels with rooms, seasons/rates, payment rules. |
| POST | `/api/admin/hotels` | Create hotel. |
| GET | `/api/admin/hotels/:id` | Hotel detail including images. |
| PATCH | `/api/admin/hotels/:id` | Update hotel. |
| GET | `/api/admin/hotels/:id/rooms` | List room types. |
| POST | `/api/admin/hotels/:id/rooms` | Create room type. |
| PATCH | `/api/admin/hotels/:id/rooms/:roomId` | Update room type. |
| GET | `/api/admin/hotels/:id/seasons` | List seasons (with rates). |
| POST | `/api/admin/hotels/:id/seasons` | Create season. |
| PATCH | `/api/admin/hotels/:id/seasons/:seasonId` | Update season. |
| GET | `/api/admin/hotels/:id/rates` | List rates for hotel. |
| POST | `/api/admin/hotels/:id/rates` | Create rate row. |
| PATCH | `/api/admin/rates/:id` | Update rate. |
| PUT | `/api/admin/hotels/:id/payment-methods` | Replace payment/tax rules (`methods[]`). |
| POST | `/api/admin/hotels/:id/images` | Upload image (`multipart/form-data`); WebP, stored as `held`. |
| PATCH | `/api/admin/images/:id` | Update image (`status`, `sort_order`, `alt`); publish moves storage key private → public. |
| DELETE | `/api/admin/images/:id` | Delete storage file and DB record. |

### Exchange rates & holidays (admin+)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/exchange-rates` | Last 50 exchange rate history rows. |
| POST | `/api/admin/exchange-rates/manual` | Set manual exchange rate override. |
| GET | `/api/admin/holidays` | List holidays. |
| POST | `/api/admin/holidays` | Create holiday (`date`, `name`). |
| DELETE | `/api/admin/holidays/:date` | Delete holiday (`YYYY-MM-DD`). |

### Tarifario import (admin+)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/tarifario/imports` | Dry-run rate import; returns plan preview. |
| POST | `/api/admin/tarifario/imports/:id/commit` | Commit import; **Body:** `expected_hash`. |

### Staff users (super_admin only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users` | List staff users. |
| POST | `/api/admin/users` | Create user (`email`, `password`, `role`). |
| PATCH | `/api/admin/users/:id/role` | Change role. |
| POST | `/api/admin/users/:id/reset-password` | Reset password; revokes all sessions for user. |

---

## Related docs

- **[FRONTEND_API_GUIDE.md](./FRONTEND_API_GUIDE.md)** — Request/response schemas, types, and frontend integration details.

## Source files

| Area | Router |
|------|--------|
| App mount | `src/app.ts` |
| Catalog | `src/modules/catalog/routes.ts` |
| Bookings | `src/modules/bookings/routes.ts` |
| Leads | `src/modules/leads/routes.ts` |
| Rates | `src/modules/rates/routes.ts` |
| Admin + auth | `src/modules/admin/routes.ts`, `src/modules/admin/auth.ts` |
