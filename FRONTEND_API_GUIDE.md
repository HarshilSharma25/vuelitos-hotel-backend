# Vuelitos Hotels: Frontend & Admin API Implementation Guide

Comprehensive API contract, data structures, and implementation guide for both the **Customer Frontend (Web & React Native)** and the **Staff Admin Console**.

---

## 1. System Conventions & Architecture

### Base URLs
- **Customer API:** `{API_ORIGIN}/api/v1` (English `snake_case`, versioned)
- **Admin API:** `{API_ORIGIN}/api/admin` (English `snake_case`, unversioned)

### Global Headers
| Header | Context | Description |
| :--- | :--- | :--- |
| `Content-Type` | All | `application/json` (except image uploads which use `multipart/form-data`) |
| `Accept-Language` | Customer | `es` (default) or `en` — localized status labels and descriptions are returned by the server |
| `X-Booking-Token` | Customer | Per-booking secret token for `GET /bookings/:code` |
| `Credentials` | Admin | `include` (reads the `__Secure-vh_session` HTTP-only cookie; Bearer token accepted for native clients) |

### Unified Error Structure
All `4xx` and `5xx` errors return a standard JSON envelope:
```typescript
interface ApiErrorResponse {
  error: {
    code: string;       // e.g. 'VALIDATION_ERROR', 'INVALID_TRANSITION', 'STAY_NOT_BOOKABLE'
    message: string;    // Human-readable summary (generic 'Internal error' on 500)
    details?: unknown;  // Zod path-level validation failures on 400
    request_id: string; // Unique trace ID to attach to user support links
  };
}
```

---

## 2. Customer Frontend Guide (Web & React Native)

### 2.1 Core Shared Data Types
```typescript
export type Currency = 'USD' | 'EUR';
export type PayCurrency = 'VES' | 'USD' | 'EUR' | 'USDT';
export type PaymentMethod =
  | 'pago_movil'
  | 'bs_transfer'
  | 'zelle'
  | 'usdt_binance'
  | 'cash_usd'
  | 'cash_eur'
  | 'stripe_card';

export interface Money {
  base: number;       // In hotel base currency (USD or EUR)
  bs: number | null;  // Converted via BCV + IVA (null for is_solo_divisas hotels)
  usdt: number;       // Converted via Binance P2P (1:1 with base for solo-divisas)
}

export interface Exchange {
  available: boolean;
  bcv_usd: number | null;
  bcv_eur: number | null;
  binance_usdt: number | null;
  bcv_value_date: string | null; // Format YYYY-MM-DD
  stale: boolean;                // If true, display the reference-only banner
}

export interface MethodTotal {
  method: PaymentMethod;
  currency: PayCurrency;
  amount: number;
  iva_rate: number;
  iva_amount: number;
  exchange_rate_used: number | null;
  is_lowest: boolean;            // Neutral badge "Monto menor" - NEVER auto-select or recommend
}

export interface RoomSelection {
  room_type_id: string;
  adults: number;                // 1..20
  children: number;              // 0..10
  child_ages: number[];
}
```

---

### 2.2 Public Endpoints Reference

#### 1. Destinations & Exchange Rates
- **`GET /api/v1/destinations`**: Populates the search bar destination dropdown.
  ```json
  {
    "data": {
      "destinations": [
        { "slug": "margarita", "name": "Isla de Margarita", "hotel_count": 8 }
      ]
    }
  }
  ```
- **`GET /api/v1/exchange-rates`**: Feeds the global rates header/footer and stale-rate warning banner.
  ```json
  {
    "data": {
      "available": true,
      "bcv_usd": 45.0,
      "bcv_eur": 49.0,
      "binance_usdt": 46.8,
      "bcv_value_date": "2026-10-29",
      "stale": false
    }
  }
  ```

#### 2. Search & Catalog (`GET /api/v1/hotels`)
- **Query Parameters:** `destination`, `check_in`, `check_out` (`YYYY-MM-DD`, both or neither), `adults` (1..20, default 2), `children` (0..20), `rooms` (1..10), `meal_plan`, `max_price`, `category`, `q`, `sort` (`price_asc` default, `price_desc`, `stars_desc`), `cursor`, `limit` (default 20, max 50).
- **Clamping Rule:** The server clamps out-of-range values instead of rejecting. Always read effective filter state from `meta.applied`.
- **Response Shape:**
  ```json
  {
    "data": {
      "items": [
        {
          "slug": "hotel-playa-el-agua",
          "name": "Hotel Playa El Agua",
          "destination": "Isla de Margarita",
          "category": "Hotel",
          "star_rating": 4,
          "base_currency": "USD",
          "is_solo_divisas": false,
          "image_url": "https://cdn.vuelitos.com/public/hotels/h-1/cover.webp",
          "meal_plans": ["desayuno", "todo_incluido"],
          "rooms_quoted": 1,
          "price": { "base": 120.0, "bs": 6264.0, "usdt": 133.85 },
          "price_basis": "stay_total",
          "availability": "ok",
          "min_nights_required": null
        }
      ],
      "exchange": { ... }
    },
    "meta": {
      "next_cursor": "eyJpZCI6Ii4uLiJ9",
      "applied": {
        "check_in": "2026-11-10",
        "check_out": "2026-11-12",
        "nights": 2,
        "adults": 2,
        "children": 0,
        "rooms": 1
      }
    }
  }
  ```

#### 3. Hotel Detail (`GET /api/v1/hotels/:slug`)
- Returns the complete hotel profile, seasonal rate matrix, photo gallery, available stay options, and group request indicators.
- **Group Threshold:** If requested rooms $\ge 5$ or guests $\ge 12$, `group_request` is non-null:
  ```json
  {
    "group_request": {
      "whatsapp_url": "https://wa.me/584120000000?text=Hola...",
      "email": "grupos@vuelitos.com"
    }
  }
  ```
  *When `group_request` is present, hide price buttons and display group booking links.*

#### 4. Checkout Pricing Calculation (`POST /api/v1/hotels/:slug/price`)
- Read-only call invoked before payment method selection.
- **Request:**
  ```json
  {
    "check_in": "2026-11-10",
    "check_out": "2026-11-12",
    "meal_plan": "desayuno",
    "room_selections": [
      { "room_type_id": "rt_std", "adults": 2, "children": 0, "child_ages": [] }
    ]
  }
  ```
- **Response (Union on `priced`):**
  ```typescript
  type PriceResponse =
    | {
        priced: true;
        nights: number;
        base_currency: Currency;
        rooms: { room_type_id: string; guests: number; price: Money }[];
        total: Money;
        methods: MethodTotal[];
        exchange: Exchange;
      }
    | {
        priced: false;
        reason: 'no_season' | 'no_rate' | 'min_nights' | 'group_request';
        min_nights_required?: number;
        group_request?: { whatsapp_url: string; email: string };
      };
  ```

#### 5. Booking Creation (`POST /api/v1/bookings`)
- **Honeypot Protection:** Include a hidden field `website: ""`. If filled, the server silently returns a synthetic `201 Created` without storing anything in the database.
- **Request:**
  ```json
  {
    "items": [
      {
        "type": "hotel_stay",
        "hotel_slug": "hotel-playa-el-agua",
        "check_in": "2026-11-10",
        "check_out": "2026-11-12",
        "meal_plan": "desayuno",
        "room_selections": [
          { "room_type_id": "rt_std", "adults": 2, "children": 0, "child_ages": [] }
        ]
      }
    ],
    "contact": {
      "name": "Carlos Perez",
      "email": "carlos@example.com",
      "phone": "+584121234567"
    },
    "locale": "es",
    "payment_method": "pago_movil",
    "notes": "Llegada en la tarde",
    "terms_accepted": true,
    "website": ""
  }
  ```
- **Response (201 Created):**
  ```json
  {
    "data": {
      "code": "VH-2026-000123",
      "access_token": "u4Q8z...32_bytes_base64url",
      "status": "requested",
      "sla_due_at": "2026-10-30T15:00:00.000Z"
    }
  }
  ```
  *The `access_token` is returned only once at creation. Immediately navigate to `/reserva/{code}?token={access_token}`.*

#### 6. Booking Status Page (`GET /api/v1/bookings/:code`)
- **Header:** `X-Booking-Token: {access_token}`
- **Security Rule:** Invalid codes and invalid tokens both return `404 NOT_FOUND` (prevents token scanning).
- **Response Shape:**
  ```json
  {
    "data": {
      "code": "VH-2026-000123",
      "status": "awaiting_payment",
      "status_label": "Esperando pago",
      "status_description": "El hotel ha confirmado disponibilidad. Realiza el pago para asegurar tu reserva.",
      "sla_due_at": null,
      "payment_due_at": "2026-11-01T15:00:00.000Z",
      "contact": { "name": "Carlos Perez", "email": "carlos@example.com" },
      "items": [ ... ],
      "totals_by_method": [ ... ],
      "payments": [],
      "timeline": [
        { "at": "2026-10-29T11:30:00Z", "event": "hotel_confirmed", "label": "Disponibilidad confirmada" },
        { "at": "2026-10-29T10:00:00Z", "event": "requested", "label": "Solicitud recibida" }
      ],
      "allowed_actions": ["report_payment", "cancel"],
      "created_at": "2026-10-29T10:00:00.000Z"
    }
  }
  ```
  *Render action buttons strictly from `allowed_actions`:*
  - Show "Reportar Pago" only if `allowed_actions.includes('report_payment')`.
  - Show "Cancelar Solicitud" only if `allowed_actions.includes('cancel')`.

#### 7. Customer Actions
- **Report Payment:** `POST /api/v1/bookings/:code/payments`
  ```json
  {
    "token": "u4Q8z...",
    "method": "pago_movil",
    "reference": "PM-12345678"
  }
  ```
- **Cancel Booking:** `POST /api/v1/bookings/:code/cancel`
  ```json
  {
    "token": "u4Q8z..."
  }
  ```

---

### 2.3 React / React Native Client Implementation Pattern

```typescript
// api/client.ts
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://api.vuelitos.com/api/v1';

export async function customerRequest<T>(
  path: string,
  options: RequestInit & { token?: string } = {}
): Promise<T> {
  const { token, headers, ...rest } = options;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': 'es',
      ...(token ? { 'X-Booking-Token': token } : {}),
      ...headers,
    },
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const error = json?.error;
    throw new Error(error?.message || `Request failed with status ${res.status}`);
  }
  return json;
}

// hooks/useBookingStatus.ts (React Query Polling)
import { useQuery } from '@tanstack/react-query';

const TERMINAL_STATUSES = ['unavailable', 'cancelled', 'refunded'];

export function useBookingStatus(code: string, token: string) {
  return useQuery({
    queryKey: ['booking', code],
    queryFn: () => customerRequest<{ data: any }>(`/bookings/${code}`, { token }),
    refetchInterval: (query) => {
      const status = query.state.data?.data?.status;
      if (!status || TERMINAL_STATUSES.includes(status)) return false;
      return 60_000; // Poll every 60 seconds while active
    },
    refetchOnWindowFocus: true,
  });
}
```

---

## 3. Staff Admin Console Guide

### 3.1 Authentication & Security Architecture
- **Base Path:** `/api/admin`
- **Session Authentication:** Handled via HTTP-only cookie `__Secure-vh_session` (12-hour sliding window, refreshed after 1 hour).
- **CSRF & Origin Protection:** All mutation requests (`POST`, `PUT`, `PATCH`, `DELETE`) require verified origin headers (`Sec-Fetch-Site` or `Origin`).
- **Role Hierarchy:**
  $$\text{agent} < \text{admin} < \text{super\_admin}$$
  - **`agent`**: Bookings inbox, availability recording, quotes, read-only catalog.
  - **`admin`**: Hotel catalog CRUD, room types, seasons, rates, manual exchange rates, image management, tarifario imports.
  - **`super_admin`**: Staff user creation, role modification, password resets.

---

### 3.2 Admin Endpoints Reference

#### 1. Authentication
- `POST /api/admin/auth/sign-in`: `{ "email": "staff@vuelitos.com", "password": "..." }`
- `POST /api/admin/auth/sign-out`: Clears session cookie and invalidates Redis token.
- `GET /api/admin/auth/me`: Returns current user profile and role.

#### 2. Bookings Inbox (`GET /api/admin/bookings`)
- **Role:** `agent`
- **Query Params:**
  - `status`: Filter by status (`requested`, `checking_availability`, etc.)
  - `overdue=true`: Filters bookings where `sla_due_at < now` and status is still awaiting confirmation
  - `q`: Search by code, customer name, or email
- **Response:**
  ```json
  {
    "data": [
      {
        "id": "b-uuid",
        "code": "VH-2026-000123",
        "status": "requested",
        "contact_name": "Carlos Perez",
        "contact_email": "carlos@example.com",
        "contact_phone": "+584121234567",
        "sla_due_at": "2026-10-30T15:00:00.000Z",
        "ms_until_sla": 7200000,
        "items_count": 1,
        "created_at": "2026-10-29T10:00:00.000Z"
      }
    ]
  }
  ```

#### 3. Booking Transitions (`POST /api/admin/bookings/:code/transition`)
- **Role:** `agent` (`complete_refund` requires `admin`)
- **Allowed Transition Events:**
  - `start_check` (`requested` $\rightarrow$ `checking_availability`)
  - `hotel_confirmed` ($\rightarrow$ `awaiting_payment`)
  - `offer_alternatives` ($\rightarrow$ `alternatives_offered`)
  - `mark_unavailable` ($\rightarrow$ `unavailable`)
  - `verify_payment` (`payment_submitted` $\rightarrow$ `payment_verified`)
  - `reject_payment` (`payment_submitted` $\rightarrow$ `awaiting_payment`)
  - `confirm_booking` (`payment_verified` $\rightarrow$ `confirmed`)
  - `cancel` ($\rightarrow$ `cancelled` or `refund_pending`)
  - `complete_refund` (`refund_pending` $\rightarrow$ `refunded`)
- **Request:**
  ```json
  {
    "event": "hotel_confirmed",
    "note": "Habitacion confirmada telefonicamente con el hotel"
  }
  ```

#### 4. Availability Check Record (`POST /api/admin/availability`)
- Records the answer received from the hotel supplier:
  ```json
  {
    "booking_id": "b-uuid",
    "hotel_id": "h-uuid",
    "check_in": "2026-11-10",
    "check_out": "2026-11-12",
    "status": "available",
    "note": "Recepcion confirma Cupo standard disponible"
  }
  ```

#### 5. Image Upload & Processing
- **Upload (`POST /api/admin/hotels/:id/images`):**
  - Sends `multipart/form-data` with field `file` (max 10MB; JPEG/PNG/WebP).
  - Evaluated via magic bytes, converted by `sharp` into 1600px WebP, EXIF stripped, stored in `private/hotels/...` as `held`.
- **Publish (`PATCH /api/admin/images/:id`):**
  - Moves image atomically from `private/` to `public/`:
    ```json
    { "status": "published", "sort_order": 1 }
    ```
- **Delete (`DELETE /api/admin/images/:id`)**: Removes physical asset and DB record.

#### 6. Tarifario Import Engine
- **Dry-run (`POST /api/admin/tarifario/imports`):**
  - Accepts normalized JSON (`tarifarioSchema` v1), diffs against DB rates, and returns the pending plan with SHA-256 snapshot hash:
    ```json
    {
      "data": {
        "planId": "plan-uuid",
        "snapshotHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "summary": { "toInsert": 12, "toDeactivate": 4, "unchanged": 80 },
        "markdownDiff": "### Import Plan Diff..."
      }
    }
    ```
- **Commit (`POST /api/admin/tarifario/imports/:id/commit`):**
  - Applies rate changes within an isolated database transaction (retiring old rates without hard-deleting):
    ```json
    { "expected_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }
    ```

#### 7. Exchange Rates Manual Override (`POST /api/admin/exchange-rates/manual`)
- Allows administrative staff to set or override BCV/USDT values:
  ```json
  {
    "bcv_usd": 46.2,
    "bcv_eur": 50.1,
    "binance_usdt": 47.5,
    "bcv_value_date": "2026-10-30"
  }
  ```

---

## 4. Frontend Golden Rules

1. **Server-Owned Pricing:** Never perform arithmetic on pricing amounts in frontend components beyond formatting or computing the single display quotient $\frac{\text{total.base}}{\text{nights}}$.
2. **Payment Method Neutrality:** Present payment methods in the order provided by the backend. Never preselect or recommend a method. The `is_lowest` flag is an informative tag ("Monto menor"), not a selection recommendation.
3. **No Fabricated Urgency:** Availability is validated manually by operations staff. Never show urgency timers or inventory countdowns ("Solo quedan 2 habitaciones").
4. **Action-Driven Booking UI:** Buttons and forms on the booking status page must be rendered dynamically based on `allowed_actions`, never hardcoded against `status` strings.
